import type { ScrobbleMetadata } from '../core/metadata';
import { apiSig } from './sign';

/**
 * Last.fm API error codes (https://www.last.fm/api/errorcodes) grouped by what we do next.
 * auth:   the user's session is gone; they need to sign in again
 * retry:  temporary; back off and try again
 * config: our API key/secret is wrong; nothing a retry fixes
 * fatal:  this request is bad; don't retry it as-is
 */
export type LastfmErrorKind = 'auth' | 'retry' | 'config' | 'fatal';

export class LastfmError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly kind: LastfmErrorKind,
  ) {
    super(message);
    this.name = 'LastfmError';
  }
}

export function classify(code: number): LastfmErrorKind {
  if ([4, 9, 14, 15, 17].includes(code)) return 'auth';
  if ([8, 11, 16, 29].includes(code) || code >= 500 || code === 0) return 'retry';
  if ([10, 13, 26].includes(code)) return 'config';
  return 'fatal';
}

export interface ScrobbleItem extends ScrobbleMetadata {
  /** unix seconds, play start */
  timestamp: number;
}

export interface ScrobbleItemResult {
  accepted: boolean;
  ignoredCode: number;
  ignoredMessage?: string;
}

export interface RecentTrack {
  artist: string;
  track: string;
  /** unix seconds; absent for the "now playing" entry */
  uts?: number;
}

export class LastfmClient {
  constructor(
    private readonly o: {
      apiKey: string;
      secret: string;
      base: string;
      authUrl: string;
      fetch: typeof fetch;
    },
  ) {}

  authUrl(callback: string): string {
    const u = new URL(this.o.authUrl);
    u.searchParams.set('api_key', this.o.apiKey);
    u.searchParams.set('cb', callback);
    return u.toString();
  }

  private async call(
    params: Record<string, string>,
    opts: { signed: boolean; post: boolean },
  ): Promise<unknown> {
    const p: Record<string, string> = { ...params, api_key: this.o.apiKey };
    if (opts.signed) p.api_sig = apiSig(p, this.o.secret);
    p.format = 'json';
    const body = new URLSearchParams(p);
    let res: Response;
    try {
      res = opts.post
        ? await this.o.fetch(this.o.base, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'skyscrob/0.1' },
            body,
          })
        : await this.o.fetch(`${this.o.base}?${body}`, { headers: { 'user-agent': 'skyscrob/0.1' } });
    } catch (e) {
      throw new LastfmError(0, `network: ${e instanceof Error ? e.message : 'error'}`, 'retry');
    }
    const json = (await res.json().catch(() => null)) as { error?: number; message?: string } | null;
    if (json && typeof json.error === 'number') {
      throw new LastfmError(json.error, json.message ?? 'error', classify(json.error));
    }
    if (!res.ok || json === null) {
      throw new LastfmError(
        res.status,
        `HTTP ${res.status}`,
        res.status >= 500 || res.status === 429 ? 'retry' : 'fatal',
      );
    }
    return json;
  }

  async getSession(token: string): Promise<{ name: string; key: string }> {
    const r = (await this.call({ method: 'auth.getSession', token }, { signed: true, post: false })) as {
      session?: { name?: string; key?: string };
    };
    if (!r.session?.name || !r.session.key) throw new LastfmError(0, 'malformed session response', 'fatal');
    return { name: r.session.name, key: r.session.key };
  }

  async updateNowPlaying(sk: string, m: ScrobbleMetadata): Promise<void> {
    const p: Record<string, string> = {
      method: 'track.updateNowPlaying',
      sk,
      artist: m.artist,
      track: m.track,
    };
    if (m.album) p.album = m.album;
    if (m.albumArtist) p.albumArtist = m.albumArtist;
    if (m.durationS) p.duration = String(m.durationS);
    await this.call(p, { signed: true, post: true });
  }

  /** Up to 50 per call. Results come back in submission order. */
  async scrobble(sk: string, items: ScrobbleItem[]): Promise<ScrobbleItemResult[]> {
    if (items.length === 0) return [];
    if (items.length > 50) throw new Error('max 50 scrobbles per batch');
    const p: Record<string, string> = { method: 'track.scrobble', sk };
    items.forEach((m, i) => {
      p[`artist[${i}]`] = m.artist;
      p[`track[${i}]`] = m.track;
      p[`timestamp[${i}]`] = String(m.timestamp);
      if (m.album) p[`album[${i}]`] = m.album;
      if (m.albumArtist) p[`albumArtist[${i}]`] = m.albumArtist;
      if (m.durationS) p[`duration[${i}]`] = String(m.durationS);
    });
    const r = (await this.call(p, { signed: true, post: true })) as {
      scrobbles?: { scrobble?: unknown };
    };
    const raw = r.scrobbles?.scrobble;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as {
      ignoredMessage?: { code?: string | number; '#text'?: string };
    }[];
    if (list.length !== items.length) throw new LastfmError(0, 'scrobble response length mismatch', 'retry');
    return list.map((s) => {
      const code = Number(s.ignoredMessage?.code ?? 0);
      return {
        accepted: code === 0,
        ignoredCode: code,
        ignoredMessage: s.ignoredMessage?.['#text'] || undefined,
      };
    });
  }

  async getRecentTracks(user: string, fromS: number, toS: number): Promise<RecentTrack[]> {
    const r = (await this.call(
      { method: 'user.getRecentTracks', user, from: String(fromS), to: String(toS), limit: '200' },
      { signed: false, post: false },
    )) as { recenttracks?: { track?: unknown } };
    const raw = r.recenttracks?.track;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as {
      artist?: { '#text'?: string; name?: string };
      name?: string;
      date?: { uts?: string };
    }[];
    return list
      .map((t) => ({
        artist: t.artist?.['#text'] ?? t.artist?.name ?? '',
        track: t.name ?? '',
        uts: t.date?.uts ? Number(t.date.uts) : undefined,
      }))
      .filter((t) => t.artist && t.track);
  }
}
