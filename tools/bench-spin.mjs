#!/usr/bin/env node
/**
 * tools/bench-spin.mjs — the "spin around the room" benchmark.
 *
 * Simulates a camera pan (a moving crop window over the sample photo, with a
 * full 360° over N frames), pushes it through the real pipeline, and reports
 * per-frame detection cost and when each object first gets tagged — the
 * number that decides whether the app feels instant.
 *
 *   node tools/bench-spin.mjs [frames=24]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FRAMES = Number(process.argv[2] || 24);

let ort = await import('onnxruntime-web');
ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = join(ROOT, 'node_modules/onnxruntime-web/dist') + '/';
globalThis.ort = ort; globalThis.self = globalThis; globalThis.IS_NODE_BROWSERLESS = true;
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
const { Pipeline } = await import('../js/pipeline.js');
const { CONFIG } = await import('../js/config.js');
const jpeg = (await import('jpeg-js')).default ?? (await import('jpeg-js'));
const raw = jpeg.decode(readFileSync(join(ROOT, 'tools/sample-bus.jpg')), { useTArray: true, maxMemoryUsageInMB: 512 });
const photo = new ImageData(raw.width, raw.height);
photo.data.set(raw.data.subarray(0, photo.data.length));

// A "camera frame": a 640-wide window over the photo, panning left→right→left
// (a full sweep) to imitate turning around. Objects leave and re-enter view.
const VIEW_W = 480, VIEW_H = 640;   // portrait phone-ish crop of the 720x960 photo
function panFrame(t) {
  const maxX = photo.width - VIEW_W;
  const x = Math.round((Math.sin((t / FRAMES) * Math.PI * 2) * 0.5 + 0.5) * maxX);
  const out = new ImageData(VIEW_W, VIEW_H);
  for (let y = 0; y < VIEW_H; y++) {
    const src = ((y + 160) * photo.width + x) * 4;
    out.data.set(photo.data.subarray(src, src + VIEW_W * 4), y * VIEW_W * 4);
  }
  return out;
}

const runtime = new Runtime({ onLog: () => {} });
runtime.ort = ort; runtime.tier = 'wasm'; runtime.providers = ['wasm']; runtime.env = ort.env;
const settings = { ...CONFIG, ocrEvery: 2400, ocrSettleMs: 1200 };
const pipeline = new Pipeline({ runtime, settings, onLog: () => {} });
await runtime._nodeBoot?.() ?? null;
await pipeline.loadCore();
pipeline.enableAll({ modules: ['classifier', 'ocr'] });   // in background, like the app

let clock = 1000;
const firstTag = new Map();
const times = [];
for (let i = 0; i < FRAMES; i++) {
  const frame = panFrame(i);
  const t0 = performance.now();
  const snap = await pipeline.processFrame(frame, { time: clock });
  const dt = performance.now() - t0;
  times.push(dt);
  for (const r of snap.records) {
    const key = `${r.cls}@${Math.round(r.box[0] / 40)},${Math.round(r.box[1] / 40)}`;
    if (!firstTag.has(key)) firstTag.set(key, { frame: i, label: r.label, source: r.source, conf: r.confidence });
  }
  clock += 66;                       // ~15 fps display
  await new Promise((r) => setTimeout(r, 1));
}
await pipeline._bgQueue;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sorted = [...times].sort((a, b) => a - b);
console.log(`\nspin simulation — ${FRAMES} frames, full-frame detect only (wasm 1 thread)`);
console.log(`  detect ms/frame: mean ${Math.round(mean(times))}, p50 ${Math.round(sorted[FRAMES >> 1])}, max ${Math.round(Math.max(...times))}`);
console.log(`  effective detection rate: ~${(1000 / mean(times)).toFixed(1)} fps`);
console.log(`  final scan size: ${pipeline.scanSize}px`);
console.log(`  objects tagged within the sweep: ${firstTag.size}`);
for (const [, v] of [...firstTag.entries()].slice(0, 10)) {
  console.log(`    frame ${String(v.frame).padStart(2)} → ${v.label} (${(v.conf * 100) | 0}%, ${v.source})`);
}
