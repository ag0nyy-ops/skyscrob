/**
 * The background loop: poll Apple Music per user, turn changes into planned scrobbles,
 * deliver them to Last.fm. Called from the cron trigger once a minute.
 *
 * Never logs tokens. Log lines carry a user id and an event name, nothing else sensitive.
 */
import { fetchRecentTracks } from './apple/client';
import { cachedDeveloperToken } from './apple/devToken';
import { findAlreadyScrobbled } from './core/dedupe';
import { toScrobbleMetadata } from './core/metadata';
import { backoffMs, MAX_ATTEMPTS, MAX_SCROBBLE_AGE_S } from './core/retry';
import { initialTrackerState, step, type TrackerState } from './core/tracker';
import type { PlannedScrobble, SkippedPlay } from './core/types';
import { aesKey, decrypt, sha256Hex } from './crypto';
import { loadConfig, type Config, type Deps, type Env } from './env';
import { LastfmClient, LastfmError, type ScrobbleItem } from './lastfm/client';
import { parseSettings, type UserSettings } from './settings';

export interface UserRow {
  id: string;
  lastfm_user: string;
  lastfm_sk: string | null;
  lastfm_status: string;
  apple_mut: string | null;
  apple_status: string;
  paused: number;
  settings: string;
  tracker: string | null;
  state_version: number;
  consecutive_errors: number;
}

interface ScrobbleRow {
  id: string;
  artist: string;
  track: string;
  album: string | null;
  album_artist: string | null;
  duration_s: number | null;
  ts: number;
  ts_uncertainty_s: number;
  attempts: number;
}

const LEASE_MS = 55_000;
const RETENTION_MS = 15 * 86400_000;

