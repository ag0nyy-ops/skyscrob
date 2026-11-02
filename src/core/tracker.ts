/**
 * Per-user scrobble state machine. Pure: (state, snapshot, now) -> (new state, actions).
 *
 * Apple gives us no play timestamps, so every start time here is an estimate built from
 * when we noticed the change, how long the previous poll was ago, and track durations.
 * Invariants we keep (and test):
 *   - every planned scrobble's startMs is <= now (never in the future)
 *   - planned scrobbles are emitted oldest first with strictly increasing startMs, and
 *     never start before `cursorMs` (the end of the last play we've accounted for), so they
 *     don't overlap earlier ones, across polls and restarts
 *   - a play is planned at most once (the head is flagged `scrobbled`, older plays are only
 *     ever seen once because the snapshot advances atomically with the plan)
 */
import { diffSnapshots, snapshotSig } from './diff';
import {
  MIN_TRACK_MS,
  scrobbleThresholdMs,
  type PlannedScrobble,
  type SkippedPlay,
  type Track,
  type TrackerConfig,
} from './types';

export interface HeadState {
  track: Track;
  startMs: number;
  uncertaintyMs: number;
  /** Was this already at the top when we started watching? Then we never scrobble it. */
  baseline: boolean;
  /** Already planned for scrobbling (or deliberately not scrobbled). */
  done: boolean;
}

export interface TrackerState {
  v: 1;
  snapshot: string[] | null;
  /** start mode only: the track we believe is currently playing (top of the list). */
  head: HeadState | null;
  lastPollMs: number | null;
  /** No newly detected play may start before this (unix ms). */
  cursorMs: number;
  recentSigs: { sig: string; atMs: number }[];
  anomaly: { sig: string; count: number } | null;
  lastChangeMs: number | null;
}

export type StepEvent =
  'baseline' | 'unchanged' | 'new' | 'overflow' | 'empty' | 'stale' | 'anomaly' | 'rebaseline';

export interface StepResult {
  state: TrackerState;
  scrobbles: PlannedScrobble[];
  skipped: SkippedPlay[];
  /** start mode: a new track just appeared on top; worth a Last.fm now-playing update. */
  nowPlaying: Track | null;
  event: StepEvent;
}

const MAX_SIGS = 6;
const DEFAULT_GAP_MS = 60_000;
/**
 * Listening time is only known to within about one poll gap. When deciding whether a play
 * passed Last.fm's threshold we give it half a gap of benefit of the doubt: Apple put it in
 * the history, so the user probably did listen.
 */
const BENEFIT_OF_DOUBT = 0.5;

export function initialTrackerState(): TrackerState {
  return {
    v: 1,
    snapshot: null,
    head: null,
    lastPollMs: null,
    cursorMs: 0,
    recentSigs: [],
    anomaly: null,
    lastChangeMs: null,
  };
}

const dur = (t: Track) => (t.durationMs && t.durationMs > 0 ? t.durationMs : MIN_TRACK_MS);
const tooShort = (t: Track) => t.durationMs !== undefined && t.durationMs > 0 && t.durationMs < MIN_TRACK_MS;

function pushSig(s: TrackerState, sig: string, now: number) {
  if (s.recentSigs.at(-1)?.sig === sig) return;
  s.recentSigs.push({ sig, atMs: now });
  if (s.recentSigs.length > MAX_SIGS) s.recentSigs.splice(0, s.recentSigs.length - MAX_SIGS);
}

/** start mode: scrobble the held head once it's been on top long enough. */
function maybeCompleteHead(s: TrackerState, now: number): PlannedScrobble | null {
  const h = s.head;
  if (!h || h.done || h.baseline) return null;
  const thr = scrobbleThresholdMs(h.track.durationMs);
  if (now - h.startMs < thr) return null;
  h.done = true;
  s.cursorMs = Math.max(s.cursorMs, h.startMs + thr);
  return { track: h.track, startMs: h.startMs, uncertaintyMs: h.uncertaintyMs };
}

function baselineFrom(s: TrackerState, tracks: Track[], keys: string[], now: number, cfg: TrackerConfig) {
  s.snapshot = keys;
  s.lastPollMs = now;
  s.cursorMs = Math.max(s.cursorMs, now - cfg.lagMs);
  const top = tracks[0];
  s.head =
    cfg.mode === 'start' && top
      ? { track: top, startMs: now, uncertaintyMs: 0, baseline: true, done: true }
      : null;
  s.anomaly = null;
}

/**
 * Spread `count` start times (newest first) so the newest is `newest`, each older one
 * starts a full track-length before the next, and nothing starts before `lower`. If they
 * don't fit, squeeze them evenly into [lower, newest].
 */
function layoutStarts(plays: Track[], newest: number, lower: number): number[] {
  const starts = [newest];
  for (let i = 1; i < plays.length; i++) starts.push(starts[i - 1]! - dur(plays[i]!));
  if (plays.length > 1 && starts.at(-1)! < lower) {
    const stepMs = Math.max(0, newest - lower) / (plays.length - 1);
    for (let i = 1; i < plays.length; i++) starts[i] = Math.round(newest - i * stepMs);
  }
  return starts;
}

