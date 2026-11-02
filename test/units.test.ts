import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fetchRecentTracks, parseTracks } from '../src/apple/client';
import { mintDeveloperToken } from '../src/apple/devToken';
import { findAlreadyScrobbled } from '../src/core/dedupe';
import { looseKey, stripRemaster, toScrobbleMetadata } from '../src/core/metadata';
import { backoffMs } from '../src/core/retry';
import { aesKey, decrypt, encrypt } from '../src/crypto';
import { classify, LastfmClient, LastfmError } from '../src/lastfm/client';
import { parseSettings } from '../src/settings';
import { nextPollDelayMs } from '../src/service';
import { initialTrackerState } from '../src/core/tracker';
import { tr } from './helpers';

describe('crypto', () => {
  it('round-trips and binds ciphertext to its AAD', async () => {
    const key = await aesKey(Buffer.alloc(32, 1).toString('base64'));
    const c = await encrypt(key, 'secret-token', 'u1:apple_mut');
    expect(c).toMatch(/^v1\./);
    expect(c).not.toContain('secret');
    expect(await decrypt(key, c, 'u1:apple_mut')).toBe('secret-token');
    await expect(decrypt(key, c, 'u2:apple_mut')).rejects.toThrow();
    expect(await encrypt(key, 'secret-token', 'u1:apple_mut')).not.toBe(c); // random IV
  });

  it('refuses a wrong-sized key', async () => {
    await expect(aesKey(Buffer.alloc(16).toString('base64'))).rejects.toThrow(/32 bytes/);
  });
});

describe('Apple developer token', () => {
  it('is a valid ES256 JWT with the claims Apple requires', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = Date.UTC(2026, 10, 2);
    const jwt = await mintDeveloperToken({
      teamId: 'TEAM',
      keyId: 'KID',
      privateKeyPem: pem,
      nowMs: now,
      origin: ['https://x.test'],
    });
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KID',
      typ: 'JWT',
    });
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toEqual({
      iss: 'TEAM',
      iat: now / 1000,
      exp: now / 1000 + 12 * 3600,
      origin: ['https://x.test'],
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('accepts a PEM pasted with literal \\n sequences (common when setting secrets)', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
    await expect(
      mintDeveloperToken({ teamId: 'T', keyId: 'K', privateKeyPem: pem, nowMs: 0 }),
    ).resolves.toMatch(/\./);
  });
});

describe('Apple client', () => {
  it('parses songs and library songs, drops videos and junk', () => {
    const tracks = parseTracks({
      data: [
        {
          id: '1',
          type: 'songs',
          attributes: { name: 'S', artistName: 'A', albumName: 'Al', durationInMillis: 1000 },
        },
        { id: 'i.2', type: 'library-songs', attributes: { name: 'L', artistName: 'B' } },
        { id: '3', type: 'music-videos', attributes: { name: 'V', artistName: 'C' } },
        { id: '4', type: 'songs', attributes: { name: '', artistName: 'D' } },
        { type: 'songs' },
        {
          id: '5',
          type: 'songs',
          attributes: { name: 'X', artistName: 'Feat Guy & Main' },
          relationships: { albums: { data: [{ attributes: { artistName: 'Main' } }] } },
        },
      ],
    });
    expect(tracks.map((t) => t.key)).toEqual(['songs:1', 'library-songs:i.2', 'songs:5']);
    expect(tracks[0]).toEqual({
      key: 'songs:1',
      name: 'S',
      artist: 'A',
      album: 'Al',
      albumArtist: undefined,
      durationMs: 1000,
    });
    expect(tracks[2]!.albumArtist).toBe('Main');
    expect(parseTracks(null)).toEqual([]);
    expect(parseTracks({ data: 'nope' })).toEqual([]);
  });

  it('classifies failures', async () => {
    const mk = (status: number, headers: Record<string, string> = {}) =>
      fetchRecentTracks({
        fetch: (async () => new Response('{}', { status, headers })) as typeof fetch,
        base: 'https://a.test',
        developerToken: 'd',
        musicUserToken: 'm',
      });
    expect(await mk(401)).toMatchObject({ ok: false, kind: 'dev_auth' });
    expect(await mk(403)).toMatchObject({ ok: false, kind: 'user_auth' });
    expect(await mk(429, { 'retry-after': '42' })).toMatchObject({
      ok: false,
      kind: 'rate_limited',
      retryAfterS: 42,
    });
    expect(await mk(500)).toMatchObject({ ok: false, kind: 'transient' });
    const net = await fetchRecentTracks({
      fetch: (async () => {
        throw new Error('boom');
      }) as typeof fetch,
      base: 'https://a.test',
      developerToken: 'd',
      musicUserToken: 'm',
    });
    expect(net).toMatchObject({ ok: false, kind: 'transient', status: 0 });
  });

  it('sends the tokens and required query params', async () => {
    let seen: Request | null = null;
    await fetchRecentTracks({
      fetch: (async (i: RequestInfo, init?: RequestInit) => {
        seen = new Request(i, init);
        return Response.json({ data: [] });
      }) as typeof fetch,
      base: 'https://a.test',
      developerToken: 'dev',
      musicUserToken: 'mut',
    });
    const r = seen as unknown as Request;
    const u = new URL(r.url);
    expect(u.pathname).toBe('/v1/me/recent/played/tracks');
    expect(u.searchParams.get('types')).toBe('songs,library-songs');
    expect(u.searchParams.get('limit')).toBe('30');
    expect(r.headers.get('authorization')).toBe('Bearer dev');
    expect(r.headers.get('music-user-token')).toBe('mut');
  });
});

