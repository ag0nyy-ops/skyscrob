import { DEFAULT_TRACKER_CONFIG, type DetectionMode, type TrackerConfig } from './core/types';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  // Secrets (wrangler secret put ...)
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  /** Contents of the MusicKit .p8 file (PEM, PKCS#8). */
  APPLE_PRIVATE_KEY: string;
  LASTFM_API_KEY: string;
  LASTFM_API_SECRET: string;
  /** base64 of 32 random bytes. Encrypts tokens at rest. */
  ENCRYPTION_KEY: string;

  // Plain vars (wrangler.toml [vars])
  /** Comma-separated Last.fm usernames allowed to sign in, or "*" for anyone (hosted mode). */
  ALLOWED_LASTFM_USERS?: string;
  /** "start" or "end"; see docs/feasibility.md. */
  DETECTION_MODE?: string;
  DETECTION_LAG_SECONDS?: string;
  /** Users polled per cron run. Keep small on the Workers free plan (50 subrequests). */
  POLL_BATCH_SIZE?: string;
  /** Ask Apple for album relationships (album artist). Only if the spike showed it works. */
  APPLE_INCLUDE_ALBUMS?: string;

  // Overridable for tests / local mocks.
  APPLE_API_BASE?: string;
  LASTFM_API_BASE?: string;
  LASTFM_AUTH_URL?: string;
}

export interface Config {
  allowedUsers: '*' | Set<string>;
  tracker: TrackerConfig;
  pollBatchSize: number;
  includeAlbums: boolean;
  appleApiBase: string;
  lastfmApiBase: string;
  lastfmAuthUrl: string;
}

export function loadConfig(env: Env): Config {
  const allowed = (env.ALLOWED_LASTFM_USERS ?? '').trim();
  const mode: DetectionMode = env.DETECTION_MODE === 'end' ? 'end' : 'start';
  const lag = Number(env.DETECTION_LAG_SECONDS);
  const batch = Number(env.POLL_BATCH_SIZE);
  return {
    allowedUsers:
      allowed === '*'
        ? '*'
        : new Set(
            allowed
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
          ),
    tracker: {
      ...DEFAULT_TRACKER_CONFIG,
      mode,
      lagMs: Number.isFinite(lag) && lag >= 0 ? lag * 1000 : DEFAULT_TRACKER_CONFIG.lagMs,
    },
    pollBatchSize: Number.isInteger(batch) && batch > 0 ? Math.min(batch, 200) : 8,
    includeAlbums: env.APPLE_INCLUDE_ALBUMS === 'true',
    appleApiBase: env.APPLE_API_BASE || 'https://api.music.apple.com',
    lastfmApiBase: env.LASTFM_API_BASE || 'https://ws.audioscrobbler.com/2.0/',
    lastfmAuthUrl: env.LASTFM_AUTH_URL || 'https://www.last.fm/api/auth/',
  };
}

export function isAllowed(cfg: Config, lastfmUser: string): boolean {
  return cfg.allowedUsers === '*' || cfg.allowedUsers.has(lastfmUser.toLowerCase());
}

/** Injected so tests can control time and the network. */
export interface Deps {
  fetch: typeof fetch;
  now: () => number;
}

export const realDeps: Deps = { fetch: (...a) => fetch(...a), now: () => Date.now() };
