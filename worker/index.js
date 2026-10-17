// Everything Hub server: static site (./site) + /api/* on the same Cloudflare Worker.
//   /api/health                      status and which optional features are configured
//   /api/ai/...                      OpenAI-compatible chat, images, transcription, speech on Workers AI (binding AI)
//   /api/fetch                       CORS-free proxy for ehub.net.fetch (target in x-ehub-target)
//   /api/email/send                  outbound mail through Resend when RESEND_API_KEY is set
//   /api/peer/<code>                 WebSocket signalling room for ehub.peer (Durable Object PeerRoom)
//   /api/w/<app>/<instance>/<path>   an app's team server (Durable Object AppServer runs the app's own script)
import { DurableObject } from 'cloudflare:workers';
import { SCRIPTS, BY_APP, FIXED } from './apps/index.js';
import { aiChatCompletions, aiImages, aiTranscribe, aiSpeech, aiChatSimple } from './ai.js';
import { sendEmail, emailConfigured } from './email.js';
import { makeKV, makeFS, identityFromHeaders, json, Router } from './runtime.js';

const BUILD = '2026-10-17-core';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (e) {
      return json({ success: false, error: { code: 'server_error', message: String((e && e.message) || e) } }, 500);
    }
  },
};

async function api(request, env, url) {
  const p = url.pathname;
  if (p === '/api/health' || p === '/api/') {
    return json({ ok: true, name: 'everything-hub', build: BUILD, ai: !!env.AI, email: emailConfigured(env), teamServers: Object.keys(BY_APP).length, sharedServers: Object.keys(FIXED).length, time: new Date().toISOString() });
  }
  if (p.startsWith('/api/ai/')) {
    if (!env.AI) return json({ error: { message: 'AI is not enabled on this server.' } }, 503);
    if (!identityFromHeaders(request.headers)) return json({ error: { message: 'Open this from an Everything Hub app.' } }, 401);
    const tail = p.slice('/api/ai'.length);
    if (tail === '/chat/completions' && request.method === 'POST') return aiChatCompletions(env, await request.json());
    if (tail === '/images/generations' && request.method === 'POST') return aiImages(env, await request.json());
    if (tail === '/audio/transcriptions' && request.method === 'POST') return aiTranscribe(env, await request.formData());
    if (tail === '/audio/speech' && request.method === 'POST') return aiSpeech(env, await request.json());
    if (tail === '/models') return json({ data: [{ id: 'default', object: 'model', owned_by: 'everything-hub' }] });
    return json({ error: { message: 'Not found' } }, 404);
  }
  if (p === '/api/fetch') return proxyFetch(request);
  if (p === '/api/email/send' && request.method === 'POST') {
    const who = identityFromHeaders(request.headers);
    if (!who) return json({ message: 'Sign-in token missing.' }, 401);
    if (!emailConfigured(env)) return json({ configured: false, message: 'Email sending is not set up on this server.' }, 503);
    const r = await sendEmail(env, await request.json(), who);
    return json(r, r.delivered && r.delivered.length ? 200 : 502);
  }
  let m = /^\/api\/peer\/([^/]{1,80})$/.exec(p);
  if (m) {
    if (request.headers.get('upgrade') !== 'websocket') return json({ message: 'WebSocket expected' }, 426);
    const id = env.PEER_ROOM.idFromName(decodeURIComponent(m[1]));
    return env.PEER_ROOM.get(id).fetch(request);
  }
  m = /^\/api\/w\/([a-z0-9-]{1,60})\/([a-z0-9-]{1,63})(\/.*)?$/.exec(p);
  if (m) return routeWorker(env, m[1], m[2], m[3] || '/', url.search, request);
  return json({ message: 'Not found' }, 404);
}

export function scriptFor(app, inst) {
  if (FIXED[inst]) return FIXED[inst];
  if (BY_APP[app]) return BY_APP[app];
  return null;
}