describe('Last.fm client', () => {
  const client = (body: unknown, status = 200) =>
    new LastfmClient({
      apiKey: 'k',
      secret: 's',
      base: 'https://l.test/2.0/',
      authUrl: 'https://l.test/api/auth/',
      fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
    });

  it('maps error codes to actions', () => {
    expect(classify(9)).toBe('auth');
    expect(classify(16)).toBe('retry');
    expect(classify(11)).toBe('retry');
    expect(classify(29)).toBe('retry');
    expect(classify(13)).toBe('config');
    expect(classify(6)).toBe('fatal');
  });

  it('throws typed errors', async () => {
    await expect(
      client({ error: 9, message: 'Invalid session key' }).updateNowPlaying('sk', {
        artist: 'a',
        track: 't',
      }),
    ).rejects.toMatchObject({
      code: 9,
      kind: 'auth',
    });
    await expect(client('<html>', 503).getSession('t')).rejects.toBeInstanceOf(LastfmError);
  });

  it('parses single and multiple scrobble results', async () => {
    const one = await client({
      scrobbles: { scrobble: { ignoredMessage: { code: '0', '#text': '' } } },
    }).scrobble('sk', [{ artist: 'a', track: 't', timestamp: 1 }]);
    expect(one).toEqual([{ accepted: true, ignoredCode: 0, ignoredMessage: undefined }]);
    const two = await client({
      scrobbles: {
        scrobble: [
          { ignoredMessage: { code: '0' } },
          { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } },
        ],
      },
    }).scrobble('sk', [
      { artist: 'a', track: 't', timestamp: 1 },
      { artist: 'b', track: 'u', timestamp: 2 },
    ]);
    expect(two[1]).toEqual({ accepted: false, ignoredCode: 3, ignoredMessage: 'Timestamp too old' });
  });

  it('parses recent tracks incl. the now-playing entry without a date', async () => {
    const r = await client({
      recenttracks: {
        track: [
          { artist: { '#text': 'A' }, name: 'Now', '@attr': { nowplaying: 'true' } },
          { artist: { '#text': 'B' }, name: 'Then', date: { uts: '100' } },
        ],
      },
    }).getRecentTracks('u', 0, 200);
    expect(r).toEqual([
      { artist: 'A', track: 'Now', uts: undefined },
      { artist: 'B', track: 'Then', uts: 100 },
    ]);
  });

  it('builds the auth URL with the callback', () => {
    const u = new URL(client({}).authUrl('https://me.test/cb?state=x'));
    expect(u.searchParams.get('api_key')).toBe('k');
    expect(u.searchParams.get('cb')).toBe('https://me.test/cb?state=x');
  });
});

