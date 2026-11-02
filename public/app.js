// skyscrob dashboard. No framework, no tracking. All DOM text goes through textContent.
const app = document.getElementById('app');
let me = null;

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': me?.csrf ?? '' },
          body: JSON.stringify(body),
        };
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

const $ = (root, sel) => root.querySelector(sel);
const slot = (name) => $(app, `[data-slot="${name}"]`);

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleString();
}

const STATUS = {
  sent: 'scrobbled',
  pending: 'waiting',
  skipped: 'skipped',
  duplicate: 'already on Last.fm',
  ignored: 'ignored by Last.fm',
  dropped: 'too old',
  failed: 'failed',
};

function render() {
  if (!me) {
    app.replaceChildren(document.getElementById('signed-out').content.cloneNode(true));
    return;
  }
  if (!slot('rows')) app.replaceChildren(document.getElementById('dashboard').content.cloneNode(true));

  const lfmOk = me.lastfm.status === 'ok';
  slot('lfm-user').textContent = me.lastfm.user;
  slot('lfm-status').textContent = lfmOk ? 'Connected' : 'Session expired';
  slot('lfm-dot').className = `dot ${lfmOk ? 'ok' : 'bad'}`;

  const a = me.apple.status;
  slot('apple-status').textContent =
    a === 'ok' ? 'Connected' : a === 'reauth' ? 'Needs reconnecting' : 'Not connected';
  slot('apple-dot').className = `dot ${a === 'ok' ? 'ok' : a === 'reauth' ? 'bad' : 'off'}`;
  $(app, '[data-action="connect"]').textContent =
    a === 'none' ? 'Connect Apple Music' : 'Reconnect Apple Music';
  $(app, '[data-action="connect"]').hidden = a === 'ok';
  $(app, '[data-action="disconnect"]').hidden = a === 'none';

  slot('poll').textContent = me.paused
    ? 'Paused. Nothing is being checked or sent.'
    : a !== 'ok'
      ? 'Waiting for Apple Music.'
      : `Last checked ${ago(me.lastPollAt)}.`;
  $(app, '[data-action="pause"]').checked = me.paused;

  const banner = slot('banner');
  const problems = [];
  if (!lfmOk)
    problems.push([
      'Your Last.fm session is no longer valid. ',
      'Sign in with Last.fm again',
      '/auth/lastfm/login',
    ]);
  if (a === 'reauth')
    problems.push(['Apple Music access expired or was revoked. Hit "Reconnect Apple Music".']);
  if (a === 'none') problems.push(['Connect Apple Music to start scrobbling.']);
  banner.hidden = problems.length === 0 && !me.lastError;
  banner.replaceChildren(
    ...problems.map(([text, linkText, href]) => {
      const p = document.createElement('p');
      p.textContent = text;
      if (linkText) {
        const l = document.createElement('a');
        l.href = href;
        l.textContent = linkText;
        p.append(l);
      }
      return p;
    }),
  );
  if (me.lastError && problems.length === 0) {
    const p = document.createElement('p');
    p.textContent = me.lastError;
    banner.append(p);
  }

  for (const input of app.querySelectorAll('[data-setting]'))
    input.checked = !!me.settings[input.dataset.setting];
  $(app, '[data-setting="nowPlaying"]').disabled = me.detectionMode !== 'start';

  const rows = me.scrobbles.map((s) => {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    when.textContent = `~${new Date(s.ts * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
    const what = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = s.track;
    what.append(strong, ` — ${s.artist}`);
    const st = document.createElement('td');
    st.textContent = STATUS[s.status] ?? s.status;
    st.className = `status ${s.status}`;
    if (s.reason) st.title = s.reason;
    tr.append(when, what, st);
    return tr;
  });
  slot('rows').replaceChildren(...rows);
  slot('empty').hidden = rows.length > 0;
}

async function refresh() {
  try {
    me = await api('/api/me');
  } catch (e) {
    if (e.status === 401) me = null;
    else return;
  }
  render();
}

function loadMusicKit() {
  if (window.MusicKit) return Promise.resolve();
  return new Promise((resolve, reject) => {
    document.addEventListener('musickitloaded', resolve, { once: true });
    const s = document.createElement('script');
    // Loaded straight from Apple's CDN, as Apple's terms require (never bundled or re-hosted).
    s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    s.async = true;
    s.onerror = () => reject(new Error('Could not load MusicKit from Apple'));
    document.head.append(s);
  });
}

async function connectApple(btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Waiting for Apple…';
  try {
    const { token } = await api('/api/apple/developer-token');
    await loadMusicKit();
    const mk = await MusicKit.configure({ developerToken: token, app: { name: 'skyscrob', build: '0.1.0' } });
    const musicUserToken = await mk.authorize();
    if (!musicUserToken) throw new Error('Apple Music authorization was cancelled');
    await api('/api/apple/connect', { musicUserToken });
    await refresh();
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

app.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn || btn.type === 'checkbox') return;
  const action = btn.dataset.action;
  try {
    if (action === 'connect') return connectApple(btn);
    if (action === 'disconnect') {
      if (!confirm('Stop scrobbling and forget your Apple Music token?')) return;
      await api('/api/apple/disconnect', {});
    }
    if (action === 'logout') {
      await api('/api/logout', {});
      me = null;
      return render();
    }
    if (action === 'delete') {
      if (!confirm('Delete everything skyscrob stores about you? This cannot be undone.')) return;
      await api('/api/delete', {});
      me = null;
      alert('Deleted. You can also revoke access at last.fm/settings/applications.');
      return render();
    }
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

app.addEventListener('change', async (ev) => {
  const el = ev.target;
  try {
    if (el.dataset.action === 'pause') await api('/api/pause', { paused: el.checked });
    else if (el.dataset.setting) await api('/api/settings', { [el.dataset.setting]: el.checked });
    await refresh();
  } catch (e) {
    alert(e.message);
    await refresh();
  }
});

refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), 30_000);
