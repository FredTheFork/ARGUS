/**
 * core.js — compute runtime, tensor plumbing and image mathematics.
 *
 * One ONNX Runtime instance serves every model in ARGUS. The tier logic is
 * deliberately the same shape as the original single-model loader, because it
 * solves the problem that actually bites in the field: a host handing back a
 * truncated WASM binary or an error page for the runtime bundle. Runtime bytes
 * are fetched here, checked (HTTP status, declared length, WebAssembly magic,
 * plausible JavaScript) and handed to ORT as same-origin blob URLs, so the
 * runtime never touches the network for itself.
 *
 * Everything else in this file exists because the vision modules need it:
 * letterboxing, NHWC/NCHW conversion, perspective warps for OCR quads,
 * non-maximum suppression, and a handful of numeric helpers.
 */

export const VENDOR = 'vendor/';

/* ------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------ */

// Every tier boots with ORT's proxy worker by default: all graph execution —
// CPU and GPU alike — then happens in a worker, and a 200 ms OCR pass or a
// 640 px pose run blocks a worker thread instead of the video feed and the
// overlay. Attempt 1 of each tier uses the proxy; if anything in the chain
// fails (worker spawn blocked, WebGPU absent inside the worker, a wedged
// import), the tier's attempt 2 falls back to in-thread inference rather
// than losing the runtime altogether.
const TIERS = [
  {
    id: 'webgpu',
    bundle: 'ort.webgpu.min.js',
    base: 'ort-wasm-simd-threaded.jsep',
    providers: ['webgpu', 'wasm'],
    label: 'WebGPU',
    proxy: true,
    needsAdapter: true
  },
  {
    id: 'wasm',
    bundle: 'ort.min.js',
    base: 'ort-wasm-simd-threaded',
    providers: ['wasm'],
    label: 'WASM SIMD',
    proxy: true,
    needsAdapter: false
  }
];

