import { looseKey } from './metadata';

export interface PendingLike {
  id: string;
  artist: string;
  track: string;
  /** unix seconds */
  ts: number;
  uncertaintyS: number;
}

export interface Played {
  artist: string;
  track: string;
  uts: number;
}

/** Extra slack on top of our own timestamp uncertainty when matching against Last.fm. */
const MATCH_SLACK_S = 300;
/** Our own sent scrobbles come back from Last.fm with the exact timestamp we sent. */
const OWN_MATCH_S = 30;

/**
 * Which pending scrobbles are already on Last.fm? Covers two cases:
 *  - the user runs another scrobbler too (e.g. on their Mac), which got the play first
 *  - we crashed after Last.fm accepted a batch but before we recorded it as sent
 *
 * Each Last.fm entry can explain at most one of our plays. Entries that are our own earlier
 * sent scrobbles are consumed first, so a genuine replay of a song we just scrobbled isn't
 * mistaken for a duplicate of it.
 */
export function findAlreadyScrobbled(
  pending: PendingLike[],
  ourSent: Played[],
  lastfm: Played[],
): Set<string> {
  const entries = lastfm.map((e) => ({ ...e, key: looseKey(e.artist, e.track), used: false }));

  const consume = (key: string, ts: number, within: number) => {
    let best: (typeof entries)[number] | null = null;
    for (const e of entries) {
      if (e.used || e.key !== key) continue;
      const d = Math.abs(e.uts - ts);
      if (d <= within && (!best || d < Math.abs(best.uts - ts))) best = e;
    }
    if (best) best.used = true;
    return best !== null;
  };

  for (const s of ourSent) consume(looseKey(s.artist, s.track), s.uts, OWN_MATCH_S);

  const dupes = new Set<string>();
  for (const p of [...pending].sort((a, b) => a.ts - b.ts)) {
    if (consume(looseKey(p.artist, p.track), p.ts, p.uncertaintyS + MATCH_SLACK_S)) dupes.add(p.id);
  }
  return dupes;
}
