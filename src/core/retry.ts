/** Exponential backoff with +/-20% jitter. attempt 0 -> ~1 min, capped at 6 h. */
export function backoffMs(
  attempt: number,
  rand: () => number = Math.random,
  baseMs = 60_000,
  capMs = 6 * 3600_000,
): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (0.8 + 0.4 * rand()));
}

/** Last.fm ignores scrobbles older than two weeks; we stop trying a bit before that. */
export const MAX_SCROBBLE_AGE_S = 14 * 86400 - 3600;

/** After this many failed attempts a non-temporary error marks the scrobble failed. */
export const MAX_ATTEMPTS = 12;