describe('metadata', () => {
  const off = { stripSingleEp: false, stripRemaster: false, preferAlbumArtist: false };
  it('strips remaster tags', () => {
    expect(stripRemaster('Hey Jude (Remastered 2015)')).toBe('Hey Jude');
    expect(stripRemaster('Song - 2011 Remaster')).toBe('Song');
    expect(stripRemaster('Song - Remastered 2009')).toBe('Song');
    expect(stripRemaster('Album [2019 Remaster]')).toBe('Album');
    expect(stripRemaster('Remaster')).toBe('Remaster');
    expect(stripRemaster('Song (Live)')).toBe('Song (Live)');
  });

  it('applies options only when enabled', () => {
    const t = tr('1', 200, { name: 'X (Remastered)', album: 'Y - EP', artist: 'Feat', albumArtist: 'Main' });
    expect(toScrobbleMetadata(t, off)).toEqual({
      artist: 'Feat',
      track: 'X (Remastered)',
      album: 'Y - EP',
      albumArtist: 'Main',
      durationS: 200,
    });
    expect(
      toScrobbleMetadata(t, { stripSingleEp: true, stripRemaster: true, preferAlbumArtist: true }),
    ).toEqual({
      artist: 'Main',
      track: 'X',
      album: 'Y',
      albumArtist: 'Main',
      durationS: 200,
    });
  });

  it('loose keys ignore case, accents, brackets and featured artists', () => {
    expect(looseKey('Beyoncé', 'Halo')).toBe(looseKey('beyonce', 'HALO'));
    expect(looseKey('A & B', 'Song (feat. C)')).toBe(looseKey('A', 'Song'));
    expect(looseKey('A', 'Song - 2011 Remaster')).toBe(looseKey('A', 'Song'));
    expect(looseKey('A', 'Song')).not.toBe(looseKey('A', 'Other Song'));
  });
});

describe('dedupe against Last.fm history', () => {
  const p = (id: string, track: string, ts: number, uncertaintyS = 60) => ({
    id,
    artist: 'Art',
    track,
    ts,
    uncertaintyS,
  });
  const e = (track: string, uts: number) => ({ artist: 'Art', track, uts });

  it('matches a play another scrobbler sent within the window', () => {
    expect(findAlreadyScrobbled([p('1', 'S', 1000)], [], [e('S', 1100)])).toEqual(new Set(['1']));
    expect(findAlreadyScrobbled([p('1', 'S', 1000)], [], [e('S', 1000 + 60 + 301)])).toEqual(new Set());
  });

  it('one Last.fm entry explains at most one play', () => {
    expect(findAlreadyScrobbled([p('1', 'S', 1000), p('2', 'S', 1100)], [], [e('S', 1050)])).toEqual(
      new Set(['1']),
    );
  });

  it("our own earlier scrobble of the same song isn't a duplicate of a genuine replay", () => {
    expect(
      findAlreadyScrobbled([p('2', 'S', 1300)], [{ artist: 'Art', track: 'S', uts: 1000 }], [e('S', 1000)]),
    ).toEqual(new Set());
  });
});

describe('misc', () => {
  it('backoff grows and caps, with jitter', () => {
    const fixed = () => 0.5;
    expect(backoffMs(0, fixed)).toBe(60_000);
    expect(backoffMs(3, fixed)).toBe(480_000);
    expect(backoffMs(50, fixed)).toBe(6 * 3600_000);
    expect(backoffMs(0, () => 0)).toBe(48_000);
    expect(backoffMs(0, () => 1)).toBe(72_000);
  });

  it('settings parsing rejects non-booleans and ignores unknown keys', () => {
    expect(parseSettings({ stripRemaster: true, evil: 'x' })).toMatchObject({ stripRemaster: true });
    expect(parseSettings({ stripRemaster: 'true' })).toBeNull();
    expect(parseSettings([1])).toBeNull();
    expect(parseSettings('not json')).toMatchObject({ nowPlaying: true });
  });

  it('adaptive polling backs off when idle', () => {
    const s = initialTrackerState();
    const now = 10 * 86400_000;
    expect(nextPollDelayMs({ ...s, lastChangeMs: now - 60_000 }, now)).toBe(60_000);
    expect(nextPollDelayMs({ ...s, lastChangeMs: now - 3600_000 }, now)).toBe(180_000);
    expect(nextPollDelayMs({ ...s, lastChangeMs: now - 5 * 3600_000 }, now)).toBe(300_000);
    expect(nextPollDelayMs({ ...s, lastChangeMs: 0 }, now)).toBe(600_000);
    const playing = {
      ...s,
      lastChangeMs: 0,
      head: { track: tr('x'), startMs: now, uncertaintyMs: 0, baseline: false, done: false },
    };
    expect(nextPollDelayMs(playing, now)).toBe(60_000);
  });
});
