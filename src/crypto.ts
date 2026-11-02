/** Small WebCrypto helpers. Works in Workers and Node 20+. */

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64Decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** AES-256-GCM key from the ENCRYPTION_KEY secret (base64, 32 bytes). */
export async function aesKey(secretB64: string): Promise<CryptoKey> {
  let k = keyCache.get(secretB64);
  if (!k) {
    const raw = b64Decode(secretB64);
    if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be base64 of exactly 32 bytes');
    k = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(secretB64, k);
  }
  return k;
}

/**
 * Encrypt a secret value. `aad` binds the ciphertext to where it's stored (user id + field),
 * so a ciphertext copied into another row or column fails to decrypt.
 */
export async function encrypt(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function decrypt(key: CryptoKey, blob: string, aad: string): Promise<string> {
  const [v, ivS, ctS] = blob.split('.');
  if (v !== 'v1' || !ivS || !ctS) throw new Error('unknown ciphertext format');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(ivS), additionalData: new TextEncoder().encode(aad) },
    key,
    b64urlDecode(ctS),
  );
  return new TextDecoder().decode(pt);
}

/** Constant-time string compare for CSRF tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
