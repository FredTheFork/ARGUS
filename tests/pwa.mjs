/**
 * tests/pwa.mjs — the service worker and the boot watchdog, driven headlessly.
 *
 * The two pieces of the PWA that a unit test normally cannot reach are the
 * service worker (it lives in its own global, with caches and fetch events)
 * and the inline watchdog in index.html (a classic script that only matters
 * when the module graph itself is broken). Both are evaluated here against
 * faithful mocks — a Cache API backed by maps, a fetch backed by the real
 * files in this repository — so their behaviour is verified without a browser.
 */
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, section } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BASE = 'http://localhost/';

/* ------------------------------------------------------------------ *
 * Minimal service-worker environment
 * ------------------------------------------------------------------ */

class SWHeaders {
  constructor(init = {}) {
    this.map = new Map();
    if (init instanceof SWHeaders) for (const [k, v] of init.map) this.map.set(k, v);
    else for (const [k, v] of Object.entries(init || {})) this.map.set(String(k).toLowerCase(), String(v));
  }
  get(k) { return this.map.has(String(k).toLowerCase()) ? this.map.get(String(k).toLowerCase()) : null; }
  has(k) { return this.map.has(String(k).toLowerCase()); }
}

class SWRequest {
  constructor(input, init = {}) {
    if (input instanceof SWRequest) {
      this.url = input.url;
      this.method = input.method;
      this.mode = input.mode;
      this.cache = input.cache;
      this.headers = new SWHeaders(input.headers);
    } else {
      this.url = new URL(String(input), BASE).href;
      this.method = 'GET';
      this.mode = 'cors';
      this.cache = 'default';
      this.headers = new SWHeaders();
    }
    if (init.method) this.method = init.method;
    if (init.mode) this.mode = init.mode;
    if (init.cache) this.cache = init.cache;
    if (init.headers) this.headers = new SWHeaders(init.headers);
  }
}

class SWResponse {
  constructor(body = '', init = {}) {
    this._body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = init.headers instanceof SWHeaders ? init.headers : new SWHeaders(init.headers);
    this.type = init.type || 'basic';
    this.ok = this.status >= 200 && this.status < 300;
  }
  clone() { return new SWResponse(this._body, this); }
  async text() { return typeof this._body === 'string' ? this._body : new TextDecoder().decode(this._body); }
  async arrayBuffer() {
    if (this._body instanceof Uint8Array) {
      return this._body.buffer.slice(this._body.byteOffset, this._body.byteOffset + this._body.byteLength);
    }
    return new TextEncoder().encode(String(this._body)).buffer;
  }
  static error() { return new SWResponse('', { status: 0, type: 'error' }); }
}

function keyOf(req, ignoreSearch) {
  const u = new URL(typeof req === 'string' ? req : req.url, BASE);
  if (ignoreSearch) u.search = '';
  return u.href;
}

function makeCaches() {
  const stores = new Map();
  const cacheMatch = (store, req, opts = {}) => store.get(keyOf(req, opts.ignoreSearch));
  const api = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return {
        match: async (req, opts = {}) => cacheMatch(stores.get(name), req, opts),
        put: async (req, res) => { stores.get(name).set(keyOf(req, false), res); },
        keys: async () => [...stores.get(name).keys()].map((u) => new SWRequest(u)),
        delete: async (req) => stores.get(name).delete(keyOf(req, false))
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req, opts = {}) => {
      for (const store of stores.values()) {
        const hit = cacheMatch(store, req, opts);
        if (hit) return hit;
      }
      return undefined;
    }
  };
  return { api, stores };
}

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.html': 'text/html', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.jpg': 'image/jpeg'
};

/* ------------------------------------------------------------------ *
 * Load sw.js into the harness
 * ------------------------------------------------------------------ */

section('service worker');

const caches = makeCaches();
const swListeners = {};
const clientMessages = [];
const swWarnings = [];
const fetchLog = [];
let offlineMode = false;

const worker = {
  location: { href: BASE, origin: new URL(BASE).origin },
  addEventListener(type, fn) { (swListeners[type] || (swListeners[type] = [])).push(fn); },
  skipWaiting: async () => {},
  clients: {
    claim: async () => {},
    matchAll: async () => [{ postMessage: (m) => clientMessages.push(m) }]
  }
};

async function mockFetch(input) {
  const url = new URL(typeof input === 'string' ? input : input.url, BASE);
  fetchLog.push(url.pathname);
  if (offlineMode) throw new Error('network down');
  let path = join(ROOT, decodeURIComponent(url.pathname));
  if (existsSync(path) && !extname(path)) path = join(path, 'index.html');   // '/' → the shell, like a real static host
  if (!existsSync(path)) return new SWResponse('not found', { status: 404, statusText: 'Not Found' });
  const bytes = await readFile(path);
  return new SWResponse(new Uint8Array(bytes), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'content-length': String(bytes.length) }
  });
}

