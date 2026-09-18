/**
 * sw.js — ARGUS offline shell.
 *
 * Pre-caches the whole application — HTML, CSS, ES modules, the
 * onnxruntime-web runtime, both WASM binaries and the 12.7 MB YOLOv8-nano
 * weights — so the assistant works with no network at all after the first
 * visit. Range requests are answered from cache because some WebKit builds
 * stream large binaries that way.
 *
 * Two rules stop this cache from ever pinning the app to a broken boot:
 *
 *   1. Nothing large is cached until its bytes have been checked (WASM magic
 *      and size, ONNX protobuf header, plausible JavaScript for modules). A
 *      proxy that answers a runtime download with an error page, a redirect
 *      stub or a truncated body must not become permanent state.
 *   2. A request carrying ?bust= is the loader saying "my previous copy was
 *      rejected". It bypasses the cache in both directions, so a retry is a
 *      real retry. Pages can also ask the worker to drop an asset outright
 *      (message type 'argus-purge') once the runtime has proved it unusable.
 */

const VERSION = 'argus-1.0.2';   // bump to force a full re-cache on the next launch
const CORE = `${VERSION}-core`;
const RUNTIME = `${VERSION}-runtime`;
const MODELS = `${VERSION}-models`;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/detector.js',
  './js/install.js',
  './js/tracker.js',
  './js/speech.js',
  './js/ui.js',
  // Bundled sample feed, so ?demo=1 also works with no network at all.
  './tools/sample-bus.jpg',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// Only the default (WASM) runtime pair is precached: it is the tier every
// browser can use, and it keeps an installed app near 25 MB instead of 47 MB.
// The WebGPU pair is ~22 MB on its own and is fetched on demand by the first
// GPU-accelerated boot, then cached by the fetch handler below. A device that
// goes offline before that still works — the loader falls back to the cached
// WASM tier.
const RUNTIME_ASSETS = [
  './vendor/ort.min.js',
  './vendor/ort-wasm-simd-threaded.mjs',
  './vendor/ort-wasm-simd-threaded.wasm'
];

const MODEL_ASSETS = ['./models/yolov8n.onnx'];

/**
 * Is this payload safe to keep forever? Only the kinds that are served
 * cache-first are judged, and only on their first bytes — but that is exactly
 * enough to reject an HTML error page, a truncated transfer or a mislabelled
 * file, which is what strands users on "previous call to initWasm() failed".
 */
function looksRight(pathname, bytes) {
  if (/\.wasm$/.test(pathname)) {
    return bytes.length >= 512 * 1024
      && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;   // \0asm
  }
  if (/\.onnx$/.test(pathname)) {
    // ONNX is protobuf: field 1 (ir_version) is a varint, so a real model starts
    // 0x08. An error page starts '<'.
    return bytes.length >= 1024 * 1024 && bytes[0] === 0x08;
  }
  if (/\.mjs$/.test(pathname) || /\.js$/.test(pathname)) {
    const head = new TextDecoder().decode(bytes.subarray(0, 400));
    return !/^\s*</.test(head) && /function|=>|import|export|const|var|let/.test(head);
  }
  return true;
}

const asResponse = (bytes, source) => new Response(bytes, {
  status: 200,
  statusText: (source && source.statusText) || 'OK',
  headers: (source && source.headers) || undefined
});

/**
 * Read a response body exactly once and grade it.
 *
 * Reading it once matters: an earlier version of this file validated through
 * `response.clone()`, which tees the network stream, and Chrome then fails
 * `Cache.put()` with "encountered a network error" on the large binaries —
 * silently leaving an "offline" app with no runtime cached. Buffering the bytes
 * and building a fresh Response avoids the tee entirely.
 */
async function readPayload(pathname, response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, ok: looksRight(pathname, bytes) };
}

/**
 * Fetch and verify before writing to a cache. Failures are best-effort — one
 * missing asset must never block the install — but they are reported, because
 * "offline, and one binary is missing" should be visible in a console rather
 * than guessed at.
 */
