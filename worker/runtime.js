// Server-side runtime for app team servers: router, key-value store and file store on
// Durable Object storage, and caller identity from the engine's token.

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/* ------------------------------------------------------------------ identity */
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function parseToken(t) {
  try {
    const part = String(t).split('.')[1];
    const o = JSON.parse(decodeURIComponent(escape(atob(part.replace(/-/g, '+').replace(/_/g, '/')))));
    if (o && typeof o.uu === 'string' && UUID.test(o.uu)) return o;
  } catch {}
  return null;
}
// Unverified parse (used only where a signature has already been checked, or for display).
export function identityFromHeaders(h) {
  const o = tokenFromHeaders(h);
  return o ? toIdentity(o) : null;
}
function tokenFromHeaders(h) {
  return parseToken(h.get('x-ehub-auth')) || parseToken(h.get('ehub-auth')) || parseToken((h.get('authorization') || '').replace(/^Bearer\s+/i, ''));
}
function toIdentity(o, verified) {
  const uuid = o.uu.toLowerCase();
  return { uuid, username: 'user-' + uuid.slice(0, 8), displayName: typeof o.n === 'string' ? o.n.slice(0, 80) : '', verified: !!verified };
}

/* ---------------------------------------------------------- signed identities
 * The engine mints its own random uuid per browser. To stop anyone from presenting someone else's uuid,
 * the first time a browser shows up it claims its uuid (POST /api/session) and gets back an HMAC signature
 * that it carries in every token (field "s"). Once a uuid is claimed, only tokens with a valid signature
 * are accepted for it. Unclaimed (legacy) uuids keep working until their browser claims them.
 * The HMAC key is env.AUTH_SECRET when set, otherwise a random key kept in a system Durable Object. */
let keyPromise = null;
const claimCache = new Map(); // uuid -> { claimed, at }
export function sysStub(env, name) { return env.APP_SERVER.get(env.APP_SERVER.idFromName('sys|' + name)); }
export async function sysCall(env, name, op, body) {
  const r = await sysStub(env, name).fetch('https://sys.internal/' + op, { method: 'POST', headers: { 'x-ehub-sys': op, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function hmacKey(env) {
  if (!keyPromise) {
    keyPromise = (async () => {
      let raw = env.AUTH_SECRET ? new TextEncoder().encode(String(env.AUTH_SECRET)) : null;
      if (!raw) { const j = await sysCall(env, 'auth', 'key'); raw = Uint8Array.from(atob(j.key), (c) => c.charCodeAt(0)); }
      return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })().catch((e) => { keyPromise = null; throw e; });
  }
  return keyPromise;
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function signUuid(env, uuid) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode('ehub-id:' + String(uuid).toLowerCase()));
  return b64u(sig).slice(0, 32);
}
function sameStr(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
export async function isClaimed(env, uuid) {
  const c = claimCache.get(uuid);
  if (c && (c.claimed || Date.now() - c.at < 30000)) return c.claimed;
  const j = await sysCall(env, 'auth', 'claimed', { uuid });
  claimCache.set(uuid, { claimed: !!j.claimed, at: Date.now() });
  if (claimCache.size > 5000) claimCache.clear();
  return !!j.claimed;
}
export function markClaimed(uuid) { claimCache.set(uuid, { claimed: true, at: Date.now() }); }
// Verified identity for a request, or null. A token with a bad signature is rejected outright.
export async function verifiedIdentity(env, h) {
  const o = tokenFromHeaders(h);
  if (!o) return null;
  const uuid = o.uu.toLowerCase();
  if (typeof o.s === 'string' && o.s) {
    try { if (sameStr(o.s, await signUuid(env, uuid))) return toIdentity(o, true); } catch (e) { return null; }
    return null;
  }
  try { if (await isClaimed(env, uuid)) return null; } catch (e) { /* auth store unreachable: fall back to legacy */ }
  return toIdentity(o, false);
}

/* -------------------------------------------------------------------- router */
function compile(pattern) {
  const names = [];
  const src = String(pattern).split('/').map((seg) => {
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    if (seg.startsWith('*')) { names.push(seg.slice(1) || 'path'); return '(.*)'; }
    return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp('^' + src + '/?$'), names };
}
export class Router {
  constructor() {
    this.routes = [];
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'any']) {
      this[m] = (path, handler) => this.add(m === 'all' || m === 'any' ? '*' : m.toUpperCase(), path, handler);
    }
  }
  add(method, path, handler) { this.routes.push({ method: String(method).toUpperCase(), ...compile(path), handler }); return this; }
  custom(method, path, handler) { return this.add(method, path, handler); }
  async handle(request, user) {
    const url = new URL(request.url);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    let pathOnly = false;
    for (const r of this.routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.method !== '*' && r.method !== method) { pathOnly = true; continue; }
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1] || ''); } catch { params[n] = m[i + 1] || ''; } });
      try {
        const out = await r.handler({ request, user, params, url });
        return toResponse(out);
      } catch (e) {
        const status = (e && (e.status || e.statusCode)) || 500;
        return json({ success: false, message: String((e && e.message) || e), error: { message: String((e && e.message) || e), code: e && e.code } }, status >= 400 && status < 600 ? status : 500);
      }
    }
    if (method === 'OPTIONS') return new Response(null, { status: 204 });
    return json({ message: 'Not found' }, pathOnly ? 405 : 404);
  }
}
function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined || out === null) return new Response(null, { status: 204 });
  if (typeof out === 'string') return new Response(out, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out) || out instanceof Blob || out instanceof ReadableStream) return new Response(out);
  return json(out);
}

