-- skyscrob schema. Times are unix milliseconds unless the column says _s (seconds).
-- Stores the minimum: encrypted tokens, settings, scrobble-engine state, and a rolling
-- 14-day window of scrobbles (for dedupe and the dashboard). No long-term history.

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  lastfm_user        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  lastfm_sk          TEXT,                         -- AES-GCM encrypted session key
  lastfm_status      TEXT NOT NULL DEFAULT 'ok',   -- ok | invalid
  apple_mut          TEXT,                         -- AES-GCM encrypted Music User Token
  apple_status       TEXT NOT NULL DEFAULT 'none', -- none | ok | reauth
  apple_connected_at INTEGER,
  paused             INTEGER NOT NULL DEFAULT 0,
  settings           TEXT NOT NULL DEFAULT '{}',
  tracker            TEXT,                         -- JSON TrackerState
  state_version      INTEGER NOT NULL DEFAULT 0,
  next_poll_at       INTEGER NOT NULL DEFAULT 0,
  lease_until        INTEGER NOT NULL DEFAULT 0,
  last_poll_at       INTEGER,
  last_poll_result   TEXT,
  last_error         TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX users_due ON users (next_poll_at);

CREATE TABLE scrobbles (
  id               TEXT PRIMARY KEY,          -- hash(user, track, estimated start): idempotent inserts
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  artist           TEXT NOT NULL,
  track            TEXT NOT NULL,
  album            TEXT,
  album_artist     TEXT,
  duration_s       INTEGER,
  ts               INTEGER NOT NULL,          -- unix SECONDS, estimated play start
  ts_approx        INTEGER NOT NULL DEFAULT 1,
  ts_uncertainty_s INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,             -- pending | sent | ignored | duplicate | skipped | dropped | failed
  reason           TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX scrobbles_pending ON scrobbles (status, next_attempt_at);
CREATE INDEX scrobbles_user_ts ON scrobbles (user_id, ts);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,               -- sha256 of the cookie value; the cookie itself is never stored
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE auth_states (
  state      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
