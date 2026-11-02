import type { Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { runScheduled } from '../../src/service';
import { T0 } from '../helpers';
import { TestD1 } from './d1';
import {
  APPLE_BASE,
  FakeApple,
  FakeLastfm,
  LASTFM_AUTH,
  LASTFM_BASE,
  makeAppleKey,
  routerFetch,
} from './fakes';

export const ORIGIN = 'https://skyscrob.test';

export class Harness {
  d1 = new TestD1();
  clock = T0;
  key = makeAppleKey();
  apple = new FakeApple(this.key.publicKey, 'TEAMID1234', 'KEYID12345');
  lastfm = new FakeLastfm('lfm-key', 'lfm-secret');
  env: Env;
  deps = { fetch: routerFetch(this.apple, this.lastfm), now: () => this.clock };

  constructor(vars: Partial<Env> = {}) {
    this.env = {
      DB: this.d1 as unknown as D1Database,
      APPLE_TEAM_ID: 'TEAMID1234',
      APPLE_KEY_ID: 'KEYID12345',
      APPLE_PRIVATE_KEY: this.key.pem,
      LASTFM_API_KEY: 'lfm-key',
      LASTFM_API_SECRET: 'lfm-secret',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      ALLOWED_LASTFM_USERS: '*',
      APPLE_API_BASE: APPLE_BASE,
      LASTFM_API_BASE: LASTFM_BASE,
      LASTFM_AUTH_URL: LASTFM_AUTH,
      ...vars,
    };
  }

  request(path: string, init: RequestInit & { cookie?: string; ip?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
    return handleRequest(new Request(ORIGIN + path, { ...init, headers }), this.env, this.deps);
  }

  tick(ms = 60_000) {
    this.clock += ms;
    return runScheduled(this.env, this.deps);
  }

  /** Full Last.fm web-auth dance; returns a signed-in browser. */
  async signIn(username: string, ip?: string): Promise<Browser> {
    const start = await this.request('/auth/lastfm/login', { ip });
    if (start.status !== 302) throw new Error(`login start ${start.status}`);
    const lfmUrl = new URL(start.headers.get('location')!);
    const cb = new URL(lfmUrl.searchParams.get('cb')!);
    const token = `tok${username.replace(/\W/g, '')}abcdef`;
    this.lastfm.tokens.set(token, username);
    cb.searchParams.set('token', token);
    const res = await this.request(cb.pathname + cb.search, { ip });
    if (res.status !== 302) throw new Error(`callback ${res.status}: ${await res.text()}`);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const b = new Browser(this, cookie);
    await b.refresh();
    return b;
  }
}

export class Browser {
  csrf = '';
  constructor(
    readonly h: Harness,
    readonly cookie: string,
  ) {}
  async refresh() {
    const r = await this.h.request('/api/me', { cookie: this.cookie });
    const body = (await r.json()) as { csrf: string };
    this.csrf = body.csrf;
    return body as unknown as MeResponse;
  }
  me() {
    return this.refresh();
  }
  post(path: string, body: unknown = {}, extra: Record<string, string> = {}) {
    return this.h.request(path, {
      method: 'POST',
      cookie: this.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': this.csrf, origin: ORIGIN, ...extra },
      body: JSON.stringify(body),
    });
  }
  async connectApple(mut: string) {
    const r = await this.post('/api/apple/connect', { musicUserToken: mut });
    if (r.status !== 200) throw new Error(`connect ${r.status}: ${await r.text()}`);
  }
}

export interface MeResponse {
  csrf: string;
  lastfm: { user: string; status: string };
  apple: { status: string };
  paused: boolean;
  settings: Record<string, boolean>;
  lastPollAt: number | null;
  lastError: string | null;
  scrobbles: { artist: string; track: string; ts: number; status: string; reason: string | null }[];
}
