/**
 * tests/assets.mjs — packaging integrity.
 *
 * Checks that every import resolves to a real export, that every asset the app
 * and the service worker claim to ship exists, that the HTML hooks the code
 * looks up are present, and that the data tables are consistent.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, section } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

section('import graph');
const files = [
  'js/core.js', 'js/config.js', 'js/kb.js', 'js/detector.js', 'js/classify.js', 'js/ocr.js', 'js/pose.js',
  'js/attributes.js', 'js/tracker.js', 'js/pipeline.js', 'js/memory.js', 'js/agent.js', 'js/ui.js',
  'js/speech.js', 'js/install.js', 'js/app.js',
  'js/data/imagenet.js', 'js/data/ocrchars.js', 'js/data/kb-objects.js', 'js/data/kb-objects2.js',
  'js/data/kb-materials.js', 'js/data/kb-colours.js', 'js/data/kb-brands.js'
];

const namespaces = new Map();
for (const rel of files) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { test(`file ${rel}`, false, 'missing'); continue; }
  try { namespaces.set(rel, await import(abs)); }
  catch (err) { test(`load ${rel}`, false, err.message.split('\n')[0]); }
}

const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))\s+from\s+['"]([^'"]+)['"]/g;
let edges = 0;
for (const rel of files) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[5];
    if (!spec.startsWith('.')) continue;
    edges++;
    const target = join(dirname(abs), spec);
    if (!existsSync(target)) { test(`${rel} → ${spec}`, false, 'target missing'); continue; }
    const targetRel = target.slice(ROOT.length + 1);
    const ns = namespaces.get(targetRel);
    if (!ns) { test(`${rel} → ${spec}`, false, 'target failed to load'); continue; }
    const wanted = (m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const missing = wanted.filter((name) => !(name in ns));
    test(`${rel} → ${targetRel}`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
  }
}
console.log(`  info ${edges} internal imports resolved`);

section('assets');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
  const ref = m[1];
  if (/^https?:/.test(ref)) continue;
  test(`index.html → ${ref}`, existsSync(join(ROOT, ref)));
}

const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
for (const m of sw.matchAll(/const (CORE_ASSETS|RUNTIME_ASSETS|MODEL_ASSETS) = \[([\s\S]*?)\];/g)) {
  const entries = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((x) => x !== './');
  const missing = entries.filter((e) => !existsSync(join(ROOT, e)));
  test(`sw.js ${m[1]} (${entries.length})`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'all present');
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
const iconMissing = (manifest.icons || []).map((i) => i.src).filter((s) => !existsSync(join(ROOT, s)));
test('manifest icons', iconMissing.length === 0, iconMissing.join(', '));

const modelManifest = JSON.parse(readFileSync(join(ROOT, 'models/manifest.json'), 'utf8'));
const modelEntries = Object.entries(modelManifest.models || {});
const modelMissing = modelEntries
  .map(([, m]) => m.file || m.path)
  .filter(Boolean)
  .filter((f) => !existsSync(join(ROOT, 'models', f.replace(/^models\//, ''))));
test(`models/manifest.json (${modelEntries.length} models)`, modelMissing.length === 0, modelMissing.join(', '));
const bytesMissing = modelEntries.filter(([, m]) => !m.bytes || !m.sha256).map(([k]) => k);
test('every model declares bytes and sha256', bytesMissing.length === 0, bytesMissing.join(', '));

const { createHash } = await import('node:crypto');
const hashMismatch = [];
for (const [key, m] of modelEntries) {
  const file = join(ROOT, 'models', (m.file || '').replace(/^models\//, ''));
  if (!existsSync(file)) continue;
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (digest !== m.sha256) hashMismatch.push(`${key} (${digest.slice(0, 10)} != ${String(m.sha256).slice(0, 10)})`);
}
test('model digests match models/manifest.json', hashMismatch.length === 0, hashMismatch.join(', '));

section('DOM contract');
const appSrc = readFileSync(join(ROOT, 'js/app.js'), 'utf8') + readFileSync(join(ROOT, 'js/ui.js'), 'utf8');
const referenced = new Set([
  ...[...appSrc.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]),
  ...[...appSrc.matchAll(/bind\('([\w-]+)'/g)].map((m) => m[1])
]);
const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
// install-btn and friends are injected by ui.js at runtime, so they are not in
// the static HTML on purpose.
const dynamic = new Set(['install-btn']);
const missingIds = [...referenced].filter((id) => !htmlIds.has(id) && !dynamic.has(id));
test(`app/ui element ids (${referenced.size})`, missingIds.length === 0, missingIds.join(', '));

section('data');
const kb = namespaces.get('js/kb.js');
const cfg = namespaces.get('js/config.js');
const stats = kb.stats();
test('knowledge base size', stats.objects > 800 && stats.brands > 200, JSON.stringify(stats));
test('COCO-80 complete', cfg.CLASSES.length === 80, String(cfg.CLASSES.length));
test('every COCO class has meta', cfg.CLASSES.every((c) => cfg.COCO_META[c]));
test('themes complete', Object.values(cfg.THEMES).every((t) => t.vars['--accent'] && t.label), Object.keys(cfg.THEMES).join(', '));
test('phrase bank', Object.keys(cfg.LINES).length >= 50, `${Object.keys(cfg.LINES).length} groups`);
test('settings defaults', Object.keys(cfg.DEFAULTS).length >= 50, `${Object.keys(cfg.DEFAULTS).length} settings`);