/* ------------------------------------------------------------------------ kv */
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const nowSec = () => Math.floor(Date.now() / 1000);
// Paths accept dot and bracket notation like the client SDK: a.b, a[0], ["key.with.dots"].
export function pathParts(path) {
  if (Array.isArray(path)) return path.map(String);
  const s = String(path), out = []; let i = 0, cur = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '.') { if (cur) out.push(cur); cur = ''; i++; continue; }
    if (c === '[') {
      if (cur) { out.push(cur); cur = ''; }
      const q = s[i + 1];
      if (q === '"' || q === "'") {
        let j = i + 2, buf = '';
        while (j < s.length && s[j] !== q) { if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; } buf += s[j]; j++; }
        out.push(buf); i = s.indexOf(']', j); i = i < 0 ? s.length : i + 1; continue;
      }
      const e = s.indexOf(']', i); if (e < 0) { cur += s.slice(i); break; }
      out.push(s.slice(i + 1, e).trim()); i = e + 1; continue;
    }
    cur += c; i++;
  }
  if (cur) out.push(cur);
  return out.length ? out : [s];
}
function setPath(obj, path, value) {
  const parts = pathParts(path); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = value;
}
const getPath = (obj, path) => pathParts(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);
function delPath(obj, path) {
  const parts = pathParts(path), last = parts.pop(), o = parts.length ? getPath(obj, parts) : obj;
  if (o && typeof o === 'object') { if (Array.isArray(o) && /^\d+$/.test(last)) o.splice(Number(last), 1); else delete o[last]; }
}
const ENC = new TextEncoder();
function globToRe(pattern) {
  return new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
}

