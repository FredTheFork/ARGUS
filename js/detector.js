/**
 * detector.js — on-device YOLOv8 object detection.
 *
 * Runs the bundled quantised-free ONNX YOLOv8-nano through onnxruntime-web,
 * preferring the WebGPU execution provider and falling back to multi-threaded
 * WASM. Everything is served from this origin: no CDN, no network calls, no
 * frames leaving the handset.
 *
 * Pipeline: canvas letterbox -> NCHW float32 -> ORT session -> YOLOv8 head
 * (84 x N, no objectness, no objectness branch) -> class-wise NMS -> pixel boxes.
 */

import { CLASSES } from './config.js';

const ORT_SCRIPT = { webgpu: 'ort.webgpu.min.js', wasm: 'ort.min.js' };
const MODELS = { yolov8n: 'models/yolov8n.onnx' };

export class Detector {
  constructor({ vendorPath = 'vendor/', modelKey = 'yolov8n', onLog = () => {} } = {}) {
    this.vendorPath = vendorPath.endsWith('/') ? vendorPath : `${vendorPath}/`;
    this.modelUrl = MODELS[modelKey] || MODELS.yolov8n;
    this.onLog = onLog;
    this.ort = null;
    this.session = null;
    this.backend = 'none';
    this.inputName = 'images';
    this.outputName = 'output0';
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._inputDims = { w: 416, h: 416 };
    this._buffer = null;
    this._busy = false;
    this._modelBytes = null;
    this._blobUrls = [];
    this.attemptsPerTier = 2;
    this.lastError = null;
    this.tierUsed = null;
    // Scratch canvases for staged downscaling (see _preprocess).
    this._scratchA = document.createElement('canvas');
    this._scratchB = document.createElement('canvas');
    this._halve = this._scratchA;
  }

