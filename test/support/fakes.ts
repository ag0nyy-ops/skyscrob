/**
 * In-process fakes of the Apple Music API and the Last.fm API. They check what a real
 * server would check (JWT signature, api_sig) so the tests prove we'd be accepted.
 */
import { createHash, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import type { Track } from '../../src/core/types';

export const APPLE_BASE = 'https://apple.test';
export const LASTFM_BASE = 'https://lastfm.test/2.0/';
export const LASTFM_AUTH = 'https://lastfm.test/api/auth/';

export function makeAppleKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

export class FakeApple {
  /** Music User Token -> current recently-played list (newest first). */
  lists = new Map<string, Track[]>();
  revoked = new Set<string>();
  nextStatus: number | null = null;
  requests = 0;
  constructor(
    private publicKey: KeyObject,
    private teamId: string,
    private keyId: string,
  ) {}

  private verifyJwt(jwt: string): boolean {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return false;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (header.alg !== 'ES256' || header.kid !== this.keyId || payload.iss !== this.teamId) return false;
    if (payload.exp - payload.iat > 15777000) return false;
    return verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: this.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
  }

  handle(req: Request): Response {
    this.requests++;
    const url = new URL(req.url);
    if (this.nextStatus !== null) {
      const status = this.nextStatus;
      this.nextStatus = null;
      return new Response(JSON.stringify({ errors: [{ status: String(status) }] }), {
        status,
        headers: { 'retry-after': '30' },
      });
    }
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !this.verifyJwt(auth.slice(7)))
      return new Response('{}', { status: 401 });
    const mut = req.headers.get('music-user-token') ?? '';
    if (!this.lists.has(mut) || this.revoked.has(mut)) return new Response('{}', { status: 403 });
    if (url.pathname !== '/v1/me/recent/played/tracks') return new Response('{}', { status: 404 });
    if (!url.searchParams.get('types')) return new Response('{}', { status: 400 });
    const data = this.lists
      .get(mut)!
      .slice(0, 30)
      .map((t) => {
        const [type, id] = t.key.split(':');
        return {
          id,
          type,
          href: `/v1/catalog/us/songs/${id}`,
          attributes: {
            name: t.name,
            artistName: t.artist,
            albumName: t.album,
            durationInMillis: t.durationMs,
            playParams: { id, kind: 'song' },
          },
        };
      });
    return Response.json({ data });
  }
}

export interface FakeScrobble {
  sk: string;
  artist: string;
  track: string;
  timestamp: number;
  album?: string;
  albumArtist?: string;
  duration?: string;
}

export class FakeLastfm {
  /** auth token -> username */
  tokens = new Map<string, string>();
  /** session key -> username */
  sessions = new Map<string, string>();
  scrobbles: FakeScrobble[] = [];
  nowPlaying: { sk: string; artist: string; track: string }[] = [];
  /** Queue of error codes returned by the next track.scrobble calls. */
  scrobbleErrors: number[] = [];
  /** Entries other scrobblers already put on the user's profile. */
  external: { user: string; artist: string; track: string; uts: number }[] = [];
  calls: string[] = [];
  constructor(
    readonly apiKey: string,
    readonly secret: string,
  ) {}

  private sigOk(p: URLSearchParams): boolean {
    const keys = [...p.keys()].filter((k) => k !== 'format' && k !== 'callback' && k !== 'api_sig').sort();
    const base = keys.map((k) => k + p.get(k)).join('') + this.secret;
    return createHash('md5').update(base, 'utf8').digest('hex') === p.get('api_sig');
  }

  async handle(req: Request): Promise<Response> {
    const p = req.method === 'POST' ? new URLSearchParams(await req.text()) : new URL(req.url).searchParams;
    const method = p.get('method') ?? '';
    this.calls.push(method);
    const fail = (error: number, message = 'err') => Response.json({ error, message });
    if (p.get('api_key') !== this.apiKey) return fail(10, 'Invalid API key');
    if (p.get('format') !== 'json') return fail(6, 'format');

    if (method === 'user.getRecentTracks') {
      const user = p.get('user')!;
      const from = Number(p.get('from') ?? 0);
      const to = Number(p.get('to') ?? Infinity);
      const ours = this.scrobbles
        .filter((s) => this.sessions.get(s.sk) === user)
        .map((s) => ({ artist: s.artist, track: s.track, uts: s.timestamp }));
      const ext = this.external.filter((e) => e.user === user);
      const all = [...ours, ...ext].filter((t) => t.uts >= from && t.uts <= to).sort((a, b) => b.uts - a.uts);
      return Response.json({
        recenttracks: {
          track: all.map((t) => ({
            artist: { '#text': t.artist },
            name: t.track,
            date: { uts: String(t.uts) },
          })),
        },
      });
    }

    if (!this.sigOk(p)) return fail(13, 'Invalid method signature supplied');

    if (method === 'auth.getSession') {
      const user = this.tokens.get(p.get('token') ?? '');
      if (!user) return fail(14, 'Unauthorized Token');
      const key = `sk-${user}`;
      this.sessions.set(key, user);
      return Response.json({ session: { name: user, key, subscriber: 0 } });
    }

    const sk = p.get('sk') ?? '';
    if (!this.sessions.has(sk)) return fail(9, 'Invalid session key');

    if (method === 'track.updateNowPlaying') {
      this.nowPlaying.push({ sk, artist: p.get('artist')!, track: p.get('track')! });
      return Response.json({ nowplaying: {} });
    }
    if (method === 'track.scrobble') {
      const err = this.scrobbleErrors.shift();
      if (err !== undefined) return fail(err, 'scripted failure');
      const out = [];
      for (let i = 0; i < 50 && p.has(`artist[${i}]`); i++) {
        const ts = Number(p.get(`timestamp[${i}]`));
        const s: FakeScrobble = {
          sk,
          artist: p.get(`artist[${i}]`)!,
          track: p.get(`track[${i}]`)!,
          timestamp: ts,
          album: p.get(`album[${i}]`) ?? undefined,
          albumArtist: p.get(`albumArtist[${i}]`) ?? undefined,
          duration: p.get(`duration[${i}]`) ?? undefined,
        };
        this.scrobbles.push(s);
        out.push({
          track: { '#text': s.track },
          artist: { '#text': s.artist },
          timestamp: String(ts),
          ignoredMessage: { code: '0', '#text': '' },
        });
      }
      return Response.json({
        scrobbles: {
          scrobble: out.length === 1 ? out[0] : out,
          '@attr': { accepted: out.length, ignored: 0 },
        },
      });
    }
    return fail(3, 'Invalid Method');
  }
}

export function routerFetch(apple: FakeApple, lastfm: FakeLastfm): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith(APPLE_BASE)) return apple.handle(req);
    if (req.url.startsWith('https://lastfm.test/2.0/')) return lastfm.handle(req);
    throw new Error(`unexpected outbound request to ${req.url}`);
  }) as typeof fetch;
}
