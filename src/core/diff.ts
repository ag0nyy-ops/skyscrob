/**
 * Snapshot diffing for Apple Music's recently-played list.
 *
 * The API returns the most recent ~30 tracks, newest first, with no timestamps. We can only
 * infer plays by comparing consecutive snapshots. The list probably behaves as a "distinct
 * recent tracks" list (replaying a song moves it to the top), but might be a true play log
 * (replays appear as new entries). We accept either explanation:
 *
 *   new list = [new plays...] + (old list, minus the replayed items if distinct semantics)
 *
 * and pick the smallest number of new plays that explains the new list. Anything that can't
 * be explained is an anomaly and is never scrobbled.
 *
 * Note that with distinct-list semantics almost any reordering *can* be explained as a run
 * of replays, so anomalies are rare (an entry vanishing from the middle is the typical one).
 * Implausible bursts of "replays" are mostly harmless anyway: squeezed into one poll gap they
 * fail Last.fm's listening threshold and get dropped as short plays.
 */

export type DiffResult =
  | { kind: 'baseline' }
  | { kind: 'unchanged' }
  | { kind: 'new'; count: number; overflow: boolean }
  | { kind: 'empty' }
  | { kind: 'anomaly' };

/** True if `a` is a prefix of `b`. */
function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `tail` is what's left of the new list after the first k entries; `base` is what we expect
 * it to continue from. Normally tail is a prefix of base (older entries fell off the end).
 * If the old list wasn't full, the new list can be longer, so base being a non-empty prefix
 * of tail is accepted too.
 */
function compatible(
  tail: readonly string[],
  base: readonly string[],
  prevLen: number,
  limit: number,
): boolean {
  if (isPrefix(tail, base)) return true;
  return base.length > 0 && prevLen < limit && isPrefix(base, tail);
}

/**
 * @param prev previous snapshot keys (newest first), or null if we have none yet
 * @param next current snapshot keys (newest first)
 * @param limit page size requested from the API (30)
 */
export function diffSnapshots(
  prev: readonly string[] | null,
  next: readonly string[],
  limit = 30,
): DiffResult {
  if (prev === null) return { kind: 'baseline' };
  if (next.length === 0) return prev.length === 0 ? { kind: 'unchanged' } : { kind: 'empty' };

  for (let k = 0; k < next.length; k++) {
    const head = next.slice(0, k);
    const tail = next.slice(k);
    const headSet = new Set(head);
    // Distinct-list semantics: replayed items were removed from their old position.
    const withoutReplayed = prev.filter((key) => !headSet.has(key));
    // Play-log semantics: old list continues unchanged below the new entries.
    if (
      compatible(tail, withoutReplayed, prev.length, limit) ||
      (k > 0 && compatible(tail, prev, prev.length, limit))
    ) {
      return k === 0 ? { kind: 'unchanged' } : { kind: 'new', count: k, overflow: false };
    }
  }

  // Nothing lines up. If the lists share no entries at all, more plays happened than fit in
  // one page since the last poll: everything is new. Otherwise it's an anomaly.
  const prevSet = new Set(prev);
  if (!next.some((key) => prevSet.has(key)))
    return { kind: 'new', count: next.length, overflow: prev.length > 0 };
  return { kind: 'anomaly' };
}

/** Compact signature of a snapshot, used to spot stale replicas flip-flopping. */
export function snapshotSig(keys: readonly string[]): string {
  // FNV-1a over the joined keys; collisions only cost us a missed/extra stale check.
  let h = 0x811c9dc5;
  const s = keys.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${keys.length}:${h.toString(16)}`;
}
