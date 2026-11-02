// Shared helpers for the Phase 0 spike. Throwaway code: zero dependencies, Node >= 20.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const SECRETS_PATH = join(SPIKE_DIR, '.secrets.json');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Mint an Apple Music developer token (ES256 JWT) from a MusicKit .p8 key. */
export function mintDeveloperToken({ teamId, keyId, p8Path, ttlSeconds = 60 * 60 * 24 * 7 }) {
  const key = createPrivateKey(readFileSync(p8Path, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now, exp: now + ttlSeconds }));
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

export function loadSecrets() {
  if (!existsSync(SECRETS_PATH)) {
    console.error('No spike/.secrets.json yet. Run `node spike/token-server.mjs` first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'));
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. See spike/README.md.`);
    process.exit(1);
  }
  return v;
}
