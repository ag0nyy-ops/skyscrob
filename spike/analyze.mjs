// Phase 0 spike, step 3: turn a poll log into a readable timeline.
//
//   node spike/analyze.mjs spike/logs/poll-....jsonl
//   node spike/analyze.mjs spike/logs/poll-....jsonl --fixture test/fixtures/spike-session-1.json
//
// The timeline shows each marker you typed and each change in the recently-played list,
// with seconds elapsed since the previous marker, so "how long after I pressed play did it
// show up" can be read straight off. --fixture writes a trimmed recording (no headers, no
// artwork) that the unit tests can replay. It still contains what you listened to, so only
// commit it if you're fine with that.
import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: node spike/analyze.mjs <log.jsonl> [--fixture out.json]');
  process.exit(1);
}
const fixtureOut = rest[rest.indexOf('--fixture') + 1];
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const t0 = Date.parse(lines[0].t);
const rel = (t) => `${((Date.parse(t) - t0) / 1000).toFixed(0).padStart(6)}s`;
let lastMarker = null;
let prevIds = null;
const statuses = {};
const rateHeaders = new Set();
const fixture = [];

for (const e of lines) {
  if (e.headers) for (const k of Object.keys(e.headers)) if (/rate|retry|limit/i.test(k)) rateHeaders.add(k);
  if (e.kind === 'probe') {
    console.log(`${rel(e.t)}  probe ${e.path} -> ${e.status}, ${e.body?.data?.length ?? 0} items`);
    continue;
  }
  if (e.kind === 'marker') {
    lastMarker = e;
    console.log(`${rel(e.t)}  >>> MARKER: ${e.note}`);
    continue;
  }
  if (e.kind !== 'poll') continue;
  statuses[e.status] = (statuses[e.status] || 0) + 1;
  if (e.status !== 200) {
    console.log(`${rel(e.t)}  HTTP ${e.status}`);
    fixture.push({ t: e.t, status: e.status });
    continue;
  }
  const ids = e.items.map((i) => `${i.type}:${i.id}`);
  fixture.push({ t: e.t, status: 200, items: e.items });
  if (prevIds && ids.join() !== prevIds.join()) {
    // Which items are at the head now that weren't there (or were further down) before?
    const moved = [];
    for (let k = 0; k < ids.length; k++) {
      const prevPos = prevIds.indexOf(ids[k]);
      if (prevPos === k - moved.length) break;
      moved.push({ ...e.items[k], prevPos });
    }
    const since = lastMarker ? ` (+${((Date.parse(e.t) - Date.parse(lastMarker.t)) / 1000).toFixed(0)}s after "${lastMarker.note}")` : '';
    console.log(`${rel(e.t)}  CHANGE${since}: ${ids.length} items`);
    for (const m of moved)
      console.log(`            new@head: ${m.artist} – ${m.name} [${m.type}, ${Math.round((m.durMs ?? 0) / 1000)}s] ${m.prevPos >= 0 ? `(was at #${m.prevPos})` : '(not in previous list)'}`);
    const removed = prevIds.filter((id) => !ids.includes(id));
    if (removed.length) console.log(`            fell off the end: ${removed.length}`);
  }
  prevIds = ids;
}

console.log('\nHTTP statuses:', statuses);
console.log('Rate-limit-ish headers seen:', [...rateHeaders].join(', ') || 'none');
const dupes = lines.filter((e) => e.kind === 'poll' && e.items).some((e) => new Set(e.items.map((i) => i.id)).size !== e.items.length);
console.log('Any duplicate track ids inside a single response:', dupes);

if (fixtureOut && rest.includes('--fixture')) {
  writeFileSync(fixtureOut, JSON.stringify(fixture, null, 1));
  console.log(`Fixture written: ${fixtureOut} (${fixture.length} polls)`);
}