export async function routeWorker(env, app, inst, path, search, request) {
  const key = scriptFor(app, inst);
  if (!key) return json({ message: 'This app has no team server on Everything Hub.' }, 404);
  const stub = env.APP_SERVER.get(env.APP_SERVER.idFromName(key + '|' + inst));
  const h = new Headers(request.headers);
  h.set('x-ehub-key', key); h.set('x-ehub-inst', inst); h.set('x-ehub-app', app); h.set('x-ehub-path', path + (search || ''));
  h.set('x-ehub-origin', new URL(request.url).origin);
  const init = { method: request.method, headers: h, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
  return stub.fetch('https://app-server.internal/', init);
}

/* ---------------------------------------------------------------- fetch proxy */
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.invalid|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
const MAX_PROXY_BYTES = 25 * 1024 * 1024;
async function proxyFetch(request) {
  const target = request.headers.get('x-ehub-target') || new URL(request.url).searchParams.get('url');
  let u;
  try { u = new URL(target); } catch { return json({ message: 'A valid target URL is required.' }, 400); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) return json({ message: 'That address cannot be fetched.' }, 403);
  if (!identityFromHeaders(request.headers)) return json({ message: 'Sign-in token missing.' }, 401);
  const h = new Headers();
  for (const [k, v] of request.headers) {
    if (/^(host|cookie|origin|referer|x-ehub-.*|ehub-auth|cf-.*|x-forwarded-.*|x-real-ip|content-length)$/i.test(k)) continue;
    h.set(k, v);
  }
  const init = { method: request.method, headers: h, redirect: 'follow', signal: AbortSignal.timeout(25000) };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
  let r;
  try { r = await fetch(u.href, init); } catch (e) { return json({ message: 'Could not reach ' + u.hostname + '.' }, 502); }
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_PROXY_BYTES) return json({ message: 'That response is too large to proxy.' }, 413);
  const out = new Headers(r.headers);
  out.delete('set-cookie'); out.delete('content-security-policy'); out.delete('strict-transport-security');
  out.set('x-ehub-final-url', r.url);
  let body = r.body;
  if (body && !len) {
    let seen = 0;
    body = body.pipeThrough(new TransformStream({ transform(chunk, c) { seen += chunk.byteLength; if (seen > MAX_PROXY_BYTES) c.error(new Error('too large')); else c.enqueue(chunk); } }));
  }
  return new Response(body, { status: r.status, statusText: r.statusText, headers: out });
}

/* ------------------------------------------------------------ peer signalling */
export class PeerRoom extends DurableObject {
  async fetch(request) {
    if (this.ctx.getWebSockets().length >= 48) return new Response('Room is full', { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 65536) return;
    for (const other of this.ctx.getWebSockets()) if (other !== ws) { try { other.send(msg); } catch {} }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {} }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch {} }
}

/* ------------------------------------------------------------- app team servers */
const SYSTEM_OWNER = { uuid: '00000000-0000-4000-8000-000000000000', username: 'everything-hub' };

