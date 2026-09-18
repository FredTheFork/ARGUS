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
 * letterboxing, NHWC/NCHW conversion, perspective warps for OCR quads, edge and
 * texture statistics for the material scorer, non-maximum suppression, k-means
 * in Lab for colour extraction, and a handful of numeric helpers.
 */

export const VENDOR = 'vendor/';

/* ------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------ */

const TIERS = [
  {
    id: 'webgpu',
    bundle: 'ort.webgpu.min.js',
    base: 'ort-wasm-simd-threaded.jsep',
    providers: ['webgpu', 'wasm'],
    label: 'WebGPU',
    needsAdapter: true
  },
  {
    id: 'wasm',
    bundle: 'ort.min.js',
    base: 'ort-wasm-simd-threaded',
    providers: ['wasm'],
    label: 'WASM SIMD',
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
          await this._startTier(tier, bust, onStage);
          this.tier = tier.id;
          this.providers = tier.providers;
          this.label = tier.label;
          return { tier: tier.id, label: tier.label, threads: this.threadCount };
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

  async _startTier(tier, bust, onStage) {
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
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4))
      : 1;
    ort.env.logLevel = 'error';
    this.env = ort.env;
    onStage('COMPUTE RUNTIME READY', 0.35);
    this.onLog(`runtime: ${tier.label}, threads=${ort.env.wasm.numThreads}, isolated=${!!self.crossOriginIsolated}`);
    return ort;
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
      loadMs: Math.round(performance.now() - started)
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

/** Wrapper that serialises runs: ORT sessions are not re-entrant per frame. */
export class Session {
  constructor(session, meta = {}) {
    this.session = session;
    this.meta = meta;
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

  /** Warm the graph with a correctly-shaped zero tensor so frame 1 is not slow. */
  async warmup(shape, dtype = 'float32') {
    const feeds = {};
    feeds[this.inputs[0]] = new Float32Array(shape.reduce((a, b) => a * b, 1));
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
 * ------------------------------------------------------------------ */

let scratchCanvas = null;
function scratch(w, h) {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== w) scratchCanvas.width = w;
  if (scratchCanvas.height !== h) scratchCanvas.height = h;
  return scratchCanvas;
}

/** Resize but keep the aspect ratio — used everywhere a model wants "fit". */
export function fitSize(w, h, target, mode = 'min') {
  const scale = mode === 'min' ? Math.min(target / w, target / h) : Math.max(target / w, target / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

export function resizeImageData(src, w, h) {
  const c = scratch(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  // Draw the source through a temporary bitmap so any ImageData/Canvas is valid.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = src.width; srcCanvas.height = src.height;
  srcCanvas.getContext('2d').putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export function cropImageData(src, x, y, w, h) {
  const c = scratch(Math.max(1, w), Math.max(1, h));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, c.width, c.height);
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = src.width; srcCanvas.height = src.height;
  srcCanvas.getContext('2d').putImageData(src, 0, 0);
  ctx.drawImage(srcCanvas, x, y, w, h, 0, 0, c.width, c.height);
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
  if (layout === 'NCHW') {
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < c; ch++) {
        out[ch * n + i] = output === 'uint8'
          ? data[i * 4 + ch]
          : (data[i * 4 + ch] * scale - mean) / std;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < c; ch++) {
        out[i * c + ch] = output === 'uint8'
          ? data[i * 4 + ch]
          : (data[i * 4 + ch] * scale - mean) / std;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Feature statistics for the material / texture scorers
 * ------------------------------------------------------------------ */

export function toLuma(img) {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (img.data[i * 4] * 0.299 + img.data[i * 4 + 1] * 0.587 + img.data[i * 4 + 2] * 0.114) / 255;
  }
  return out;
}

export function boxBlur(gray, w, h, r = 1) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0; let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += gray[yy * w + xx]; count++;
        }
      }
      out[y * w + x] = sum / count;
    }
  }
  return out;
}

/** Sobel gradient magnitude — drives edge density and structure cues. */
export function gradient(gray, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
        + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
        + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = Math.hypot(gx, gy) / 4;
    }
  }
  return mag;
}

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