  static get webgpuAvailable() {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  /**
   * A real adapter is the only proof WebGPU will actually be used. Without
   * this check onnxruntime-web happily accepts the provider and then silently
   * runs on WASM while the HUD claims GPU acceleration — and we would have
   * downloaded the 21 MB jsep runtime for nothing.
   */
  static async gpuReady() {
    if (!Detector.webgpuAvailable) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  }

  /**
   * Backend tiers, tried in order. Each tier names the exact runtime bundle and
   * WASM pair it needs, so a failure in one can never poison the next: every
   * attempt loads a *fresh* ORT global (see _loadRuntimeScript).
   */
  static get TIERS() {
    return [
      { id: 'webgpu', bundle: 'ort.webgpu.min.js', base: 'ort-wasm-simd-threaded.jsep', providers: ['webgpu'], label: 'webgpu', needsAdapter: true },
      { id: 'wasm', bundle: 'ort.min.js', base: 'ort-wasm-simd-threaded', providers: ['wasm'], label: 'wasm' }
    ];
  }

  /**
   * Load a session, working down the tier list until one succeeds.
   *
   * The large WASM binary and its ES-module glue are fetched here, checked
   * (HTTP status, length, WebAssembly magic, plausible JavaScript) and handed to
   * the runtime as blob URLs, so the runtime never fetches them itself. That
   * removes the single biggest cause of "previous call to initWasm() failed" —
   * a truncated or error-page response for a multi-megabyte binary behind an
   * unfriendly proxy.
   */
  async load({ backend = 'auto', onStage = () => {}, onRetry = () => {} } = {}) {
    const gpu = await Detector.gpuReady();
    if (backend === 'webgpu' && !gpu) this.onLog('warn: WebGPU requested but no GPU adapter is exposed — using WASM instead');
    if (backend === 'wasm' && gpu) this.onLog('note: WebGPU available but WASM was forced in configuration');

    let tiers = Detector.TIERS;
    if (backend === 'wasm') tiers = tiers.filter((t) => t.id === 'wasm');
    else if (backend === 'auto' && !gpu) tiers = tiers.filter((t) => t.id !== 'webgpu');

    const failures = [];
    for (const tier of tiers) {
      if (tier.needsAdapter && !gpu) continue;
      for (let attempt = 1; attempt <= this.attemptsPerTier; attempt++) {
        const bust = attempt > 1 ? `${Date.now()}-${attempt}` : '';
        if (attempt > 1) {
          this.onLog(`retry: ${tier.id} attempt ${attempt} of ${this.attemptsPerTier} (cache bypassed)`);
          onRetry(tier, attempt);
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
        try {
          const result = await this._attemptTier(tier, bust, onStage);
          this.tierUsed = tier.id;
          return result;
        } catch (err) {
          const detail = `${tier.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${err.message}`;
          failures.push(detail);
          this.onLog(`warn: ${detail}`);
        }
      }
    }
    const summary = failures.join('; ');
    this.lastError = summary;
    throw new Error(summary);
  }

  async _attemptTier(tier, bust, onStage) {
    const t0 = performance.now();
    await this._loadRuntimeScript(tier.bundle, bust, onStage);

    // Fetch and verify the WASM pair ourselves, with progress.
    const wasmUrl = `${this.vendorPath}${tier.base}.wasm`;
    const mjsPath = `${this.vendorPath}${tier.base}.mjs`;
    let wasmBytes; let mjsText;
    try {
      [wasmBytes, mjsText] = await Promise.all([
        this._fetchBytes(wasmUrl, {
          label: `WASM RUNTIME (${tier.id.toUpperCase()})`,
          bust,
          magic: [0x00, 0x61, 0x73, 0x6d],   // \0asm
          minBytes: 512 * 1024,
          onStage
        }),
        this._fetchText(mjsPath, bust)
      ]);
      if (!/WebAssembly/.test(mjsText) || /^\s*</.test(mjsText)) {
        throw new Error(`${tier.base}.mjs is not valid JavaScript (got ${mjsText.slice(0, 40).replace(/\s+/g, ' ')}…)`);
      }
    } catch (err) {
      // Whatever we were served is unusable — make sure it cannot come back.
      this._purgeCached(wasmUrl);
      this._purgeCached(mjsPath);
      throw err;
    }

    const ort = this.ort;
    // Hand the verified bytes over as same-origin blob URLs covering BOTH halves
    // of the runtime pair: the ES module the glue imports, and the binary it
    // instantiates. The runtime then touches the network for neither, so a
    // mangling proxy, a stale cache or a bad Content-Type cannot corrupt a
    // multi-megabyte download.
    //
    // Do NOT be tempted back to `env.wasm.wasmBinary`: in ORT 1.20 that route
    // resolves a path against `import.meta.url`, which a blob URL does not have,
    // and init dies with "no available backend found … Failed to construct
    // 'URL': Invalid URL". Measured on this build (probe, all with the bytes
    // already in hand): wasmBinary=Uint8Array ✗, wasmBinary=ArrayBuffer ✗,
    // {mjs}=blob only ✗, {mjs,wasm}=blob URLs ✓ boots AND runs,
    // {mjs,wasm}+wasmBinary ✗, wasmPaths=dir string ✓ (the pre-rewrite design,
    // which is what left the runtime at the mercy of the host's fetch).
    const mjsBlob = URL.createObjectURL(new Blob([mjsText], { type: 'text/javascript' }));
    const wasmBlob = URL.createObjectURL(new Blob([wasmBytes], { type: 'application/wasm' }));
    ort.env.wasm.wasmBinary = undefined;   // never let a previous attempt poison this one
    ort.env.wasm.wasmPaths = { mjs: mjsBlob, wasm: wasmBlob };
    this._blobUrls.push(mjsBlob, wasmBlob);

    // Cache the weights across tier retries, but never hand over a buffer the
    // runtime has already consumed (it can detach it, leaving byteLength 0).
    if (!this._modelBytes || this._modelBytes.byteLength === 0) {
      try {
        this._modelBytes = await this._fetchBytes(this.modelUrl, {
          label: 'NEURAL CORE',
          minBytes: 1024 * 1024,
          onStage
        });
      } catch (err) {
        this._purgeCached(this.modelUrl);
        throw err;
      }
    }
    onStage('COMPILING INFERENCE GRAPH', 0.9);
    const modelBuffer = this._modelBytes.buffer;

    try {
      this.session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: tier.providers,
        graphOptimizationLevel: 'all',
        executionMode: 'sequential'
      });
    } catch (err) {
      // Byte-valid but the runtime still refused it: treat both the runtime and
      // the weights as suspect and clear them, so the retry starts from zero.
      this._purgeCached(wasmUrl);
      this._purgeCached(mjsPath);
      this._purgeCached(this.modelUrl);
      throw err;
    }
    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    this.backend = tier.label;
    this.loadMs = Math.round(performance.now() - t0);
    this.onLog(`session ready — tier=${tier.id}, provider=${tier.label}, threads=${ort.env.wasm.numThreads}, model=${(modelBuffer.byteLength / 1048576).toFixed(1)} MB, setup=${this.loadMs}ms`);
    return { backend: this.backend, loadMs: this.loadMs, tier: tier.id, threads: ort.env.wasm.numThreads };
  }