export class Runtime {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.ort = null;
    this.tier = null;
    this.providers = ['wasm'];
    this.env = null;
    this._blobUrls = [];
    this.attemptsPerTier = 2;
    this.lastError = null;
    this.sessions = new Map();
  }

  static get webgpuAvailable() {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  static async gpuReady() {
    if (!Runtime.webgpuAvailable) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch { return false; }
  }

  get threadCount() {
    return this.ort ? this.ort.env.wasm.numThreads : 1;
  }

  /** Boot ORT, preferring the WebGPU build then falling back to WASM. */
  async boot({ backend = 'auto', onStage = () => {} } = {}) {
    const gpu = await Runtime.gpuReady();
    if (backend === 'webgpu' && !gpu) this.onLog('warn: WebGPU requested but no adapter is exposed — using WASM');
    if (backend === 'wasm' && gpu) this.onLog('note: WebGPU is available but WASM was forced in settings');

    let tiers = TIERS;
    if (backend === 'wasm') tiers = tiers.filter((t) => t.id === 'wasm');
    else if (backend === 'auto' && !gpu) tiers = tiers.filter((t) => t.id !== 'webgpu');

    const failures = [];
    for (const tier of tiers) {
      if (tier.needsAdapter && !gpu) continue;
      for (let attempt = 1; attempt <= this.attemptsPerTier; attempt++) {
        const bust = attempt > 1 ? `${Date.now()}-${attempt}` : '';
        if (attempt > 1) {
          this.onLog(`retry: ${tier.id} attempt ${attempt} of ${this.attemptsPerTier} (cache bypassed)`);
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
        try {
          // Attempt 2 of a tier drops the proxy worker — the fallback path
          // when worker creation or its first run fails in this webview.
          const useProxy = attempt === 1 && tier.proxy === true;
          await this._startTier(tier, bust, onStage, useProxy);
          this.tier = tier.id;
          this.providers = tier.providers;
          this.label = tier.label;
          this.proxied = useProxy;
          return { tier: tier.id, label: tier.label, threads: this.threadCount, proxy: this.proxied };
        } catch (err) {
          const detail = `${tier.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${err.message}`;
          failures.push(detail);
          this.onLog(`warn: ${detail}`);
        }
      }
    }
    this.lastError = failures.join('; ');
    throw new Error(this.lastError);
  }

  async _startTier(tier, bust, onStage, useProxy = false) {
    onStage('LOADING COMPUTE RUNTIME', 0.2);
    try { delete window.ort; } catch { window.ort = undefined; }
    await new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = `${VENDOR}${tier.bundle}${bust ? `?bust=${bust}` : ''}`;
      tag.async = false;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error(`could not load ${tier.bundle} (network or blocked)`));
      document.head.appendChild(tag);
    });
    const ort = (this.ort = window.ort);
    if (!ort || !ort.InferenceSession) throw new Error(`${tier.bundle} loaded but did not expose onnxruntime`);

    const wasmUrl = `${VENDOR}${tier.base}.wasm`;
    const mjsPath = `${VENDOR}${tier.base}.mjs`;
    let wasmBytes; let mjsText;
    try {
      [wasmBytes, mjsText] = await Promise.all([
        fetchVerified(wasmUrl, {
          label: `WASM RUNTIME (${tier.label.toUpperCase()})`,
          bust,
          magic: [0x00, 0x61, 0x73, 0x6d],
          minBytes: 512 * 1024,
          onStage
        }),
        fetchText(mjsPath, bust)
      ]);
      if (!/WebAssembly/.test(mjsText) || /^\s*</.test(mjsText)) {
        throw new Error(`${tier.base}.mjs is not valid JavaScript`);
      }
    } catch (err) {
      purgeCached(wasmUrl);
      purgeCached(mjsPath);
      throw err;
    }

    const mjsBlob = URL.createObjectURL(new Blob([mjsText], { type: 'text/javascript' }));
    const wasmBlob = URL.createObjectURL(new Blob([wasmBytes], { type: 'application/wasm' }));
    ort.env.wasm.wasmBinary = undefined;
    ort.env.wasm.wasmPaths = { mjs: mjsBlob, wasm: wasmBlob };
    this._blobUrls.push(mjsBlob, wasmBlob);

    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = useProxy === true;
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4))
      : 1;
    ort.env.logLevel = 'error';
    this.env = ort.env;
    // Prove the whole chain — worker spawn (when proxied), blob-binary import,
    // session build, run, output read — before declaring the tier usable.
    // A runtime that only half-works must fail here, at boot, with a retry,
    // not three seconds later inside a camera frame.
    await this._smokeTest(useProxy);
    onStage('COMPUTE RUNTIME READY', 0.35);
    this.onLog(`runtime: ${tier.label}, threads=${ort.env.wasm.numThreads}, proxy=${!!useProxy}, isolated=${!!self.crossOriginIsolated}`);
    return ort;
  }

  /**
   * Create and run a 1-op Identity model end to end. The graph is a ~130-byte
   * protobuf built here, so the check costs nothing to ship and exercises
   * exactly the path every session will take (same EP, same proxy setting,
   * same wasm binary).
   */
  async _smokeTest(useProxy) {
    // The tier's own provider list — the exact path the detector takes.
    await this._smokeSession(this.providers);
    // On a GPU tier, the classifier/OCR/pose sessions deliberately run on the
    // CPU EP, which under the proxy is a different worker-side path; prove it
    // too, so nothing can pass boot and fail three seconds into a frame.
    if (useProxy && this.providers.some((p) => p !== 'wasm')) {
      await this._smokeSession(['wasm']);
    }
    return true;
  }

  async _smokeSession(providers) {
    const session = await this.ort.InferenceSession.create(smokeModelBytes(), {
      executionProviders: providers,
      graphOptimizationLevel: 'basic'
    });
    const input = new this.ort.Tensor('float32', new Float32Array([1]), [1]);
    const feeds = {};
    feeds[session.inputNames[0]] = input;
    const out = await session.run(feeds);
    const got = out[session.outputNames[0]];
    if (!got || got.data?.[0] !== 1) throw new Error('runtime smoke test returned a wrong answer');
    await session.release?.();
  }

  /**
   * Create (or reuse) a session for a model. Sessions are cached by URL so a
   * module that is toggled off and on again does not re-download 10 MB.
   */
  async session(url, { label = url, ep = null, onProgress = () => {}, verify = false } = {}) {
    if (this.sessions.has(url)) return this.sessions.get(url);
    const bytes = await fetchVerified(url, {
      label,
      minBytes: 64 * 1024,
      onStage: (msg, pct) => onProgress(pct, msg)
    });
    if (!isOnnx(bytes)) throw new Error(`${label} is not an ONNX protobuf (bad header)`);
    // Hashing 13 MB costs a few milliseconds and turns "the file arrived" into
    // "this is the file the manifest describes".
    const digest = verify ? await sha256(bytes) : null;
    const providers = ep || this.providers;
    const started = performance.now();
    const session = await this.ort.InferenceSession.create(bytes.buffer, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential'
    });
    const wrapper = new Session(session, {
      url, label, providers,
      bytes: bytes.length,
      sha256: digest,
      loadMs: Math.round(performance.now() - started),
      ort: this.ort
    });
    this.sessions.set(url, wrapper);
    this.onLog(`model ready — ${label}, ${(bytes.length / 1048576).toFixed(1)} MB, ${wrapper.loadMs} ms, ${providers.join('>')}`);
    return wrapper;
  }

  release(url) {
    const s = this.sessions.get(url);
    if (s) { try { s.session.release?.(); } catch { /* already gone */ } this.sessions.delete(url); }
  }
}

