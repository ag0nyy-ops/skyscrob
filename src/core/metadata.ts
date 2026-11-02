import type { Track } from './types';

export interface MetadataOptions {
  /** "Album - Single" / "Album - EP" -> "Album" */
  stripSingleEp: boolean;
  /** "Song (Remastered 2011)" / "Song - 2009 Remaster" -> "Song" (track and album) */
  stripRemaster: boolean;
  /** Use the album artist as the scrobbled artist when Apple provides one. */
  preferAlbumArtist: boolean;
}

export const DEFAULT_METADATA_OPTIONS: MetadataOptions = {
  stripSingleEp: false,
  stripRemaster: false,
  preferAlbumArtist: false,
};

const SINGLE_EP = /\s+-\s+(Single|EP)$/i;
const REMASTER_PAREN = /\s*[([][^)\]]*\bremaster(ed)?\b[^)\]]*[)\]]/gi;
const REMASTER_DASH = /\s+-\s+[^-]*\bremaster(ed)?\b.*$/i;

export function stripRemaster(s: string): string {
  const out = s.replace(REMASTER_PAREN, '').replace(REMASTER_DASH, '').trim();
  return out || s;
}

export interface ScrobbleMetadata {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  durationS?: number;
}

export function toScrobbleMetadata(t: Track, o: MetadataOptions): ScrobbleMetadata {
  let track = t.name.trim();
  let album = t.album?.trim() || undefined;
  let artist = t.artist.trim();
  const albumArtist = t.albumArtist?.trim() || undefined;
  if (o.stripRemaster) {
    track = stripRemaster(track);
    if (album) album = stripRemaster(album);
  }
  if (o.stripSingleEp && album) album = album.replace(SINGLE_EP, '').trim() || album;
  if (o.preferAlbumArtist && albumArtist) artist = albumArtist;
  return {
    artist,
    track,
    album,
    albumArtist,
    durationS: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
  };
}

/** Loose key for "is this the same song" comparisons against Last.fm history. */
export function looseKey(artist: string, track: string): string {
  const norm = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[([][^)\]]*[)\]]/g, ' ')
      .replace(/\s+-\s+.*$/, '')
      .replace(/\b(feat|ft|featuring)\b.*$/, '')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  // Only the primary artist: "A & B", "A, B", "A x B" all collapse to "a".
  const primary = artist.split(/\s*(?:,|&| x | and |\bfeat\.?|\bft\.?)\s*/i)[0] ?? artist;
  return `${norm(primary)}\u0000${norm(track)}`;
}
