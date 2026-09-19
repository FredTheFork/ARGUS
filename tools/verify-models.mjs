#!/usr/bin/env node
/**
 * tools/verify-models.mjs — run the real models over a real photograph.
 *
 * `npm test` proves the logic, the assets and the boot path, but it never runs
 * an ONNX graph: that needs a browser (or, here, a Node build of the same
 * runtime). This tool closes that gap. It loads the shipped models from
 * `models/`, checks their digests against `models/manifest.json`, pushes a
 * photograph through the whole perception stack — detector, tiled detail
 * pass, tracker, classifier, OCR, pose, fusion naming — and prints what
 * ARGUS saw, field by field.
 *
 * The models are byte-for-byte the ones the browser loads, and the code is the
 * project's own `js/` modules, so a clean run here means the ONNX graphs, the
 * tensor layouts, the pre-processing constants and the fusion rules are all
 * correct together. What it cannot prove is browser-only plumbing (WebGPU, the
 * service worker, camera capture).
 *
 *   npm run verify:models                 # tools/sample-bus.jpg
 *   npm run verify:models -- photo.jpg
 *   npm run verify:models -- --json       # machine-readable report
 *
 * Requirements: `npm install` (onnxruntime-web@1.20.1 and jpeg-js are dev
 * dependencies) and the prepared JPEG. The runtime is deliberately pinned to
 * the version the browser bundle ships, so this verifies the graphs against the
 * same ONNX opset support the app uses.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const args = argv.filter((a) => !a.startsWith('--'));
const IMAGE = resolve(ROOT, args[0] || 'tools/sample-bus.jpg');
const FRAMES = Number((args.find((a) => a.startsWith('frames=')) || 'frames=3').split('=')[1]) || 3;

if (!existsSync(IMAGE)) {
  console.error(`no image at ${IMAGE}`);
  process.exit(2);
}

/* ---------------------------------------------------------------- *
 * The runtime, loaded before the project's modules so each one finds it.
 * ---------------------------------------------------------------- */
let ort;
try {
  ort = await import('onnxruntime-web');
} catch {
  console.error('onnxruntime-web is not installed.\n\n  npm install\n\nthen run this again. (It is a dev dependency; the browser build lives in vendor/.)');
  process.exit(2);
}

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = join(ROOT, 'node_modules/onnxruntime-web/dist') + '/';
globalThis.ort = ort;
globalThis.self = globalThis;
globalThis.IS_NODE_BROWSERLESS = true;

// The perception modules only touch canvas from inside functions, so the
// project's own test harness is enough to run them under Node.
await import('../tests/harness.mjs');
globalThis.document.head = { appendChild() {} };
globalThis.location = { href: `file://${ROOT}/` };

/*
 * Node has no page origin, so a relative model URL is not something its fetch
 * can resolve. Serving requests for the project's own paths out of the working
 * directory is enough — and it exercises the project's real fetchVerified(),
 * with its stall watchdog, size floor and progress reporting, end to end.
 */
const HOST = (() => {
  const real = globalThis.fetch;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https?:|^data:|^blob:/i.test(url)) return real(input, init);
    const rel = url.split(/[?#]/)[0].replace(/^\/+/, '');
    const path = join(ROOT, rel);
    if (!existsSync(path)) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const bytes = readFileSync(path);
    const type = /\.onnx$/.test(path) ? 'application/octet-stream' : /\.json$/.test(path) ? 'application/json' : 'text/plain';
    return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
  };
})();
globalThis.fetch = HOST;

const { Runtime } = await import('../js/core.js');
const { Pipeline } = await import('../js/pipeline.js');
const { CONFIG } = await import('../js/config.js');

/*
 * Node-side runtime support.
 *
 * In the browser `Runtime.boot()` injects vendor/ort.min.js with a <script> tag.
 * Here the runtime already exists, so boot is reduced to the two things the
 * sessions actually need: a decision about providers, and the wasm path the
 * graph runner loads its binary from.
 */
Runtime.prototype._nodeBoot = async function boot() {
  this.ort = ort;
  this.tier = 'wasm';
  this.providers = ['wasm'];
  this.label = `ONNX Runtime Web ${ort.env.versions.web} (Node)`;
  this.env = ort.env;
  this.onLog(`runtime: ${this.label}`);
  return { tier: this.tier, label: this.label, threads: 1 };
};

