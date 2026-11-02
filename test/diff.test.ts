import { describe, expect, it } from 'vitest';
import { diffSnapshots, snapshotSig } from '../src/core/diff';

const k = (s: string) => s.split(' ').filter(Boolean);
const full = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('diffSnapshots', () => {
  it('first poll is a baseline', () => {
    expect(diffSnapshots(null, k('A B C'))).toEqual({ kind: 'baseline' });
  });

  it('identical lists are unchanged', () => {
    expect(diffSnapshots(k('A B C'), k('A B C'))).toEqual({ kind: 'unchanged' });
  });

  it('one new song on top', () => {
    expect(diffSnapshots(k('A B C'), k('D A B'))).toEqual({ kind: 'new', count: 1, overflow: false });
  });

  it('several new songs on top', () => {
    expect(diffSnapshots(k('A B C'), k('F E D A'))).toEqual({ kind: 'new', count: 3, overflow: false });
  });

  it('replay of an older song moves it to the top (distinct-list semantics)', () => {
    expect(diffSnapshots(k('A B C D'), k('C A B D'))).toEqual({ kind: 'new', count: 1, overflow: false });
  });

  it('replay of an older song plus a new song', () => {
    expect(diffSnapshots(k('A B C D'), k('E C A B'))).toEqual({ kind: 'new', count: 2, overflow: false });
  });

  it('replay as a duplicate entry (play-log semantics)', () => {
    expect(diffSnapshots(k('A B C'), k('A A B C'))).toEqual({ kind: 'new', count: 1, overflow: false });
    expect(diffSnapshots(k('A B C'), k('C A B C'))).toEqual({ kind: 'new', count: 1, overflow: false });
  });

  it('full 30-item lists: oldest falls off the end', () => {
    const prev = full('x', 30);
    const next = ['new1', ...prev.slice(0, 29)];
    expect(diffSnapshots(prev, next)).toEqual({ kind: 'new', count: 1, overflow: false });
  });

  it('list grows at the tail when the history was short (no new plays)', () => {
    expect(diffSnapshots(k('A B'), k('A B C'))).toEqual({ kind: 'unchanged' });
  });

  it('list shrinks at the tail (no new plays)', () => {
    expect(diffSnapshots(k('A B C'), k('A B'))).toEqual({ kind: 'unchanged' });
  });

  it('first ever play into an empty history', () => {
    expect(diffSnapshots([], k('A'))).toEqual({ kind: 'new', count: 1, overflow: false });
  });

  it('empty response after a non-empty one is a hiccup, not "everything vanished"', () => {
    expect(diffSnapshots(k('A B'), [])).toEqual({ kind: 'empty' });
    expect(diffSnapshots([], [])).toEqual({ kind: 'unchanged' });
  });

  it('no overlap at all = more plays than fit in one page (overflow)', () => {
    expect(diffSnapshots(full('old', 30), full('new', 30))).toEqual({
      kind: 'new',
      count: 30,
      overflow: true,
    });
  });

  it('an item disappearing from the middle is an anomaly, not new plays', () => {
    expect(diffSnapshots(k('A B C D'), k('A C D'))).toEqual({ kind: 'anomaly' });
  });

  it('a reordering is read as the smallest run of replays that explains it', () => {
    // D, A, B replayed (in that order) leaves C at the bottom.
    expect(diffSnapshots(k('A B C D'), k('B A D C'))).toEqual({ kind: 'new', count: 3, overflow: false });
    // X played, then A replayed.
    expect(diffSnapshots(k('A B C'), k('A X B C'))).toEqual({ kind: 'new', count: 2, overflow: false });
  });

  it('an item vanishing from below the new ones is an anomaly', () => {
    expect(diffSnapshots(k('A B C D'), k('X A C D'))).toEqual({ kind: 'anomaly' });
  });

  it('never reports the whole list as new while it still overlaps the old one', () => {
    // N = [D E B]: B is old but sits under two new ones in a way that doesn't line up.
    expect(diffSnapshots(k('A B C'), k('D E B'))).toEqual({ kind: 'anomaly' });
  });
});

describe('snapshotSig', () => {
  it('is stable and order sensitive', () => {
    expect(snapshotSig(k('A B'))).toBe(snapshotSig(k('A B')));
    expect(snapshotSig(k('A B'))).not.toBe(snapshotSig(k('B A')));
  });
});
