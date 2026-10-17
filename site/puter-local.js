/*!
 * puter-local.js — a dependency-free, fully local stand-in for the Puter.js v2 SDK.
 *
 * Load it with a plain (non-module, non-deferred) <script> before any app code:
 *   <script src="../../puter-local.js"></script>
 *
 * Nothing here talks to puter.com. Storage lives in the browser:
 *   - puter.kv  -> localStorage, namespaced per app ("everything:kv:<app>:<key>"),
 *                  spilling to IndexedDB when a value will not fit.
 *   - puter.fs  -> IndexedDB "everything-drive", one virtual drive shared by every app,
 *                  rooted at /me (relative paths resolve to /me/AppData/<app>/ like the SDK).
 *   - puter.ai  -> an OpenAI-compatible endpoint the user configures in the hub
 *                  (localStorage "everything:ai" = {endpoint, apiKey, model}); off otherwise.
 *   - puter.peer -> WebRTC between tabs/frames of this origin, signalled over BroadcastChannel.
 * Requests to Puter hosts (puter.com, puter.work, puter.site, ...) are refused locally.
 * Unknown members never throw: the object is wrapped in Proxies that hand back no-ops.
 */
(function () {
  'use strict';
  if (window.puter && window.puter.__everything) return;

  /* ------------------------------------------------------------------ basics */
  var LS = window.localStorage;
  var USERNAME = 'me';
  var HOME = '/' + USERNAME;
  var APP = (function () {
    if (window.EVERYTHING_APP_ID) return String(window.EVERYTHING_APP_ID);
    var m = /\/apps\/([^/]+)\//.exec(location.pathname);
    if (m) return decodeURIComponent(m[1]);
    try { var q = new URLSearchParams(location.search).get('everything-app'); if (q) return q; } catch (e) {}
    return 'default';
  })();
  var IN_FRAME = window.parent && window.parent !== window;
  var delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); };
  var nowSec = function () { return Math.floor(Date.now() / 1000); };
  var rid = function (n) {
    var a = new Uint8Array(n || 8); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  };
  var uuid = function () {
    if (crypto.randomUUID) return crypto.randomUUID();
    var h = rid(16); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
  };
  var err = function (code, message, extra) {
    var e = new Error(message || code); e.code = code; e.error = { code: code, message: message || code };
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  };
  function post(type, data) {
    if (!IN_FRAME) return;
    try { window.parent.postMessage(Object.assign({ everything: 1, type: type, app: APP }, data || {}), location.origin); } catch (e) {}
  }
  function jsonClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /* ----------------------------------------------------- the local user */
  var USER = (function () {
    var u = null;
    try { u = JSON.parse(LS.getItem('everything:user') || 'null'); } catch (e) {}
    if (!u || !u.uuid) {
      u = { uuid: uuid(), created: Date.now() };
      try { LS.setItem('everything:user', JSON.stringify(u)); } catch (e) {}
    }
    return {
      username: USERNAME, uuid: u.uuid, email: USERNAME + '@everything.local', email_confirmed: true,
      requires_email_confirmation: false, is_temp: false, desktop_bg_url: null, desktop_bg_color: null,
      referral_code: null, feature_flags: {}, taskbar_items: [], is_verified: true,
      actual_free_storage: 1073741824 * 10, display_name: u.displayName || 'You',
    };
  })();
  var b64url = function (s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var AUTH_TOKEN = 'local.' + b64url(JSON.stringify({ t: 'au', v: '2', uu: USER.uuid, app_uid: 'app-' + APP, local: true })) + '.everything';

  /* ------------------------------------------- network guard (no Puter calls) */
  var PUTER_HOST = /(^|\.)(puter\.(com|work|site|app|io|dev)|puter\.local|puter-local\.invalid)$/i;
  var TRACKER_HOST = /(^|\.)(plausible\.io|google-analytics\.com|googletagmanager\.com|analytics\.google\.com|segment\.io|mixpanel\.com|hotjar\.com|posthog\.com|sentry\.io)$/i;
  function isPuterURL(u) {
    try { var url = new URL(String(u && u.url ? u.url : u), location.href); return PUTER_HOST.test(url.hostname) || TRACKER_HOST.test(url.hostname); } catch (e) { return false; }
  }
  function refusedResponse(u) {
    return new Response(JSON.stringify({ success: false, error: { code: 'offline_local', message: 'Everything runs locally; Puter cloud services are not used.' } }),
      { status: 503, statusText: 'Local mode', headers: { 'content-type': 'application/json' } });
  }
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (isPuterURL(input)) {
        var href = String(input && input.url ? input.url : input);
        if (/js\.puter\.com/i.test(href)) return Promise.resolve(new Response('/* puter-local */', { status: 200, headers: { 'content-type': 'text/javascript' } }));
        return Promise.resolve(refusedResponse(input));
      }
      return nativeFetch(input, init);
    };
  }
  try {
    var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__evBlocked = isPuterURL(u); return xo.apply(this, arguments.length > 2 ? arguments : [m, u, true]); };
    XMLHttpRequest.prototype.send = function () {
      if (this.__evBlocked) { var x = this; setTimeout(function () { try { x.dispatchEvent(new ProgressEvent('error')); } catch (e) {} if (x.onerror) x.onerror(new ProgressEvent('error')); }, 0); return; }
      return xs.apply(this, arguments);
    };
  } catch (e) {}
  try {
    if (window.WebSocket) {
      var NWS = window.WebSocket;
      var GuardWS = function (u, p) {
        if (isPuterURL(String(u).replace(/^ws/, 'http'))) {
          var fake = new EventTarget(); fake.readyState = 3; fake.send = function () {}; fake.close = function () {}; fake.url = String(u);
          setTimeout(function () { var ev = new Event('error'); fake.dispatchEvent(ev); if (fake.onerror) fake.onerror(ev); var c = new CloseEvent('close', { code: 1006 }); fake.dispatchEvent(c); if (fake.onclose) fake.onclose(c); }, 0);
          return fake;
        }
        return p === undefined ? new NWS(u) : new NWS(u, p);
      };
      GuardWS.prototype = NWS.prototype; GuardWS.CONNECTING = 0; GuardWS.OPEN = 1; GuardWS.CLOSING = 2; GuardWS.CLOSED = 3;
      window.WebSocket = GuardWS;
    }
    if (navigator.sendBeacon) { var sb = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function (u, d) { return isPuterURL(u) ? true : sb(u, d); }; }
    if (window.EventSource) { var NES = window.EventSource; window.EventSource = function (u, o) { if (isPuterURL(u)) { var f = new EventTarget(); f.readyState = 2; f.close = function () {}; return f; } return new NES(u, o); }; window.EventSource.prototype = NES.prototype; }
    // A dynamically injected <script src="https://js.puter.com/v2/"> loads an empty script instead.
    var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true, enumerable: srcDesc.enumerable, get: srcDesc.get,
        set: function (v) { return srcDesc.set.call(this, isPuterURL(v) ? 'data:text/javascript,' : v); },
      });
    }
  } catch (e) {}

  /* --------------------------------------------------------------- IndexedDB */
  var DB_NAME = 'everything-drive';
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('nodes')) { var s = d.createObjectStore('nodes', { keyPath: 'path' }); s.createIndex('parent', 'parent'); s.createIndex('uid', 'uid', { unique: false }); }
        if (!d.objectStoreNames.contains('kvbig')) d.createObjectStore('kvbig');
      };
      req.onsuccess = function () { var d = req.result; d.onversionchange = function () { d.close(); dbPromise = null; }; resolve(d); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { console.warn('[puter-local] drive upgrade blocked'); };
    });
    return dbPromise;
  }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function txDone(t) { return new Promise(function (res, rej) { t.oncomplete = function () { res(); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || err('aborted', 'Transaction aborted')); }; }); }
  async function store(name, mode) { var d = await db(); return d.transaction(name, mode || 'readonly').objectStore(name); }
  async function getNode(path) { return reqP((await store('nodes')).get(path)); }
  async function childrenOf(path) { return reqP((await store('nodes')).index('parent').getAll(path)); }
  async function putNodes(nodes) { var d = await db(); var t = d.transaction('nodes', 'readwrite'); var s = t.objectStore('nodes'); nodes.forEach(function (n) { s.put(n); }); return txDone(t); }
  async function deleteKeys(paths) { var d = await db(); var t = d.transaction('nodes', 'readwrite'); var s = t.objectStore('nodes'); paths.forEach(function (p) { s.delete(p); }); return txDone(t); }
  async function allUnder(path) {
    var s = await store('nodes');
    var range = IDBKeyRange.bound(path + '/', path + '/\uffff');
    return reqP(s.getAll(range));
  }

  /* ------------------------------------------------------------------- paths */
  function normPath(p) {
    if (p && typeof p === 'object') p = p.path || p.name || '';
    p = String(p == null ? '' : p).replace(/\\/g, '/');
    if (p === '' || p === '.') p = '~/AppData/' + APP;
    else if (p === '~') p = HOME;
    if (p.indexOf('~/') === 0) p = HOME + p.slice(1);
    else if (p[0] !== '/') p = HOME + '/AppData/' + APP + '/' + p;
    var out = [];
    p.split('/').forEach(function (seg) { if (!seg || seg === '.') return; if (seg === '..') out.pop(); else out.push(seg); });
    return '/' + out.join('/');
  }
  var dirname = function (p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  var basename = function (p) { return p.slice(p.lastIndexOf('/') + 1); };
  var fsBus = (function () { try { return new BroadcastChannel('everything:fs'); } catch (e) { return null; } })();
  var fsListeners = [];
  function fsEmit(kind, path, extra) {
    var msg = Object.assign({ kind: kind, type: kind, path: path, app: APP, at: Date.now() }, extra || {});
    try { fsBus && fsBus.postMessage(msg); } catch (e) {}
  }
  if (fsBus) fsBus.onmessage = function (e) { fsListeners.slice().forEach(function (l) { try { l(e.data); } catch (x) {} }); };

  function guessType(name) {
    var ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
    var map = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', stl: 'model/stl', glb: 'model/gltf-binary', gltf: 'model/gltf+json', dxf: 'image/vnd.dxf' };
    return (ext && map[ext.toLowerCase()]) || 'application/octet-stream';
  }
  function toItem(n) {
    if (!n) return null;
    var it = {
      id: n.uid, uid: n.uid, uuid: n.uid, name: n.name, path: n.path, is_dir: !!n.is_dir, isDirectory: !!n.is_dir,
      size: n.is_dir ? 0 : n.size || 0, type: n.is_dir ? null : n.type || guessType(n.name),
      created: n.created, modified: n.modified, accessed: n.modified, changed: n.modified,
      parent_id: null, dirname: dirname(n.path), immutable: false, is_shortcut: 0, is_symlink: false, writable: true,
      owner: { username: USERNAME, email: USER.email }, local: true,
    };
    Object.defineProperty(it, 'read', { enumerable: false, value: function (o) { return fs.read(n.path, o); } });
    Object.defineProperty(it, 'readdir', { enumerable: false, value: function () { return fs.readdir(n.path); } });
    Object.defineProperty(it, 'write', { enumerable: false, value: function (d) { return fs.write(n.path, d); } });
    Object.defineProperty(it, 'delete', { enumerable: false, value: function () { return fs.delete(n.path); } });
    Object.defineProperty(it, 'rename', { enumerable: false, value: function (nn) { return fs.rename(n.path, nn); } });
    return it;
  }
  function dirNode(path) { var t = nowSec(); return { path: path, parent: path === '/' ? '' : dirname(path), name: basename(path) || '/', is_dir: true, size: 0, uid: 'ev-' + rid(10), created: t, modified: t }; }

  var bootstrapped = null;
  function bootstrap() {
    if (bootstrapped) return bootstrapped;
    bootstrapped = (async function () {
      var base = ['/', HOME, HOME + '/Desktop', HOME + '/Documents', HOME + '/Pictures', HOME + '/Videos', HOME + '/Public', HOME + '/AppData', HOME + '/AppData/' + APP];
      var missing = [];
      for (var i = 0; i < base.length; i++) if (!(await getNode(base[i]))) missing.push(dirNode(base[i]));
      if (missing.length) await putNodes(missing);
    })().catch(function (e) { bootstrapped = null; throw e; });
    return bootstrapped;
  }
  async function ensureDir(path) {
    var parts = path.split('/').filter(Boolean), cur = '', add = [];
    for (var i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      var n = await getNode(cur);
      if (n && !n.is_dir) throw err('dest_is_not_a_directory', cur + ' is a file, not a folder');
      if (!n) add.push(dirNode(cur));
    }
    if (add.length) await putNodes(add);
    return getNode(path);
  }
  async function dedupe(path) {
    if (!(await getNode(path))) return path;
    var dir = dirname(path), name = basename(path), m = /^(.*?)(\.[^.]*)?$/.exec(name), stem = m[1], ext = m[2] || '';
    for (var i = 1; i < 10000; i++) { var c = (dir === '/' ? '' : dir) + '/' + stem + ' (' + i + ')' + ext; if (!(await getNode(c))) return c; }
    return path;
  }
  async function toBlob(data, type) {
    if (data == null) return new Blob([], { type: type || '' });
    if (data instanceof Blob) return data;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data], { type: type || '' });
    if (typeof data === 'string') return new Blob([data], { type: type || 'text/plain' });
    if (typeof data === 'object' && data.constructor === Object) return new Blob([JSON.stringify(data)], { type: 'application/json' });
    return new Blob([String(data)], { type: type || 'text/plain' });
  }
  async function resolveTarget(p) {
    if (p && typeof p === 'object' && !p.path && (p.uid || p.uuid || p.id)) {
      var uidv = p.uid || p.uuid || p.id;
      var n = await reqP((await store('nodes')).index('uid').get(uidv));
      if (!n) throw err('subject_does_not_exist', 'No file with id ' + uidv);
      return n.path;
    }
    return normPath(p);
  }

  var fs = {
    async write(path, data, opts) {
      await bootstrap();
      if ((path instanceof Blob) && data === undefined) { data = path; path = path.name || ('Untitled-' + Date.now()); }
      if (data && typeof data === 'object' && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) && opts === undefined && ('overwrite' in data || 'dedupeName' in data || 'createMissingParents' in data)) { opts = data; data = ''; }
      opts = opts || {};
      var p = await resolveTarget(path);
      if (opts.createMissingParents === false && !(await getNode(dirname(p)))) throw err('dest_does_not_exist', dirname(p) + ' does not exist');
      await ensureDir(dirname(p));
      var existing = await getNode(p);
      if (existing && existing.is_dir) throw err('dest_is_a_directory', p + ' is a folder');
      if (existing && (opts.dedupeName || opts.dedupe_name)) { p = await dedupe(p); existing = null; }
      else if (existing && opts.overwrite === false) throw err('item_with_same_name_exists', 'A file with that name already exists', { entry_name: basename(p) });
      var blob = await toBlob(data, guessType(p));
      var t = nowSec();
      var node = { path: p, parent: dirname(p), name: basename(p), is_dir: false, size: blob.size, type: blob.type || guessType(p), uid: existing ? existing.uid : 'ev-' + rid(10), created: existing ? existing.created : t, modified: t, blob: blob };
      try { await putNodes([node]); }
      catch (e) { // Safari historically refused Blobs in IDB: store bytes instead.
        node.blob = await blob.arrayBuffer(); node.raw = true; await putNodes([node]);
      }
      fsEmit('write', p, { uid: node.uid });
      return toItem(node);
    },
    async read(path, opts) {
      await bootstrap();
      var p = await resolveTarget(path);
      var n = await getNode(p);
      if (!n) throw err('subject_does_not_exist', p + ' does not exist', { path: p });
      if (n.is_dir) throw err('is_directory', p + ' is a folder');
      var blob = n.blob instanceof Blob ? n.blob : new Blob([n.blob || ''], { type: n.type || guessType(n.name) });
      if (blob.type !== (n.type || blob.type)) blob = new Blob([blob], { type: n.type });
      opts = opts || {};
      if (opts.offset != null || opts.byte_count != null) {
        var start = opts.offset || 0; blob = blob.slice(start, opts.byte_count != null ? start + opts.byte_count : undefined, blob.type);
      }
      return blob;
    },
    async readdir(path, opts) {
      await bootstrap();
      if (path && typeof path === 'object' && !Array.isArray(path) && path.path === undefined && path.uid === undefined) path = '';
      var p = await resolveTarget(path);
      var n = await getNode(p);
      if (!n) { if (p === normPath('')) { await ensureDir(p); return []; } throw err('subject_does_not_exist', p + ' does not exist', { path: p }); }
      if (!n.is_dir) throw err('is_not_directory', p + ' is not a folder');
      var kids = await childrenOf(p);
      return kids.sort(function (a, b) { return a.name.localeCompare(b.name); }).map(toItem);
    },
    async stat(path, opts) {
      await bootstrap();
      var p = await resolveTarget(path);
      var n = await getNode(p);
      if (!n) throw err('subject_does_not_exist', p + ' does not exist', { path: p });
      var it = toItem(n);
      if (n.is_dir && opts && (opts.returnSubdomains || opts.returnSize)) it.size = (await allUnder(p)).reduce(function (s, x) { return s + (x.size || 0); }, 0);
      return it;
    },
    async mkdir(path, opts) {
      await bootstrap();
      opts = opts || {};
      var p = await resolveTarget(path);
      var existing = await getNode(p);
      if (existing) {
        if (opts.dedupeName || opts.dedupe_name) p = await dedupe(p);
        else if (existing.is_dir) { if (opts.overwrite === false) throw err('item_with_same_name_exists', 'A folder with that name already exists'); return toItem(existing); }
        else throw err('item_with_same_name_exists', 'A file with that name already exists');
      }
      if (opts.createMissingParents === false && opts.recursive !== true && !(await getNode(dirname(p)))) throw err('dest_does_not_exist', dirname(p) + ' does not exist');
      var n = await ensureDir(p);
      fsEmit('mkdir', p);
      return toItem(n);
    },
    async delete(paths, opts) {
      await bootstrap();
      opts = opts || {};
      var list = Array.isArray(paths) ? paths : [paths];
      for (var i = 0; i < list.length; i++) {
        var p = await resolveTarget(list[i]);
        var n = await getNode(p);
        if (!n) { if (opts.ignoreMissing === false) throw err('subject_does_not_exist', p + ' does not exist'); continue; }
        if (p === '/' || p === HOME) throw err('immutable', 'Cannot delete ' + p);
        var under = n.is_dir ? (await allUnder(p)).map(function (x) { return x.path; }) : [];
        if (n.is_dir && under.length && opts.recursive === false) throw err('not_empty', p + ' is not empty');
        await deleteKeys(opts.descendantsOnly ? under : under.concat([p]));
        fsEmit('delete', p);
      }
      return true;
    },
    async rename(path, newName) {
      await bootstrap();
      var p = await resolveTarget(path);
      var target = String(newName).indexOf('/') >= 0 ? normPath(newName) : (dirname(p) === '/' ? '' : dirname(p)) + '/' + newName;
      return move(p, target, { overwrite: false, keepModified: false });
    },
    async move(src, dest, opts) {
      await bootstrap();
      opts = opts || {};
      var p = await resolveTarget(src), d = normPath(dest);
      var dn = await getNode(d);
      var target = dn && dn.is_dir ? d + '/' + (opts.newName || basename(p)) : (opts.newName ? dirname(d) + '/' + opts.newName : d);
      if (opts.dedupeName) target = await dedupe(target);
      if (opts.createMissingParents !== false) await ensureDir(dirname(target));
      return move(p, target, opts);
    },
    async copy(src, dest, opts) {
      await bootstrap();
      opts = opts || {};
      var p = await resolveTarget(src), d = normPath(dest);
      var n = await getNode(p);
      if (!n) throw err('subject_does_not_exist', p + ' does not exist');
      var dn = await getNode(d);
      var target = dn && dn.is_dir ? d + '/' + (opts.newName || basename(p)) : d;
      if (await getNode(target)) { if (opts.dedupeName || opts.dedupe_name) target = await dedupe(target); else if (!opts.overwrite) throw err('item_with_same_name_exists', 'An item with that name already exists'); }
      await ensureDir(dirname(target));
      var t = nowSec();
      var nodes = [n].concat(n.is_dir ? await allUnder(p) : []).map(function (x) {
        var np = target + x.path.slice(p.length);
        return Object.assign({}, x, { path: np, parent: dirname(np), name: basename(np), uid: 'ev-' + rid(10), created: t, modified: t });
      });
      await putNodes(nodes);
      fsEmit('write', target);
      return [{ copied: toItem(nodes[0]), overwritten: null }];
    },
    async upload(items, dirPath, opts) {
      await bootstrap();
      opts = opts || {};
      var files = items instanceof FileList ? Array.prototype.slice.call(items) : Array.isArray(items) ? items : [items];
      var dir = normPath(dirPath || '~/Desktop');
      await ensureDir(dir);
      var out = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var rel = f.webkitRelativePath || f.name || ('upload-' + i);
        out.push(await fs.write(dir + '/' + rel, f, { dedupeName: opts.dedupeName !== false && opts.overwrite !== true, overwrite: !!opts.overwrite }));
      }
      return out.length === 1 ? out[0] : out;
    },
    async getReadURL(path, expiresIn) {
      var blob = await fs.read(path);
      return URL.createObjectURL(blob);
    },
    async revokeReadURL(url) { try { URL.revokeObjectURL(url); } catch (e) {} return true; },
    async space() {
      await bootstrap();
      var used = 0;
      try { var all = await reqP((await store('nodes')).getAll()); all.forEach(function (n) { used += n.size || 0; }); } catch (e) {}
      var quota = 0;
      try { var est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; quota = est && est.quota || 0; } catch (e) {}
      var capacity = quota || 10 * 1073741824;
      return { capacity: capacity, used: used, host_used: used };
    },
    async exists(path) { try { await fs.stat(path); return true; } catch (e) { return false; } },
    // Sharing has no meaning on a single-device drive: answer as an unshared file.
    async share(path, recipient, mode) { await fs.stat(path); return [{ uid: 'share-' + rid(6), mode: mode || 'read', path: normPath(path), holder: String(recipient || ''), pending: true, local: true }]; },
    async unshare() { return { revoked: 0 }; },
    async getShares() { return []; },
    async listShared() { return { items: [] }; },
    async getShareLink(path) { var s = await fs.stat(path); return location.origin + location.pathname + '#file=' + encodeURIComponent(s.uid); },
    async sign(app, items) { return { token: AUTH_TOKEN, items: [].concat(items || []).map(function (i) { return Object.assign({}, i, { signature: 'local' }); }) }; },
    async symlink() { throw err('not_supported', 'Shortcuts are not supported on the local drive'); },
  };
  async function move(p, target, opts) {
    var n = await getNode(p);
    if (!n) throw err('subject_does_not_exist', p + ' does not exist', { path: p });
    if (target === p) return toItem(n);
    var clash = await getNode(target);
    if (clash) {
      if (opts && opts.overwrite) await fs.delete(target);
      else throw err('item_with_same_name_exists', 'An item named ' + basename(target) + ' already exists', { entry_name: basename(target) });
    }
    var t = nowSec();
    var kids = n.is_dir ? await allUnder(p) : [];
    var moved = [n].concat(kids).map(function (x) {
      var np = target + x.path.slice(p.length);
      return Object.assign({}, x, { path: np, parent: dirname(np), name: basename(np), modified: x === n ? t : x.modified });
    });
    await putNodes(moved);
    await deleteKeys([p].concat(kids.map(function (k) { return k.path; })));
    fsEmit('rename', target, { from: p });
    return toItem(moved[0]);
  }

  /* ---------------------------------------------------------------------- kv */
  var KV_PREFIX = 'everything:kv:' + APP + ':';
  var BIG = '\u0000idb';
  function kvRead(key) {
    var raw = LS.getItem(KV_PREFIX + key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  async function kvLoad(key) {
    var rec = kvRead(key);
    if (!rec) return null;
    if (rec.e && rec.e * 1000 <= Date.now()) { kvRemove(key); return null; }
    if (rec.b === BIG) {
      try { var big = await reqP((await store('kvbig')).get(KV_PREFIX + key)); if (big) return big; } catch (e) {}
      return null;
    }
    return rec;
  }
  async function kvSave(key, value, expireAt) {
    if (typeof key !== 'string' || !key.length) throw err('key_undefined', 'A key is required');
    if (key.length > 1024) throw err('key_too_large', 'Key is too long');
    if (value === undefined) value = null;
    var rec = { v: jsonClone(value) };
    if (expireAt) rec.e = expireAt;
    var json = JSON.stringify(rec);
    var prevRaw = LS.getItem(KV_PREFIX + key);
    try {
      LS.setItem(KV_PREFIX + key, json);
      if (prevRaw && prevRaw.indexOf(BIG) >= 0) { try { var s = await store('kvbig', 'readwrite'); s.delete(KV_PREFIX + key); } catch (e) {} }
    } catch (e) {
      // localStorage is full: keep the value in IndexedDB and a marker here.
      var s2 = await store('kvbig', 'readwrite');
      await reqP(s2.put(rec, KV_PREFIX + key));
      LS.setItem(KV_PREFIX + key, JSON.stringify({ b: BIG, e: expireAt || undefined }));
    }
    return true;
  }
  function kvRemove(key) {
    LS.removeItem(KV_PREFIX + key);
    store('kvbig', 'readwrite').then(function (s) { s.delete(KV_PREFIX + key); }).catch(function () {});
  }
  function kvKeys() {
    var out = [];
    for (var i = 0; i < LS.length; i++) { var k = LS.key(i); if (k && k.indexOf(KV_PREFIX) === 0) out.push(k.slice(KV_PREFIX.length)); }
    return out;
  }
  function globToRe(pattern) {
    var esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + esc + '$');
  }
  function setPath(obj, path, value) {
    var parts = String(path).split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = value;
  }
  function getPath(obj, path) { return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
  var kvQueue = Promise.resolve();
  function serial(fn) { var r = kvQueue.then(fn, fn); kvQueue = r.catch(function () {}); return r; }

  var kv = {
    MAX_KEY_SIZE: 1024, MAX_VALUE_SIZE: 399 * 1024,
    async get(key) {
      if (Array.isArray(key)) return Promise.all(key.map(function (k) { return kv.get(k); }));
      var r = await kvLoad(String(key));
      return r ? jsonClone(r.v) : null;
    },
    async set(key, value, expireAt) {
      if (Array.isArray(key)) { for (var i = 0; i < key.length; i++) await kvSave(key[i].key, key[i].value, key[i].expireAt); return true; }
      if (key && typeof key === 'object') { if (Array.isArray(key.items)) return kv.set(key.items); return kvSave(key.key, key.value, key.expireAt); }
      return kvSave(String(key), value, typeof expireAt === 'number' ? expireAt : (expireAt && expireAt.expireAt) || null);
    },
    async del() {
      var keys = Array.prototype.slice.call(arguments).reduce(function (a, k) { return a.concat(k); }, []);
      keys.forEach(function (k) { kvRemove(String(k)); });
      return true;
    },
    async incr(key, amount) {
      return serial(async function () {
        var rec = await kvLoad(key);
        if (amount && typeof amount === 'object') {
          var obj = rec && rec.v && typeof rec.v === 'object' ? rec.v : {};
          Object.keys(amount).forEach(function (p) { setPath(obj, p, (Number(getPath(obj, p)) || 0) + Number(amount[p])); });
          await kvSave(key, obj, rec && rec.e); return jsonClone(obj);
        }
        var next = (rec && typeof rec.v === 'number' ? rec.v : Number(rec && rec.v) || 0) + (amount === undefined ? 1 : Number(amount));
        await kvSave(key, next, rec && rec.e);
        return next;
      });
    },
    async decr(key, amount) {
      if (amount && typeof amount === 'object') { var neg = {}; Object.keys(amount).forEach(function (k) { neg[k] = -amount[k]; }); return kv.incr(key, neg); }
      return kv.incr(key, -(amount === undefined ? 1 : Number(amount)));
    },
    async add(key, values) {
      return serial(async function () {
        var rec = await kvLoad(key);
        if (values && typeof values === 'object' && !Array.isArray(values) && rec && rec.v && typeof rec.v === 'object' && !Array.isArray(rec.v)) {
          var o = rec.v; Object.keys(values).forEach(function (p) { var cur = getPath(o, p); setPath(o, p, (Array.isArray(cur) ? cur : cur == null ? [] : [cur]).concat(values[p])); });
          await kvSave(key, o, rec.e); return jsonClone(o);
        }
        var list = rec ? (Array.isArray(rec.v) ? rec.v : rec.v == null ? [] : [rec.v]) : [];
        list = list.concat(Array.isArray(values) ? values : [values]);
        await kvSave(key, list, rec && rec.e);
        return jsonClone(list);
      });
    },
    async remove(key, paths) {
      return serial(async function () {
        var rec = await kvLoad(key); if (!rec || !rec.v || typeof rec.v !== 'object') return null;
        [].concat(paths || []).forEach(function (p) { var parts = String(p).split('.'), last = parts.pop(), o = getPath(rec.v, parts.join('.')) || (parts.length ? null : rec.v); if (o && typeof o === 'object') delete o[last]; });
        await kvSave(key, rec.v, rec.e); return jsonClone(rec.v);
      });
    },
    async update(key, paths, ttl) {
      return serial(async function () {
        var rec = await kvLoad(key);
        var v = rec && rec.v && typeof rec.v === 'object' ? rec.v : {};
        Object.keys(paths || {}).forEach(function (p) { setPath(v, p, jsonClone(paths[p])); });
        await kvSave(key, v, typeof ttl === 'number' ? nowSec() + ttl : rec && rec.e);
        return jsonClone(v);
      });
    },
    async expire(key, seconds) { var r = await kvLoad(key); if (!r) return false; await kvSave(key, r.v, nowSec() + Number(seconds)); return true; },
    async expireAt(key, ts) { var r = await kvLoad(key); if (!r) return false; await kvSave(key, r.v, Number(ts)); return true; },
    async list(a, b) {
      var opts = {};
      if (typeof a === 'string') opts = { pattern: a, returnValues: !!b };
      else if (typeof a === 'boolean') opts = { returnValues: a };
      else if (a && typeof a === 'object') opts = a;
      var re = globToRe(opts.pattern || '*');
      var keys = kvKeys().filter(function (k) { return re.test(k); }).sort();
      var live = [];
      for (var i = 0; i < keys.length; i++) { var r = await kvLoad(keys[i]); if (r) live.push({ key: keys[i], rec: r }); }
      if (opts.reverse) live.reverse();
      var paged = opts.limit !== undefined || opts.cursor !== undefined;
      var start = opts.cursor ? Number(opts.cursor) || 0 : opts.offset || 0;
      var lim = Math.min(opts.limit || 1000, 1000);
      var slice = paged ? live.slice(start, start + lim) : live;
      var items = slice.map(function (x) { return opts.returnValues ? { key: x.key, value: jsonClone(x.rec.v) } : x.key; });
      if (!paged) return items;
      return { items: items, cursor: start + lim < live.length ? String(start + lim) : undefined, total: opts.includeTotal ? live.length : undefined };
    },
    async flush() { kvKeys().forEach(kvRemove); return true; },
    async clear() { return kv.flush(); },
  };

  /* ---------------------------------------------------------------------- ai */
  var AI_OFF = 'AI is off — add a key in Everything settings';
  function aiConfig() {
    try { var c = JSON.parse(LS.getItem('everything:ai') || 'null'); if (c && c.endpoint && (c.apiKey || /localhost|127\.0\.0\.1/.test(c.endpoint))) return c; } catch (e) {}
    return null;
  }
  function aiOff() { post('toast', { message: AI_OFF, action: 'settings' }); return err('ai_off', AI_OFF, { success: false }); }
  function aiURL(c, tail) {
    var base = String(c.endpoint).replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) base = base.replace(/\/chat\/completions$/, '');
    return base + tail;
  }
  function aiHeaders(c) { var h = { 'content-type': 'application/json' }; if (c.apiKey) h.authorization = 'Bearer ' + c.apiKey; return h; }
  function normTools(tools) {
    return (tools || []).map(function (t) {
      if (t && t.type === 'function' && t.function) return t;
      return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || t.input_schema || { type: 'object', properties: {} } } };
    });
  }
  function normMessages(prompt, images) {
    var msgs;
    if (Array.isArray(prompt)) msgs = prompt.map(function (m) { return typeof m === 'string' ? { role: 'user', content: m } : m; });
    else msgs = [{ role: 'user', content: String(prompt == null ? '' : prompt) }];
    if (images && images.length) {
      var last = msgs[msgs.length - 1];
      var parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content || []).slice();
      images.forEach(function (u) { parts.push({ type: 'image_url', image_url: { url: u } }); });
      last.content = parts;
    }
    // Puter accepts a few extra part shapes; map them to OpenAI's.
    return msgs.map(function (m) {
      if (!Array.isArray(m.content)) return m;
      return Object.assign({}, m, { content: m.content.map(function (p) {
        if (typeof p === 'string') return { type: 'text', text: p };
        if (p && p.type === 'image' && p.source && p.source.data) return { type: 'image_url', image_url: { url: 'data:' + (p.source.media_type || 'image/png') + ';base64,' + p.source.data } };
        if (p && p.type === 'document' && p.source && p.source.data) return { type: 'text', text: '[Attached document omitted: ' + (p.source.media_type || 'file') + ']' };
        return p;
      }) });
    });
  }
  function parseChatArgs(args) {
    args = Array.prototype.slice.call(args);
    var prompt = args.shift(), images = [], opts = {};
    args.forEach(function (a) {
      if (typeof a === 'boolean') opts.testMode = a;
      else if (typeof a === 'string') images.push(a);
      else if (Array.isArray(a)) images = images.concat(a.filter(function (x) { return typeof x === 'string'; }));
      else if (a && typeof a === 'object') opts = Object.assign(opts, a);
    });
    return { prompt: prompt, images: images, opts: opts };
  }
  function chatResult(message, extra) {
    var content = message.content == null ? '' : message.content;
    var res = Object.assign({ index: 0, message: Object.assign({ role: 'assistant' }, message, { content: content }), finish_reason: 'stop', via_ai_chat_service: true }, extra || {});
    res.toString = function () { return typeof content === 'string' ? content : Array.isArray(content) ? content.map(function (c) { return c.text || ''; }).join('') : ''; };
    res.valueOf = res.toString;
    return res;
  }
  async function* streamSSE(resp) {
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '', tools = {}, usage = null;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split(/\r?\n/); buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        var j; try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) { yield { type: 'error', success: false, error: j.error }; continue; }
        if (j.usage) usage = j.usage;
        var ch = j.choices && j.choices[0]; if (!ch) continue;
        var d = ch.delta || {};
        if (d.reasoning_content || d.reasoning) yield { type: 'reasoning', reasoning: d.reasoning_content || d.reasoning };
        if (typeof d.content === 'string' && d.content) yield { type: 'text', text: d.content };
        (d.tool_calls || []).forEach(function (tc) {
          var k = tc.index != null ? tc.index : 0;
          var t = tools[k] || (tools[k] = { id: tc.id, name: '', args: '' });
          if (tc.id) t.id = tc.id;
          if (tc.function && tc.function.name) t.name += tc.function.name;
          if (tc.function && tc.function.arguments) t.args += tc.function.arguments;
        });
      }
    }
    for (var k2 in tools) {
      var t2 = tools[k2], input = {};
      try { input = t2.args.trim() ? JSON.parse(t2.args) : {}; } catch (e) { input = t2.args; }
      yield { type: 'tool_use', id: t2.id || ('call_' + rid(6)), name: t2.name, input: input };
    }
    if (usage) yield { type: 'usage', usage: usage };
  }
  function speakFallback(text, opts) {
    // A small audio-like object driven by the browser's own speech synthesis.
    var et = new EventTarget(), u = null;
    var o = { paused: true, currentTime: 0, duration: NaN, src: '', dataset: { text: String(text).slice(0, 60) },
      play: function () { try { speechSynthesis.cancel(); u = new SpeechSynthesisUtterance(String(text)); if (opts && opts.language) u.lang = opts.language; u.onend = function () { o.paused = true; var e = new Event('ended'); et.dispatchEvent(e); if (o.onended) o.onended(e); }; speechSynthesis.speak(u); o.paused = false; var pe = new Event('play'); et.dispatchEvent(pe); if (o.onplay) o.onplay(pe); } catch (e) {} return Promise.resolve(); },
      pause: function () { try { speechSynthesis.cancel(); } catch (e) {} o.paused = true; var e = new Event('pause'); et.dispatchEvent(e); if (o.onpause) o.onpause(e); },
      addEventListener: et.addEventListener.bind(et), removeEventListener: et.removeEventListener.bind(et), dispatchEvent: et.dispatchEvent.bind(et), load: function () {} };
    return o;
  }
  var ai = {
    async chat() {
      var a = parseChatArgs(arguments);
      if (a.opts.testMode === true) return chatResult({ content: 'Test mode reply from Everything (local).' });
      var c = aiConfig();
      if (!c) throw aiOff();
      var body = { model: (a.opts.model && c.allowModelOverride ? a.opts.model : c.model) || 'gpt-4o-mini', messages: normMessages(a.prompt, a.images) };
      if (a.opts.tools && a.opts.tools.length) body.tools = normTools(a.opts.tools);
      if (a.opts.max_tokens) body.max_tokens = a.opts.max_tokens;
      if (a.opts.temperature != null) body.temperature = a.opts.temperature;
      if (a.opts.response_format) body.response_format = a.opts.response_format;
      if (a.opts.stream) { body.stream = true; body.stream_options = { include_usage: true }; }
      var resp;
      try { resp = await nativeFetch(aiURL(c, '/chat/completions'), { method: 'POST', headers: aiHeaders(c), body: JSON.stringify(body) }); }
      catch (e) { throw err('ai_unreachable', 'Could not reach the AI endpoint: ' + (e.message || e)); }
      if (!resp.ok) {
        var t = ''; try { t = await resp.text(); } catch (e) {}
        var msg = t; try { var j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.message || t; } catch (e) {}
        throw err('ai_error_' + resp.status, String(msg || ('AI request failed (' + resp.status + ')')).slice(0, 500), { success: false, status: resp.status });
      }
      if (a.opts.stream) {
        var it = streamSSE(resp);
        it.toString = function () { return '[stream]'; };
        return it;
      }
      var data = await resp.json();
      var ch = (data.choices && data.choices[0]) || {};
      return chatResult(ch.message || { content: '' }, { finish_reason: ch.finish_reason, usage: data.usage, model: data.model });
    },
    async complete(prompt, opts) { return ai.chat(prompt, opts || {}); },
    async txt2img(prompt, opts) {
      if (opts === true) { var ti = new Image(); ti.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="#e9e4da"/></svg>'); return ti; }
      var c = aiConfig(); if (!c) throw aiOff();
      if (typeof prompt === 'object' && prompt) { opts = prompt; prompt = prompt.prompt; }
      var resp = await nativeFetch(aiURL(c, '/images/generations'), { method: 'POST', headers: aiHeaders(c), body: JSON.stringify({ model: c.imageModel || (opts && opts.model) || 'gpt-image-1', prompt: String(prompt), n: 1, size: (opts && opts.size) || '1024x1024' }) });
      if (!resp.ok) throw err('ai_error_' + resp.status, 'Image generation failed (' + resp.status + ')');
      var j = await resp.json(), d = (j.data || [])[0] || {};
      var img = new Image(); img.alt = String(prompt);
      img.src = d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url;
      return img;
    },
    async img2txt(image, prompt) {
      var url = image;
      if (image instanceof Blob) url = await new Promise(function (r) { var fr = new FileReader(); fr.onload = function () { r(fr.result); }; fr.readAsDataURL(image); });
      var res = await ai.chat(typeof prompt === 'string' ? prompt : 'Transcribe all text in this image. Reply with the text only.', url);
      return res.toString();
    },
    async txt2speech(text, opts) {
      var c = aiConfig();
      if (c && c.tts !== false) {
        try {
          var resp = await nativeFetch(aiURL(c, '/audio/speech'), { method: 'POST', headers: aiHeaders(c), body: JSON.stringify({ model: c.ttsModel || 'tts-1', input: String(text), voice: (opts && opts.voice) || 'alloy' }) });
          if (resp.ok) { var a = new Audio(URL.createObjectURL(await resp.blob())); return a; }
        } catch (e) {}
      }
      return speakFallback(text, typeof opts === 'string' ? { language: opts } : opts);
    },
    async speech2txt(audio) {
      var c = aiConfig(); if (!c) throw aiOff();
      var fd = new FormData(); fd.append('file', audio instanceof Blob ? audio : await (await nativeFetch(audio)).blob(), 'audio.webm'); fd.append('model', c.sttModel || 'whisper-1');
      var h = aiHeaders(c); delete h['content-type'];
      var resp = await nativeFetch(aiURL(c, '/audio/transcriptions'), { method: 'POST', headers: h, body: fd });
      if (!resp.ok) throw err('ai_error_' + resp.status, 'Transcription failed (' + resp.status + ')');
      var j = await resp.json(); return { text: j.text || '' , toString: function () { return j.text || ''; } };
    },
    async listModels() { var c = aiConfig(); return c ? [{ id: c.model || 'default', provider: 'local' }] : []; },
    async listModelProviders() { return aiConfig() ? ['local'] : []; },
  };
  ai.speech = ai.txt2speech;
  ai.txt2vid = async function () { throw err('not_supported', 'Video generation is not available in Everything.'); };

  /* ------------------------------------------------------------------- email */
  var OUTBOX = 'everything:outbox';
  function outbox() { try { return JSON.parse(LS.getItem(OUTBOX) || '[]'); } catch (e) { return []; } }
  var email = {
    async send(msg) {
      msg = msg || {};
      var to = [].concat(msg.to || []);
      var rec = { id: String(Date.now()).padStart(15, '0') + '-' + rid(3), app: APP, at: Date.now(), to: to, cc: [].concat(msg.cc || []), subject: msg.subject || '', text: msg.text || '', html: msg.html ? String(msg.html).slice(0, 200000) : undefined, attachments: (msg.attachments || []).map(function (a) { return { filename: a.filename, contentType: a.contentType }; }) };
      var box = outbox(); box.push(rec); try { LS.setItem(OUTBOX, JSON.stringify(box.slice(-200))); } catch (e) {}
      post('toast', { message: 'Email kept in your Outbox — Everything doesn’t send mail from this device.' });
      return { delivered: to, failed: [], suppressed: [], local: true, outbox: true, id: rec.id };
    },
    async sendTransactional(msg) { return email.send(msg); },
    async list(opts) {
      var folder = opts && opts.folder;
      var items = folder && folder !== 'sent' ? [] : outbox().slice().reverse().map(function (m) { return { id: m.id, folder: 'sent', subject: m.subject, to: m.to, date: new Date(m.at).toISOString(), size: (m.text || '').length }; });
      return { items: items.slice(0, (opts && opts.limit) || 50), cursor: undefined };
    },
    async get(opts) { var id = opts && (opts.id || opts); var m = outbox().filter(function (x) { return x.id === id; })[0]; return m ? Object.assign({ from: USER.email }, m) : null; },
  };

  /* ----------------------------------------------- workers / hosting (local) */
  var WK = 'everything:workers', HK = 'everything:hosting';
  function readJ(k, d) { try { return JSON.parse(LS.getItem(k) || 'null') || d; } catch (e) { return d; } }
  function writeJ(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var workers = {
    async create(name, filePath) {
      var all = readJ(WK, {});
      all[name] = { name: name, url: 'https://' + name + '.puter.work', file_path: normPath(filePath || ''), app: APP, created_at: new Date().toISOString(), local: true };
      writeJ(WK, all);
      return { success: true, name: name, url: all[name].url, file_path: all[name].file_path, errors: [] };
    },
    async get(name) { var w = readJ(WK, {})[name]; return w ? Object.assign({}, w) : undefined; },
    async list() { var all = readJ(WK, {}); return Object.keys(all).map(function (k) { return all[k]; }); },
    async delete(name) { var all = readJ(WK, {}); delete all[name]; writeJ(WK, all); return true; },
    async exec(url, init) { return refusedResponse(url); },
    async getLoggingHandle() { return { close: function () {}, addEventListener: function () {} }; },
  };
  var hosting = {
    async create(subdomain, dir) {
      if (subdomain && typeof subdomain === 'object') { dir = subdomain.root_dir; subdomain = subdomain.subdomain; }
      var all = readJ(HK, {});
      if (all[subdomain]) throw err('subdomain_taken', 'Subdomain already exists');
      all[subdomain] = { uid: 'site-' + rid(6), subdomain: subdomain || ('site-' + rid(3)), root_dir: dir ? { path: normPath(dir) } : null, created_at: new Date().toISOString(), local: true };
      writeJ(HK, all); return all[subdomain];
    },
    async update(subdomain, dir) { var all = readJ(HK, {}); if (!all[subdomain]) throw err('subject_does_not_exist', 'Subdomain does not exist'); all[subdomain].root_dir = { path: normPath(dir) }; writeJ(HK, all); return all[subdomain]; },
    async get(subdomain) { var s = readJ(HK, {})[subdomain]; if (!s) throw err('subject_does_not_exist', 'Subdomain does not exist'); return s; },
    async list() { var all = readJ(HK, {}); return Object.keys(all).map(function (k) { return all[k]; }); },
    async delete(subdomain) { var all = readJ(HK, {}); delete all[subdomain]; writeJ(HK, all); return { success: true }; },
  };
  var apps = {
    async list() { return []; }, async get(name) { return { name: name || APP, uid: 'app-' + (name || APP), title: name || APP, index_url: location.href }; },
    async create(o) { return Object.assign({ uid: 'app-' + rid(4) }, typeof o === 'object' ? o : { name: o }); }, async update(n, o) { return Object.assign({ name: n }, o); }, async delete() { return true; },
  };

  /* -------------------------------------------------------------------- peer */
  var peer = (function () {
    var CH = 'everything:peer', NO_HOST_MS = 2500;
    var rand = function (n) { return Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(n || 6)), function (b) { return 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]; }).join(''); };
    var ev = function (type, props) { return Object.assign(new Event(type), props || {}); };
    var me = { uuid: USER.uuid + ':' + rid(3), username: USERNAME };
    function Conn(pc, o) {
      var t = new EventTarget(); var self = this;
      ['addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(function (m) { self[m] = t[m].bind(t); });
      this.peerconnection = pc; this.owner = o && o.owner || null; this.room = o && o.room; this.connected = false; this.closed = false; this._dc = null;
      var fire = function (type, props) { var e = ev(type, props); self.dispatchEvent(e); var h = self['on' + type]; if (typeof h === 'function') h(e); };
      this._fire = fire;
      pc.addEventListener('connectionstatechange', function () { if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && !self.closed) self._closed('connection ' + pc.connectionState); });
    }
    Conn.prototype.attach = function (dc) {
      var self = this; this._dc = dc;
      dc.onopen = function () { if (self.closed) return; self.connected = true; self._fire('open'); };
      dc.onmessage = function (e) { self._fire('message', { data: e.data }); };
      dc.onclose = function () { self._closed('channel closed'); };
      if (dc.readyState === 'open') dc.onopen();
    };
    Conn.prototype.send = function (d) { if (!this.connected || !this._dc || this._dc.readyState !== 'open') throw new Error('Connection is not open'); this._dc.send(d); };
    Conn.prototype.close = function (reason) { if (this.closed) return; this.closed = true; this.connected = false; try { this._dc && this._dc.close(); } catch (e) {} try { this.peerconnection.close(); } catch (e) {} this._fire('close', { reason: reason }); };
    Conn.prototype._closed = function (reason) { if (this.closed) return; this.closed = true; this.connected = false; try { this.peerconnection.close(); } catch (e) {} this._fire('close', { reason: reason }); };
    Conn.prototype.on = function (t, fn) { this.addEventListener(t, fn); return this; };
    function Server(code) { var t = new EventTarget(), self = this; ['addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(function (m) { self[m] = t[m].bind(t); }); this.inviteCode = code; this.name = code; this.connections = new Map(); this.closed = false; }
    Server.prototype.setGuestGrant = function () {};
    Server.prototype.on = function (t, fn) { this.addEventListener(t, fn); return this; };
    Server.prototype.close = function () { if (this.closed) return; this.closed = true; this.connections.forEach(function (c) { c.close('server closed'); }); this.connections.clear(); this._onClose && this._onClose(); };
    var bus = null; try { bus = new BroadcastChannel(CH); } catch (e) {}
    var servers = new Map(), dials = new Map(), serving = new Map(), RTC = { iceServers: [] };
    function postBus(msg) { try { bus && bus.postMessage(msg); } catch (e) {} handle(msg); }
    if (bus) bus.onmessage = function (e) { handle(e.data); };
    async function feed(rec, c) { if (!rec.pc.remoteDescription) { rec.queued.push(c); return; } try { await rec.pc.addIceCandidate(c || undefined); } catch (e) {} }
    async function flush(rec) { var q = rec.queued.splice(0); for (var i = 0; i < q.length; i++) await feed(rec, q[i]); }
    async function handle(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'dial') {
        var srv = servers.get(msg.code); if (!srv || srv.closed) return;
        var pc = new RTCPeerConnection(RTC), conn = new Conn(pc, { owner: Object.assign({}, me), room: /^[a-z]/.test(msg.code) ? msg.code : undefined });
        var rec = { pc: pc, conn: conn, queued: [] }; serving.set(msg.connId, rec);
        pc.ondatachannel = function (e) { conn.attach(e.channel); };
        pc.onicecandidate = function (e) { postBus({ t: 'ice', connId: msg.connId, to: 'dialer', candidate: e.candidate ? e.candidate.toJSON() : null }); };
        conn.addEventListener('close', function () { serving.delete(msg.connId); srv.connections.delete(msg.connId); });
        try { await pc.setRemoteDescription(msg.offer); await pc.setLocalDescription(await pc.createAnswer()); } catch (e) { conn.close('bad offer'); return; }
        srv.connections.set(msg.connId, conn);
        postBus({ t: 'answer', connId: msg.connId, answer: pc.localDescription.toJSON(), owner: Object.assign({}, me) });
        await flush(rec);
        var ce = ev('connection', { conn: conn, user: msg.from ? Object.assign({}, msg.from) : undefined });
        srv.dispatchEvent(ce); if (typeof srv.onconnection === 'function') srv.onconnection(ce);
        return;
      }
      if (msg.t === 'answer') {
        var r = dials.get(msg.connId); if (!r || r.answered) return;
        r.answered = true; clearTimeout(r.timer); r.conn.owner = msg.owner || null;
        try { await r.pc.setRemoteDescription(msg.answer); } catch (e) { r.conn.close('bad answer'); return; }
        await flush(r); return;
      }
      if (msg.t === 'ice') { var rr = msg.to === 'dialer' ? dials.get(msg.connId) : serving.get(msg.connId); if (rr) await feed(rr, msg.candidate); }
    }
    return {
      async serve(opts) {
        opts = opts || {};
        if (opts.name !== undefined && !/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/.test(String(opts.name))) throw new TypeError('Not a valid room name');
        var code = opts.name || ('EV-' + rand());
        var old = servers.get(code); if (old) old.close();
        var s = new Server(code); s._onClose = function () { if (servers.get(code) === s) servers.delete(code); };
        servers.set(code, s); return s;
      },
      async connect(code) {
        if (typeof RTCPeerConnection === 'undefined') throw err('not_supported', 'Peer connections are not available in this browser');
        var pc = new RTCPeerConnection(RTC), connId = rand(8);
        var conn = new Conn(pc, { owner: null, room: /^[a-z]/.test(String(code)) ? code : undefined });
        conn.attach(pc.createDataChannel('puter'));
        var rec = { pc: pc, conn: conn, queued: [], answered: false, timer: null }; dials.set(connId, rec);
        conn.addEventListener('close', function () { clearTimeout(rec.timer); dials.delete(connId); });
        pc.onicecandidate = function (e) { postBus({ t: 'ice', connId: connId, to: 'server', candidate: e.candidate ? e.candidate.toJSON() : null }); };
        await pc.setLocalDescription(await pc.createOffer());
        rec.timer = setTimeout(function () { if (rec.answered || conn.closed) return; var e = err('invalid_invite', 'No one is hosting that code on this device. Online play between devices needs Puter; locally, open the game in another tab.'); conn._fire('error', { error: e }); conn.close('invalid_invite'); }, NO_HOST_MS);
        postBus({ t: 'dial', code: String(code), connId: connId, from: { uuid: me.uuid, username: me.username }, offer: pc.localDescription.toJSON() });
        return conn;
      },
      async ensureTurnRelays() {}, async createGuestGrant() { return { grant: 'local-grant', expiresAt: nowSec() + 3600 }; },
    };
  })();

  /* ------------------------------------------------------------- events/perms */
  var subs = new Map();
  var events = {
    async onLocal(subject, cb, opts) {
      var id = 'sub-' + rid(6), s = String(subject || '');
      var root = s.indexOf('fs:') === 0 ? normPath(s.slice(3)) : null;
      var l = function (m) { if (root && (m.path === root || String(m.path).indexOf(root + '/') === 0 || String(m.from || '').indexOf(root) === 0)) cb({ subject: s, event: m, data: m }); };
      fsListeners.push(l);
      var sub = { id: id, subject: s, off: function () { var i = fsListeners.indexOf(l); if (i >= 0) fsListeners.splice(i, 1); subs.delete(id); }, unsubscribe: function () { sub.off(); }, close: function () { sub.off(); } };
      subs.set(id, sub); return sub;
    },
    async onPersistent(o) { var id = 'sub-' + rid(6); var sub = Object.assign({ id: id, subId: id, local: true }, o || {}); subs.set(id, sub); return sub; },
    async list() { return []; },
    async unsubscribe(id) { var s = subs.get(id && id.id || id); if (s && s.off) s.off(); subs.delete(id); return true; },
    async emit() { return true; }, on: function () {}, off: function () {},
  };
  var perms = {
    async request(what) {
      if (what === 'email' || (what && what.resource === 'email')) return USER.email;
      if (Array.isArray(what)) return what.map(function () { return true; }).every(Boolean);
      return true;
    },
    async check() { return true; }, async grant() { return true; }, async revoke() { return true; },
    async requestEmail() { return USER.email; }, async requestReadDesktop() { return HOME + '/Desktop'; }, async requestWriteDesktop() { return HOME + '/Desktop'; },
    async requestReadDocuments() { return HOME + '/Documents'; }, async requestWriteDocuments() { return HOME + '/Documents'; },
    async requestReadPictures() { return HOME + '/Pictures'; }, async requestWritePictures() { return HOME + '/Pictures'; },
    async requestReadVideos() { return HOME + '/Videos'; }, async requestWriteVideos() { return HOME + '/Videos'; },
    async requestReadApps() { return true; }, async requestManageApps() { return true; }, async requestManageSubdomains() { return true; },
  };

  /* -------------------------------------------------------------------- auth */
  var auth = {
    isSignedIn: function () { return true; },
    async signIn() { return Object.assign({}, USER); },
    signOut: function () { post('toast', { message: 'Everything keeps you signed in on this device.' }); return Promise.resolve(); },
    async getUser() { return Object.assign({}, USER); },
    async whoami() { return Object.assign({}, USER); },
    async getProfilePicture() { return null; },
    async getMonthlyUsage() { return { allowanceInfo: { monthUsageAllowance: 0, remaining: 0 }, appTotals: {}, usage: {}, local: true }; },
    async getDetailedAppUsage() { return { total: 0, local: true }; },
  };

  /* ---------------------------------------------------------------------- ui */
  var lastPointer = { x: 120, y: 120 };
  document.addEventListener('pointerdown', function (e) { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('contextmenu', function (e) { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  var STYLE_ID = 'everything-ui-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style'); st.id = STYLE_ID;
    st.textContent = '.ev-ui{font:14px/1.4 Inter,Manrope,system-ui,-apple-system,sans-serif;color:#2a2622;z-index:2147483646}' +
      '.ev-menu{position:fixed;min-width:180px;background:rgba(252,250,246,.97);backdrop-filter:blur(16px);border:1px solid rgba(60,50,40,.12);border-radius:12px;box-shadow:0 12px 40px rgba(40,30,20,.18);padding:6px;animation:evpop .14s ease-out}' +
      '.ev-menu button{display:flex;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:0;padding:8px 10px;border-radius:8px;font:inherit;color:inherit;cursor:pointer}' +
      '.ev-menu button:hover,.ev-menu button:focus{background:rgba(60,50,40,.07);outline:none}.ev-menu button[disabled]{opacity:.45;cursor:default}.ev-menu hr{border:0;border-top:1px solid rgba(60,50,40,.1);margin:4px 6px}' +
      '.ev-scrim{position:fixed;inset:0;background:rgba(30,24,18,.28);display:grid;place-items:center;animation:evfade .15s}' +
      '.ev-dialog{background:#fcfaf6;border-radius:16px;box-shadow:0 24px 70px rgba(30,20,10,.3);padding:22px;max-width:min(420px,92vw);width:100%;animation:evpop .18s cubic-bezier(.2,.9,.3,1.2)}' +
      '.ev-dialog p{margin:0 0 14px;white-space:pre-wrap}.ev-dialog input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(60,50,40,.2);border-radius:10px;font:inherit;margin-bottom:14px;background:#fff}' +
      '.ev-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.ev-row button{border:0;border-radius:999px;padding:8px 16px;font:inherit;cursor:pointer;background:rgba(60,50,40,.08);color:inherit}.ev-row button.primary{background:#2a2622;color:#fcfaf6}' +
      '@keyframes evpop{from{opacity:0;transform:scale(.96)}}@keyframes evfade{from{opacity:0}}';
    (document.head || document.documentElement).appendChild(st);
  }
  function closeMenus() { Array.prototype.forEach.call(document.querySelectorAll('.ev-menu'), function (m) { m.remove(); }); }
  function showMenu(items, x, y, parentMenu) {
    ensureStyle();
    if (!parentMenu) closeMenus();
    var m = document.createElement('div'); m.className = 'ev-ui ev-menu'; m.setAttribute('role', 'menu');
    (items || []).forEach(function (it) {
      if (it === '-' || it === null || (it && it.type === 'separator')) { m.appendChild(document.createElement('hr')); return; }
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.textContent = (it.checked ? '✓ ' : '') + (it.label || it.text || it.title || '') + (it.items ? '  ›' : '');
      if (it.disabled) b.disabled = true;
      b.onclick = function (e) {
        e.stopPropagation();
        if (it.items) { var r = b.getBoundingClientRect(); showMenu(it.items, r.right - 4, r.top, m); return; }
        closeMenus(); try { (it.action || it.onClick || function () {})(); } catch (x) { console.error(x); }
      };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    if (!parentMenu) setTimeout(function () {
      var off = function (e) { if (!e.target.closest || !e.target.closest('.ev-menu')) { closeMenus(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', esc, true); } };
      var esc = function (e) { if (e.key === 'Escape') { closeMenus(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', esc, true); } };
      document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', esc, true);
    }, 0);
    var first = m.querySelector('button:not([disabled])'); if (first) first.focus({ preventScroll: true });
    return m;
  }
  function dialog(message, buttons, withInput, placeholder) {
    ensureStyle();
    return new Promise(function (resolve) {
      var s = document.createElement('div'); s.className = 'ev-ui ev-scrim';
      var d = document.createElement('div'); d.className = 'ev-dialog'; d.setAttribute('role', 'dialog');
      var p = document.createElement('p'); p.textContent = String(message == null ? '' : message); d.appendChild(p);
      var input = null;
      if (withInput) { input = document.createElement('input'); input.placeholder = placeholder || ''; input.value = withInput === true ? '' : String(withInput); d.appendChild(input); }
      var row = document.createElement('div'); row.className = 'ev-row';
      var done = function (v) { s.remove(); resolve(v); };
      (buttons && buttons.length ? buttons : [{ label: 'OK', value: true, type: 'primary' }]).forEach(function (bt, i, arr) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = bt.label || String(bt);
        if (bt.type === 'primary' || (i === arr.length - 1 && !arr.some(function (x) { return x.type === 'primary'; }))) b.className = 'primary';
        b.onclick = function () { done(input ? (bt.value === false ? null : input.value) : (bt.value !== undefined ? bt.value : bt.label || bt)); };
        row.appendChild(b);
      });
      if (input) { input.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); }); }
      d.appendChild(row); s.appendChild(d); document.body.appendChild(s);
      (input || row.lastChild).focus();
    });
  }
  function pickFiles(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var inp = document.createElement('input'); inp.type = 'file';
      if (opts.multiple) inp.multiple = true;
      if (opts.directory) { inp.webkitdirectory = true; }
      var acc = opts.accept;
      if (Array.isArray(acc)) acc = acc.join(',');
      if (acc && typeof acc === 'object') acc = Object.keys(acc).join(',');
      if (acc) inp.accept = String(acc);
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      var settled = false;
      inp.addEventListener('change', function () { settled = true; var f = Array.prototype.slice.call(inp.files || []); inp.remove(); f.length ? resolve(f) : reject(err('cancelled', 'cancelled')); });
      inp.addEventListener('cancel', function () { if (settled) return; settled = true; inp.remove(); reject(err('cancelled', 'cancelled')); });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'download';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  var launchHandlers = [], closeHandler = null, msgHandlers = [];
  var ui = {
    env: 'web',
    async showOpenFilePicker(opts) {
      opts = opts || {};
      var files = await pickFiles({ multiple: !!opts.multiple, accept: opts.accept });
      var out = [];
      for (var i = 0; i < files.length; i++) {
        var it = await fs.write('~/Desktop/' + files[i].name, files[i], { overwrite: true });
        Object.defineProperty(it, 'file', { enumerable: false, value: files[i] });
        out.push(it);
      }
      return opts.multiple ? out : out[0];
    },
    async showDirectoryPicker(opts) {
      opts = opts || {};
      try {
        var files = await pickFiles({ directory: true });
        var root = files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : 'Imported';
        var dir = await fs.mkdir('~/Desktop/' + root, { dedupeName: true });
        for (var i = 0; i < files.length; i++) {
          var rel = files[i].webkitRelativePath.split('/').slice(1).join('/') || files[i].name;
          await fs.write(dir.path + '/' + rel, files[i], { overwrite: true });
        }
        return opts.multiple ? [dir] : dir;
      } catch (e) { throw e; }
    },
    async showSaveFilePicker(content, suggestedName, opts) {
      if (typeof content === 'string' && suggestedName === undefined && /\.[a-z0-9]{1,6}$/i.test(content) && content.length < 200) { suggestedName = content; content = undefined; }
      var name = suggestedName || ('Untitled-' + Date.now());
      var blob = content === undefined ? null : await toBlob(content, guessType(name));
      var savedToDisk = false;
      if (blob && window.showSaveFilePicker && !(opts && opts.noDisk)) {
        try {
          var h = await window.showSaveFilePicker({ suggestedName: name });
          var w = await h.createWritable(); await w.write(blob); await w.close();
          name = h.name || name; savedToDisk = true;
        } catch (e) {
          if (e && e.name === 'AbortError') throw err('cancelled', 'cancelled');
        }
      }
      if (blob && !savedToDisk) download(blob, name);
      var item = blob ? await fs.write('~/Documents/' + name, blob, { overwrite: true }) : toItem(Object.assign(dirNode(normPath('~/Documents/' + name)), { is_dir: false }));
      return item;
    },
    contextMenu(o) { var items = Array.isArray(o) ? o : (o && o.items) || []; var x = o && o.position ? o.position.left || o.position.x : lastPointer.x, y = o && o.position ? o.position.top || o.position.y : lastPointer.y; showMenu(items, x, y); },
    async alert(message, buttons) { return dialog(message, buttons); },
    async prompt(message, placeholder, defaultValue) { return dialog(message, [{ label: 'Cancel', value: false }, { label: 'OK', type: 'primary' }], defaultValue != null ? String(defaultValue) || true : true, placeholder); },
    async confirm(message) { return dialog(message, [{ label: 'Cancel', value: false }, { label: 'OK', value: true, type: 'primary' }]); },
    async showColorPicker(def) { return new Promise(function (r) { var i = document.createElement('input'); i.type = 'color'; i.value = typeof def === 'string' ? def : (def && def.defaultColor) || '#000000'; i.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(i); i.onchange = function () { r(i.value); i.remove(); }; i.click(); }); },
    async showFontPicker() { return { fontFamily: 'Inter' }; },
    async launchApp(name, args) {
      var appName = typeof name === 'object' && name ? name.name || name.app : name;
      post('launchApp', { target: String(appName || ''), args: args || (name && name.args) || null });
      var conn = { usesSDK: true, response: {}, postMessage: function () {}, on: function () {}, off: function () {}, addEventListener: function () {}, close: function () {} };
      return conn;
    },
    parentApp: function () { return null; },
    setWindowTitle: function (t) { try { document.title = String(t); } catch (e) {} post('setWindowTitle', { title: String(t) }); return Promise.resolve(); },
    setWindowSize: function () { return Promise.resolve(); }, setWindowWidth: function () { return Promise.resolve(); }, setWindowHeight: function () { return Promise.resolve(); },
    setWindowPosition: function () { return Promise.resolve(); }, setWindowX: function () { return Promise.resolve(); }, setWindowY: function () { return Promise.resolve(); },
    hideWindow: function () { post('hideWindow'); return Promise.resolve(); }, showWindow: function () { post('showWindow'); return Promise.resolve(); },
    toggleFullscreen: function () { post('fullscreen'); return Promise.resolve(); },
    onLaunchedWithItems: function (cb) { if (typeof cb === 'function') { launchHandlers.push(cb); if (pendingItems) deliverItems(pendingItems); } },
    onItemsOpened: function (cb) { ui.onLaunchedWithItems(cb); },
    onWindowClose: function (cb) { closeHandler = cb; post('closeHandler', { on: typeof cb === 'function' }); },
    on: function (ev, cb) { msgHandlers.push({ ev: ev, cb: cb }); }, off: function () {},
    getLanguage: function () { return Promise.resolve((navigator.language || 'en').split('-')[0]); },
    requestPermission: function () { return Promise.resolve(true); },
    authenticateWithPuter: function () { return Promise.resolve(Object.assign({}, USER)); },
    showFeedbackDialog: function () { return Promise.resolve(); },
    socialShare: function (url) { try { if (navigator.share) return navigator.share({ url: url }); } catch (e) {} return Promise.resolve(); },
    notify: function (o) { post('toast', { message: typeof o === 'string' ? o : (o && (o.text || o.title)) || '' }); return Promise.resolve(); },
    exit: function () { return puterObj.exit(); },
    isWindowFocused: function () { return document.hasFocus(); },
  };
  var pendingItems = null;
  async function deliverItems(paths) {
    pendingItems = paths;
    if (!launchHandlers.length) return;
    pendingItems = null;
    var items = [];
    for (var i = 0; i < paths.length; i++) { try { items.push(await fs.stat(paths[i])); } catch (e) {} }
    if (!items.length) return;
    launchHandlers.forEach(function (h) { try { h(items); } catch (e) { console.error(e); } });
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.everything !== 1 || e.source !== window.parent) return;
    var d = e.data;
    if (d.type === 'items' && Array.isArray(d.items)) deliverItems(d.items);
    if (d.type === 'requestClose') { if (closeHandler) { try { closeHandler(); } catch (x) { puterObj.exit(); } } else puterObj.exit(); }
    if (d.type === 'message') msgHandlers.forEach(function (h) { if (h.ev === 'message') try { h.cb(d.data); } catch (x) {} });
  });
  try {
    var q = new URLSearchParams(location.search).get('everything-items') || (/[#&]everything-items=([^&]+)/.exec(location.hash) || [])[1];
    if (q) pendingItems = JSON.parse(decodeURIComponent(q));
  } catch (e) {}

  /* ------------------------------------------------------------------- net */
  var net = {
    fetch: function (u, init) { return window.fetch(u, init); },
    Socket: function () { var t = new EventTarget(); t.write = function () {}; t.close = function () {}; t.on = function (n, f) { t.addEventListener(n, function (e) { f(e.detail); }); }; setTimeout(function () { t.dispatchEvent(new CustomEvent('error', { detail: 'Raw sockets are not available in Everything' })); }, 0); return t; },
  };
  net.tls = { TLSSocket: net.Socket };

  /* ------------------------------------------------------------ puter global */
  var ADJ = ['amber', 'brisk', 'calm', 'dapper', 'eager', 'fancy', 'gentle', 'happy', 'ivory', 'jolly', 'kind', 'lucky', 'mellow', 'nimble', 'olive', 'plucky', 'quiet', 'rosy', 'sunny', 'tidy', 'umber', 'vivid', 'warm', 'young', 'zesty'];
  var NOUN = ['acorn', 'brook', 'cedar', 'dune', 'ember', 'fern', 'grove', 'harbor', 'iris', 'juniper', 'kite', 'lark', 'meadow', 'nest', 'orchid', 'pebble', 'quill', 'river', 'sparrow', 'thistle', 'umbra', 'valley', 'willow', 'yarrow', 'zephyr'];
  var puterObj = {
    __everything: true,
    version: '2.0.0-everything-local',
    env: 'web',
    appID: APP,
    appName: APP,
    appDataPath: HOME + '/AppData/' + APP,
    APIOrigin: 'https://api.puter-local.invalid',
    defaultAPIOrigin: 'https://api.puter-local.invalid',
    defaultGUIOrigin: location.origin,
    authToken: AUTH_TOKEN,
    username: USERNAME,
    auth: auth, fs: fs, kv: kv, ai: ai, email: email, workers: workers, hosting: hosting, apps: apps,
    peer: peer, events: events, perms: perms, ui: ui, net: net,
    teams: { async list() { return []; }, async get() { return null; } },
    os: { async user() { return Object.assign({}, USER); }, async version() { return { version: 'local' }; } },
    threads: { async create() { return { uid: 'th-' + rid(4) }; }, async list() { return []; }, async subscribe() { return { off: function () {} }; } },
    setAuthToken: function () {}, setAPIOrigin: function () {}, setAppID: function () {}, resetAuthToken: function () {},
    initSubmodules: function () {}, configure: function () {},
    randName: function (sep) { sep = sep == null ? '-' : sep; return ADJ[Math.random() * ADJ.length | 0] + sep + NOUN[Math.random() * NOUN.length | 0] + sep + (Math.random() * 10000 | 0); },
    print: function () { var s = Array.prototype.slice.call(arguments).join(' '); console.log('[puter.print]', s); try { var d = document.createElement('div'); d.innerHTML = s; (document.body || document.documentElement).appendChild(d); } catch (e) {} },
    exit: function (code) { post('exit', { code: code || 0 }); return Promise.resolve(); },
    on: function () {}, off: function () {},
    isLocal: true,
  };

  /* Never throw on missing members: unknown properties become harmless no-ops. */
  function noop(name) {
    var target = function () {
      if (/^(is|has|can)[A-Z_]/.test(name)) return false;
      if (/^list/.test(name)) return Promise.resolve([]);
      return Promise.resolve(undefined);
    };
    return new Proxy(target, {
      get: function (t, p) {
        if (p === 'then' || p === 'catch' || p === 'finally' || p === 'toJSON' || typeof p === 'symbol') return p === Symbol.toPrimitive ? function () { return ''; } : undefined;
        if (p === 'name') return name; if (p === 'length') return 0;
        return noop(String(p));
      },
    });
  }
  var NS_FALLBACK = { perms: function () { return function () { return Promise.resolve(true); }; } };
  function wrap(obj, nsName, depth) {
    return new Proxy(obj, {
      get: function (t, p, r) {
        if (typeof p === 'symbol' || p in t) {
          var v = Reflect.get(t, p, r);
          if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof EventTarget) && Object.getPrototypeOf(v) === Object.prototype) return wrapped[p] || (wrapped[p] = wrap(v, p, depth + 1));
          return v;
        }
        if (p === 'then' || p === 'toJSON' || p === 'catch' || p === 'finally') return undefined;
        if (NS_FALLBACK[nsName]) return NS_FALLBACK[nsName](p);
        if (/^[A-Z_]+$/.test(String(p))) return undefined;
        return noop(String(p));
      },
    });
  }
  var wrapped = {};
  var puter = wrap(puterObj, 'puter', 0);
  try { Object.defineProperty(window, 'puter', { value: puter, writable: true, configurable: true, enumerable: true }); } catch (e) { window.puter = puter; }
  window.__puterLocal = { app: APP, user: USER, normPath: normPath, db: db, aiConfig: aiConfig };

  /* Hub shortcuts from inside an app: Cmd/Ctrl+K and Cmd/Ctrl+1..9, unless the app handled them. */
  if (IN_FRAME) window.addEventListener('keydown', function (e) {
    var mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey || e.defaultPrevented) return;
    var k = String(e.key || '').toLowerCase();
    if (k === 'k' || /^[1-9]$/.test(k)) { e.preventDefault(); post('key', { combo: 'mod+' + k }); }
  });

  bootstrap().catch(function (e) { console.warn('[puter-local] drive unavailable', e); });
  post('ready', { title: document.title });
  try { document.dispatchEvent(new Event('puter.ready')); window.dispatchEvent(new Event('puter-ready')); } catch (e) {}
})();
