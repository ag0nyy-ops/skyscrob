import { describe, expect, it } from 'vitest';
import { list, T0, tr } from './helpers';
import { Harness, ORIGIN } from './support/harness';

const MUT = 'mut-' + 'x'.repeat(40);

async function setup(vars = {}) {
  const h = new Harness(vars);
  h.apple.lists.set(MUT, list('A B C'));
  const b = await h.signIn('alice');
  await b.connectApple(MUT);
  return { h, b };
}

describe('end to end against fake Apple + Last.fm', () => {
  it('sign in, connect, play a song on "the phone", see it on Last.fm', async () => {
    const { h, b } = await setup();
    let me = await b.me();
    expect(me.lastfm).toEqual({ user: 'alice', status: 'ok' });
    expect(me.apple.status).toBe('ok');

    // Existing history is never scrobbled.
    await h.tick();
    await h.tick();
    expect(h.lastfm.scrobbles).toEqual([]);

    // A new song starts.
    h.apple.lists.set(MUT, list('D A B C'));
    await h.tick();
    expect(h.lastfm.nowPlaying.map((n) => n.track)).toEqual(['Song D']);
    expect(h.lastfm.scrobbles).toEqual([]);

    // Past half its length: scrobbled once, with a sane timestamp.
    await h.tick();
    await h.tick();
    expect(h.lastfm.scrobbles).toHaveLength(1);
    const s = h.lastfm.scrobbles[0]!;
    expect(s).toMatchObject({ artist: 'Artist D', track: 'Song D', album: 'Album D', duration: '200' });
    expect(s.timestamp * 1000).toBeLessThanOrEqual(h.clock);
    expect(s.timestamp * 1000).toBeGreaterThan(T0);

    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.lastfm.scrobbles).toHaveLength(1);
    me = await b.me();
    expect(me.scrobbles[0]).toMatchObject({ track: 'Song D', status: 'sent' });
    expect(me.lastPollAt).toBe(h.clock);
  });

  it('overlapping cron runs never double-scrobble', async () => {
    const { h } = await setup();
    h.apple.lists.set(MUT, list('D A B C'));
    await h.tick();
    h.clock += 120_000;
    const { runScheduled } = await import('../src/service');
    await Promise.all([
      runScheduled(h.env, h.deps),
      runScheduled(h.env, h.deps),
      runScheduled(h.env, h.deps),
    ]);
    await h.tick();
    expect(h.lastfm.scrobbles.map((s) => s.track)).toEqual(['Song D']);
  });

  it('a crash after Last.fm accepted but before we recorded it does not resend', async () => {
    const { h } = await setup();
    h.apple.lists.set(MUT, list('D A B C'));
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.lastfm.scrobbles).toHaveLength(1);
    // Pretend the "mark as sent" write never happened.
    h.d1.db.exec("UPDATE scrobbles SET status = 'pending', next_attempt_at = 0 WHERE status = 'sent'");
    await h.tick();
    expect(h.lastfm.scrobbles).toHaveLength(1);
    expect(h.d1.rows("SELECT status FROM scrobbles WHERE track = 'Song D'")).toEqual([
      { status: 'duplicate' },
    ]);
  });

  it('skips plays another scrobbler already sent (e.g. a Mac scrobbler)', async () => {
    const { h } = await setup();
    h.apple.lists.set(MUT, list('D A B C'));
    await h.tick();
    h.lastfm.external.push({
      user: 'alice',
      artist: 'Artist D',
      track: 'Song D',
      uts: Math.floor(h.clock / 1000) - 50,
    });
    await h.tick();
    await h.tick();
    expect(h.lastfm.scrobbles).toEqual([]);
  });

  it('a replay of a song we already scrobbled is scrobbled again (not mistaken for a duplicate)', async () => {
    const { h } = await setup();
    h.apple.lists.set(MUT, list('D A B C'));
    for (let i = 0; i < 4; i++) await h.tick();
    h.apple.lists.set(MUT, list('E D A B'));
    for (let i = 0; i < 4; i++) await h.tick();
    h.apple.lists.set(MUT, list('D E A B'));
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.lastfm.scrobbles.map((s) => s.track)).toEqual(['Song D', 'Song E', 'Song D']);
    const ts = h.lastfm.scrobbles.map((s) => s.timestamp);
    expect(ts[1]!).toBeGreaterThan(ts[0]!);
    expect(ts[2]!).toBeGreaterThan(ts[1]!);
  });

  it('temporary Last.fm failures are retried with backoff and delivered once', async () => {
    const { h } = await setup();
    h.lastfm.scrobbleErrors.push(16, 11);
    h.apple.lists.set(MUT, list('D A B C'));
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.lastfm.scrobbles).toEqual([]);
    const row = h.d1.rows<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM scrobbles WHERE track = ?',
      'Song D',
    )[0]!;
    expect(row.status).toBe('pending');
    for (let i = 0; i < 10; i++) await h.tick();
    expect(h.lastfm.scrobbles.map((s) => s.track)).toEqual(['Song D']);
  });

  it('batches more than 50 pending scrobbles', async () => {
    const { h } = await setup();
    // A long day away: 30 new songs, then 30 more (no overlap = overflow, all new).
    h.apple.lists.set(
      MUT,
      Array.from({ length: 30 }, (_, i) => tr(`n${i}`)),
    );
    h.clock += 6 * 3600_000;
    await h.tick();
    h.apple.lists.set(
      MUT,
      Array.from({ length: 30 }, (_, i) => tr(`m${i}`)),
    );
    h.clock += 6 * 3600_000;
    await h.tick();
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.lastfm.scrobbles.length).toBe(60);
    expect(h.lastfm.calls.filter((c) => c === 'track.scrobble').length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.lastfm.scrobbles.map((s) => s.timestamp)).size).toBe(60);
  });

  it('drops pending plays older than Last.fm accepts', async () => {
    const { h } = await setup();
    h.lastfm.scrobbleErrors.push(...Array(100).fill(16));
    h.apple.lists.set(MUT, list('D A B C'));
    for (let i = 0; i < 3; i++) await h.tick();
    h.lastfm.scrobbleErrors = [];
    h.clock += 15 * 86400_000;
    h.d1.db.exec('UPDATE scrobbles SET next_attempt_at = 0, created_at = ' + (h.clock - 1000));
    await h.tick();
    expect(h.lastfm.scrobbles).toEqual([]);
    expect(h.d1.rows("SELECT status FROM scrobbles WHERE track = 'Song D'")).toEqual([{ status: 'dropped' }]);
  });

  it('Apple token expiry: marks re-auth, stops polling, shows on dashboard, reconnect resumes', async () => {
    const { h, b } = await setup();
    h.apple.revoked.add(MUT);
    await h.tick();
    let me = await b.me();
    expect(me.apple.status).toBe('reauth');
    expect(me.lastError).toMatch(/Reconnect Apple Music/);
    const before = h.apple.requests;
    await h.tick();
    await h.tick();
    expect(h.apple.requests).toBe(before);

    const MUT2 = 'mut2-' + 'y'.repeat(40);
    h.apple.lists.set(MUT2, list('A B C'));
    await b.connectApple(MUT2);
    me = await b.me();
    expect(me.apple.status).toBe('ok');
    h.apple.lists.set(MUT2, list('Z A B C'));
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.lastfm.scrobbles.map((s) => s.track)).toEqual(['Song Z']);
  });

  it('Last.fm session revoked: marks invalid, keeps plays pending until the user signs in again', async () => {
    const { h, b } = await setup();
    h.lastfm.sessions.clear();
    h.apple.lists.set(MUT, list('D A B C'));
    for (let i = 0; i < 3; i++) await h.tick();
    const me = await b.me();
    expect(me.lastfm.status).toBe('invalid');
    expect(h.lastfm.scrobbles).toEqual([]);
    await h.signIn('alice');
    for (let i = 0; i < 2; i++) await h.tick();
    expect(h.lastfm.scrobbles.map((s) => s.track)).toEqual(['Song D']);
  });

  it('pause stops scrobbling, and what played while paused is never scrobbled', async () => {
    const { h, b } = await setup();
    expect((await b.post('/api/pause', { paused: true })).status).toBe(200);
    h.apple.lists.set(MUT, list('P Q A B C'));
    for (let i = 0; i < 5; i++) await h.tick();
    await b.post('/api/pause', { paused: false });
    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.lastfm.scrobbles).toEqual([]);
    h.apple.lists.set(MUT, list('R P Q A B C'));
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.lastfm.scrobbles.map((s) => s.track)).toEqual(['Song R']);
  });

  it('metadata cleanup settings apply to what is sent', async () => {
    const { h, b } = await setup();
    await b.post('/api/settings', { stripSingleEp: true, stripRemaster: true });
    h.apple.lists.set(MUT, [
      tr('S', 200, { name: 'Hey Jude (Remastered 2015)', artist: 'The Beatles', album: 'Hey Jude - Single' }),
      ...list('A B C'),
    ]);
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.lastfm.scrobbles[0]).toMatchObject({
      track: 'Hey Jude',
      album: 'Hey Jude',
      artist: 'The Beatles',
    });
  });

  it('delete my data removes every row about the user and kills the session', async () => {
    const { h, b } = await setup();
    h.apple.lists.set(MUT, list('D A B C'));
    for (let i = 0; i < 3; i++) await h.tick();
    const r = await b.post('/api/delete');
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    for (const t of ['users', 'scrobbles', 'sessions']) expect(h.d1.rows(`SELECT * FROM ${t}`)).toEqual([]);
    expect((await h.request('/api/me', { cookie: b.cookie })).status).toBe(401);
    const before = h.apple.requests;
    await h.tick();
    expect(h.apple.requests).toBe(before);
  });

  it('tokens are encrypted at rest and never stored in plaintext', async () => {
    const { h } = await setup();
    const dump =
      JSON.stringify(h.d1.rows('SELECT * FROM users')) + JSON.stringify(h.d1.rows('SELECT * FROM sessions'));
    expect(dump).not.toContain(MUT);
    expect(dump).not.toContain('sk-alice');
    expect(dump).toContain('v1.');
  });

  it('ciphertexts are bound to their row (copying one to another user fails to decrypt)', async () => {
    const { h } = await setup();
    h.apple.lists.set('mut-bob-' + 'z'.repeat(40), list('A'));
    const bob = await h.signIn('bob', '198.51.100.9');
    await bob.connectApple('mut-bob-' + 'z'.repeat(40));
    h.d1.db.exec(
      "UPDATE users SET apple_mut = (SELECT apple_mut FROM users WHERE lastfm_user = 'alice') WHERE lastfm_user = 'bob'",
    );
    await h.tick();
    const bobRow = h.d1.rows<{ last_poll_result: string | null }>(
      "SELECT last_poll_result FROM users WHERE lastfm_user='bob'",
    )[0]!;
    // Bob's poll failed to decrypt and never reached Apple with Alice's token.
    expect(bobRow.last_poll_result).toBe('baseline');
  });
});

