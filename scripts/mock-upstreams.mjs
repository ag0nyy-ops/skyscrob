// Local stand-ins for the Apple Music API and Last.fm, for trying skyscrob without real
// accounts (and for smoke-testing the Worker in workerd). Not used in production.
//
//   node scripts/mock-upstreams.mjs            # listens on :8799
//   then run wrangler dev with: --var APPLE_API_BASE:http://localhost:8799/apple
//     --var LASTFM_API_BASE:http://localhost:8799/lastfm/2.0/ --var LASTFM_AUTH_URL:http://localhost:8799/lastfm/auth/
//
// Control endpoints:
//   POST /control/apple-list   body: ["Artist - Song", ...]  newest first (sets everyone's list)
//   GET  /control/state        everything Last.fm "received"
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8799);
// Song length for every mock track. Short songs make demos quick (threshold = half the song).
const DURATION_MS = Number(process.env.MOCK_DURATION_S || 180) * 1000;
let list = [];
const state = { scrobbles: [], nowPlaying: [], sessions: {} };

const songs = () =>
  list.map((s, i) => {
    const [artist, name] = s.includes(' - ') ? s.split(' - ') : ['Mock Artist', s];
    const id = String(1000 + [...s].reduce((a, c) => a + c.charCodeAt(0), i * 0));
    return {
      id,
      type: 'songs',
      attributes: { name, artistName: artist, albumName: name, durationInMillis: DURATION_MS },
    };
  });

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = '';
  for await (const c of req) raw += c;

  if (url.pathname === '/control/apple-list' && req.method === 'POST') {
    list = JSON.parse(raw);
    return send(res, 200, { ok: true, list });
  }
  if (url.pathname === '/control/state') return send(res, 200, { list, ...state });

  if (url.pathname === '/apple/v1/me/recent/played/tracks') {
    if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')) return send(res, 401, {});
    if (!req.headers['music-user-token']) return send(res, 403, {});
    return send(res, 200, { data: songs() });
  }

  if (url.pathname === '/lastfm/auth/') {
    // Pretend the user approved: bounce straight back with a token.
    const cb = new URL(url.searchParams.get('cb'));
    cb.searchParams.set('token', 'mocktoken' + Date.now());
    res.writeHead(302, { location: cb.toString() });
    return res.end();
  }

  if (url.pathname === '/lastfm/2.0/') {
    const p = req.method === 'POST' ? new URLSearchParams(raw) : url.searchParams;
    const m = p.get('method');
    if (m === 'auth.getSession') {
      state.sessions['sk-mockuser'] = 'mockuser';
      return send(res, 200, { session: { name: 'mockuser', key: 'sk-mockuser' } });
    }
    if (m === 'user.getRecentTracks') {
      return send(res, 200, {
        recenttracks: {
          track: state.scrobbles.map((s) => ({
            artist: { '#text': s.artist },
            name: s.track,
            date: { uts: String(s.timestamp) },
          })),
        },
      });
    }
    if (p.get('sk') !== 'sk-mockuser') return send(res, 200, { error: 9, message: 'Invalid session key' });
    if (m === 'track.updateNowPlaying') {
      state.nowPlaying.push({ artist: p.get('artist'), track: p.get('track'), at: new Date().toISOString() });
      return send(res, 200, { nowplaying: {} });
    }
    if (m === 'track.scrobble') {
      const out = [];
      for (let i = 0; p.has(`artist[${i}]`); i++) {
        const s = {
          artist: p.get(`artist[${i}]`),
          track: p.get(`track[${i}]`),
          album: p.get(`album[${i}]`),
          timestamp: Number(p.get(`timestamp[${i}]`)),
        };
        state.scrobbles.push(s);
        out.push({ ignoredMessage: { code: '0' } });
      }
      console.log(
        `[lastfm] scrobbled ${out.length}:`,
        state.scrobbles
          .slice(-out.length)
          .map((s) => `${s.artist} - ${s.track}`)
          .join(', '),
      );
      return send(res, 200, { scrobbles: { scrobble: out } });
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`mock Apple Music + Last.fm on http://localhost:${PORT}`));