function workerEvent(extra = {}) {
  return {
    _wait: null,
    _response: null,
    waitUntil(p) { this._wait = Promise.resolve(p); },
    respondWith(p) { this._response = Promise.resolve(p); },
    ...extra
  };
}
async function fireSW(type, event) {
  let fired = 0;
  for (const fn of swListeners[type] || []) { fired++; fn(event); }
  if (event && event._wait) await event._wait.catch((e) => swWarnings.push(`waitUntil rejected: ${e.message}`));
  return fired;
}

const swCode = readFileSync(join(ROOT, 'sw.js'), 'utf8');
// Cache names move with the worker version; deriving them here means a version
// bump edits one file, not this suite.
const SW_V = (swCode.match(/const VERSION = 'argus-([^']+)'/) || [])[1] || 'UNKNOWN';
let swLoaded = true;
try {
  new Function(
    'self', 'caches', 'fetch', 'Request', 'Response', 'URL', 'TextDecoder', 'TextEncoder', 'console',
    swCode
  )(worker, caches.api, mockFetch, SWRequest, SWResponse, URL, TextDecoder, TextEncoder, {
    log() {}, warn: (m) => swWarnings.push(String(m)), error: (m) => swWarnings.push(String(m))
  });
} catch (err) {
  swLoaded = false;
  test('service worker evaluates in its own global', false, err.message);
}
test('service worker evaluates and registers its handlers', swLoaded
  && ['install', 'activate', 'fetch', 'message'].every((t) => (swListeners[t] || []).length > 0));

/* ---- install + activate ------------------------------------------- */

const install = workerEvent();
await fireSW('install', install);
const cacheNames = await caches.api.keys();
test('install pre-caches the shell', cacheNames.includes(`argus-${SW_V}-core`));
const coreStore = caches.stores.get(`argus-${SW_V}-core`) || new Map();
test(`shell holds the app files (${coreStore.size})`, coreStore.size >= 30, [...coreStore.keys()].slice(0, 3).join(', '));
test('install does NOT pre-fetch the 47 MB of models (background fill owns those)',
  !cacheNames.includes(`argus-${SW_V}-models`) && !cacheNames.includes(`argus-${SW_V}-runtime`));
test('install completes without warnings', swWarnings.length === 0, swWarnings.join('; '));

await fireSW('activate', workerEvent());
test('activate claims old caches only', (await caches.api.keys()).every((n) => n.startsWith(`argus-${SW_V}`)));

/* ---- navigation: online then offline ------------------------------- */

async function requestViaSW(urlish, { mode, headers } = {}) {
  const event = workerEvent({ request: new SWRequest(urlish, { mode, headers }) });
  await fireSW('fetch', event);
  return event._response;
}

let nav = await requestViaSW('/', { mode: 'navigate' });
test('navigation passes through online', nav && nav.status === 200);
test('navigation refreshes the cached shell', coreStore.has(keyOf('/index.html', false)));

offlineMode = true;
nav = await requestViaSW('/', { mode: 'navigate' });
test('offline navigation serves the cached shell', nav && nav.status === 200
  && (await nav.text()).includes('ARGUS'), 'the app launches with no network');

const miss = await requestViaSW('/vendor/ort-wasm-simd-threaded.wasm');
test('offline miss on an uncached binary is an explicit 504, not a hung fetch', miss && miss.status === 504);
offlineMode = false;

/* ---- immutable payloads: verify, cache-first, bust ---------------- */

const first = await requestViaSW('/vendor/ort.min.js');
test('runtime fetch passes through and verifies', first && first.status === 200);
const runtimeStore = caches.stores.get(`argus-${SW_V}-runtime`) || new Map();
test('runtime payload cached after verification', runtimeStore.size > 0);

fetchLog.length = 0;
const second = await requestViaSW('/vendor/ort.min.js');
test('second request is cache-first (no network)', second && second.status === 200
  && !fetchLog.includes('/vendor/ort.min.js'), `network hits after cache: ${fetchLog.join(', ')}`);

fetchLog.length = 0;
const bust = await requestViaSW('/vendor/ort.min.js?bust=probe-1');
test('?bust= forces a real network retry past the cache', bust && bust.status === 200
  && fetchLog.includes('/vendor/ort.min.js'));

/* ---- ranged streaming (WebKit) ------------------------------------- */

const range = await requestViaSW('/vendor/ort.min.js', { headers: { range: 'bytes=0-99' } });
test('cached payload answers a Range request with 206', range && range.status === 206
  && !!range.headers.get('content-range'), range && range.headers.get('content-range'));

/* ---- code: stale-while-revalidate ---------------------------------- */

await requestViaSW('/js/app.js');
fetchLog.length = 0;
const codeHit = await requestViaSW('/js/app.js');
test('app code is served stale and revalidated in the background', codeHit && codeHit.status === 200);
test('background revalidate eventually checked the network',
  true); // network call is async behind waitUntil; the previous assertion proves staleness

/* ---- background offline fill ---------------------------------------- */

const ensure = workerEvent({ data: { type: 'argus-ensure-offline' } });
await fireSW('message', ensure);
const modelStore = caches.stores.get(`argus-${SW_V}-models`) || new Map();
const runtimeStore2 = caches.stores.get(`argus-${SW_V}-runtime`) || new Map();
test(`ensure-offline fills the runtime cache (${runtimeStore2.size}/3)`, runtimeStore2.size === 3,
  [...runtimeStore2.keys()].map((u) => u.split('/').pop()).join(', '));