async function precacheVerified(cacheName, urls, { reload = true } = {}) {
  const cache = await caches.open(cacheName);
  const rejected = [];
  await Promise.allSettled(urls.map(async (url) => {
    try {
      const response = await fetch(new Request(url, reload ? { cache: 'reload' } : undefined));
      const pathname = new URL(url, self.location.href).pathname;
      if (!response || response.status !== 200) { rejected.push(`${url} (HTTP ${response && response.status})`); return; }
      const { bytes, ok } = await readPayload(pathname, response);
      if (!ok) { rejected.push(`${url} (failed verification)`); return; }
      await cache.put(new Request(url), asResponse(bytes, response));
    } catch (err) {
      rejected.push(`${url} (${(err && err.message) || err})`);
    }
  }));
  if (rejected.length) console.warn(`[argus-sw] precache incomplete for ${cacheName}: ${rejected.join('; ')}`);
  return rejected;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Best-effort: never let one missing or unverifiable asset block the install.
    await precacheVerified(CORE, CORE_ASSETS);
    await precacheVerified(RUNTIME, RUNTIME_ASSETS);
    await precacheVerified(MODELS, MODEL_ASSETS, { reload: false });
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/**
 * A cached asset whose bytes have changed means a new build is waiting. Tell
 * the open pages so they can offer a reload instead of silently running stale
 * code until the next launch.
 */
async function notifyIfChanged(pathname, previous, response) {
  try {
    const [before, after] = await Promise.all([
      previous.clone().text(),
      response.clone().text()
    ]);
    if (before === after) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'argus-update-cached', url: pathname });
  } catch { /* binary or opaque body — nothing to compare */ }
}

async function respondWithRange(request, cached) {
  const range = request.headers.get('range');
  if (!range || !cached) return cached;
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return cached;
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  const slice = buffer.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cached.headers.get('content-type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell so launches are instant and offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CORE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CORE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // The worker script itself must always come from the network: caching it
  // would pin this service worker forever.
  if (url.pathname.endsWith('/sw.js')) return;

  // Immutable payloads (runtime binaries, model weights) are cache-first:
  // they never change under the same URL and are too large to re-fetch.
  // Application code is stale-while-revalidate so a new build lands on the
  // next launch without the user having to clear anything.
  const isImmutable = /\.onnx$/.test(url.pathname) || /\/vendor\//.test(url.pathname);

  event.respondWith((async () => {
    // "My previous copy was rejected" — never answer this from cache, and never
    // store the answer under a cache-first key. A retry has to be able to see
    // the network again, or a repaired host can never be reached.
    if (isImmutable && url.searchParams.has('bust')) {
      try {
        return await fetch(request);
      } catch {
        return new Response('Offline and asset not cached.', { status: 504, statusText: 'Offline' });
      }
    }

    const cached = await caches.match(request, { ignoreSearch: true });

    if (isImmutable) {
      if (cached) return request.headers.has('range') ? respondWithRange(request, cached) : cached;
      try {
        const response = await fetch(request);
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const { bytes, ok } = await readPayload(url.pathname, response);
        const payload = asResponse(bytes, response);
        if (ok) {
          const cache = await caches.open(/\.onnx$/.test(url.pathname) ? MODELS : RUNTIME);
          cache.put(request, payload.clone());
        } else {
          // Hand it on so the page reports the specific fault; just never store it.
          console.warn('[argus-sw] refused to cache an unverified payload:', url.pathname);
        }
        return payload;
      } catch {
        return new Response('Offline and asset not cached.', { status: 504, statusText: 'Offline' });
      }
    }

    const network = fetch(request).then(async (response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const cache = await caches.open(CORE);
        const previous = await cache.match(request, { ignoreSearch: true });
        if (previous) await notifyIfChanged(url.pathname, previous, response);
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => null);

    if (cached) {
      // Serve immediately, refresh in the background for next time.
      event.waitUntil(network);
      return cached;
    }
    const response = await network;
    return response || new Response('Offline and asset not cached.', { status: 504, statusText: 'Offline' });
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'skip-waiting') { self.skipWaiting(); return; }

  // The page only asks for this after it has proved a cached asset is unusable
  // (failed length/magic checks, or the runtime refused to build a session from
  // it). Deleting by pathname also clears entries cached under other queries.
  if (data && data.type === 'argus-purge' && data.url) {
    event.waitUntil((async () => {
      let removed = 0;
      const target = new URL(data.url, self.location.href).pathname;
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname === target) {
            await cache.delete(request);
            removed++;
          }
        }
      }
      if (event.source) event.source.postMessage({ type: 'argus-purged', url: target, removed });
    })());
  }
});
