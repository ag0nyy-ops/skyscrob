import type { Track } from '../core/types';

export type AppleResult =
  | { ok: true; tracks: Track[] }
  | {
      ok: false;
      /** user_auth: Music User Token expired/revoked (403). dev_auth: our developer token (401). */
      kind: 'user_auth' | 'dev_auth' | 'rate_limited' | 'transient';
      status: number;
      retryAfterS?: number;
    };

interface AppleResource {
  id?: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
  };
  relationships?: { albums?: { data?: { attributes?: { artistName?: string } }[] } };
}

export function parseTracks(body: unknown): Track[] {
  const data = (body as { data?: AppleResource[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: Track[] = [];
  for (const d of data) {
    const a = d.attributes;
    if (!d.id || !d.type || !a?.name || !a.artistName) continue;
    if (d.type !== 'songs' && d.type !== 'library-songs') continue; // no videos, no podcasts
    out.push({
      key: `${d.type}:${d.id}`,
      name: a.name,
      artist: a.artistName,
      album: a.albumName || undefined,
      albumArtist: d.relationships?.albums?.data?.[0]?.attributes?.artistName || undefined,
      durationMs: typeof a.durationInMillis === 'number' ? a.durationInMillis : undefined,
    });
  }
  return out;
}

export async function fetchRecentTracks(opts: {
  fetch: typeof fetch;
  base: string;
  developerToken: string;
  musicUserToken: string;
  includeAlbums?: boolean;
}): Promise<AppleResult> {
  const url = new URL(`${opts.base.replace(/\/+$/, '')}/v1/me/recent/played/tracks`);
  url.searchParams.set('types', 'songs,library-songs');
  url.searchParams.set('limit', '30');
  if (opts.includeAlbums) url.searchParams.set('include', 'albums');
  let res: Response;
  try {
    res = await opts.fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${opts.developerToken}`,
        'Music-User-Token': opts.musicUserToken,
      },
    });
  } catch {
    return { ok: false, kind: 'transient', status: 0 };
  }
  if (res.status === 200) {
    const body = await res.json().catch(() => null);
    if (body === null) return { ok: false, kind: 'transient', status: 200 };
    return { ok: true, tracks: parseTracks(body) };
  }
  await res.body?.cancel();
  if (res.status === 401) return { ok: false, kind: 'dev_auth', status: 401 };
  if (res.status === 403) return { ok: false, kind: 'user_auth', status: 403 };
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    return {
      ok: false,
      kind: 'rate_limited',
      status: 429,
      retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : undefined,
    };
  }
  return { ok: false, kind: 'transient', status: res.status };
}