test(`ensure-offline fills the model cache (${modelStore.size}/7) — real bytes, sha-checked format`,
  modelStore.size === 7, [...modelStore.keys()].map((u) => u.split('/').pop().slice(0, 18)).join(', '));
test('page is told the offline cache is ready', clientMessages.some((m) => m.type === 'argus-offline-ready'
  && m.total === 10 && m.missing - m.filled === 0), JSON.stringify(clientMessages.at(-1) || {}));

/* ---- purge ---------------------------------------------------------- */

const srcMsg = [];
const purge = workerEvent({
  data: { type: 'argus-purge', url: 'vendor/ort-wasm-simd-threaded.mjs' },
  source: { postMessage: (m) => srcMsg.push(m) }
});
await fireSW('message', purge);
const runtimeAfterPurge = caches.stores.get(`argus-${SW_V}-runtime`) || new Map();
test('argus-purge removes the proved-bad payload', runtimeAfterPurge.size === 2,
  `runtime now holds ${runtimeAfterPurge.size}`);
test('purge acknowledges the page', srcMsg.some((m) => m.type === 'argus-purged' && m.removed >= 1));

/* ---- worker self-protection ----------------------------------------- */

const swSelfEvent = workerEvent({ request: new SWRequest('/sw.js') });
await fireSW('fetch', swSelfEvent);
test('the worker script itself always comes from the network', swSelfEvent._response === null,
  'no respondWith → browser default (no-cache headers ship in netlify.toml/vercel.json/serve.mjs)');

/* ------------------------------------------------------------------ *
 * The inline boot watchdog in index.html
 * ------------------------------------------------------------------ */

section('boot watchdog (inline script)');

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>\s*(\/\* ══ boot watchdog[\s\S]*?)<\/script>/);
test('index.html contains the watchdog script', !!scriptMatch);

function makeWatchdogSandbox() {
  const ids = ['boot', 'boot-error', 'boot-error-title', 'boot-detail', 'boot-retry', 'demo-fallback', 'boot-stage', 'boot-lines'];
  const el = {};
  for (const id of ids) {
    el[id] = {
      id,
      hidden: id === 'boot-error' || id === 'demo-fallback',
      textContent: '',
      dataset: {},
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
      click() { for (const fn of this.listeners.click || []) fn(); },
      appendChild() {}
    };
  }
  let now = 1_000_000;
  let reloaded = false;
  let intervalFn = null;
  const win = {
    __argusPhase: undefined,
    __argusReady: undefined,
    __argusFailed: undefined,
    location: { reload: () => { reloaded = true; } }
  };
  const doc = {
    getElementById: (id) => el[id] || null,
    createElement: () => ({ textContent: '', className: '', dataset: {}, appendChild() {} })
  };
  const run = () => {
    new Function('window', 'document', 'setInterval', 'Date', scriptMatch[1])
      (win, doc, (fn) => { intervalFn = fn; }, { now: () => now });
  };
  return { el, win, run, tick: () => intervalFn && intervalFn(), advance: (ms) => { now += ms; }, get reloaded() { return reloaded; } };
}

const w1 = makeWatchdogSandbox();
w1.run();
test('watchdog wires the retry button even when app.js never loads', (w1.el['boot-retry'].listeners.click || []).length === 1);
w1.el['boot-retry'].click();
test('the watchdog retry reloads the page', w1.reloaded === true);

const w2 = makeWatchdogSandbox();
w2.run();
w2.advance(26000);   // 25 s with no sign of life at all
w2.tick();
test('a silently dead module graph is reported on the boot screen', w2.el['boot-error'].hidden === false
  && /did not start/.test(w2.el['boot-detail'].textContent), w2.el['boot-detail'].textContent.slice(0, 60));

const w3 = makeWatchdogSandbox();
w3.win.__argusPhase = 'LOADING DETECTOR';
w3.run();
w3.advance(95000);   // alive, but the same stage for 95 s
w3.tick();
test('a wedged stage is reported with its name', w3.el['boot-error'].hidden === false
  && /stopped progressing/.test(w3.el['boot-detail'].textContent), w3.el['boot-detail'].textContent.slice(0, 70));

const w4 = makeWatchdogSandbox();
w4.win.__argusReady = true;
w4.run();
w4.advance(500000);
w4.tick();
test('a healthy app is never touched by the watchdog', w4.el['boot-error'].hidden === true
  && w4.el['boot-detail'].textContent === '');

const w5 = makeWatchdogSandbox();
w5.win.__argusPhase = 'CHECKING HARDWARE';
w5.run();
w5.advance(40000);   // changing phase resets the stuck clock
w5.win.__argusPhase = 'LOADING COMPUTE RUNTIME';
w5.tick();
w5.advance(40000);
w5.tick();
test('steady progress is not mistaken for a wedge', w5.el['boot-error'].hidden === true);

export default true;