describe('web security', () => {
  it('rejects state-changing requests without the CSRF token', async () => {
    const { b } = await setup();
    expect((await b.post('/api/pause', { paused: true }, { 'x-csrf-token': 'nope' })).status).toBe(403);
  });

  it('rejects cross-origin writes even with a valid token', async () => {
    const { b } = await setup();
    expect((await b.post('/api/pause', { paused: true }, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
  });

  it('rejects non-JSON bodies, bad settings, bad tokens', async () => {
    const { h, b } = await setup();
    const form = await h.request('/api/pause', {
      method: 'POST',
      cookie: b.cookie,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': b.csrf,
        origin: ORIGIN,
      },
      body: 'paused=true',
    });
    expect(form.status).toBe(415);
    expect((await b.post('/api/settings', { stripRemaster: 'yes' })).status).toBe(400);
    expect((await b.post('/api/apple/connect', { musicUserToken: '<script>' })).status).toBe(400);
  });

  it('API requires a session', async () => {
    const h = new Harness();
    expect((await h.request('/api/me')).status).toBe(401);
    expect((await h.request('/api/apple/developer-token')).status).toBe(401);
  });

  it('self-host allowlist keeps strangers out', async () => {
    const h = new Harness({ ALLOWED_LASTFM_USERS: 'alice, carol' });
    await expect(h.signIn('mallory')).rejects.toThrow(/callback 403/);
    await expect(h.signIn('Alice')).resolves.toBeTruthy();
    expect(h.d1.rows('SELECT lastfm_user FROM users')).toEqual([{ lastfm_user: 'Alice' }]);
  });

  it('a reused or forged sign-in state is refused', async () => {
    const h = new Harness();
    const start = await h.request('/auth/lastfm/login');
    const cb = new URL(new URL(start.headers.get('location')!).searchParams.get('cb')!);
    h.lastfm.tokens.set('tokaliceabcdef', 'alice');
    cb.searchParams.set('token', 'tokaliceabcdef');
    expect((await h.request(cb.pathname + cb.search)).status).toBe(302);
    expect((await h.request(cb.pathname + cb.search)).status).toBe(400);
    expect(
      (await h.request('/auth/lastfm/callback?state=' + 'f'.repeat(32) + '&token=tokaliceabcdef')).status,
    ).toBe(400);
  });

  it('rate-limits sign-in attempts per IP', async () => {
    const h = new Harness();
    const statuses = [];
    for (let i = 0; i < 22; i++)
      statuses.push((await h.request('/auth/lastfm/login', { ip: '192.0.2.1' })).status);
    expect(statuses.slice(0, 20).every((s) => s === 302)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await h.request('/auth/lastfm/login', { ip: '192.0.2.2' })).status).toBe(302);
  });

  it('session cookie is HttpOnly, Secure, SameSite and __Host- scoped', async () => {
    const h = new Harness();
    const start = await h.request('/auth/lastfm/login');
    const cb = new URL(new URL(start.headers.get('location')!).searchParams.get('cb')!);
    h.lastfm.tokens.set('tokaliceabcdef', 'alice');
    cb.searchParams.set('token', 'tokaliceabcdef');
    const r = await h.request(cb.pathname + cb.search);
    const c = r.headers.get('set-cookie')!;
    expect(c).toMatch(/^__Host-skyscrob=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(c).toContain(flag);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });

  it('developer token for the browser is origin-locked and valid', async () => {
    const { h, b } = await setup();
    const r = await h.request('/api/apple/developer-token', { cookie: b.cookie });
    const { token } = (await r.json()) as { token: string };
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload.origin).toEqual([ORIGIN]);
    expect(payload.iss).toBe('TEAMID1234');
  });
});