/** Shannon entropy of the 8-bit luma histogram: grain, weave, noise floor. */
export function entropy(gray) {
  const bins = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) bins[Math.min(255, Math.max(0, (gray[i] * 255) | 0))]++;
  const n = gray.length;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    if (!bins[i]) continue;
    const p = bins[i] / n;
    e -= p * Math.log2(p);
  }
  return e / 8;   // normalised to 0-1
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
      const overlap = iou(a.box, b.box);
      const small = Math.min(boxArea(a.box), boxArea(b.box));
      const inside = small > 0 && iou(a.box, b.box) > 0.75 && iou(a.box, b.box) * (boxArea(a.box) + boxArea(b.box) - iou(a.box, b.box) * 0) > 0
        ? false : false;   // containment handled by IoU below
      if (overlap > iouThreshold || inside) suppressed.add(j);
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
 * Colour science
 * ------------------------------------------------------------------ */

export function rgbToLab(r, g, b) {
  let R = r / 255; let G = g / 255; let B = b / 255;
  R = R > 0.04045 ? ((R + 0.055) / 1.055) ** 2.4 : R / 12.92;
  G = G > 0.04045 ? ((G + 0.055) / 1.055) ** 2.4 : G / 12.92;
  B = B > 0.04045 ? ((B + 0.055) / 1.055) ** 2.4 : B / 12.92;
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * inv(fx);
  const Y = inv(fy);
  const Z = 1.08883 * inv(fz);
  let R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let B = X * 0.0557 + Y * -0.2040 + Z * 1.0570;
  const gam = (c) => 255 * (c > 0.0031308 ? 1.055 * (c ** (1 / 2.4)) - 0.055 : 12.92 * c);
  return [
    Math.max(0, Math.min(255, Math.round(gam(R)))),
    Math.max(0, Math.min(255, Math.round(gam(G)))),
    Math.max(0, Math.min(255, Math.round(gam(B))))
  ];
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
/**
 * HSV back to RGB. Used by the colour path: an illuminant correction should
 * move an object's hue without inflating its saturation, or a red mug in a
 * scene that averages slightly red comes back brown.
 */
export function hsvToRgb(h, s, v) {
  const hh = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const seg = Math.floor(hh) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg] || [0, 0, 0];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

export const hexOf = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}`;

/**
 * k-means in Lab with k-means++ seeding. Small k (3-5) over a ≤64×64 patch, so
 * the O(n·k·iters) cost is trivial and the result is stable enough to label.
 */
export function kmeansLab(samples, k = 4, iters = 8) {
  if (!samples.length) return [];
  const pts = samples.map((s) => s.lab);
  // Deterministic seeding: the point closest to the mean first, then
  // farthest-first from there. Math.random() here meant the same frame could
  // read two different colours on two different runs — indefensible for a
  // camera judged frame to frame, and impossible to test.
  const mean = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / pts.length);
  let first = 0;
  let firstD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist2(pts[i], mean);
    if (d < firstD) { firstD = d; first = i; }
  }
  let centres = [pts[first]];
  while (centres.length < Math.min(k, pts.length)) {
    let pick = -1;
    let pickD = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.min(...centres.map((cc) => dist2(pts[i], cc)));
      if (d > pickD) { pickD = d; pick = i; }
    }
    if (pick < 0) break;
    centres.push(pts[pick]);
  }
  const assign = new Array(pts.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0; let bestD = Infinity;
      for (let ci = 0; ci < centres.length; ci++) {
        const d = dist2(pts[i], centres[ci]);
        if (d < bestD) { bestD = d; best = ci; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const a = assign[i]; const s = sums[a];
      s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
    }
    centres = sums.map((s, i) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centres[i]));
    if (!moved) break;
  }
  const counts = centres.map(() => 0);
  for (const a of assign) counts[a]++;
  return centres.map((cc, i) => ({
    lab: cc,
    weight: counts[i] / pts.length,
    rgb: labToRgb(cc[0], cc[1], cc[2])
  })).filter((cc) => cc.weight > 0).sort((a, b) => b.weight - a.weight);
}

function dist2(a, b) {
  const d0 = a[0] - b[0]; const d1 = a[1] - b[1]; const d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

export function deltaE(a, b) {
  return Math.sqrt(dist2(a, b));
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const now = () => performance.now();
export const round = (v, p = 1) => Math.round(v * 10 ** p) / 10 ** p;

/** Exponential smoothing that keeps a target and converges without overshoot. */
export class Smoother {
  constructor(alpha = 0.45) { this.alpha = alpha; this.value = null; }
  push(v) {
    this.value = this.value === null ? v : this.value + (v - this.value) * this.alpha;
    return this.value;
  }
  reset() { this.value = null; }
}

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