export function log(event: string, fields: Record<string, string | number | boolean | undefined> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

export function lastfmClient(env: Env, cfg: Config, deps: Deps) {
  return new LastfmClient({
    apiKey: env.LASTFM_API_KEY,
    secret: env.LASTFM_API_SECRET,
    base: cfg.lastfmApiBase,
    authUrl: cfg.lastfmAuthUrl,
    fetch: deps.fetch,
  });
}

/**
 * Adaptive polling. Every minute while something is playing or changed recently, backing off
 * when idle. 30 items of history means even a 10-minute gap can't lose plays, only delay them.
 */
export function nextPollDelayMs(state: TrackerState, now: number): number {
  if (state.head && !state.head.done) return 60_000;
  const idle = now - (state.lastChangeMs ?? 0);
  if (idle < 20 * 60_000) return 60_000;
  if (idle < 2 * 3600_000) return 3 * 60_000;
  if (idle < 12 * 3600_000) return 5 * 60_000;
  return 10 * 60_000;
}

export async function scrobbleId(userId: string, p: PlannedScrobble | SkippedPlay, startMs: number) {
  return (await sha256Hex(`${userId}|${p.track.key}|${startMs}`)).slice(0, 32);
}

/** Persist one tracker step atomically: rows only land if the state version still matches. */
export async function commitStep(
  env: Env,
  user: UserRow,
  result: { state: TrackerState; scrobbles: PlannedScrobble[]; skipped: SkippedPlay[]; event: string },
  settings: UserSettings,
  now: number,
  extra: { nextPollAt: number },
): Promise<boolean> {
  const stmts: D1PreparedStatement[] = [];
  const insert = `INSERT OR IGNORE INTO scrobbles
      (id, user_id, artist, track, album, album_artist, duration_s, ts, ts_approx, ts_uncertainty_s,
       status, reason, attempts, next_attempt_at, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0, ?, ?
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND state_version = ?)`;
  const add = (
    id: string,
    p: PlannedScrobble | SkippedPlay,
    startMs: number,
    unc: number,
    status: string,
    reason: string | null,
  ) => {
    const m = toScrobbleMetadata(p.track, settings);
    stmts.push(
      env.DB.prepare(insert).bind(
        id,
        user.id,
        m.artist,
        m.track,
        m.album ?? null,
        m.albumArtist ?? null,
        m.durationS ?? null,
        Math.floor(startMs / 1000),
        Math.round(unc / 1000),
        status,
        reason,
        now,
        now,
        user.id,
        user.state_version,
      ),
    );
  };
  for (const s of result.scrobbles)
    add(await scrobbleId(user.id, s, s.startMs), s, s.startMs, s.uncertaintyMs, 'pending', null);
  for (const s of result.skipped) add(await scrobbleId(user.id, s, now), s, now, 0, 'skipped', s.reason);
  stmts.push(
    env.DB.prepare(
      `UPDATE users SET tracker = ?, state_version = state_version + 1, next_poll_at = ?, last_poll_at = ?,
         last_poll_result = ?, last_error = NULL, consecutive_errors = 0, lease_until = 0, updated_at = ?
       WHERE id = ? AND state_version = ?`,
    ).bind(
      JSON.stringify(result.state),
      extra.nextPollAt,
      now,
      result.event,
      now,
      user.id,
      user.state_version,
    ),
  );
  const res = await env.DB.batch(stmts);
  return (res.at(-1)?.meta.changes ?? 0) === 1;
}

async function releaseWithError(
  env: Env,
  userId: string,
  now: number,
  fields: { next: number; error: string; status?: 'reauth'; bumpErrors?: boolean },
) {
  await env.DB.prepare(
    `UPDATE users SET lease_until = 0, next_poll_at = ?, last_error = ?, last_poll_at = ?,
       consecutive_errors = consecutive_errors + ?, apple_status = COALESCE(?, apple_status), updated_at = ?
     WHERE id = ?`,
  )
    .bind(fields.next, fields.error, now, fields.bumpErrors ? 1 : 0, fields.status ?? null, now, userId)
    .run();
}

export async function pollUser(env: Env, deps: Deps, cfg: Config, userId: string): Promise<void> {
  const now = deps.now();
  const lease = await env.DB.prepare(
    `UPDATE users SET lease_until = ? WHERE id = ? AND lease_until < ? AND paused = 0
       AND apple_status = 'ok' AND lastfm_status = 'ok'`,
  )
    .bind(now + LEASE_MS, userId, now)
    .run();
  if (lease.meta.changes !== 1) return; // someone else has it, or it's no longer active

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  if (!user?.apple_mut) return;
  const key = await aesKey(env.ENCRYPTION_KEY);
  const mut = await decrypt(key, user.apple_mut, `${user.id}:apple_mut`);
  const developerToken = await cachedDeveloperToken({
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    privateKeyPem: env.APPLE_PRIVATE_KEY,
    nowMs: now,
  });

  const res = await fetchRecentTracks({
    fetch: deps.fetch,
    base: cfg.appleApiBase,
    developerToken,
    musicUserToken: mut,
    includeAlbums: cfg.includeAlbums,
  });

  if (!res.ok) {
    log('apple_poll_failed', { user: user.id, kind: res.kind, status: res.status });
    if (res.kind === 'user_auth') {
      await releaseWithError(env, user.id, now, {
        next: now,
        error: 'Apple Music access expired or was revoked. Reconnect Apple Music.',
        status: 'reauth',
      });
    } else if (res.kind === 'dev_auth') {
      await releaseWithError(env, user.id, now, {
        next: now + 10 * 60_000,
        error: 'Apple rejected the developer token. Check APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY.',
        bumpErrors: true,
      });
    } else if (res.kind === 'rate_limited') {
      await releaseWithError(env, user.id, now, {
        next: now + Math.max(120, res.retryAfterS ?? 0) * 1000,
        error: 'Apple Music rate limit; backing off.',
        bumpErrors: true,
      });
    } else {
      const delay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(user.consecutive_errors, 5));
      await releaseWithError(env, user.id, now, {
        next: now + delay,
        error: `Apple Music API error (${res.status}); retrying.`,
        bumpErrors: true,
      });
    }
    return;
  }

  const settings = parseSettings(user.settings) ?? parseSettings('{}')!;
  const prevState: TrackerState = user.tracker ? JSON.parse(user.tracker) : initialTrackerState();
  const result = step(prevState, res.tracks, now, cfg.tracker);
  const nextPollAt = now + nextPollDelayMs(result.state, now) - 5_000;
  const committed = await commitStep(env, user, result, settings, now, { nextPollAt });
  if (!committed) {
    log('state_conflict', { user: user.id });
    return;
  }
  if (result.event !== 'unchanged') {
    log('poll', {
      user: user.id,
      event: result.event,
      planned: result.scrobbles.length,
      skipped: result.skipped.length,
    });
  }

  if (result.nowPlaying && settings.nowPlaying && cfg.tracker.mode === 'start' && user.lastfm_sk) {
    try {
      const sk = await decrypt(key, user.lastfm_sk, `${user.id}:lastfm_sk`);
      await lastfmClient(env, cfg, deps).updateNowPlaying(
        sk,
        toScrobbleMetadata(result.nowPlaying, settings),
      );
    } catch (e) {
      if (e instanceof LastfmError && e.kind === 'auth') await markLastfmInvalid(env, user.id, now);
      // Now-playing is best effort; never retried.
    }
  }
}