/**
 * A minimal valid ONNX model — one Identity node, one float input, one float
 * output — encoded as protobuf bytes at call time. It is the boot smoke test's
 * workload: cheap to build, and it exercises the exact session path (EP,
 * proxy, wasm binary) that every real model will take.
 */
export function smokeModelBytes() {
  // protobuf primitives
  const varint = (n) => {
    const out = [];
    let v = n;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  };
  const tag = (field, wire) => varint((field << 3) | wire);
  const lenField = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload];
  const stringField = (field, s) => lenField(field, [...new TextEncoder().encode(s)]);
  const intField = (field, n) => [...tag(field, 0), ...varint(n)];

  // TensorType { elem_type: 1 (FLOAT), shape { dim { dim_value: 1 } } }
  const dim = lenField(1, intField(1, 1));
  const shape = lenField(2, lenField(1, dim));
  const tensorType = lenField(1, [...intField(1, 1), ...shape]);
  const valueInfo = (name) => lenField(11 + (name === 'y' ? 1 : 0), [...stringField(1, name), ...lenField(2, tensorType)]);

  const node = lenField(1, [
    ...stringField(1, 'x'),                 // input
    ...stringField(2, 'y'),                 // output
    ...stringField(4, 'Identity')           // op_type
  ]);
  const graph = lenField(7, [
    ...node,
    ...stringField(2, 'argus-smoke'),
    ...valueInfo('x'),                      // field 11: input
    ...valueInfo('y')                       // field 12: output
  ]);
  const model = [
    ...intField(1, 6),                      // ir_version
    ...lenField(8, intField(2, 13)),        // opset_import { domain: "" (default), version: 13 }
    ...graph
  ];
  return new Uint8Array(model);
}

/** Wrapper that serialises runs: ORT sessions are not re-entrant per frame. */
export class Session {
  constructor(session, meta = {}) {
    this.session = session;
    this.meta = meta;
    this.ort = meta.ort || null;      // the ORT namespace, for tensor construction
    this.inputs = session.inputNames;
    this.outputs = session.outputNames;
    // Declared tensor shapes. Fixed-shape graphs (the quantised pose model is
    // 640x640, the classifier 224x224) must be fed exactly what they ask for —
    // asking the session beats hard-coding a size that a future re-export
    // silently changes.
    this.inputMetadata = session.inputMetadata || null;
    this.outputMetadata = session.outputMetadata || null;
    this._queue = Promise.resolve();
    this.busy = false;
  }

