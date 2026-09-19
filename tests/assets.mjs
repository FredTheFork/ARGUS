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

section('vendored runtime');
// The app ships ONNX Runtime itself, so the runtime is a dependency like any
// other file we are responsible for: same digests, same version, and old enough
// to run the models it is asked to run.
const runtime = modelManifest?.runtime;
const runtimeFiles = Object.entries(runtime?.bundles || {});
test('manifest describes the runtime', runtimeFiles.length >= 4, runtime ? `${runtime.name} ${runtime.version}, ${runtimeFiles.length} files` : 'missing');

const runtimeProblems = [];
for (const [key, meta] of runtimeFiles) {
  const file = join(ROOT, 'vendor', meta.file);
  if (!existsSync(file)) { runtimeProblems.push(`${key}: missing`); continue; }
  const bytes = readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== meta.bytes) runtimeProblems.push(`${key}: ${bytes.length} bytes, manifest says ${meta.bytes}`);
  if (digest !== meta.sha256) runtimeProblems.push(`${key}: digest ${digest.slice(0, 10)} != ${String(meta.sha256).slice(0, 10)}`);
  if (/Binary$/.test(key) && !(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
    runtimeProblems.push(`${key}: not a WebAssembly module`);
  }
}
test('every runtime file matches the manifest', runtimeProblems.length === 0, runtimeProblems.join('; '));

const banners = ['ort.min.js', 'ort.webgpu.min.js'].map((f) => {
  const head = readFileSync(join(ROOT, 'vendor', f), 'utf8').slice(0, 200);
  const m = head.match(/ONNX Runtime Web v([\d.]+)/);
  return m ? m[1] : null;
});
test('both bundles report the same version', banners[0] && banners[0] === banners[1], banners.join(' / '));
test('bundle version matches the manifest', banners[0] === runtime?.version, `${banners[0]} vs ${runtime?.version}`);
test('runtime is new enough for the INT8 graphs (>= 1.21)', (() => {
  const [maj, min] = String(banners[0] || '0.0').split('.').map(Number);
  return maj > 1 || (maj === 1 && min >= 21);
})(), `v${banners[0]} — ConvInteger needs 1.21+`);

// The runtime's own file names are referenced from js/core.js; a rename in one
// place and not the other is a boot failure on a phone, which is expensive to
// discover there.
const coreSrc = readFileSync(join(ROOT, 'js/core.js'), 'utf8');
const wanted = new Set();
for (const m of coreSrc.matchAll(/base:\s*'([^']+)'/g)) { wanted.add(`${m[1]}.mjs`); wanted.add(`${m[1]}.wasm`); }
for (const m of coreSrc.matchAll(/bundle:\s*'([^']+)'/g)) wanted.add(m[1]);
const namedInManifest = new Set(runtimeFiles.flatMap(([_, meta]) => [meta.file]));
const missingFiles = [...wanted].filter((f) => !existsSync(join(ROOT, 'vendor', f)));
const unlisted = [...wanted].filter((f) => !namedInManifest.has(f));
test('runtime files named in core.js exist', missingFiles.length === 0, missingFiles.join(', '));
test('runtime files named in core.js are in the manifest', unlisted.length === 0, unlisted.join(', '));

section('DOM contract');
const appSrc = readFileSync(join(ROOT, 'js/app.js'), 'utf8') + readFileSync(join(ROOT, 'js/ui.js'), 'utf8');
const referenced = new Set([
  ...[...appSrc.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]),
  ...[...appSrc.matchAll(/bind\('([\w-]+)'/g)].map((m) => m[1])
]);
const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
// v2.1 injects no elements at runtime: every id the app or the UI asks for
// must exist in the static markup.
const missingIds = [...referenced].filter((id) => !htmlIds.has(id));
test(`app/ui element ids (${referenced.size})`, missingIds.length === 0, missingIds.join(', '));

section('mobile boot contract');
// Regression guards for the "stuck on the loading screen on mobile" report:
// three separate defects combined to leave the boot card up forever.
const css = readFileSync(join(ROOT, 'css/app.css'), 'utf8');
test('css honours the hidden attribute over explicit display rules',
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
  'without it, .boot{display:grid} beats the UA [hidden] rule and the overlay never goes away');
const appJsSrc = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
const enterStageBody = (appJsSrc.match(/function enterStage\(\) \{([\s\S]*?)\n\}/) || [])[1] || '';
test('the boot card is dismissed on the success path',
  enterStageBody.includes('hideBoot()') && enterStageBody.includes('startLoop()'),
  'enterStage() must both dismiss the boot card and start the loop');
test('index.html carries the non-module boot watchdog',
  html.includes('__argusPhase') && /<noscript>/.test(html),
  'the watchdog reports a dead module graph; noscript covers JS-off');
test('retry button exists in markup', htmlIds.has('boot-retry'));

section('version sync');
// A drift between these is how a new build ships code with an old cache: the
// worker version namespaces every cache, so they must move together.
const cfgSrc = readFileSync(join(ROOT, 'js/config.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const appVersion = (cfgSrc.match(/VERSION = '([^']+)'/) || [])[1];
const swVersion = (sw.match(/VERSION = 'argus-([^']+)'/) || [])[1];
const htmlVersion = (html.match(/id="boot-ver">([^<]+)</) || [])[1];
test('config, package.json, service worker and boot card share one version',
  !!appVersion && appVersion === pkg.version && appVersion === swVersion && appVersion === htmlVersion,
  `config=${appVersion} pkg=${pkg.version} sw=${swVersion} html=${htmlVersion}`);

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
