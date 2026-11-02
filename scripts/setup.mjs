#!/usr/bin/env node
// One-shot self-host setup: creates the D1 database, applies migrations, deploys the Worker
// and stores your secrets in Cloudflare. Safe to re-run (it won't rotate your encryption key
// unless you ask, because that would make stored tokens unreadable).
//
//   npm run setup
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
const yes = async (q, def = false) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
const wrangler = (args, opts = {}) =>
  spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    input: opts.input,
  });
const die = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

console.log(
  '\nskyscrob setup. You need: Apple Team ID, MusicKit Key ID + .p8 file, Last.fm API key + secret.\n',
);

// 1. Cloudflare login
let who = wrangler(['whoami']);
if (/not authenticated|You are not logged in/i.test(who.stdout + who.stderr)) {
  console.log('Logging in to Cloudflare (a browser window will open)…');
  wrangler(['login'], { inherit: true });
  who = wrangler(['whoami']);
}
if (who.status !== 0) die('wrangler whoami failed:\n' + who.stderr);
console.log('✓ Cloudflare login OK');

// 2. Answers
const toml = readFileSync('wrangler.toml', 'utf8');
const firstRun = /database_id = "0{8}-/.test(toml);
const users = await ask('Your Last.fm username (only this account can use your instance; "*" = anyone)');
if (!users) die('A Last.fm username is required (or "*" for hosted mode).');
let secrets = {};
if (firstRun || (await yes('Update Apple / Last.fm secrets?'))) {
  const teamId = await ask('Apple Team ID (10 chars, developer.apple.com → Membership)');
  const keyId = await ask('MusicKit Key ID (10 chars)');
  const p8 = (await ask('Path to AuthKey_XXXXXXXXXX.p8')).replace(/^~/, process.env.HOME ?? '');
  if (!existsSync(p8)) die(`No file at ${p8}`);
  const pem = readFileSync(p8, 'utf8');
  if (!pem.includes('PRIVATE KEY')) die('That file does not look like a .p8 private key.');
  const lfmKey = await ask('Last.fm API key');
  const lfmSecret = await ask('Last.fm shared secret');
  if (![teamId, keyId, lfmKey, lfmSecret].every(Boolean)) die('All values are required.');
  secrets = {
    APPLE_TEAM_ID: teamId,
    APPLE_KEY_ID: keyId,
    APPLE_PRIVATE_KEY: pem,
    LASTFM_API_KEY: lfmKey,
    LASTFM_API_SECRET: lfmSecret,
  };
}
if (firstRun || (await yes('Generate a NEW encryption key? (Everyone will have to reconnect.)'))) {
  secrets.ENCRYPTION_KEY = randomBytes(32).toString('base64');
}
rl.close();

// 3. D1 database
let dbId = toml.match(/database_id = "([^"]+)"/)?.[1];
if (firstRun) {
  console.log('Creating D1 database "skyscrob"…');
  const c = wrangler(['d1', 'create', 'skyscrob']);
  dbId = (c.stdout + c.stderr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  if (!dbId) {
    const list = wrangler(['d1', 'list', '--json']);
    dbId = JSON.parse(list.stdout || '[]').find((d) => d.name === 'skyscrob')?.uuid;
  }
  if (!dbId) die('Could not create or find the D1 database:\n' + c.stderr);
}
writeFileSync(
  'wrangler.toml',
  toml
    .replace(/database_id = "[^"]+"/, `database_id = "${dbId}"`)
    .replace(/ALLOWED_LASTFM_USERS = "[^"]*"/, `ALLOWED_LASTFM_USERS = "${users}"`),
);
console.log(`✓ D1 database ${dbId}`);

const mig = wrangler(['d1', 'migrations', 'apply', 'skyscrob', '--remote'], { input: 'y\n' });
if (mig.status !== 0) die('Migrations failed:\n' + mig.stderr);
console.log('✓ Database schema applied');

// 4. Deploy, then secrets (the Worker must exist first)
const dep = wrangler(['deploy']);
if (dep.status !== 0) die('Deploy failed:\n' + dep.stderr + dep.stdout);
const url = (dep.stdout + dep.stderr).match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
console.log(`✓ Deployed${url ? ` to ${url}` : ''}`);

if (Object.keys(secrets).length) {
  const dir = mkdtempSync(join(tmpdir(), 'skyscrob-'));
  const f = join(dir, 'secrets.json');
  try {
    writeFileSync(f, JSON.stringify(secrets), { mode: 0o600 });
    const s = wrangler(['secret', 'bulk', f]);
    if (s.status !== 0) die('Storing secrets failed:\n' + s.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`✓ Stored secrets: ${Object.keys(secrets).join(', ')}`);
}

console.log(`
Done. Next:
  1. Open ${url ?? 'your workers.dev URL'} and "Sign in with Last.fm".
  2. Click "Connect Apple Music" and approve.
  3. Play a song on any device. It shows up within a couple of minutes.
`);
