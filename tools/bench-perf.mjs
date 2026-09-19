#!/usr/bin/env node
/**
 * tools/bench-perf.mjs — per-stage latency breakdown for the perception stack.
 *
 * Development tool: loads the shipped models the same way verify-models does,
 * then times each stage of a frame in isolation (detector at several scan
 * sizes, tile passes, tensor packing, OCR detection at several caps,
 * recogniser passes, pose, classifier). The point is to know exactly what a
 * frame costs and where the milliseconds are before touching the pipeline.
 *
 *   node tools/bench-perf.mjs [image.jpg]
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IMAGE = resolve(ROOT, process.argv[2] || 'tools/sample-bus.jpg');

let ort;
try { ort = await import('onnxruntime-web'); }
catch { console.error('npm install first'); process.exit(2); }
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = join(ROOT, 'node_modules/onnxruntime-web/dist') + '/';
globalThis.ort = ort;
globalThis.self = globalThis;
globalThis.IS_NODE_BROWSERLESS = true;
await import('../tests/harness.mjs');
globalThis.document.head = { appendChild() {} };
globalThis.location = { href: `file://${ROOT}/` };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (/^https?:|^data:|^blob:/i.test(url)) return realFetch(input, init);
  const rel = url.split(/[?#]/)[0].replace(/^\/+/, '');
  const path = join(ROOT, rel);
  if (!existsSync(path)) return new Response('not found', { status: 404 });
  const bytes = readFileSync(path);
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
};

const { Runtime } = await import('../js/core.js');
const { Detector } = await import('../js/detector.js');
const { Classifier } = await import('../js/classify.js');
const { Ocr } = await import('../js/ocr.js');
const { Pose } = await import('../js/pose.js');
const { toTensor } = await import('../js/core.js');

const jpeg = (await import('jpeg-js')).default ?? (await import('jpeg-js'));
const raw = jpeg.decode(readFileSync(IMAGE), { useTArray: true, maxMemoryUsageInMB: 512 });
const photo = new ImageData(raw.width, raw.height);
photo.data.set(raw.data.subarray(0, photo.data.length));
function downscale(img, maxWidth) {
  if (img.width <= maxWidth) return img;
  const s = maxWidth / img.width;
  const w = Math.round(img.width * s); const h = Math.round(img.height * s);
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / s));
      const si = (sy * img.width + sx) * 4; const di = (y * w + x) * 4;
      out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1]; out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = 255;
    }
  }
  return out;
}
const frame = downscale(photo, 720);   // what a phone frame grab looks like
console.log(`frame: ${frame.width}x${frame.height}\n`);

const runtime = new Runtime({ onLog: () => {} });
Runtime.prototype._nodeBoot = async function () {
  this.ort = ort; this.tier = 'wasm'; this.providers = ['wasm']; this.env = ort.env;
  return { tier: 'wasm', label: 'node', threads: 1 };
};
await runtime._nodeBoot();

const ms = async (fn, n = 5) => {
  await fn();                                   // warm
  const t = [];
  for (let i = 0; i < n; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  return Math.round(t[Math.floor(t.length / 2)] * 10) / 10;
};

const det = new Detector({ runtime, onLog: () => {} });
await det.load({ onProgress: () => {} });

console.log('— detector, full frame —');
for (const size of [256, 288, 320, 352, 384, 416, 448]) {
  const t = await ms(() => det.detect(frame, { size, minScore: 0.34, tiles: 'off' }));
  console.log(`  full ${size}px: ${t} ms`);
}

console.log('— detector, 2x2 tile sweep (what "detail mode" adds each frame) —');
for (const size of [256, 320, 416]) {
  const t = await ms(() => det.detectTiles(frame, { size, minScore: 0.34, target: 2 }));
  console.log(`  tiles@${size}: ${t} ms`);
}

console.log('— preprocess —');
{
  const w = 416, h = 416;
  const t = await ms(() => { const lb = det._letterbox(frame, w, h); toTensor(lb, { layout: 'NCHW', scale: 1 / 255, mean: 0, std: 1 }); }, 10);
  console.log(`  letterbox+toTensor @416: ${t} ms`);
}

const cls = new Classifier({ runtime, onLog: () => {} });
await cls.load({ onProgress: () => {} });
console.log('— classifier (per crop, in-frame) —');
{
  const crop = new ImageData(200, 200);
  const t = await ms(() => cls.classify(crop, { topK: 5, embed: false }));
  console.log(`  classify 224px: ${t} ms`);
}

const pose = new Pose({ runtime, onLog: () => {} });
await pose.loadBody({ onProgress: () => {} });
await pose.loadHand({ onProgress: () => {} });
console.log(`— pose body (fixed ${pose.bodySize}px) —`);
{
  const t = await ms(() => pose.detectBodies(frame, { minScore: 0.35 }));
  console.log(`  body @${pose.bodySize}: ${t} ms`);
}

const ocr = new Ocr({ runtime, onLog: () => {} });
await ocr.load({ onProgress: () => {} });
console.log('— OCR —');
{
  const t = await ms(() => ocr.read(frame, { minConfidence: 0.55, maxLines: 16 }), 3);
  console.log(`  full read (det upscale→736 min side): ${t} ms`);
  // det stage only, at current cap
  const td = await ms(() => ocr._detect(frame), 3);
  console.log(`  det stage alone: ${td} ms`);
  // what ORT says about the det input shape
  const meta = ocr.det.inputMetadata?.[0]?.shape;
  console.log(`  det input shape: ${JSON.stringify(meta)}`);
  const pmeta = pose.body.inputMetadata?.[0]?.shape;
  console.log(`  pose input shape: ${JSON.stringify(pmeta)}`);
}

console.log('\nCPU: ' + (globalThis.process?.cpuUsage ? 'node' : ''));