  /**
   * Square input size of the first input, or null when the height and width are
   * dynamic. Dynamic graphs are free to be fed whatever the caller wants.
   */
  get fixedSize() {
    const shape = this.inputMetadata?.[0]?.shape;
    if (!shape || shape.length !== 4) return null;
    const h = Number(shape[shape.length - 2]);
    const w = Number(shape[shape.length - 1]);
    if (!Number.isFinite(h) || !Number.isFinite(w) || h < 32 || w < 32) return null;
    return Math.max(h, w);
  }

  get loadMs() { return this.meta.loadMs || 0; }
  get bytes() { return this.meta.bytes || 0; }
  get sha256() { return this.meta.sha256 || null; }

  run(feeds) {
    this.busy = true;
    const task = this._queue.then(async () => {
      const out = await this.session.run(feeds);
      return out;
    });
    this._queue = task.catch(() => {}).then(() => { this.busy = false; });
    return task;
  }

  /**
   * Warm the graph with a correctly-shaped zero tensor so frame 1 is not slow.
   * The tensor must carry the declared dims: a bare typed array would be read
   * as a rank-1 tensor, rejected by every graph here, and the failure was
   * swallowed as "best-effort" — so every first pass paid ORT's cold start.
   */
  async warmup(shape, dtype = 'float32') {
    if (!this.ort) return;
    const data = new Float32Array(shape.reduce((a, b) => a * b, 1));
    const feeds = {};
    feeds[this.inputs[0]] = new this.ort.Tensor(dtype, data, [...shape]);
    try { await this.run(feeds); } catch { /* warmup is best-effort */ }
  }
}

/* ------------------------------------------------------------------ *
 * Verified fetching (shared by runtime + models)
 * ------------------------------------------------------------------ */

function isOnnx(bytes) {
  // ONNX protobuf starts with 0x08 (field 1, varint) or 0x0a; the IR version
  // field is the first byte in practice. Reject HTML/JSON outright.
  const b0 = bytes[0];
  return b0 === 0x08 || b0 === 0x0a;
}

export function purgeCached(url) {
  try {
    const sw = navigator.serviceWorker;
    if (sw && sw.controller) sw.controller.postMessage({ type: 'argus-purge', url: new URL(url, location.href).href });
  } catch { /* no worker in scope */ }
}