export function step(prev: TrackerState, tracks: Track[], now: number, cfg: TrackerConfig): StepResult {
  const s: TrackerState = structuredClone(prev);
  const keys = tracks.map((t) => t.key);
  const sig = snapshotSig(keys);
  const out: StepResult = { state: s, scrobbles: [], skipped: [], nowPlaying: null, event: 'unchanged' };

  if (s.snapshot === null) {
    baselineFrom(s, tracks, keys, now, cfg);
    pushSig(s, sig, now);
    out.event = 'baseline';
    return out;
  }

  // A response identical to an older snapshot we saw moments ago (but not the latest one)
  // smells like a stale replica answering. Ignore it; the fresh answer will come back.
  const latest = s.recentSigs.at(-1);
  if (latest?.sig !== sig && s.recentSigs.some((r) => r.sig === sig && now - r.atMs <= cfg.staleWindowMs)) {
    out.event = 'stale';
    return out;
  }

  const d = diffSnapshots(s.snapshot, keys);

  if (d.kind === 'empty') {
    out.event = 'empty';
    return out;
  }

  if (d.kind === 'anomaly') {
    s.anomaly = s.anomaly?.sig === sig ? { sig, count: s.anomaly.count + 1 } : { sig, count: 1 };
    if (s.anomaly.count < cfg.anomalyRebaselineAfter) {
      out.event = 'anomaly';
      return out;
    }
    // It's been stable for a while; accept it as the new truth without scrobbling anything.
    const held = maybeCompleteHead(s, now);
    if (held) out.scrobbles.push(held);
    baselineFrom(s, tracks, keys, now, cfg);
    pushSig(s, sig, now);
    s.lastChangeMs = now;
    out.event = 'rebaseline';
    return out;
  }

  s.anomaly = null;

  if (d.kind === 'unchanged' || d.kind === 'baseline') {
    s.snapshot = keys;
    s.lastPollMs = now;
    pushSig(s, sig, now);
    if (cfg.mode === 'start') {
      const held = maybeCompleteHead(s, now);
      if (held) out.scrobbles.push(held);
    }
    out.event = 'unchanged';
    return out;
  }

  // d.kind === 'new'
  const plays = tracks.slice(0, d.count); // newest first
  const lastPoll = s.lastPollMs ?? now - DEFAULT_GAP_MS;
  const gap = Math.max(0, now - lastPoll);
  const hi = now - cfg.lagMs;
  const mid = lastPoll + gap / 2 - cfg.lagMs;
  const head = s.head;

  if (cfg.mode === 'start') {
    // None of these were visible at the last poll, so they started after lastPoll - lag,
    // after the end of everything already accounted for, and after the held head started.
    let lower = Math.max(s.cursorMs, lastPoll - cfg.lagMs);
    if (head && !head.baseline) lower = Math.max(lower, head.startMs + 1000);
    lower = Math.min(lower, hi);

    const olderSum = plays.slice(1).reduce((a, t) => a + dur(t), 0);
    const newest = Math.min(hi, Math.max(mid, lower + olderSum, lower));
    const starts = layoutStarts(plays, newest, lower);

    // The previously playing track got displaced when the oldest new play started.
    if (head && !head.done && !head.baseline) {
      head.done = true;
      const listened = starts.at(-1)! - head.startMs;
      if (listened + gap * BENEFIT_OF_DOUBT >= scrobbleThresholdMs(head.track.durationMs)) {
        out.scrobbles.push({ track: head.track, startMs: head.startMs, uncertaintyMs: head.uncertaintyMs });
      } else {
        out.skipped.push({ track: head.track, reason: 'short_play' });
      }
    }

    // Plays that came and went entirely between two polls (oldest first).
    for (let i = plays.length - 1; i >= 1; i--) {
      const t = plays[i]!;
      if (tooShort(t)) {
        out.skipped.push({ track: t, reason: 'track_under_30s' });
        continue;
      }
      const listened = starts[i - 1]! - starts[i]!;
      if (listened + gap * BENEFIT_OF_DOUBT >= scrobbleThresholdMs(t.durationMs)) {
        out.scrobbles.push({ track: t, startMs: starts[i]!, uncertaintyMs: gap });
      } else {
        out.skipped.push({ track: t, reason: 'short_play' });
      }
    }

    const top = plays[0]!;
    s.cursorMs = Math.max(s.cursorMs, newest + 1000);
    if (tooShort(top)) {
      out.skipped.push({ track: top, reason: 'track_under_30s' });
      s.head = { track: top, startMs: newest, uncertaintyMs: gap, baseline: false, done: true };
    } else {
      s.head = { track: top, startMs: newest, uncertaintyMs: gap, baseline: false, done: false };
      out.nowPlaying = top;
      // After a long idle gap the newest play may already be past its threshold.
      const held = maybeCompleteHead(s, now);
      if (held) out.scrobbles.push(held);
    }
  } else {
    // end mode: plays show up once finished. Newest ended around `mid`.
    const oldest = plays.at(-1)!;
    const lower = Math.min(Math.max(s.cursorMs, lastPoll - cfg.lagMs - dur(oldest)), hi);
    const totalSum = plays.reduce((a, t) => a + dur(t), 0);
    const newestEnd = Math.min(hi, Math.max(mid, lower + totalSum));
    const newestStart = Math.max(lower, newestEnd - dur(plays[0]!));
    const starts = layoutStarts(plays, newestStart, lower);
    for (let i = plays.length - 1; i >= 0; i--) {
      const t = plays[i]!;
      if (tooShort(t)) out.skipped.push({ track: t, reason: 'track_under_30s' });
      else out.scrobbles.push({ track: t, startMs: starts[i]!, uncertaintyMs: gap });
    }
    s.cursorMs = Math.max(s.cursorMs, newestEnd);
    s.head = null;
  }

  // Final guard on the invariants: never in the future, strictly increasing, not before
  // anything we've already emitted in this step.
  let floor = -Infinity;
  for (const p of out.scrobbles) {
    p.startMs = Math.min(Math.round(p.startMs), now);
    if (p.startMs <= floor) p.startMs = Math.min(floor + 1000, now);
    floor = p.startMs;
  }

  s.snapshot = keys;
  s.lastPollMs = now;
  s.lastChangeMs = now;
  pushSig(s, sig, now);
  out.event = d.overflow ? 'overflow' : 'new';
  return out;
}
