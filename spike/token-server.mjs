// Phase 0 spike, step 1: get a Music User Token for your own Apple Music account.
//
//   APPLE_TEAM_ID=XXXXXXXXXX APPLE_KEY_ID=YYYYYYYYYY APPLE_P8=~/keys/AuthKey_YYYYYYYYYY.p8 \
//     node spike/token-server.mjs
//
// Then open http://localhost:8790, click "Authorize", sign in to Apple Music.
// The tokens are written to spike/.secrets.json (gitignored) and never printed.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { mintDeveloperToken, requireEnv, SECRETS_PATH } from './lib.mjs';

const PORT = Number(process.env.PORT || 8790);
const developerToken = mintDeveloperToken({
  teamId: requireEnv('APPLE_TEAM_ID'),
  keyId: requireEnv('APPLE_KEY_ID'),
  p8Path: requireEnv('APPLE_P8').replace(/^~/, process.env.HOME),
});

const page = `<!doctype html><meta charset="utf-8"><title>skyscrob spike: authorize</title>
<style>body{font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}button{font-size:1.1rem;padding:.6rem 1.2rem}</style>
<h1>skyscrob spike</h1>
<p>Click to authorize this local script to read your Apple Music recently played tracks.</p>
<button id="go" disabled>Loading MusicKit…</button>
<p id="out"></p>
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
<script>
document.addEventListener('musickitloaded', async () => {
  const mk = await MusicKit.configure({
    developerToken: ${JSON.stringify(developerToken)},
    app: { name: 'skyscrob spike', build: '0.0.1' },
  });
  const btn = document.getElementById('go');
  btn.disabled = false; btn.textContent = 'Authorize Apple Music';
  btn.onclick = async () => {
    try {
      const musicUserToken = await mk.authorize();
      const r = await fetch('/save', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ musicUserToken }) });
      document.getElementById('out').textContent = r.ok ? 'Saved. You can close this tab and stop the server (Ctrl+C).' : 'Save failed: ' + r.status;
    } catch (e) { document.getElementById('out').textContent = 'Authorize failed: ' + e; }
  };
});
</script>`;

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { musicUserToken } = JSON.parse(body);
        if (typeof musicUserToken !== 'string' || musicUserToken.length < 20) throw new Error('bad token');
        writeFileSync(
          SECRETS_PATH,
          JSON.stringify({ developerToken, musicUserToken, savedAt: new Date().toISOString() }, null, 2),
          { mode: 0o600 },
        );
        console.log(
          `Music User Token saved to ${SECRETS_PATH} (length ${musicUserToken.length}). Next: node spike/poll.mjs`,
        );
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`Open http://localhost:${PORT} and click Authorize.`));