export function makeKV(storage, ns) {
  const P = 'kv:' + ns + ':';
  let queue = Promise.resolve();
  const serial = (fn) => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };
  async function load(key) {
    const rec = await storage.get(P + key);
    if (!rec) return null;
    if (rec.e && rec.e * 1000 <= Date.now()) { await storage.delete(P + key); return null; }
    return rec;
  }
  async function save(key, value, e) {
    if (typeof key !== 'string' || !key.length) throw Object.assign(new Error('A key is required'), { status: 400 });
    if (key.length > 1024) throw Object.assign(new Error('Key is too long'), { status: 400 });
    const rec = { v: clone(value) }; if (e) rec.e = e;
    const size = ENC.encode(JSON.stringify(rec)).length; // Durable Object values are capped at 2 MB
    if (size > 1900000) throw Object.assign(new Error('Value is too large (max about 1.9 MB)'), { status: 413, code: 'value_too_large' });
    await storage.put(P + key, rec);
    return true;
  }
  const expOf = (x) => (typeof x === 'number' ? x : x && typeof x === 'object' ? (x.expireAt || (x.ttl ? nowSec() + x.ttl : null)) : null);
  const kv = {
    MAX_KEY_SIZE: 1024, MAX_VALUE_SIZE: 399 * 1024,
    async get(key) {
      if (Array.isArray(key)) return Promise.all(key.map((k) => kv.get(k)));
      const r = await load(String(key)); return r ? clone(r.v) : null;
    },
    async set(key, value, opt) {
      if (Array.isArray(key)) { for (const it of key) await save(String(it.key), it.value, expOf(it.expireAt || it)); return true; }
      if (key && typeof key === 'object') return kv.set(key.key, key.value, key.expireAt);
      return save(String(key), value, expOf(opt));
    },
    async del(...keys) { const ks = keys.flat().map((k) => P + String(k)); for (let i = 0; i < ks.length; i += 128) await storage.delete(ks.slice(i, i + 128)); return true; },
    incr(key, amount) {
      return serial(async () => {
        const rec = await load(key);
        if (amount && typeof amount === 'object') {
          const obj = rec && rec.v && typeof rec.v === 'object' ? rec.v : {};
          for (const p of Object.keys(amount)) setPath(obj, p, (Number(getPath(obj, p)) || 0) + Number(amount[p]));
          await save(key, obj, rec && rec.e); return clone(obj);
        }
        const next = (rec ? Number(rec.v) || 0 : 0) + (amount === undefined ? 1 : Number(amount));
        await save(key, next, rec && rec.e); return next;
      });
    },
    decr(key, amount) {
      if (amount && typeof amount === 'object') { const n = {}; for (const k of Object.keys(amount)) n[k] = -amount[k]; return kv.incr(key, n); }
      return kv.incr(key, -(amount === undefined ? 1 : Number(amount)));
    },
    add(key, values) {
      return serial(async () => {
        const rec = await load(key);
        if (values && typeof values === 'object' && !Array.isArray(values) && rec && rec.v && typeof rec.v === 'object' && !Array.isArray(rec.v)) {
          const o = rec.v;
          for (const p of Object.keys(values)) { const cur = getPath(o, p); setPath(o, p, (Array.isArray(cur) ? cur : cur == null ? [] : [cur]).concat(values[p])); }
          await save(key, o, rec.e); return clone(o);
        }
        let list = rec ? (Array.isArray(rec.v) ? rec.v : rec.v == null ? [] : [rec.v]) : [];
        list = list.concat(Array.isArray(values) ? values : [values]);
        await save(key, list, rec && rec.e); return clone(list);
      });
    },
    remove(key, ...paths) {
      return serial(async () => {
        const rec = await load(key); if (!rec || !rec.v || typeof rec.v !== 'object') return null;
        for (const p of paths.flat()) if (p != null) delPath(rec.v, p);
        await save(key, rec.v, rec.e); return clone(rec.v);
      });
    },
    update(key, paths, ttl) {
      return serial(async () => {
        const rec = await load(key);
        const v = rec && rec.v && typeof rec.v === 'object' ? rec.v : {};
        for (const p of Object.keys(paths || {})) setPath(v, p, clone(paths[p]));
        await save(key, v, typeof ttl === 'number' ? nowSec() + ttl : rec && rec.e); return clone(v);
      });
    },
    async expire(key, seconds) { const r = await load(key); if (!r) return false; await save(key, r.v, nowSec() + Number(seconds)); return true; },
    async expireAt(key, ts) { const r = await load(key); if (!r) return false; await save(key, r.v, Number(ts)); return true; },
    async list(a, b) {
      let opts = {};
      if (typeof a === 'string') opts = { pattern: a, returnValues: !!b };
      else if (typeof a === 'boolean') opts = { returnValues: a };
      else if (a && typeof a === 'object') opts = a;
      const pattern = opts.pattern || '*';
      const lit = pattern.split(/[*?]/)[0];
      const re = globToRe(/[*?]/.test(pattern) ? pattern : pattern + '*');
      const now = Date.now();
      const paged = opts.limit !== undefined || opts.cursor !== undefined;
      const lim = Math.max(1, Math.min(Number(opts.limit) || 1000, 1000));
      const reverse = !!opts.reverse;
      // Cursor = the last storage key returned ("k:" form); legacy numeric cursors are offsets.
      let after = null, skip = 0;
      if (opts.cursor) { const c = String(opts.cursor); if (c.startsWith('k:')) after = P + c.slice(2); else skip = Number(c) || 0; }
      else if (opts.offset) skip = Number(opts.offset) || 0;
      const live = [];
      let lastKey = null, more = false;
      for (;;) {
        const q = { prefix: P + lit, limit: 1000, reverse };
        if (after) { if (reverse) q.end = after; else q.startAfter = after; }
        const map = await storage.list(q);
        if (!map.size) break;
        for (const [k, rec] of map) {
          after = k;
          const key = k.slice(P.length);
          if (!re.test(key) || (rec && rec.e && rec.e * 1000 <= now)) continue;
          if (skip) { skip--; continue; }
          if (paged && live.length >= lim) { more = true; break; }
          live.push({ key, rec }); lastKey = k;
        }
        if (more || map.size < 1000) break;
      }
      const items = live.map((x) => (opts.returnValues ? { key: x.key, value: clone(x.rec.v) } : x.key));
      if (!paged) return items;
      return { items, cursor: more && lastKey ? 'k:' + lastKey.slice(P.length) : undefined };
    },
    async flush() {
      for (;;) { const map = await storage.list({ prefix: P, limit: 1000 }); if (!map.size) break; const ks = [...map.keys()]; for (let i = 0; i < ks.length; i += 128) await storage.delete(ks.slice(i, i + 128)); }
      return true;
    },
  };
  kv.clear = kv.flush;
  return kv;
}

