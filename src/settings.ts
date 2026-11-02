import { DEFAULT_METADATA_OPTIONS, type MetadataOptions } from './core/metadata';

export interface UserSettings extends MetadataOptions {
  /** Send Last.fm "now playing" updates (start mode only). */
  nowPlaying: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = { ...DEFAULT_METADATA_OPTIONS, nowPlaying: true };

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof UserSettings)[];

/** Parse stored or submitted settings. Unknown keys dropped, non-booleans rejected. */
export function parseSettings(raw: unknown, base: UserSettings = DEFAULT_SETTINGS): UserSettings | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ...base };
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: UserSettings = { ...base };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYS.includes(k as keyof UserSettings)) continue;
    if (typeof v !== 'boolean') return null;
    out[k as keyof UserSettings] = v;
  }
  return out;
}