export class AppServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.router = null; this.key = null; this.inst = null; this.owner = null;
  }

  async boot(key, inst, app, origin) {
    this.origin = origin;
    if (this.router && this.key === key) return;
    this.key = key; this.inst = inst; this.app = app;
    this.owner = (await this.ctx.storage.get('sys:owner')) || null;
    const router = new Router();
    const self = this;
    const meCtx = {
      get ehub() { return self.ehubFor(self.owner || SYSTEM_OWNER, 'me', null); },
    };
    const install = SCRIPTS[key];
    const lazy = new Proxy({}, { get: (_, k) => meCtx.ehub[k], has: (_, k) => k in meCtx.ehub });
    install(router, meCtx, lazy);
    this.router = router;
  }

  ehubFor(who, ns, req) {
    const self = this, env = this.env;
    const proof = req && req.proof;
    const fsx = makeFS(this.ctx.storage, ns, who, `/${ns === 'me' ? 'owner' : who.username}/AppData/${this.inst}`, (id) => `https://${this.inst}.ehub.work/__file/${id}`);
    if (proof) {
      const baseStat = fsx.stat, baseRead = fsx.read;
      fsx.stat = async (p, o) => (normProof(p) === proof.path ? { id: 'proof', uid: 'proof', name: proof.path.split('/').pop(), path: proof.path, is_dir: false, size: proof.bytes.length, is_shared: false, owner: { username: who.username, uuid: who.uuid }, created: Date.now() / 1000 | 0, modified: Date.now() / 1000 | 0 } : baseStat(p, o));
      fsx.read = async (p, o) => (normProof(p) === proof.path ? new Blob([proof.bytes], { type: 'application/json' }) : baseRead(p, o));
    }
    return {
      kv: makeKV(this.ctx.storage, ns),
      fs: fsx,
      auth: {
        isSignedIn: () => true,
        getUser: async () => ({ uuid: who.uuid, username: who.username, email: who.username + '@users.everything-hub', email_confirmed: true, is_temp: false }),
        whoami: async () => ({ uuid: who.uuid, username: who.username }),
      },
      email: {
        send: async (msg) => {
          if (!emailConfigured(env)) { const e = new Error('Email sending is not set up on this Everything Hub server yet.'); e.code = 'email_not_configured'; e.status = 503; throw e; }
          const r = await sendEmail(env, msg || {}, who);
          if (!r.delivered || !r.delivered.length) { const e = new Error(r.message || 'The email could not be sent.'); e.status = 502; throw e; }
          return r;
        },
        sendTransactional: async (msg) => self.ehubFor(who, ns, req).email.send(msg),
      },
      ai: { chat: (...a) => aiChatSimple(env, ...a) },
      workers: {
        exec: async (u, init) => {
          const url = new URL(String(u && u.url ? u.url : u));
          const m = /^([a-z0-9-]+)\.ehub\.work$/i.exec(url.hostname);
          if (!m) return fetch(u, init);
          const h = new Headers((init && init.headers) || {});
          if (req && req.token) { h.set('x-ehub-auth', req.token); if (!h.has('ehub-auth')) h.set('ehub-auth', req.token); }
          return routeWorker(env, this.app, m[1].toLowerCase(), url.pathname, url.search, new Request('https://hub.internal/', { ...(init || {}), headers: h }));
        },
        create: async () => { throw new Error('Team servers cannot create other servers.'); },
      },
      peer: { serve: async () => { throw new Error('Not available on the server.'); } },
      authToken: (req && req.token) || 'server.' + btoa(JSON.stringify({ t: 'au', uu: who.uuid })) + '.hub',
      APIOrigin: this.origin || 'https://everything-hub.invalid',
      env: 'worker',
    };
  }

  async fetch(request) {
    const h = request.headers;
    const key = h.get('x-ehub-key'), inst = h.get('x-ehub-inst'), app = h.get('x-ehub-app');
    const pathq = h.get('x-ehub-path') || '/';
    await this.boot(key, inst, app, h.get('x-ehub-origin'));
    const who = identityFromHeaders(h);
    const [path] = pathq.split('?');

    if (path === '/__deploy') {
      if (!who) return json({ message: 'Sign in first.' }, 401);
      if (!this.owner && !Object.values(FIXED).includes(key)) { this.owner = { uuid: who.uuid, username: who.username }; await this.ctx.storage.put('sys:owner', this.owner); }
      return json({ success: true, name: inst, owner: this.owner ? this.owner.username : SYSTEM_OWNER.username });
    }
    if (path.startsWith('/__file/')) {
      const id = path.slice('/__file/'.length);
      const rec = await this.ctx.storage.get('sys:url:' + id);
      if (!rec || rec.exp < Date.now()) return json({ message: 'This link has expired.' }, 410);
      const fsx = makeFS(this.ctx.storage, rec.ns, SYSTEM_OWNER, '/', () => '');
      try { const b = await fsx.read(rec.path); return new Response(b, { headers: { 'content-type': b.type || 'application/octet-stream', 'cache-control': 'private, max-age=300' } }); }
      catch { return json({ message: 'Not found' }, 404); }
    }

    let proof = null;
    if (who && h.get('x-ehub-proof-file')) {
      try { proof = { path: normProof(decodeURIComponent(h.get('x-ehub-proof-path') || '')), bytes: b64urlDecode(h.get('x-ehub-proof-file')) }; } catch {}
    }
    const token = h.get('ehub-auth') || h.get('x-ehub-auth') || null;
    const fwd = new Headers();
    for (const [k, v] of h) if (!/^x-ehub-/.test(k) && !/^cf-/.test(k)) fwd.set(k, v);
    const init = { method: request.method, headers: fwd };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
    const req = new Request(`https://${inst}.ehub.work${pathq}`, init);
    const reqCtx = { token, proof };
    const user = who ? { uuid: who.uuid, username: who.username, ehub: this.ehubFor(who, 'u:' + who.uuid, reqCtx) } : null;
    if (this.owner == null && who && !Object.values(FIXED).includes(key)) { this.owner = { uuid: who.uuid, username: who.username }; await this.ctx.storage.put('sys:owner', this.owner); }
    return this.router.handle(req, user);
  }
}

function normProof(p) { return String(p || '').replace(/\/+/g, '/').replace(/\/$/, ''); }
function b64urlDecode(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