/* ------------------------------------------------------------------------ fs */
const CHUNK = 1000 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
function mimeOf(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '';
  return ({ json: 'application/json', txt: 'text/plain', html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ics: 'text/calendar; charset=utf-8', xml: 'application/xml', rss: 'application/rss+xml', atom: 'application/atom+xml', csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8', ico: 'image/x-icon', mjs: 'text/javascript', woff2: 'font/woff2', woff: 'font/woff', avif: 'image/avif', vcf: 'text/vcard', zip: 'application/zip', htm: 'text/html' })[ext.toLowerCase()] || 'application/octet-stream';
}
async function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(JSON.stringify(data));
}
export function makeFS(storage, ns, who, home, urlFor) {
  const P = 'fs:' + ns + ':';
  const norm = (p) => {
    p = String(p || '');
    if (p.startsWith('~')) p = '/' + (who.username || 'owner') + p.slice(1);
    if (!p.startsWith('/')) p = home.replace(/\/$/, '') + '/' + p;
    const out = [];
    for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
    return '/' + out.join('/');
  };
  const item = (path, meta) => ({
    id: meta.uid, uid: meta.uid, name: path.split('/').pop(), path, is_dir: !!meta.dir, size: meta.size || 0, type: meta.type || null,
    created: meta.created, modified: meta.modified, accessed: meta.modified, is_shared: false, immutable: false,
    owner: { username: who.username, uuid: who.uuid },
  });
  const notFound = (path) => Object.assign(new Error('No entry at ' + path), { code: 'subject_does_not_exist', status: 404 });
  async function meta(path) { return storage.get(P + 'm:' + path); }
  async function removeFile(path, m) {
    for (let i = 0; i < (m.chunks || 0); i++) await storage.delete(P + 'c:' + path + ':' + i);
    await storage.delete(P + 'm:' + path);
  }
  async function exists(path) { return !!(await meta(path)); }
  const fs = {
    async write(path, data, opts = {}) {
      if (path && typeof path === 'object' && !(typeof path === 'string')) { opts = data || {}; data = path.data; path = path.path; }
      let p = norm(path);
      if (p.length > 1500) throw Object.assign(new Error('That path is too long.'), { status: 400, code: 'path_too_long' });
      const prev = await meta(p);
      if (prev && !opts.overwrite) {
        if (opts.dedupeName === false) throw Object.assign(new Error('An entry already exists at ' + p), { code: 'item_with_same_name_exists', status: 409 });
        const m = /^(.*?)(\.[^./]*)?$/.exec(p); let i = 1;
        while (await exists(`${m[1]} (${i})${m[2] || ''}`)) i++;
        p = `${m[1]} (${i})${m[2] || ''}`;
      } else if (prev) await removeFile(p, prev);
      const bytes = await toBytes(data);
      if (bytes.length > MAX_FILE) throw Object.assign(new Error('That file is too large.'), { status: 413 });
      const chunks = Math.ceil(bytes.length / CHUNK);
      for (let i = 0; i < chunks; i++) await storage.put(P + 'c:' + p + ':' + i, bytes.slice(i * CHUNK, (i + 1) * CHUNK));
      const t = Date.now() / 1000 | 0;
      const mm = { uid: (prev && prev.uid) || crypto.randomUUID(), size: bytes.length, type: (data && data.type) || mimeOf(p), chunks, created: (prev && prev.created) || t, modified: t };
      await storage.put(P + 'm:' + p, mm);
      return item(p, mm);
    },
    async read(path) {
      const p = norm(path && path.path ? path.path : path);
      const m = await meta(p); if (!m || m.dir) throw notFound(p);
      const parts = [];
      for (let i = 0; i < (m.chunks || 0); i++) { const c = await storage.get(P + 'c:' + p + ':' + i); if (c) parts.push(c); }
      return new Blob(parts, { type: m.type || 'application/octet-stream' });
    },
    async stat(path) {
      const p = norm(path && path.path ? path.path : path);
      const m = await meta(p);
      if (m) return item(p, m);
      const kids = await storage.list({ prefix: P + 'm:' + p + '/', limit: 1 });
      if (kids.size) return item(p, { uid: 'dir:' + p, dir: true, created: 0, modified: 0 });
      throw notFound(p);
    },
    async exists(path) { try { await fs.stat(path); return true; } catch { return false; } },
    async delete(path, opts = {}) {
      for (const one of [].concat(path)) {
        const p = norm(one && one.path ? one.path : one);
        const m = await meta(p);
        if (m) await removeFile(p, m);
        const kids = await storage.list({ prefix: P + 'm:' + p + '/' });
        for (const [k, km] of kids) await removeFile(k.slice((P + 'm:').length), km);
      }
      return true;
    },
    async mkdir(path) { const p = norm(path); return item(p, { uid: 'dir:' + p, dir: true, created: Date.now() / 1000 | 0, modified: Date.now() / 1000 | 0 }); },
    async readdir(path) {
      const p = norm(path && path.path ? path.path : path).replace(/\/$/, '');
      const kids = await storage.list({ prefix: P + 'm:' + p + '/' });
      const seen = new Map();
      for (const [k, m] of kids) {
        const full = k.slice((P + 'm:').length), rest = full.slice(p.length + 1), first = rest.split('/')[0];
        if (rest.includes('/')) { if (!seen.has(first)) seen.set(first, item(p + '/' + first, { uid: 'dir:' + p + '/' + first, dir: true, created: 0, modified: 0 })); }
        else seen.set(first, item(full, m));
      }
      return [...seen.values()];
    },
    async rename(from, to) {
      const a = norm(from), m = await meta(a); if (!m) throw notFound(a);
      const b = to.includes('/') ? norm(to) : a.replace(/[^/]+$/, to);
      const blob = await fs.read(a); await removeFile(a, m); return fs.write(b, blob, { overwrite: true });
    },
    async move(from, to) { return fs.rename(from, to); },
    async copy(from, to) { const blob = await fs.read(from); return fs.write(norm(to), blob, { overwrite: true }); },
    async getReadURL(path, ttl) {
      const p = norm(path && path.path ? path.path : path);
      if (!(await meta(p))) throw notFound(p);
      const secs = typeof ttl === 'number' ? ttl : /^(\d+)h$/.test(String(ttl)) ? Number(RegExp.$1) * 3600 : /^(\d+)m$/.test(String(ttl)) ? Number(RegExp.$1) * 60 : 86400;
      const id = crypto.randomUUID().replace(/-/g, '');
      await storage.put('sys:url:' + id, { ns, path: p, exp: Date.now() + Math.min(secs, 7 * 86400) * 1000 });
      if (Math.random() < 0.05) { // sweep expired links now and then so they don't pile up
        const old = await storage.list({ prefix: 'sys:url:', limit: 500 }); const dead = [];
        for (const [k, v] of old) if (!v || v.exp < Date.now()) dead.push(k);
        for (let i = 0; i < dead.length; i += 128) await storage.delete(dead.slice(i, i + 128));
      }
      return urlFor(id);
    },
    async revokeReadURL(url) { const id = String(url).split('/__file/')[1]; if (id) await storage.delete('sys:url:' + id.split('?')[0]); return true; },
  };
  return fs;
}
