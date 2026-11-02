/** One entry of Apple's recently-played list, normalised. */
export interface Track {
  /** `${type}:${id}`: identity of the entry inside the recently-played list. */
  key: string;
  name: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  durationMs?: number;
}

/** A play we've decided to scrobble, with an estimated start time. */
export interface PlannedScrobble {
  track: Track;
  /** Estimated play start, unix ms. Always approximate: Apple gives no play timestamps. */
  startMs: number;
  /** Rough +/- error bound on startMs, ms (≈ the poll gap at detection). */
  uncertaintyMs: number;
}

export interface SkippedPlay {
  track: Track;
  reason: 'short_play' | 'track_under_30s';
}

export type DetectionMode = 'start' | 'end';

export interface TrackerConfig {
  /** Does a play show up in the API when it starts (`start`) or after it ends (`end`)? */
  mode: DetectionMode;
  /** Typical delay between the event (start or end) and the play appearing in the API, ms. */
  lagMs: number;
  /** Polls that disagree with the previous snapshot this many times in a row get accepted as a new baseline. */
  anomalyRebaselineAfter: number;
  /** A response identical to a snapshot seen this recently (but not the latest) is treated as a stale replica. */
  staleWindowMs: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  mode: 'start',
  lagMs: 20_000,
  anomalyRebaselineAfter: 3,
  staleWindowMs: 3 * 60_000,
};

/** Last.fm: tracks must be longer than 30 s to be scrobbled. */
export const MIN_TRACK_MS = 30_000;

/** Last.fm: scrobble after half the track or 4 minutes, whichever comes first. */
export function scrobbleThresholdMs(durationMs: number | undefined): number {
  if (!durationMs || durationMs <= 0) return MIN_TRACK_MS;
  return Math.min(durationMs / 2, 240_000);
}
