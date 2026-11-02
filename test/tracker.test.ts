import { afterAll, describe, expect, it } from 'vitest';
import { initialTrackerState, step, type StepResult, type TrackerState } from '../src/core/tracker';
import { DEFAULT_TRACKER_CONFIG, type TrackerConfig, type Track } from '../src/core/types';
import { list, min, sec, T0, tr } from './helpers';

const START: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG, mode: 'start', lagMs: 20_000 };
const END: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG, mode: 'end', lagMs: 20_000 };

/** Drive the tracker like the poller does, round-tripping state through JSON like D1 does. */
class Driver {
  state: TrackerState = initialTrackerState();
  results: StepResult[] = [];
  constructor(private cfg: TrackerConfig) {}
  poll(at: number, tracks: Track[]): StepResult {
    const r = step(this.state, tracks, at, this.cfg);
    this.state = JSON.parse(JSON.stringify(r.state));
    this.results.push(r);
    return r;
  }
  get scrobbles() {
    return this.results.flatMap((r) => r.scrobbles);
  }
  names() {
    return this.scrobbles.map((s) => s.track.name.replace('Song ', ''));
  }
}

describe('tracker, start mode', () => {
  it('first poll only records a baseline, never scrobbles history', () => {
    const d = new Driver(START);
    const r = d.poll(min(0), list('A B C D'));
    expect(r.event).toBe('baseline');
    expect(r.scrobbles).toEqual([]);
    expect(r.nowPlaying).toBeNull();
    // ...and the song that was on top when we connected isn't scrobbled later either.
    d.poll(min(5), list('A B C D'));
    expect(d.scrobbles).toEqual([]);
  });

  it('a fully played song: now playing on detection, scrobbled once past half its length', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    const r1 = d.poll(min(1), list('B A'));
    expect(r1.nowPlaying?.key).toBe('songs:B');
    expect(r1.scrobbles).toEqual([]);
    const r2 = d.poll(min(2), list('B A'));
    expect(r2.scrobbles).toHaveLength(1);
    const s = r2.scrobbles[0]!;
    expect(s.track.key).toBe('songs:B');
    // Appeared between 0:00 and 1:00 with a 20 s lag => estimated start 0:10.
    expect(s.startMs).toBe(sec(10));
    // Not scrobbled again on later polls.
    d.poll(min(3), list('B A'));
    d.poll(min(4), list('C B A'));
    expect(d.names()).toEqual(['B']);
  });

  it('a song skipped after a few seconds is not scrobbled', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A'));
    const r = d.poll(min(2), list('C B A'));
    expect(r.scrobbles).toEqual([]);
    expect(r.skipped.map((x) => [x.track.key, x.reason])).toEqual([['songs:B', 'short_play']]);
  });

  it('a long song is scrobbled at 4 minutes, while still playing, with its own start time', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A', { B: 600 })); // 10-minute track, threshold 4 min
    expect(d.poll(min(4), list('B A', { B: 600 })).scrobbles).toEqual([]); // 3:50 in
    const r = d.poll(min(5), list('B A', { B: 600 })); // 4:50 in
    expect(r.scrobbles.map((s) => [s.track.key, s.startMs])).toEqual([['songs:B', sec(10)]]);
    d.poll(min(6), list('C B A', { B: 600 }));
    expect(d.names()).toEqual(['B']);
  });

  it('a song displaced after its threshold but before the next poll noticed is still scrobbled', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A', { B: 150 })); // threshold 75 s, start est. 0:10
    const r = d.poll(min(2), list('C B A', { B: 150 })); // C appeared in (1:00, 2:00]
    expect(r.scrobbles.map((s) => [s.track.key, s.startMs])).toEqual([['songs:B', sec(10)]]);
  });

  it('several plays between two polls get distinct, increasing, non-future timestamps', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    const r = d.poll(min(10), list('D C B A'));
    expect(r.event).toBe('new');
    expect(r.scrobbles.map((s) => s.track.key)).toEqual(['songs:B', 'songs:C', 'songs:D']);
    const starts = r.scrobbles.map((s) => s.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(3);
    for (const s of starts) expect(s).toBeLessThanOrEqual(min(10));
    // B and C each get a full track's room (200 s) before the next one.
    expect(starts[1]! - starts[0]!).toBe(200_000);
    expect(starts[2]! - starts[1]!).toBe(200_000);
  });

  it('squeezes timestamps when more songs were detected than fit the gap', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    const r = d.poll(min(2), list('F E D C B A'));
    // 4 songs that came and went inside ~2 minutes can't have passed half their length.
    expect(r.scrobbles).toEqual([]);
    expect(r.skipped.map((s) => s.track.key)).toEqual(['songs:B', 'songs:C', 'songs:D', 'songs:E']);
    // F is now playing, started as late as possible but not in the future.
    expect(d.state.head?.track.key).toBe('songs:F');
    expect(d.state.head!.startMs).toBe(min(2) - 20_000);
  });

  it('replaying an older song from the list counts as a new play', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A B C'));
    d.poll(min(1), list('C A B'));
    d.poll(min(3), list('C A B'));
    expect(d.names()).toEqual(['C']);
  });

  it('back-to-back repeats of the same song are invisible (documented limitation)', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A'));
    // B plays three times in a row; the list never changes.
    for (let m = 2; m <= 12; m++) d.poll(min(m), list('B A'));
    expect(d.names()).toEqual(['B']);
  });

  it('tracks shorter than 30 s are never scrobbled', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    const r = d.poll(min(1), list('X A', { X: 20 }));
    expect(r.nowPlaying).toBeNull();
    expect(r.skipped.map((s) => s.reason)).toEqual(['track_under_30s']);
    d.poll(min(5), list('X A', { X: 20 }));
    expect(d.scrobbles).toEqual([]);
  });

  it('ignores a stale replica flip-flopping back to an older list', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A B C'));
    d.poll(min(1), list('D A B C'));
    expect(d.poll(min(2), list('A B C')).event).toBe('stale');
    expect(d.poll(min(3), list('D A B C')).event).toBe('unchanged');
    d.poll(min(4), list('E D A B'));
    expect(d.names()).toEqual(['D']);
  });

  it('an empty response is a hiccup: nothing scrobbled, nothing forgotten', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A B'));
    expect(d.poll(min(1), []).event).toBe('empty');
    d.poll(min(2), list('C A B'));
    d.poll(min(3), list('C A B'));
    d.poll(min(4), list('D C A B'));
    expect(d.names()).toEqual(['C']);
  });

  it('anomalies are never scrobbled; a stable anomaly becomes the new baseline', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A B C D'));
    expect(d.poll(min(1), list('A C D')).event).toBe('anomaly');
    expect(d.poll(min(2), list('A C D')).event).toBe('anomaly');
    expect(d.poll(min(3), list('A C D')).event).toBe('rebaseline');
    expect(d.poll(min(4), list('E A C D')).event).toBe('new');
    d.poll(min(8), list('E A C D'));
    expect(d.names()).toEqual(['E']);
  });

  it('identical polls (duplicate cron runs) never double-scrobble', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A'));
    d.poll(min(3), list('B A'));
    d.poll(min(3), list('B A'));
    d.poll(min(3) + 1, list('B A'));
    expect(d.names()).toEqual(['B']);
  });

  it('survives a restart mid-song (state round-trips through JSON)', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A'));
    const saved = JSON.stringify(d.state);
    const d2 = new Driver(START);
    d2.state = JSON.parse(saved);
    d2.poll(min(4), list('B A'));
    expect(d2.names()).toEqual(['B']);
  });

  it('long idle then a burst of listening (overflow: zero overlap with the old list)', () => {
    const d = new Driver(START);
    const old = Array.from({ length: 30 }, (_, i) => tr(`old${i}`));
    d.poll(min(0), old);
    const fresh = Array.from({ length: 30 }, (_, i) => tr(`new${i}`));
    const r = d.poll(min(24 * 60), fresh);
    expect(r.event).toBe('overflow');
    expect(r.scrobbles.length).toBe(30);
    const starts = r.scrobbles.map((s) => s.startMs);
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    expect(starts.at(-1)!).toBeLessThanOrEqual(min(24 * 60));
  });

  it('new plays never start before the previous play started', () => {
    const d = new Driver(START);
    d.poll(min(0), list('A'));
    d.poll(min(1), list('B A'));
    const r = d.poll(min(1) + 5000, list('C B A'));
    const b = d.state.head;
    expect(b?.track.key).toBe('songs:C');
    expect(b!.startMs).toBeGreaterThan(sec(10));
    expect(r.scrobbles).toEqual([]);
  });
});