export async function fetchVerified(url, { label = '', bust = '', magic = null, minBytes = 0, onStage = () => {} } = {}) {
  const full = bust ? `${url}${url.includes('?') ? '&' : '?'}bust=${bust}` : url;
  const STALL_MS = 30000;
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), STALL_MS);
  const bump = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), STALL_MS); };

  let res;
  try {
    res = await fetch(full, { cache: 'no-store', signal: ctrl.signal });
  } catch (err) {
    clearTimeout(stall);
    if (ctrl.signal.aborted) throw new Error(`${label || url} stalled — no response within ${STALL_MS / 1000}s`);
    throw new Error(`${label || url} unreachable (${err.message})`);
  }
  if (!res.ok) { clearTimeout(stall); throw new Error(`${label || url} → HTTP ${res.status} ${res.statusText}`); }

  const declared = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  try {
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        chunks.push(value);
        received += value.length;
        if (declared) onStage(`${label}  ${(received / 1048576).toFixed(1)} / ${(declared / 1048576).toFixed(1)} MB`, 0.35 + 0.6 * (received / declared));
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      received = buf.length;
    }
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${label || url} stalled at ${(received / 1048576).toFixed(1)} MB`);
    throw new Error(`${label || url} interrupted at ${received} bytes (${err.message})`);
  } finally { clearTimeout(stall); }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  if (declared && bytes.length !== declared) throw new Error(`${label || url} truncated — ${bytes.length} of ${declared} bytes`);
  if (bytes.length < minBytes) throw new Error(`${label || url} too small — ${bytes.length} bytes (expected ${minBytes}+)`);
  if (magic && !magic.every((b, i) => bytes[i] === b)) {
    throw new Error(`${label || url} header mismatch (${[...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' ')})`);
  }
  return bytes;
}

async function fetchText(url, bust = '') {
  const full = bust ? `${url}${url.includes('?') ? '&' : '?'}bust=${bust}` : url;
  const res = await fetch(full, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** SHA-256 of a fetched model, used once per file to prove the bytes on disk. */
export async function sha256(bytes) {
  if (!crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * Canvas / ImageData plumbing
 *
 * Every canvas here is pooled: allocating a 2-D backing store (and the
 * readback buffer that follows it) on each call is one of the most expensive
 * things a per-frame vision loop can do on a phone. Each named scratch slot
 * keeps exactly one canvas and grows it only when the requested size changes.
 * ------------------------------------------------------------------ */

const scratchPool = new Map();
export function scratch(key, w, h) {
  let c = scratchPool.get(key);
  if (!c) {
    c = document.createElement('canvas');
    scratchPool.set(key, c);
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

export function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}

/**
 * Draw an ImageData into a pooled canvas and return it — the shared first
 * half of every "ImageData in, resized ImageData out" operation below.
 */
export function putFrame(img, key) {
  const src = scratch(key, img.width, img.height);
  ctx2d(src).putImageData(img, 0, 0);
  return src;
}

/** Resize but keep the aspect ratio — used everywhere a model wants "fit". */
export function fitSize(w, h, target, mode = 'min') {
  const scale = mode === 'min' ? Math.min(target / w, target / h) : Math.max(target / w, target / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

export function resizeImageData(src, w, h) {
  const c = scratch('resize', Math.max(1, w), Math.max(1, h));
  const ctx = ctx2d(c);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(putFrame(src, 'resize-src'), 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function cropImageData(src, x, y, w, h) {
  const c = scratch('crop', Math.max(1, w), Math.max(1, h));
  const ctx = ctx2d(c);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(putFrame(src, 'crop-src'), x, y, w, h, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * Bilinear perspective warp — the OCR recogniser needs a rectified text strip
 * from a quad whose corners are in any order or orientation.
 */
export function warpQuad(src, quad, outW, outH) {
  const out = new ImageData(outW, outH);
  const [p0, p1, p2, p3] = quad;   // tl, tr, br, bl
  const sd = src.data;
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const sx = (1 - v) * ((1 - u) * p0[0] + u * p1[0]) + v * ((1 - u) * p3[0] + u * p2[0]);
      const sy = (1 - v) * ((1 - u) * p0[1] + u * p1[1]) + v * ((1 - u) * p3[1] + u * p2[1]);
      const di = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) {
        out.data[di] = 127; out.data[di + 1] = 127; out.data[di + 2] = 127; out.data[di + 3] = 255;
        continue;
      }
      const x0 = sx | 0; const y0 = sy | 0;
      const fx = sx - x0; const fy = sy - y0;
      const i00 = (y0 * src.width + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + src.width * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        out.data[di + c] = top * (1 - fy) + bot * fy;
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

/** Rotate 180° — the OCR orientation classifier sometimes insists. */
export function rotate180(src) {
  const out = new ImageData(src.width, src.height);
  const w = src.width; const h = src.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((h - 1 - y) * w + (w - 1 - x)) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

/**
 * ImageData → model tensor. Handles the three layouts ARGUS needs (float NCHW
 * scaled to [0,1] or [-1,1], float NHWC, and raw uint8 NHWC passed as float for
 * the Lite4 head) so no model needs bespoke pre-processing code.
 */
export function toTensor(img, {
  layout = 'NCHW',
  scale = 1 / 255,
  mean = 0,
  std = 1,
  output = 'float32'
} = {}) {
  const { width: w, height: h, data } = img;
  const c = 3;
  const n = w * h;
  const out = output === 'uint8' ? new Uint8Array(n * c) : new Float32Array(n * c);
  if (output === 'uint8') {
    if (layout === 'NCHW') {
      for (let ch = 0; ch < c; ch++) {
        const base = ch * n;
        for (let i = 0; i < n; i++) out[base + i] = data[i * 4 + ch];
      }
    } else {
      for (let i = 0; i < n; i++) {
        const s = i * 4; const d = i * 3;
        out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
      }
    }
    return out;
  }
  // Precompute the affine terms once: (v * scale - mean) / std ===
  // v * k + b, so the inner loop is one multiply and one add per element.
  const k = scale / std;
  const b = -mean / std;
  if (layout === 'NCHW') {
    // Channel-outer keeps the writes contiguous; the read stride is a fixed 4.
    for (let ch = 0; ch < c; ch++) {
      const base = ch * n;
      let s = ch;
      for (let i = 0; i < n; i++, s += 4) out[base + i] = data[s] * k + b;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const s = i * 4; const d = i * 3;
      out[d] = data[s] * k + b;
      out[d + 1] = data[s + 1] * k + b;
      out[d + 2] = data[s + 2] * k + b;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Numeric helpers
 * ------------------------------------------------------------------ */

export function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

export function std(arr, m = mean(arr)) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return arr.length ? Math.sqrt(s / arr.length) : 0;
}

/* ------------------------------------------------------------------ *
 * Geometry + detection maths
 * ------------------------------------------------------------------ */

export function iou(a, b) {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

export function boxArea(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

export function centreOf(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function boxWidth(b) { return Math.max(0, b[2] - b[0]); }
export function boxHeight(b) { return Math.max(0, b[3] - b[1]); }

/**
 * Greedy non-maximum suppression. `mode: 'class'` keeps the classic per-class
 * behaviour; `mode: 'agnostic'` merges overlapping classes, which is what the
 * tiled detector needs (and what a fused classifier pass wants too).
 */
export function nms(dets, iouThreshold = 0.45, mode = 'class') {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep = [];
  const suppressed = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    const a = sorted[i];
    keep.push(a);
    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      const b = sorted[j];
      if (mode === 'class' && a.cls !== b.cls) continue;
      if (iou(a.box, b.box) > iouThreshold) suppressed.add(j);
    }
  }
  return keep;
}

/** Softmax over a plain array, with a maximum subtraction for stability. */
export function softmax(arr) {
  let max = -Infinity;
  for (const v of arr) if (v > max) max = v;
  let sum = 0;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) { out[i] = Math.exp(arr[i] - max); sum += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Indices of the k largest values, descending. */
export function topK(arr, k = 5) {
  const idx = Array.from(arr, (_, i) => i);
  idx.sort((a, b) => arr[b] - arr[a]);
  return idx.slice(0, k);
}

export function l2normalise(vec) {
  let s = 0;
  for (const v of vec) s += v * v;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const now = () => performance.now();
export const round = (v, p = 1) => Math.round(v * 10 ** p) / 10 ** p;

/** Rolling window statistics for latency/adaptive-resolution logic. */
export class Rolling {
  constructor(size = 30) { this.size = size; this.items = []; }
  push(v) { this.items.push(v); if (this.items.length > this.size) this.items.shift(); return this; }
  get mean() { return this.items.length ? this.items.reduce((a, b) => a + b, 0) / this.items.length : 0; }
  get median() {
    if (!this.items.length) return 0;
    const s = [...this.items].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  get p90() {
    if (!this.items.length) return 0;
    const s = [...this.items].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
  }
  get last() { return this.items[this.items.length - 1] || 0; }
}
