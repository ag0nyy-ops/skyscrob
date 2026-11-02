/**
 * Web routes: Last.fm sign-in, Apple Music connect, dashboard API.
 *
 * Security model:
 *  - Identity = a Last.fm account, proven via Last.fm's web auth. Self-hosted instances are
 *    locked to ALLOWED_LASTFM_USERS so strangers can't use the deployer's Apple key.
 *  - Session cookie is random, HttpOnly, Secure, SameSite=Lax, __Host- prefixed; only its
 *    SHA-256 is stored.
 *  - State-changing routes are POST + JSON + X-CSRF-Token (per-session) + same-origin check.
 *  - Per-IP fixed-window rate limits on every API/auth route.
 *  - Tokens are encrypted before they touch the database and never logged or returned.
 */
import { fetchRecentTracks } from './apple/client';
import { cachedDeveloperToken } from './apple/devToken';
import { initialTrackerState, step } from './core/tracker';
import { aesKey, encrypt, randomToken, safeEqual, sha256Hex } from './crypto';
import { isAllowed, loadConfig, type Config, type Deps, type Env } from './env';
import { LastfmError } from './lastfm/client';
import { commitStep, lastfmClient, log, nextPollDelayMs, type UserRow } from './service';
import { DEFAULT_SETTINGS, parseSettings } from './settings';

const COOKIE = '__Host-skyscrob';
const SESSION_MS = 30 * 86400_000;
const MAX_BODY = 16 * 1024;

type Ctx = { env: Env; deps: Deps; cfg: Config; req: Request; url: URL; ip: string };

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const err = (status: number, error: string) => json({ error }, status);

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function withSecurityHeaders(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}

async function rateLimit(ctx: Ctx, bucket: string, limit: number, windowMs: number): Promise<boolean> {
  const now = ctx.deps.now();
  const windowStart = now - (now % windowMs);
  const key = `${bucket}:${ctx.ip}`;
  const row = await ctx.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= limit;
}

function cookieValue(req: Request): string | null {
  const c = req.headers.get('cookie') ?? '';
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return null;
}

interface Session {
  user: UserRow & {
    apple_connected_at: number | null;
    last_poll_at: number | null;
    last_poll_result: string | null;
    last_error: string | null;
  };
  csrf: string;
  idHash: string;
}