describe('tracker, end mode', () => {
  it('scrobbles on detection with start = detection - lag - duration', () => {
    const d = new Driver(END);
    d.poll(min(0), list('A'));
    const r = d.poll(min(1), list('B A'));
    expect(r.nowPlaying).toBeNull();
    expect(r.scrobbles).toHaveLength(1);
    // ended around 0:10 (midpoint minus lag); started 200 s before, but not before cursor
    expect(r.scrobbles[0]!.startMs).toBeLessThan(sec(10));
    expect(r.scrobbles[0]!.startMs).toBeGreaterThanOrEqual(T0 - 20_000 - 200_000);
  });

  it('chains several plays backwards without overlap', () => {
    const d = new Driver(END);
    d.poll(min(0), list('A'));
    const r = d.poll(min(15), list('D C B A'));
    const starts = r.scrobbles.map((s) => s.startMs);
    expect(r.scrobbles.map((s) => s.track.key)).toEqual(['songs:B', 'songs:C', 'songs:D']);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(200_000);
  });
});

/**
 * Simulated listener vs. a simulated Apple list. Checks the invariants over thousands of
 * random plays: never in the future, strictly increasing, every scrobble is a real play,
 * no play scrobbled twice, timestamps close to the truth, decent recall.
 */
describe('tracker, simulated listening sessions', () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }

  const agg = { eligible: 0, hit: 0, skips: 0, skipFP: 0, errors: [] as number[] };
  afterAll(() => {
    agg.errors.sort((a, b) => a - b);
    const p = (q: number) => Math.round(agg.errors[Math.floor(agg.errors.length * q)]! / 1000);
    // Printed so docs/feasibility.md can quote real numbers for the simulated model.
    console.log(
      `simulation: recall=${(agg.hit / agg.eligible).toFixed(3)} skipFalsePositive=${(agg.skipFP / agg.skips).toFixed(3)} ` +
        `(${agg.skipFP}/${agg.skips}) startError p50=${p(0.5)}s p90=${p(0.9)}s p99=${p(0.99)}s`,
    );
    expect(agg.hit / agg.eligible).toBeGreaterThan(0.95);
    // Known limitation of 1-minute polling: a quick skip that straddles a poll boundary looks
    // like ~1 minute of listening, which passes the threshold for short songs.
    expect(agg.skipFP / agg.skips).toBeLessThan(0.5);
  });

  for (const seed of Array.from({ length: 25 }, (_, i) => i + 1)) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const pool = Array.from({ length: 60 }, (_, i) => tr(`p${i}`, 120 + Math.floor(rand() * 240)));
      // True plays.
      const plays: { track: Track; start: number; listened: number; repeat: boolean }[] = [];
      let t = T0 + 5 * 60_000;
      let prev: Track | null = null;
      while (t < T0 + 8 * 3600_000) {
        if (rand() < 0.03) t += Math.floor(rand() * 90 * 60_000); // idle stretch
        const repeat = prev !== null && rand() < 0.05;
        const track: Track = repeat ? prev! : pool[Math.floor(rand() * pool.length)]!;
        const r = rand();
        const full = track.durationMs!;
        const listened =
          r < 0.7 ? full : r < 0.85 ? 5000 + Math.floor(rand() * 20_000) : Math.floor(rand() * full);
        plays.push({ track, start: t, listened, repeat: repeat && prev?.key === track.key });
        t += listened + 1000;
        prev = track;
      }
      const LAG = 20_000;
      const appleList = (at: number): Track[] => {
        const seen = new Map<string, Track>();
        for (let i = plays.length - 1; i >= 0 && seen.size < 30; i--) {
          const p = plays[i]!;
          if (p.start + LAG <= at && !seen.has(p.track.key)) seen.set(p.track.key, p.track);
        }
        return [...seen.values()];
      };

      const d = new Driver({ ...START, lagMs: LAG });
      let now = T0;
      const emittedAt: number[] = [];
      while (now < t + 3600_000) {
        const r = d.poll(now, appleList(now));
        for (const s of r.scrobbles) {
          expect(s.startMs).toBeLessThanOrEqual(now);
          emittedAt.push(now);
        }
        const idle = d.state.lastChangeMs !== null && now - d.state.lastChangeMs > 30 * 60_000;
        now += idle ? 10 * 60_000 : 60_000 + Math.floor(rand() * 5000);
      }

      const sc = d.scrobbles;
      for (let i = 1; i < sc.length; i++) expect(sc[i]!.startMs).toBeGreaterThan(sc[i - 1]!.startMs);

      // Greedy match each scrobble to the closest unused true play of the same track.
      const used = new Set<number>();
      const errors: number[] = [];
      for (const s of sc) {
        let best = -1;
        for (let i = 0; i < plays.length; i++) {
          if (used.has(i) || plays[i]!.track.key !== s.track.key) continue;
          if (best < 0 || Math.abs(plays[i]!.start - s.startMs) < Math.abs(plays[best]!.start - s.startMs))
            best = i;
        }
        expect(best, `scrobble of ${s.track.key} matches no real play`).toBeGreaterThanOrEqual(0);
        used.add(best);
        errors.push(Math.abs(plays[best]!.start - s.startMs));
      }
      agg.errors.push(...errors);

      const eligible = plays
        .map((p, i) => ({ p, i }))
        .filter(
          ({ p }) =>
            !p.repeat && p.listened >= Math.min(p.track.durationMs! / 2, 240_000) && p.start > T0 + 60_000,
        );
      const hit = eligible.filter(({ i }) => used.has(i)).length;
      expect(hit / eligible.length).toBeGreaterThan(0.85);
      agg.eligible += eligible.length;
      agg.hit += hit;

      const skips = plays.map((p, i) => ({ p, i })).filter(({ p }) => p.listened < 25_000 && !p.repeat);
      const falsePos = skips.filter(({ i }) => used.has(i)).length;
      agg.skips += skips.length;
      agg.skipFP += falsePos;
    });
  }
});
