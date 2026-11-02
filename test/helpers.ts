import type { Track } from '../src/core/types';

/** Synthetic library: song "A" is 200 s, "B" 180 s, etc. Override per test as needed. */
export function tr(id: string, durationS = 200, extra: Partial<Track> = {}): Track {
  return {
    key: `songs:${id}`,
    name: `Song ${id}`,
    artist: `Artist ${id}`,
    album: `Album ${id}`,
    durationMs: durationS * 1000,
    ...extra,
  };
}

/** Build a recently-played list (newest first) from ids like 'C B A'. */
export function list(ids: string, durations: Record<string, number> = {}): Track[] {
  return ids
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => tr(id, durations[id] ?? 200));
}

export const T0 = Date.UTC(2026, 10, 2, 20, 0, 0);
export const min = (m: number) => T0 + m * 60_000;
export const sec = (s: number) => T0 + s * 1000;