async function getSession(ctx: Ctx): Promise<Session | null> {
  const raw = cookieValue(ctx.req);
  if (!raw || raw.length > 100) return null;
  const idHash = await sha256Hex(raw);
  const row = await ctx.env.DB.prepare(
    `SELECT s.csrf, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  )
    .bind(idHash)
    .first<Session['user'] & { csrf: string; expires_at: number }>();
  if (!row || row.expires_at < ctx.deps.now()) return null;
  return { user: row, csrf: row.csrf, idHash };
}

/** POST + JSON + CSRF header + same origin. Returns parsed body or an error Response. */
async function guardWrite(ctx: Ctx, s: Session): Promise<Record<string, unknown> | Response> {
  if (ctx.req.method !== 'POST') return err(405, 'method not allowed');
  const origin = ctx.req.headers.get('origin');
  if (origin && origin !== ctx.url.origin) return err(403, 'cross-origin request');
  const csrf = ctx.req.headers.get('x-csrf-token') ?? '';
  if (!safeEqual(csrf, s.csrf)) return err(403, 'bad csrf token');
  if (!(ctx.req.headers.get('content-type') ?? '').startsWith('application/json'))
    return err(415, 'json only');
  const text = await ctx.req.text();
  if (text.length > MAX_BODY) return err(413, 'too large');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return err(400, 'bad body');
    return body as Record<string, unknown>;
  } catch {
    return err(400, 'bad json');
  }
}

function sessionCookie(value: string, maxAgeS: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

async function loginStart(ctx: Ctx): Promise<Response> {
  if (!(await rateLimit(ctx, 'auth', 20, 10 * 60_000))) return err(429, 'slow down');
  const state = randomToken(24);
  await ctx.env.DB.prepare('INSERT INTO auth_states (state, created_at) VALUES (?, ?)')
    .bind(state, ctx.deps.now())
    .run();
  const cb = new URL('/auth/lastfm/callback', ctx.url.origin);
  cb.searchParams.set('state', state);
  return Response.redirect(lastfmClient(ctx.env, ctx.cfg, ctx.deps).authUrl(cb.toString()), 302);
}

async function loginCallback(ctx: Ctx): Promise<Response> {
  if (!(await rateLimit(ctx, 'auth', 20, 10 * 60_000))) return err(429, 'slow down');
  const state = ctx.url.searchParams.get('state') ?? '';
  const token = ctx.url.searchParams.get('token') ?? '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state) || !/^[A-Za-z0-9]{8,64}$/.test(token))
    return err(400, 'bad callback');
  const now = ctx.deps.now();
  const st = await ctx.env.DB.prepare('DELETE FROM auth_states WHERE state = ? RETURNING created_at')
    .bind(state)
    .first<{ created_at: number }>();
  if (!st || now - st.created_at > 10 * 60_000) return err(400, 'sign-in link expired, try again');

  let session: { name: string; key: string };
  try {
    session = await lastfmClient(ctx.env, ctx.cfg, ctx.deps).getSession(token);
  } catch (e) {
    log('lastfm_getsession_failed', { code: e instanceof LastfmError ? e.code : -1 });
    return err(502, 'Last.fm sign-in failed, try again');
  }
  if (!isAllowed(ctx.cfg, session.name)) {
    log('login_refused', {});
    return new Response('This instance is private. Ask its owner, or self-host your own copy.', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const key = await aesKey(ctx.env.ENCRYPTION_KEY);
  const existing = await ctx.env.DB.prepare('SELECT id FROM users WHERE lastfm_user = ?')
    .bind(session.name)
    .first<{ id: string }>();
  const userId = existing?.id ?? crypto.randomUUID();
  const sk = await encrypt(key, session.key, `${userId}:lastfm_sk`);
  const cookie = randomToken(32);
  await ctx.env.DB.batch([
    existing
      ? ctx.env.DB.prepare(
          "UPDATE users SET lastfm_sk = ?, lastfm_status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?",
        ).bind(sk, now, userId)
      : ctx.env.DB.prepare(
          "INSERT INTO users (id, lastfm_user, lastfm_sk, lastfm_status, settings, created_at, updated_at) VALUES (?, ?, ?, 'ok', ?, ?, ?)",
        ).bind(userId, session.name, sk, JSON.stringify(DEFAULT_SETTINGS), now, now),
    ctx.env.DB.prepare(
      'INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(await sha256Hex(cookie), userId, randomToken(24), now, now + SESSION_MS),
  ]);
  log('login', { user: userId, created: !existing });
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': sessionCookie(cookie, SESSION_MS / 1000) },
  });
}

async function me(ctx: Ctx, s: Session): Promise<Response> {
  const u = s.user;
  const { results } = await ctx.env.DB.prepare(
    `SELECT artist, track, album, ts, ts_approx, status, reason FROM scrobbles WHERE user_id = ?
     ORDER BY ts DESC, created_at DESC LIMIT 30`,
  )
    .bind(u.id)
    .all();
  return json({
    csrf: s.csrf,
    lastfm: { user: u.lastfm_user, status: u.lastfm_status },
    apple: { status: u.apple_status, connectedAt: u.apple_connected_at },
    paused: !!u.paused,
    settings: parseSettings(u.settings) ?? DEFAULT_SETTINGS,
    lastPollAt: u.last_poll_at,
    lastPollResult: u.last_poll_result,
    lastError: u.last_error,
    detectionMode: ctx.cfg.tracker.mode,
    scrobbles: results,
  });
}

async function developerToken(ctx: Ctx): Promise<Response> {
  if (!(await rateLimit(ctx, 'devtoken', 30, 3600_000))) return err(429, 'slow down');
  const token = await cachedDeveloperToken({
    teamId: ctx.env.APPLE_TEAM_ID,
    keyId: ctx.env.APPLE_KEY_ID,
    privateKeyPem: ctx.env.APPLE_PRIVATE_KEY,
    origin: [ctx.url.origin],
    nowMs: ctx.deps.now(),
  });
  return json({ token });
}

async function appleConnect(ctx: Ctx, s: Session, body: Record<string, unknown>): Promise<Response> {
  const mut = body.musicUserToken;
  if (typeof mut !== 'string' || mut.length < 20 || mut.length > 4096 || !/^[A-Za-z0-9+/=._-]+$/.test(mut)) {
    return err(400, 'invalid Music User Token');
  }
  const now = ctx.deps.now();
  const devToken = await cachedDeveloperToken({
    teamId: ctx.env.APPLE_TEAM_ID,
    keyId: ctx.env.APPLE_KEY_ID,
    privateKeyPem: ctx.env.APPLE_PRIVATE_KEY,
    nowMs: now,
  });
  // Prove the token works, and take the first snapshot right away as the baseline.
  const res = await fetchRecentTracks({
    fetch: ctx.deps.fetch,
    base: ctx.cfg.appleApiBase,
    developerToken: devToken,
    musicUserToken: mut,
    includeAlbums: ctx.cfg.includeAlbums,
  });
  if (!res.ok) {
    log('apple_connect_failed', { user: s.user.id, kind: res.kind, status: res.status });
    return err(
      res.kind === 'user_auth' ? 400 : 502,
      res.kind === 'user_auth'
        ? 'Apple Music rejected the token. Do you have an active subscription?'
        : 'Apple Music API error, try again',
    );
  }
  const enc = await encrypt(await aesKey(ctx.env.ENCRYPTION_KEY), mut, `${s.user.id}:apple_mut`);
  // Fresh tracker: the current list is the baseline, so old history is never scrobbled.
  await ctx.env.DB.prepare(
    `UPDATE users SET apple_mut = ?, apple_status = 'ok', apple_connected_at = ?, tracker = NULL,
       state_version = state_version + 1, last_error = NULL, consecutive_errors = 0, updated_at = ? WHERE id = ?`,
  )
    .bind(enc, now, now, s.user.id)
    .run();
  const user = await ctx.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(s.user.id).first<UserRow>();
  const result = step(initialTrackerState(), res.tracks, now, ctx.cfg.tracker);
  await commitStep(ctx.env, user!, result, parseSettings(user!.settings) ?? DEFAULT_SETTINGS, now, {
    nextPollAt: now + nextPollDelayMs(result.state, now) - 5_000,
  });
  log('apple_connected', { user: s.user.id });
  return json({ ok: true });
}

export async function handleRequest(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const ctx: Ctx = {
    env,
    deps,
    cfg: loadConfig(env),
    req,
    url,
    ip: req.headers.get('cf-connecting-ip') ?? 'local',
  };
  const p = url.pathname;

  if (p === '/api/health') return withSecurityHeaders(json({ ok: true }));
  if (p === '/auth/lastfm/login' && req.method === 'GET') return withSecurityHeaders(await loginStart(ctx));
  if (p === '/auth/lastfm/callback' && req.method === 'GET')
    return withSecurityHeaders(await loginCallback(ctx));

  if (p.startsWith('/api/')) {
    if (!(await rateLimit(ctx, 'api', 120, 60_000))) return withSecurityHeaders(err(429, 'slow down'));
    const s = await getSession(ctx);
    if (!s) return withSecurityHeaders(err(401, 'not signed in'));
    if (p === '/api/me' && req.method === 'GET') return withSecurityHeaders(await me(ctx, s));
    if (p === '/api/apple/developer-token' && req.method === 'GET')
      return withSecurityHeaders(await developerToken(ctx));

    const body = await guardWrite(ctx, s);
    if (body instanceof Response) return withSecurityHeaders(body);
    const now = deps.now();
    const DB = env.DB;
    const uid = s.user.id;
    switch (p) {
      case '/api/apple/connect':
        return withSecurityHeaders(await appleConnect(ctx, s, body));
      case '/api/apple/disconnect':
        await DB.prepare(
          "UPDATE users SET apple_mut = NULL, apple_status = 'none', tracker = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ?",
        )
          .bind(now, uid)
          .run();
        log('apple_disconnected', { user: uid });
        return withSecurityHeaders(json({ ok: true }));
      case '/api/settings': {
        const next = parseSettings(body, parseSettings(s.user.settings) ?? DEFAULT_SETTINGS);
        if (!next) return withSecurityHeaders(err(400, 'settings must be booleans'));
        await DB.prepare('UPDATE users SET settings = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(next), now, uid)
          .run();
        return withSecurityHeaders(json({ ok: true, settings: next }));
      }
      case '/api/pause': {
        if (typeof body.paused !== 'boolean') return withSecurityHeaders(err(400, 'paused must be boolean'));
        // Resuming starts from a fresh baseline: what played while paused is never scrobbled.
        await DB.prepare(
          `UPDATE users SET paused = ?, tracker = CASE WHEN ? = 0 THEN NULL ELSE tracker END,
             state_version = state_version + 1, next_poll_at = 0, updated_at = ? WHERE id = ?`,
        )
          .bind(body.paused ? 1 : 0, body.paused ? 1 : 0, now, uid)
          .run();
        return withSecurityHeaders(json({ ok: true }));
      }
      case '/api/logout':
        await DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(s.idHash).run();
        return withSecurityHeaders(json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) }));
      case '/api/delete':
        // Everything we hold about this user, gone. (Foreign keys cascade too; this is explicit.)
        await DB.batch([
          DB.prepare('DELETE FROM scrobbles WHERE user_id = ?').bind(uid),
          DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid),
          DB.prepare('DELETE FROM users WHERE id = ?').bind(uid),
        ]);
        log('user_deleted', {});
        return withSecurityHeaders(json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) }));
    }
    return withSecurityHeaders(err(404, 'not found'));
  }

  if (env.ASSETS) return withSecurityHeaders(await env.ASSETS.fetch(req));
  return withSecurityHeaders(new Response('not found', { status: 404 }));
}