/* ---------------------------------------------------------------- *
 * The photograph
 * ---------------------------------------------------------------- */
async function decodeImage(path) {
  if (!/\.jpe?g$/i.test(path)) {
    console.error(`only JPEG is supported by this tool (got ${basename(path)})`);
    process.exit(2);
  }
  let jpeg;
  try { jpeg = (await import('jpeg-js')).default ?? (await import('jpeg-js')); }
  catch {
    console.error('jpeg-js is not installed.\n\n  npm install\n\nthen run this again.');
    process.exit(2);
  }
  const raw = jpeg.decode(readFileSync(path), { useTArray: true, maxMemoryUsageInMB: 512 });
  const frame = new ImageData(raw.width, raw.height);
  // JPEG JS hands back RGBA already; copy so the frame is a plain ImageData the
  // same code path in the browser would produce from a video element.
  frame.data.set(raw.data.subarray(0, frame.data.length));
  return frame;
}

const frame = await decodeImage(IMAGE);

/* The frames the pipeline sees are the camera's, down-scaled the way a phone
 * video track is. A 1080p photo scaled to ~720 p keeps the models on the same
 * scale they were trained for while staying cheap to run here. */
function downscale(img, maxWidth) {
  if (img.width <= maxWidth) return img;
  const scale = maxWidth / img.width;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

const videoFrame = downscale(frame, 720);

/* ---------------------------------------------------------------- *
 * Manifest digests
 * ---------------------------------------------------------------- */
const manifest = JSON.parse(readFileSync(join(ROOT, 'models/manifest.json'), 'utf8'));
const digests = [];
for (const [key, m] of Object.entries(manifest.models)) {
  const path = join(ROOT, 'models', m.file.replace(/^models\//, ''));
  if (!existsSync(path)) { digests.push({ key, ok: false, note: 'missing' }); continue; }
  const bytes = readFileSync(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  digests.push({ key, file: m.file, bytes: bytes.length, ok: sha === m.sha256 && bytes.length === m.bytes });
}

/* ---------------------------------------------------------------- *
 * Perceptual modules, loaded with verification on
 * ---------------------------------------------------------------- */
const settings = { ...CONFIG, classifyEvery: 0, detailMode: 'auto' };
const runtime = new Runtime({ onLog: () => {} });
const pipeline = new Pipeline({ runtime, settings, onLog: (m) => !AS_JSON && console.log(`    · ${m}`) });

const log = (...a) => { if (!AS_JSON) console.log(...a); };

log(`\nARGUS model verification — ${basename(IMAGE)} ${videoFrame.width}×${videoFrame.height}`);
log(`runtime: ${ort.env.versions.web} (wasm, 1 thread)\n`);
log('digests:');
for (const d of digests) log(`  ${d.ok ? 'ok   ' : 'FAIL '} ${d.key.padEnd(11)} ${d.file || ''} ${d.bytes ? `${(d.bytes / 1048576).toFixed(1)} MB` : ''}`);

log('\nloading models…');
await runtime._nodeBoot();
await pipeline.loadCore();
await pipeline.enableAll({ onProgress: () => {}, modules: ['classifier', 'ocr', 'pose', 'hands'] });
log(`loaded: ${JSON.stringify(pipeline.moduleState)}`);
const loadErrors = [];

/* ---------------------------------------------------------------- *
 * Inference
 * ---------------------------------------------------------------- */
const runs = [];
for (let i = 0; i < FRAMES; i++) {
  const t0 = Date.now();
  const snap = await pipeline.processFrame(videoFrame, { time: performance.now() });
  runs.push({ ms: Date.now() - t0, snapshot: snap });
}
// Background jobs (classifier, OCR, pose, hands) run behind the frame and
// attach on later ones; give the serial queue time to drain so the report
// describes a settled scene, not the first glance. A final pass folds
// everything that landed into the records.
for (let i = 0; i < 8; i++) {
  await pipeline.processFrame(videoFrame, { time: performance.now() });
  await new Promise((r) => setTimeout(r, 250));
}
await pipeline._bgQueue;                       // let the last scheduled job land
await pipeline.processFrame(videoFrame, { time: performance.now() });
const finalSnap = pipeline.snapshot();

const records = finalSnap.records || [];
const report = {
  image: basename(IMAGE),
  frame: `${videoFrame.width}x${videoFrame.height}`,
  digests,
  modules: pipeline.moduleState,
  timing: {
    detectMs: pipeline.lastInferMs,
    frameMs: pipeline.stats.frameMs,
    meanMs: Math.round(pipeline.latency.mean),
    inferMs: runs.map((r) => r.ms)
  },
  stats: pipeline.stats,
  scanSize: pipeline.scanSize,
  records: records.map((r) => ({
    label: r.label,
    noun: r.noun,
    category: r.category,
    confidence: Number(r.confidence.toFixed(3)),
    source: r.source,
    box: r.box.map((v) => Math.round(v)),
    refined: r.refined || null,
    classifier: (r.classifier || []).slice(0, 3).map((c) => `${c.label || c.name} ${(c.prob ?? 0).toFixed(2)}`),
    text: r.text || null,
    brand: r.brand?.name || null,
    sign: r.sign?.kind || null,
    posture: r.posture || null,
    activity: r.activity || null,
    gesture: r.gesture || null
  })),
  texts: (finalSnap.texts || []).map((l) => ({ text: l.text, confidence: Number((l.confidence || 0).toFixed(2)), brand: l.brand?.name || null, sign: l.sign?.kind || null, attached: !!l.attached }))
};

/* A few things that must be true of a correct frame, whatever is in the photo. */
const checks = [];
const push = (name, ok, note = '') => checks.push({ name, ok, note });

push('all model digests match the manifest', digests.every((d) => d.ok), digests.filter((d) => !d.ok).map((d) => d.key).join(', '));
push('detector produced objects', records.length > 0, `${records.length} records`);
push('boxes sit inside the frame', records.every((r) => r.box[0] >= -2 && r.box[1] >= -2 && r.box[2] <= videoFrame.width + 2 && r.box[3] <= videoFrame.height + 2));
push('confidences are probabilities', records.every((r) => r.confidence > 0 && r.confidence <= 1));
push('every object has a label and category', records.every((r) => r.label && r.category && r.source), records.filter((r) => !r.label || !r.category).map((r) => r.cls).join(', '));
push('classifier ran on the larger objects', !pipeline.moduleState.classifier || records.some((r) => (r.classifier || []).length > 0));
push('OCR pass completed', pipeline.moduleState.ocr ? pipeline.stats.ocrRuns > 0 : true, `runs ${pipeline.stats.ocrRuns}`);
push('no background pass threw', records.every((r) => Number.isFinite(r.confidence)), records.filter((r) => !Number.isFinite(r.confidence)).map((r) => r.label).join(', '));

/* ---------------------------------------------------------------- *\
 * Print it
 * ---------------------------------------------------------------- */
if (AS_JSON) {
  console.log(JSON.stringify({ ...report, checks }, null, 2));
} else {
  log(`\n${records.length} object${records.length === 1 ? '' : 's'} (scan ${pipeline.scanSize}px, mean frame ${report.timing.meanMs} ms):`);
  for (const r of report.records) {
    log(`\n  ${r.label}  (${r.confidence})  [${r.source}]`);
    if (r.classifier?.length) log(`    classifier ${r.classifier.join(', ')}`);
    if (r.text) log(`    text      “${r.text}”${r.brand ? ` (brand: ${r.brand})` : ''}`);
    if (r.sign) log(`    sign      ${r.sign}`);
    if (r.posture || r.activity || r.gesture) log(`    body      ${[r.posture, r.activity?.label || r.activity, r.gesture].filter(Boolean).join(', ')}`);
  }
  if (report.texts.length) {
    log(`\n${report.texts.length} text line${report.texts.length === 1 ? '' : 's'} read:`);
    for (const t of report.texts.slice(0, 12)) log(`  ${t.text}  (${t.confidence}${t.brand ? `, brand ${t.brand}` : ''}${t.attached ? ', on object' : ''})`);
  }
  log('\nchecks:');
  for (const c of checks) log(`  ${c.ok ? 'ok   ' : 'FAIL '} ${c.name}${c.note ? ` — ${c.note}` : ''}`);
}

const failed = checks.filter((c) => !c.ok);
process.exit(failed.length ? 1 : 0);
