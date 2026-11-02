// Phase 0 spike, step 2: poll /v1/me/recent/played/tracks and log everything with timestamps.
//
//   node spike/poll.mjs                 # poll every 15s until Ctrl+C
//   node spike/poll.mjs --interval 10   # custom interval (seconds)
//   node spike/poll.mjs --burst 120     # rate-limit probe: 120 back-to-back requests, then exit
//
// While it runs, type a note and press Enter to drop a timestamped marker into the log,
// e.g. "play Song A on iPhone" the moment you press play. Markers are how we measure delay.
//
// Output: spike/logs/poll-<timestamp>.jsonl (gitignored). Tokens are never written to the log.
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadSecrets, SPIKE_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const INTERVAL_S = Number(arg('interval', 15));
const BURST = Number(arg('burst', 0));
const API = 'https://api.music.apple.com';
const TYPES = 'songs,library-songs,music-videos,library-music-videos';

const { developerToken, musicUserToken } = loadSecrets();
mkdirSync(join(SPIKE_DIR, 'logs'), { recursive: true });
const logPath = join(SPIKE_DIR, 'logs', `poll-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const log = (obj) => appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');

async function get(path) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${developerToken}`, 'Music-User-Token': musicUserToken },
    });
  } catch (e) {
    return { path, status: 0, error: String(e), ms: Date.now() - started };
  }
  const headers = {};
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v;
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 500) };
  }
  return { path, status: res.status, ms: Date.now() - started, headers, body };
}

const compact = (body) =>
  (body?.data ?? []).map((d) => ({
    id: d.id,
    type: d.type,
    name: d.attributes?.name,
    artist: d.attributes?.artistName,
    album: d.attributes?.albumName,
    durMs: d.attributes?.durationInMillis,
    catalogId: d.attributes?.playParams?.catalogId,
    kind: d.attributes?.playParams?.kind,
  }));

if (BURST > 0) {
  console.log(`Burst: ${BURST} sequential requests…`);
  const counts = {};
  for (let i = 0; i < BURST; i++) {
    const r = await get(`/v1/me/recent/played/tracks?types=${TYPES}&limit=1`);
    counts[r.status] = (counts[r.status] || 0) + 1;
    log({ kind: 'burst', i, status: r.status, ms: r.ms, headers: r.headers, errors: r.body?.errors });
    if (r.status === 429)
      console.log(`429 after ${i + 1} requests, retry-after=${r.headers?.['retry-after']}`);
  }
  console.log('Status counts:', counts, `\nLog: ${logPath}`);
  process.exit(0);
}

// One-time probes: field inventory, include=albums, history depth, recent resources.
for (const path of [
  `/v1/me/recent/played/tracks?types=${TYPES}&limit=30&include=albums`,
  `/v1/me/recent/played/tracks?types=${TYPES}&limit=30&offset=30`,
  `/v1/me/recent/played/tracks?types=${TYPES}&limit=30&offset=60`,
  `/v1/me/recent/played?limit=10`,
  `/v1/me/recent/radio-stations?limit=10`,
]) {
  const r = await get(path);
  log({ kind: 'probe', ...r });
  console.log(`probe ${path} -> ${r.status} (${r.body?.data?.length ?? 0} items)`);
}

console.log(`Polling every ${INTERVAL_S}s. Type a note + Enter to add a marker. Log: ${logPath}`);
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  log({ kind: 'marker', note: line.trim() });
  console.log(`  [marker] ${new Date().toLocaleTimeString()} ${line.trim()}`);
});

let prev = null;
let n = 0;
async function tick() {
  n++;
  const r = await get(`/v1/me/recent/played/tracks?types=${TYPES}&limit=30`);
  const items = r.status === 200 ? compact(r.body) : null;
  const sig = items ? items.map((i) => `${i.type}:${i.id}`).join(',') : null;
  const changed = sig !== null && sig !== prev;
  // Full raw body on first poll and every change (that's where the field inventory lives).
  log({
    kind: 'poll',
    n,
    status: r.status,
    ms: r.ms,
    headers: r.headers,
    changed,
    items,
    raw: changed || n === 1 ? r.body : undefined,
    errors: r.status === 200 ? undefined : r.body,
  });
  const ts = new Date().toLocaleTimeString();
  if (r.status !== 200)
    console.log(`${ts} HTTP ${r.status} ${JSON.stringify(r.body?.errors ?? r.error ?? '')}`);
  else if (changed) {
    const top = items
      .slice(0, 3)
      .map((i) => `${i.artist} – ${i.name}`)
      .join(' | ');
    console.log(`${ts} CHANGED (${items.length} items) head: ${top}`);
  }
  if (sig !== null) prev = sig;
}
await tick();
setInterval(tick, INTERVAL_S * 1000);
