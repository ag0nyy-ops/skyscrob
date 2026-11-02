import { b64urlEncode } from '../crypto';

/**
 * Apple Music developer token: an ES256 JWT signed with the MusicKit .p8 key.
 * https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens
 * WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
 */

const TTL_SECONDS = 12 * 3600;
const REFRESH_BEFORE_SECONDS = 3600;

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function signingKey(pem: string): Promise<CryptoKey> {
  let k = keyCache.get(pem);
  if (!k) {
    k = crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
    ]);
    keyCache.set(pem, k);
  }
  return k;
}

export interface DevTokenOptions {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  /** Restrict a browser-facing token to these origins (Apple's recommended `origin` claim). */
  origin?: string[];
  nowMs: number;
  ttlSeconds?: number;
}

export async function mintDeveloperToken(o: DevTokenOptions): Promise<string> {
  const iat = Math.floor(o.nowMs / 1000);
  const header = { alg: 'ES256', kid: o.keyId, typ: 'JWT' };
  const payload: Record<string, unknown> = { iss: o.teamId, iat, exp: iat + (o.ttlSeconds ?? TTL_SECONDS) };
  if (o.origin) payload.origin = o.origin;
  const enc = (v: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  const input = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await signingKey(o.privateKeyPem),
    new TextEncoder().encode(input),
  );
  return `${input}.${b64urlEncode(sig)}`;
}

const cache = new Map<string, { token: string; exp: number }>();

/** Cached per isolate; re-minted an hour before expiry. */
export async function cachedDeveloperToken(o: Omit<DevTokenOptions, 'ttlSeconds'>): Promise<string> {
  // Keyed on the PEM too, so rotating the .p8 under the same key id takes effect immediately.
  const k = `${o.teamId}|${o.keyId}|${o.origin?.join(',') ?? ''}|${o.privateKeyPem}`;
  const hit = cache.get(k);
  const nowS = Math.floor(o.nowMs / 1000);
  if (hit && hit.exp - nowS > REFRESH_BEFORE_SECONDS) return hit.token;
  const token = await mintDeveloperToken(o);
  cache.set(k, { token, exp: nowS + TTL_SECONDS });
  return token;
}