async function markLastfmInvalid(env: Env, userId: string, now: number) {
  log('lastfm_session_invalid', { user: userId });
  await env.DB.prepare(
    "UPDATE users SET lastfm_status = 'invalid', last_error = ?, updated_at = ? WHERE id = ?",
  )
    .bind('Last.fm session is no longer valid. Sign in with Last.fm again.', now, userId)
    .run();
}

/** Deliver pending scrobbles for one user: drop stale ones, skip ones already on Last.fm, send the rest. */
export async function flushUser(env: Env, deps: Deps, cfg: Config, userId: string): Promise<void> {
  const now = deps.now();
  const nowS = Math.floor(now / 1000);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  if (!user || !user.lastfm_sk || user.lastfm_status !== 'ok') return;

  const { results: rows } = await env.DB.prepare(
    `SELECT id, artist, track, album, album_artist, duration_s, ts, ts_uncertainty_s, attempts FROM scrobbles
     WHERE user_id = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY ts LIMIT 50`,
  )
    .bind(userId, now)
    .all<ScrobbleRow>();
  if (rows.length === 0) return;

  const upd = (id: string, status: string, reason: string | null, attempts: number, nextAttempt: number) =>
    env.DB.prepare(
      'UPDATE scrobbles SET status = ?, reason = ?, attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?',
    ).bind(status, reason, attempts, nextAttempt, now, id);

  const fresh = rows.filter((r) => nowS - r.ts <= MAX_SCROBBLE_AGE_S);
  const stmts: D1PreparedStatement[] = rows
    .filter((r) => nowS - r.ts > MAX_SCROBBLE_AGE_S)
    .map((r) => upd(r.id, 'dropped', 'older than Last.fm accepts (14 days)', r.attempts, 0));

  const client = lastfmClient(env, cfg, deps);
  const sk = await decrypt(await aesKey(env.ENCRYPTION_KEY), user.lastfm_sk, `${user.id}:lastfm_sk`);

  // Cross-check against what Last.fm already has (other scrobblers, or our own crash-before-commit).
  let toSend = fresh;
  if (fresh.length > 0) {
    const from = Math.min(...fresh.map((r) => r.ts - r.ts_uncertainty_s)) - 600;
    try {
      const lfm = await client.getRecentTracks(user.lastfm_user, from, nowS + 60);
      const { results: sent } = await env.DB.prepare(
        "SELECT artist, track, ts FROM scrobbles WHERE user_id = ? AND status = 'sent' AND ts >= ?",
      )
        .bind(userId, from - 600)
        .all<{ artist: string; track: string; ts: number }>();
      const dupes = findAlreadyScrobbled(
        fresh.map((r) => ({
          id: r.id,
          artist: r.artist,
          track: r.track,
          ts: r.ts,
          uncertaintyS: r.ts_uncertainty_s,
        })),
        sent.map((s) => ({ artist: s.artist, track: s.track, uts: s.ts })),
        lfm
          .filter((t) => t.uts !== undefined)
          .map((t) => ({ artist: t.artist, track: t.track, uts: t.uts! })),
      );
      for (const r of fresh)
        if (dupes.has(r.id)) stmts.push(upd(r.id, 'duplicate', 'already on Last.fm', r.attempts, 0));
      toSend = fresh.filter((r) => !dupes.has(r.id));
    } catch (e) {
      if (e instanceof LastfmError && e.kind === 'auth') {
        if (stmts.length) await env.DB.batch(stmts);
        await markLastfmInvalid(env, userId, now);
        return;
      }
      // Cross-check is best effort (e.g. private profile); the send below still works.
      log('lastfm_crosscheck_failed', { user: userId, code: e instanceof LastfmError ? e.code : -1 });
    }
  }

  if (toSend.length > 0) {
    const items: ScrobbleItem[] = toSend.map((r) => ({
      artist: r.artist,
      track: r.track,
      album: r.album ?? undefined,
      albumArtist: r.album_artist ?? undefined,
      durationS: r.duration_s ?? undefined,
      timestamp: r.ts,
    }));
    try {
      const results = await client.scrobble(sk, items);
      results.forEach((res, i) => {
        const r = toSend[i]!;
        stmts.push(
          res.accepted
            ? upd(r.id, 'sent', null, r.attempts + 1, 0)
            : upd(
                r.id,
                'ignored',
                `Last.fm ignored it (code ${res.ignoredCode}${res.ignoredMessage ? `: ${res.ignoredMessage}` : ''})`,
                r.attempts + 1,
                0,
              ),
        );
      });
      log('scrobbled', {
        user: userId,
        sent: results.filter((r) => r.accepted).length,
        ignored: results.filter((r) => !r.accepted).length,
      });
    } catch (e) {
      const err = e instanceof LastfmError ? e : new LastfmError(0, 'unknown', 'retry');
      log('scrobble_failed', { user: userId, code: err.code, kind: err.kind });
      if (err.kind === 'auth') {
        if (stmts.length) await env.DB.batch(stmts);
        await markLastfmInvalid(env, userId, now);
        return;
      }
      for (const r of toSend) {
        const attempts = r.attempts + 1;
        if (err.kind !== 'retry' && attempts >= MAX_ATTEMPTS)
          stmts.push(upd(r.id, 'failed', `Last.fm error ${err.code}: ${err.message}`, attempts, 0));
        else
          stmts.push(
            upd(
              r.id,
              'pending',
              `retrying after Last.fm error ${err.code}`,
              attempts,
              now + backoffMs(attempts - 1),
            ),
          );
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/** Cron entry point. */
export async function runScheduled(env: Env, deps: Deps): Promise<void> {
  const cfg = loadConfig(env);
  const now = deps.now();

  const { results: due } = await env.DB.prepare(
    `SELECT id FROM users WHERE paused = 0 AND apple_status = 'ok' AND lastfm_status = 'ok'
       AND next_poll_at <= ? AND lease_until < ? ORDER BY next_poll_at LIMIT ?`,
  )
    .bind(now, now, cfg.pollBatchSize)
    .all<{ id: string }>();

  await inBatches(
    due.map((u) => u.id),
    4,
    async (id) => {
      try {
        await pollUser(env, deps, cfg, id);
      } catch (e) {
        log('poll_error', { user: id, error: e instanceof Error ? e.name : 'unknown' });
        await env.DB.prepare('UPDATE users SET lease_until = 0 WHERE id = ?').bind(id).run();
      }
    },
  );

  const { results: pending } = await env.DB.prepare(
    `SELECT DISTINCT s.user_id AS id FROM scrobbles s JOIN users u ON u.id = s.user_id
     WHERE s.status = 'pending' AND s.next_attempt_at <= ? AND u.lastfm_status = 'ok' AND u.paused = 0 LIMIT ?`,
  )
    .bind(deps.now(), cfg.pollBatchSize)
    .all<{ id: string }>();
  await inBatches(
    pending.map((u) => u.id),
    4,
    async (id) => {
      try {
        await flushUser(env, deps, cfg, id);
      } catch (e) {
        log('flush_error', { user: id, error: e instanceof Error ? e.name : 'unknown' });
      }
    },
  );

  // Housekeeping: rolling retention, expired sessions and auth states, old rate-limit windows.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scrobbles WHERE created_at < ?').bind(now - RETENTION_MS),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM auth_states WHERE created_at < ?').bind(now - 15 * 60_000),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 3600_000),
  ]);
}

async function inBatches<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}