  /**
   * Tell the service worker to drop an asset we have proved unusable.
   *
   * This is the difference between a retry that works and a retry that is
   * theatre: the worker serves runtime binaries and weights cache-first, so a
   * damaged download would otherwise be replayed forever — the user reloads,
   * sees the same "no available backend found", and concludes the app is dead
   * even after the host has recovered.
   */
  _purgeCached(url) {
    try {
      const sw = navigator.serviceWorker;
      if (sw && sw.controller) {
        sw.controller.postMessage({ type: 'argus-purge', url: new URL(url, location.href).href });
      }
    } catch { /* no worker in scope — nothing cached to drop */ }
  }

  /**
   * Load the runtime bundle. Deleting the global first, plus a cache-busting
   * query on retries, guarantees the script actually re-executes: otherwise a
   * module-level "initWasm already failed" promise from a previous attempt is
   * handed straight to the next one (the confusing ORT error users hit).
   */
  async _loadRuntimeScript(file, bust, onStage) {
    onStage('LOADING COMPUTE RUNTIME', 0.2);
    try { delete window.ort; } catch { window.ort = undefined; }
    await new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = `${this.vendorPath}${file}${bust ? `?bust=${bust}` : ''}`;
      tag.async = false;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error(`could not load ${file} (network or blocked)`));
      document.head.appendChild(tag);
    });
    const ort = (this.ort = window.ort);
    if (!ort || !ort.InferenceSession) throw new Error(`${file} loaded but did not expose onnxruntime`);
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false;
    const threads = navigator.hardwareConcurrency || 4;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, threads)) : 1;
    ort.env.logLevel = 'error';
  }

  /**
   * Fetch with progress + integrity checks; throws a precise, actionable error.
   *
   * A truncated response is the classic cause of the opaque ORT error users hit
   * ("no available backend found … previous call to initWasm() failed"), so the
   * bytes are never trusted: HTTP status, declared vs received length, a floor
   * size and the WebAssembly magic are all verified before they are handed on.
   * A stalled transfer (proxy holding the socket open, no data) is aborted after
   * STALL_MS instead of hanging the boot screen forever.
   */
  async _fetchBytes(url, { label = '', bust = '', magic = null, minBytes = 0, onStage = () => {} } = {}) {
    const full = bust ? `${url}${url.includes('?') ? '&' : '?'}bust=${bust}` : url;
    const STALL_MS = 30000;
    const ctrl = new AbortController();
    let stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
    const bump = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), STALL_MS); };

    let res;
    try {
      res = await fetch(full, { cache: 'no-store', signal: ctrl.signal });
    } catch (err) {
      clearTimeout(stallTimer);
      if (ctrl.signal.aborted) throw new Error(`${label || url} stalled — no response within ${STALL_MS / 1000}s`);
      throw new Error(`${label || url} unreachable (${err.message})`);
    }
    if (!res.ok) {
      clearTimeout(stallTimer);
      throw new Error(`${label || url} → HTTP ${res.status} ${res.statusText}`);
    }

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
          if (declared) {
            onStage(`${label}  ${(received / 1048576).toFixed(1)} / ${(declared / 1048576).toFixed(1)} MB`, 0.3 + 0.45 * (received / declared));
          }
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        chunks.push(buf);
        received = buf.length;
      }
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`${label || url} stalled at ${(received / 1048576).toFixed(1)} MB — transfer abandoned after ${STALL_MS / 1000}s without data`);
      throw new Error(`${label || url} interrupted at ${received} bytes (${err.message})`);
    } finally {
      clearTimeout(stallTimer);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }

    if (declared && bytes.length !== declared) {
      throw new Error(`${label || url} truncated — received ${bytes.length} of ${declared} bytes`);
    }
    if (bytes.length < minBytes) {
      throw new Error(`${label || url} too small — ${bytes.length} bytes (expected at least ${minBytes}). The host may have returned an error page.`);
    }
    if (magic && !magic.every((b, i) => bytes[i] === b)) {
      throw new Error(`${label || url} is not a WebAssembly binary (first bytes: ${[...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' ')})`);
    }
    return bytes;
  }

  async _fetchText(url, bust = '') {
    const full = bust ? `${url}${url.includes('?') ? '&' : '?'}bust=${bust}` : url;
    const res = await fetch(full, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }

  /** Warm the graph so the first live frame is not penalised. */
  async warmup(budget = 320) {
    try {
      if (this._busy) return;
      const { w, h } = Detector.inputDims(9, 16, budget);
      const dummy = new ImageData(w, h);
      this._busy = true;
      await this._runTensor(dummy, w, h);
      this._busy = false;
    } catch (err) {
      this.onLog(`warn: warmup skipped (${err && err.message})`);
    }
  }

  /**
   * Aspect-preserving input size: keep the phone's real aspect ratio (portrait
   * or landscape) inside a pixel budget, snapped to the /32 stride the model
   * requires. Far more efficient than squashing portrait video into a square.
   */
  static inputDims(sourceW, sourceH, budget = 416, { min = 256, max = 704 } = {}) {
    const aspect = sourceW / sourceH;
    const snap = (v) => Math.max(32, Math.round(v / 32) * 32);
    let w = snap(Math.sqrt(budget * budget * aspect));
    let h = snap(Math.sqrt((budget * budget) / aspect));
    const clampAxis = (v) => {
      if (v > max) return snap(max);
      if (v < min) return snap(min);
      return v;
    };
    w = clampAxis(w); h = clampAxis(h);
    return { w, h };
  }

  /**
   * @param {HTMLVideoElement|HTMLCanvasElement|ImageBitmap} source
   * @returns {{objects:Array<{cls:string,clsId:number,score:number,box:number[]}>,
   *            prepMs:number,inferMs:number,dims:{w:number,h:number},anchors:number}}
   */
  async infer(source, { budget = 416, confidence = 0.4, iou = 0.45, maxDetections = 24 } = {}) {
    const srcW = source.videoWidth || source.width;
    const srcH = source.videoHeight || source.height;
    if (!srcW || !srcH) return { objects: [], prepMs: 0, inferMs: 0, dims: { w: 0, h: 0 }, anchors: 0 };

    // onnxruntime throws "Session already started" if two runs overlap, so the
    // detector serialises itself: a call arriving mid-run returns an empty
    // result and the loop simply tries again on the next tick.
    if (this._busy) return { objects: [], prepMs: 0, inferMs: 0, dims: null, anchors: 0, skipped: true };
    this._busy = true;
    try {
      const t0 = performance.now();
      const { w, h } = Detector.inputDims(srcW, srcH, budget);
      const { tensor, params } = this._preprocess(source, srcW, srcH, w, h);
      const prepMs = performance.now() - t0;

      const t1 = performance.now();
      const output = await this._runTensor(tensor);
      const inferMs = performance.now() - t1;

      const objects = this._decode(output, params, srcW, srcH, confidence, iou, maxDetections);
      return { objects, prepMs, inferMs, dims: { w, h }, anchors: output.anchors };
    } finally {
      this._busy = false;
    }
  }

  _preprocess(source, srcW, srcH, w, h) {
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
    const ctx = this._ctx;
    // High-quality smoothing matters: a naive nearest/box downscale aliases
    // badly and measurably shifts scores and boxes at small scan sizes.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#727272';                     // YOLO letterbox grey
    ctx.fillRect(0, 0, w, h);

    const scale = Math.min(w / srcW, h / srcH);
    const dw = Math.round(srcW * scale);
    const dh = Math.round(srcH * scale);
    const dx = Math.floor((w - dw) / 2);
    const dy = Math.floor((h - dh) / 2);

    // Staged halving for aggressive reductions: each pass keeps the sampling
    // well-conditioned, approximating a true area filter. This is what keeps
    // 320 px scans accurate rather than merely fast.
    let src = source;
    let sw = srcW;
    let sh = srcH;
    while (scale < 0.5 && sw * 0.5 > dw * 1.1 && sh * 0.5 > dh * 1.1 && sw > 64 && sh > 64) {
      const scratch = this._halve;
      scratch.width = Math.max(1, Math.round(sw * 0.5));
      scratch.height = Math.max(1, Math.round(sh * 0.5));
      const hctx = scratch.getContext('2d');
      hctx.imageSmoothingEnabled = true;
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(src, 0, 0, sw, sh, 0, 0, scratch.width, scratch.height);
      src = scratch;
      sw = scratch.width;
      sh = scratch.height;
      // Ping-pong so `src` is never the canvas we are about to draw into.
      this._halve = (scratch === this._scratchA) ? this._scratchB : this._scratchA;
    }
    ctx.drawImage(src, 0, 0, sw, sh, dx, dy, dw, dh);

    return { tensor: this._toTensor(ctx, w, h), params: { w, h, scale, dx, dy, srcW, srcH } };
  }

  /** Canvas pixels -> planar NCHW float32 tensor, reusing one buffer. */
  _toTensor(ctx, w, h) {
    const { data } = ctx.getImageData(0, 0, w, h);
    const px = w * h;
    if (!this._buffer || this._buffer.length !== px * 3) this._buffer = new Float32Array(px * 3);
    const out = this._buffer;
    for (let p = 0, i = 0; p < px; p++, i += 4) {
      out[p] = data[i] / 255;
      out[px + p] = data[i + 1] / 255;
      out[2 * px + p] = data[i + 2] / 255;
    }
    return new this.ort.Tensor('float32', out, [1, 3, h, w]);
  }

  async _runTensor(input, w = 0, h = 0) {
    const ort = this.ort;
    const feeds = {};
    if (input instanceof ImageData) feeds[this.inputName] = new ort.Tensor('float32', new Float32Array(w * h * 3), [1, 3, h, w]);
    else feeds[this.inputName] = input;
    const results = await this.session.run(feeds);
    const out = results[this.outputName];
    let data = out.data;
    if (!data || typeof data.then === 'function' || typeof out.getData === 'function') {
      try { data = typeof out.getData === 'function' ? await out.getData() : await data; }
      catch { data = out.data; }
    }
    const dims = out.dims;
    const anchors = dims[2] || 0;
    return { data: data instanceof Float32Array ? data : Float32Array.from(data), dims, anchors };
  }

  /** Decode YOLOv8 head + class-wise NMS into pixel-space boxes. */
  _decode(output, params, srcW, srcH, confidence, iouThreshold, maxDetections) {
    const { data, dims } = output;
    const ch = dims[1];
    const anchors = dims[2];
    const numClasses = ch - 4;

    const boxes = [];
    const scores = [];
    const classIds = [];

    // Layout: [1, 4 + C, N] — rows 0..3 are cx,cy,w,h in model pixels.
    for (let a = 0; a < anchors; a++) {
      let best = 0;
      let bestId = 0;
      for (let c = 0; c < numClasses; c++) {
        const s = data[(4 + c) * anchors + a];
        if (s > best) { best = s; bestId = c; }
      }
      if (best < confidence || bestId >= CLASSES.length) continue;
      const bx = data[a];
      const by = data[anchors + a];
      const bw = data[anchors * 2 + a];
      const bh = data[anchors * 3 + a];
      const x1 = (bx - bw / 2 - params.dx) / params.scale;
      const y1 = (by - bh / 2 - params.dy) / params.scale;
      const x2 = (bx + bw / 2 - params.dx) / params.scale;
      const y2 = (by + bh / 2 - params.dy) / params.scale;
      boxes.push([
        Math.max(0, Math.min(srcW, x1)), Math.max(0, Math.min(srcH, y1)),
        Math.max(0, Math.min(srcW, x2)), Math.max(0, Math.min(srcH, y2))
      ]);
      scores.push(best);
      classIds.push(bestId);
    }

    // Class-wise greedy NMS.
    const order = scores.map((_, i) => i).sort((p, q) => scores[q] - scores[p]);
    const suppressed = new Uint8Array(scores.length);
    const keep = [];
    for (let i = 0; i < order.length; i++) {
      const idx = order[i];
      if (suppressed[idx]) continue;
      keep.push(idx);
      if (keep.length >= maxDetections * 3) break;
      for (let j = i + 1; j < order.length; j++) {
        const other = order[j];
        if (suppressed[other] || classIds[other] !== classIds[idx]) continue;
        if (Detector.iou(boxes[idx], boxes[other]) > iouThreshold) suppressed[other] = 1;
      }
    }

    // Query filter: drop slivers that come from letterbox padding or edges.
    const objects = [];
    for (const idx of keep) {
      const box = boxes[idx];
      const bw = box[2] - box[0];
      const bh = box[3] - box[1];
      if (bw < srcW * 0.012 || bh < srcH * 0.012) continue;
      const covered = (bw * bh) / (srcW * srcH);
      if (covered > 0.97) continue;
      objects.push({ cls: CLASSES[classIds[idx]], clsId: classIds[idx], score: scores[idx], box });
      if (objects.length >= maxDetections) break;
    }
    return objects;
  }

  static iou(a, b) {
    const ix1 = Math.max(a[0], b[0]);
    const iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]);
    const iy2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    const areaB = (b[2] - b[0]) * (b[3] - b[1]);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
  }

  async dispose() {
    try { if (this.session && this.session.release) await this.session.release(); } catch { /* ignore */ }
    this.session = null;
    for (const url of this._blobUrls) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
    this._blobUrls.length = 0;
  }
}

export const MODEL_INFO = {
  name: 'YOLOv8-nano',
  architecture: 'CSPDarknet + PAN-FPN, anchor-free decoupled head',
  opset: 12,
  params: 3_151_904,
  classes: CLASSES.length,
  dataset: 'COCO 2017 (80 classes)',
  onDisk: '12.7 MB',
  note: 'Dynamic-shape export: any /32 stride input (256–704 px per axis) is valid.'
};
