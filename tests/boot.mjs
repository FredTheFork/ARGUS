/**
 * tests/boot.mjs — the app boots, and fails honestly.
 *
 * This suite stands in for a browser: it builds every element index.html
 * declares, gives the page a camera that refuses to open and a runtime script
 * that never loads, then runs the real boot path from js/app.js. What it proves
 * is not that inference works — that needs a device — but that the application
 * starts, survives a hostile environment, reports the failure in the interface
 * and never throws into the void.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, section } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

/* ---- build the DOM index.html promises ---- */
function makeElement(id, tag = 'div') {
  const el = {
    id,
    tagName: tag.toUpperCase(),
    style: {
      setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {}, cssText: ''
    },
    dataset: {},
    hidden: false,
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    clientWidth: 390,
    clientHeight: 640,
    childElementCount: 0,
    children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
    removeEventListener() {},
    dispatch(type, event = {}) { for (const fn of this._listeners[type] || []) fn(event); },
    appendChild(child) { this.children.push(child); this.childElementCount = this.children.length; return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollTo() {},
    focus() {},
    click() {},
    getContext: () => ({
      clearRect() {}, fillRect() {}, drawImage() {}, putImageData() {},
      getImageData: (x, y, w, h) => new ImageData(w, h),
      setTransform() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      arc() {}, arcTo() {}, closePath() {}, stroke() {}, fill() {}, strokeRect() {},
      fillText() {}, measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      setLineDash() {}
    }),
    toDataURL: () => 'data:image/png;base64,'
  };
  el.firstChild = null;
  return el;
}

const elements = new Map();
for (const m of html.matchAll(/id="([\w-]+)"/g)) elements.set(m[1], makeElement(m[1]));
// Mirror the initial hidden state declared in the markup, so a test can prove
// the app revealed them rather than finding them already revealed.
for (const id of ['boot-error', 'demo-fallback', 'stage']) {
  const el = elements.get(id);
  if (el) el.hidden = true;
}

// Faithful layout: anything inside the [hidden] stage reports no box at all,
// which is exactly what a browser computes. Handing the app a 390 px canvas it
// could never have while the stage is hidden is how the 0×0 overlay shipped —
// every tag was drawn into nothing and no test could see it.
const stageEl = elements.get('stage');
for (const id of ['cam', 'hud']) {
  const el = elements.get(id);
  if (!el) continue;
  Object.defineProperty(el, 'clientWidth', { get: () => (stageEl.hidden ? 0 : 390) });
  Object.defineProperty(el, 'clientHeight', { get: () => (stageEl.hidden ? 0 : 640) });
}

const body = makeElement('body');
const head = makeElement('head');
const documentElement = makeElement('html');
const documentListeners = {};

globalThis.document = {
  head,
  body,
  documentElement,
  createElement: (tag) => makeElement(`made-${tag}`, tag),
  getElementById: (id) => elements.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(type, fn) { (documentListeners[type] || (documentListeners[type] = [])).push(fn); },
  dispatch(type, event = {}) { for (const fn of documentListeners[type] || []) fn(event); },
  hidden: false
};

// The runtime <script> never loads: appendChild turns it into an error, which is
// the same failure a blocked CDN or a stale service worker would produce.
head.appendChild = (el) => { setTimeout(() => el.onerror && el.onerror(), 0); return el; };
document.body = body;

const windowListeners = {};
globalThis.window = {
  devicePixelRatio: 1,
  isSecureContext: true,
  location: { href: 'http://localhost/', search: '', hostname: 'localhost' },
  innerWidth: 390,
  innerHeight: 640,
  addEventListener(type, fn) { (windowListeners[type] || (windowListeners[type] = [])).push(fn); },
  removeEventListener() {},
  dispatch(type, event = {}) { for (const fn of windowListeners[type] || []) fn(event); },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
  speechSynthesis: null
};
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.matchMedia = window.matchMedia;

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'node-test',
    hardwareConcurrency: 4,
    language: 'en-GB',
    maxTouchPoints: 0,
    storage: { estimate: async () => ({ usage: 1024, quota: 1024 * 1024 }) },
    serviceWorker: undefined,
    getBattery: undefined,
    // A camera that refuses to open, exactly like a denied permission prompt.
    mediaDevices: { getUserMedia: async () => { throw new Error('NotAllowedError: permission denied'); } },
    vibrate: () => {}
  }
});

/* ---- run the real boot path ---- */
section('boot sequence');
const errors = [];
process.on('unhandledRejection', (err) => errors.push(err));

const app = await import('../js/app.js');
await app.start();
await new Promise((r) => setTimeout(r, 500));

const bootError = elements.get('boot-error');
const bootDetail = elements.get('boot-detail');
const demoBtn = elements.get('demo-fallback');

test('boot() ran and bound the HUD', !!app.state.settings && !!app.state.hud, app.state.hud ? 'canvas context bound' : 'no HUD');
test('failure is reported in the interface', bootError && bootError.hidden === false, bootDetail?.textContent?.slice(0, 80));
test('interface offers the demo feed', demoBtn && demoBtn.hidden === false);
test('no unhandled rejections during boot', errors.length === 0, errors.map((e) => e?.message).join('; '));
const { CONFIG: appConfig } = await import('../js/config.js');
test('runtime config is in force', app.state.settings.scanSize === appConfig.scanSize && app.state.settings.minConfidence > 0,
  `scan ${app.state.settings.scanSize} (config ${appConfig.scanSize}), conf ${app.state.settings.minConfidence}`);
test('element index covers index.html ids', [...html.matchAll(/id="([\w-]+)"/g)].every((m) => elements.has(m[1])));

// The HUD is built while #stage is hidden, so there is no box to measure. It
// must still hold a real backing store — sized from the viewport, which is what
// a fixed inset:0 stage is — or the first tags draw into nothing.
test('overlay canvas is sized even while the stage is hidden (no box to measure)',
  app.state.hud.width > 0 && app.state.hud.height > 0 && elements.get('hud').width > 0 && elements.get('hud').height > 0,
  `viewport ${app.state.hud.width}×${app.state.hud.height}, backing ${elements.get('hud').width}×${elements.get('hud').height}`);

/* ── boot recovery wiring ─────────────────────────────────────────────── */
section('boot recovery wiring');
const retryBtn = elements.get('boot-retry');
test('retry button is wired by app.js (plus the inline watchdog)', (retryBtn._listeners.click || []).length >= 1,
  `${(retryBtn._listeners.click || []).length} click handlers`);

/* ── the loading screen actually comes down ───────────────────────────── */
section('stage reveal (regression: boot must not stick)');
// Simulate both halves of the parallel boot winning, then open the stage the
// way the real boot does.
app.state.cameraStatus = { ok: true };
app.state.modelStatus = { ok: true };
// The HUD is built during boot, while #stage is still hidden — in a real
// browser its canvas measures 0×0 then, and revealing an element fires no
// window resize. So opening the stage must re-measure the overlay itself.
let remeasuresAtReveal = 0;
const realResize = app.state.hud.resize.bind(app.state.hud);
app.state.hud.resize = (...args) => { remeasuresAtReveal++; return realResize(...args); };
const entered = app.maybeEnterStage();
app.state.hud.resize = realResize;
test('maybeEnterStage opens the stage once both halves are ready', entered === true);
test('opening the stage re-measures the overlay (no window resize fires on reveal)',
  remeasuresAtReveal >= 1, `${remeasuresAtReveal} resize() call(s) during enterStage()`);
test('a second attempt does not re-enter', app.maybeEnterStage() === false);
await new Promise((r) => setTimeout(r, 460));   // hideBoot fades over 380 ms
test('boot overlay is dismissed', elements.get('boot').hidden === true);
test('stage is revealed', elements.get('stage').hidden === false);
// The box exists now — and no window resize fires to announce that. The reveal
// itself must have handed the overlay the stage's own measured size.
test('overlay re-syncs to the stage box the moment it is revealed',
  elements.get('hud').width === 390 && elements.get('hud').height === 640 && app.state.hud.width === 390,
  `backing ${elements.get('hud').width}×${elements.get('hud').height}, stage client 390×640`);
test('no unhandled rejections after stage reveal', errors.length === 0, errors.map((e) => e?.message).join('; '));

/* ── overlay sizing (regression: tags invisible on the live feed) ─────── */
section('overlay sizing (regression: a hidden stage left a 0×0 canvas)');

// A canvas inside a hidden stage measures 0×0, so the overlay built during
// boot starts life with no box at all. A 0×0 backing store accepts every draw
// call and discards the lot: objects are detected, tags are laid out, nothing
// appears. Nothing about that throws, which is why it needs a test.
const zeroProbe = makeElement('hud-zero', 'canvas');
zeroProbe.clientWidth = 0;
zeroProbe.clientHeight = 0;
const zeroLog = [];
{
  const base = zeroProbe.getContext('2d');
  const recorder = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    if (typeof value === 'function') {
      recorder[key] = (...args) => { zeroLog.push([key, args[0]]); return key === 'measureText' ? { width: 10 } : undefined; };
    } else recorder[key] = value;
  }
  zeroProbe.getContext = () => recorder;
}
let zeroErr = null;
let hudZero = null;
try {
  hudZero = new app.state.hud.constructor({ canvas: zeroProbe, video: {}, getSettings: () => app.state.settings });
} catch (err) {
  zeroErr = err;
}
test('the HUD survives being built against a hidden (0×0) canvas',
  !zeroErr && !!hudZero,
  zeroErr ? zeroErr.message : 'built with no box to measure — not locked to a 0×0 store');

// The stage opens: the element has a box now, and no window resize fires.
// The frame loop is the net that must catch this on its own.
zeroProbe.clientWidth = 390;
zeroProbe.clientHeight = 640;
await new Promise((r) => setTimeout(r, 80));   // several animation frames
test('the frame loop re-measures a canvas that had no box — tags land on a real backing store',
  zeroProbe.width === 390 && zeroProbe.height === 640 && hudZero.width === 390 && hudZero.height === 640,
  `backing store ${zeroProbe.width}×${zeroProbe.height}, viewport ${hudZero.width}×${hudZero.height}`);

// And a frame drawn once measured must actually reach the canvas.
hudZero.render({
  frame: { width: 640, height: 480 },
  records: [{ id: 1, label: 'mug', cls: 'cup', noun: 'mug', category: 'kitchen', confidence: 0.8, box: [10, 10, 100, 100], age: 0, hits: 1 }],
  texts: [],
  facing: 'environment'
});
test('a frame drawn after the re-measure reaches the canvas',
  zeroLog.some(([kind]) => kind === 'stroke') && zeroLog.some(([kind, arg]) => kind === 'fillText' && /Mug/i.test(String(arg))),
  `${zeroLog.length} draw calls`);

// Node has no ResizeObserver, but every browser this ships to does — and it is
// the only thing watching the box after boot (split-screen, late layout).
const observed = [];
const roCallbacks = [];
class FakeResizeObserver {
  constructor(cb) { roCallbacks.push(cb); }
  observe(el) { observed.push(el); }
  disconnect() {}
}
const hadResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = FakeResizeObserver;
const roProbe = makeElement('hud-ro', 'canvas');
roProbe.clientWidth = 0;
roProbe.clientHeight = 0;
roProbe.parentElement = makeElement('hud-ro-parent');
const hudRo = new app.state.hud.constructor({ canvas: roProbe, video: {}, getSettings: () => app.state.settings });
test('the overlay observes its own box, not just the window',
  observed.includes(roProbe) && observed.includes(roProbe.parentElement),
  `${observed.length} element(s) observed`);
// Same tick, before the frame loop can get there: this proves the observer.
roProbe.clientWidth = 411;
roProbe.clientHeight = 731;
for (const cb of roCallbacks) cb([]);
test('a ResizeObserver callback re-measures the canvas',
  roProbe.width === 411 && roProbe.height === 731 && hudRo.width === 411 && hudRo.height === 731,
  `${roProbe.width}×${roProbe.height}`);
if (hadResizeObserver === undefined) delete globalThis.ResizeObserver;
else globalThis.ResizeObserver = hadResizeObserver;

/* ── the status line reports what is in view ──────────────────────────── */
section('status line');
app.state.lastResult = { records: [{ id: 1 }], texts: [] };
await new Promise((r) => setTimeout(r, 80));
test('status line counts objects in view', elements.get('status-left').textContent === '1 object recognised',
  elements.get('status-left').textContent);
app.state.lastResult = { records: [{ id: 1 }, { id: 2 }, { id: 3 }], texts: [] };
await new Promise((r) => setTimeout(r, 80));
test('status line pluralises', elements.get('status-left').textContent === '3 objects recognised',
  elements.get('status-left').textContent);

// The dot answers "is it actually working?" without a tap. Strip the class it
// ships with and prove the loop puts it back: amber means no pass has landed.
const statusDot = elements.get('status-dot');
if (statusDot) statusDot.classList.remove('warm');
await new Promise((r) => setTimeout(r, 80));
test('status dot is amber while nothing has been recognised yet',
  !!statusDot && statusDot.classList.contains('warm'), 'warm');

app.state.live = true;
app.state.lastResult = { records: [], texts: [] };
await new Promise((r) => setTimeout(r, 80));
test('status dot turns green once a pass has landed',
  !!statusDot && !statusDot.classList.contains('warm'), 'green');
test('a live pass that matched nothing says so — not "recognising"',
  elements.get('status-left').textContent === 'no matches in view',
  elements.get('status-left').textContent);

/* ── the HUD survives a real frame state ──────────────────────────────── */
section('HUD frame render');
let renderError = null;
try {
  app.state.hud.render({
    frame: { width: 640, height: 480 },
    records: [],
    texts: [],
    facing: 'environment'
  });
} catch (err) {
  renderError = err;
}
test('HUD renders a live frame without throwing', !renderError, renderError ? renderError.message : 'DOM-free canvas draw');
await new Promise((r) => setTimeout(r, 120));
test('HUD rAF loop survives repeated frames', errors.length === 0, errors.map((e) => e?.message).join('; '));

// A canvas that loses its box mid-flight (a missed resize, an odd webview, a
// rotation that lands before layout) must re-measure on the next frame rather
// than discarding every tag for the rest of the session.
const hudEl = elements.get('hud');
hudEl.width = 0;
hudEl.height = 0;
app.state.hud.width = 0;
app.state.hud.height = 0;
app.state.hud.render({ frame: { width: 640, height: 480 }, records: [], texts: [], facing: 'environment' });
test('a 0×0 overlay re-measures and draws again on the same frame',
  hudEl.width === 390 && hudEl.height === 640 && app.state.hud.width === 390 && app.state.hud.height === 640,
  `recovered to ${hudEl.width}×${hudEl.height}`);

/* ── a tag lands on its object, not beside it ─────────────────────────── */
section('tag alignment (the overlay uses the video’s cover maths)');

// A phone held upright showing a landscape frame: object-fit: cover crops the
// sides. The overlay must crop identically, or every tag is offset from the
// thing it names — which is the difference between a recognition camera and a
// screensaver.
const alignProbe = makeElement('hud-align', 'canvas');
alignProbe.clientWidth = 360;
alignProbe.clientHeight = 640;
let alignStopped = false;
const alignPoints = [];
{
  const base = alignProbe.getContext('2d');
  const recorder = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    if (key === 'measureText') { recorder[key] = () => ({ width: 10 }); continue; }
    if (typeof value !== 'function') { recorder[key] = value; continue; }
    if (key === 'stroke') { recorder[key] = () => { alignStopped = true; }; continue; }
    if (key === 'moveTo' || key === 'lineTo' || key === 'arcTo') {
      recorder[key] = (x, y) => { if (!alignStopped) alignPoints.push([x, y]); };
      continue;
    }
    recorder[key] = () => undefined;
  }
  alignProbe.getContext = () => recorder;
}
const hudAlign = new app.state.hud.constructor({ canvas: alignProbe, video: {}, getSettings: () => app.state.settings });

// The outline is the first path drawn, so everything recorded up to the first
// stroke() is exactly that outline.
const outlineFor = (box, facing) => {
  alignPoints.length = 0;
  alignStopped = false;
  hudAlign.render({
    frame: { width: 640, height: 480 },
    records: [{ id: 1, label: 'chair', cls: 'chair', noun: 'chair', category: 'furniture', confidence: 0.8, box, age: 999, hits: 9 }],
    texts: [],
    facing
  });
  const xs = alignPoints.map((p) => p[0]);
  const ys = alignPoints.map((p) => p[1]);
  return {
    n: alignPoints.length,
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2
  };
};

const map = hudAlign.coverTransform(640, 480);
test('the overlay crops the frame exactly like object-fit: cover (no bars to misplace tags)',
  map.offsetX <= 0 && map.offsetY <= 0 && map.dispW >= hudAlign.width && map.dispH >= hudAlign.height,
  `scale ${map.scale.toFixed(3)} — drawn ${map.dispW.toFixed(0)}×${map.dispH.toFixed(0)} on ${hudAlign.width}×${hudAlign.height}, offset ${map.offsetX.toFixed(1)},${map.offsetY.toFixed(1)}`);

const centred = outlineFor([270, 190, 370, 290], 'environment');
test('an object centred in the frame is outlined at the centre of the overlay',
  centred.n >= 5 && Math.abs(centred.cx - 180) <= 1.5 && Math.abs(centred.cy - 320) <= 1.5,
  `outline centre ${centred.cx.toFixed(1)},${centred.cy.toFixed(1)} vs 180,320`);

// Front camera: the video is mirrored, so the tag must be too. One box, two
// facings: it has to land on opposite sides of the screen each time, mirrored
// about the centre — tag and object stay pinned together whichever way the
// camera faces.
const leftBox = [190, 190, 290, 290];   // frame centre x 240 → display x ≈ 73
const rear = outlineFor(leftBox, 'environment');
const front = outlineFor(leftBox, 'user');
test('the front camera mirrors the tag to the side the object appears on',
  rear.n >= 5 && front.n >= 5
    && rear.cx < hudAlign.width / 2 && front.cx > hudAlign.width / 2
    && Math.abs((rear.cx + front.cx) - hudAlign.width) < 1,
  `rear centre x ${rear.cx.toFixed(1)}, front centre x ${front.cx.toFixed(1)} on a ${hudAlign.width}-wide overlay`);

/* ── the v3 camera-only contract ──────────────────────────────────────── */
section('camera-only contract');

// The stage is the feed plus the overlay drawn on it — and nothing a finger
// can press. Boot-recovery buttons live on the boot card, deliberately outside
// <main id="stage">.
const stageHtml = (html.match(/<main id="stage"[\s\S]*?<\/main>/) || [''])[0];
test('the stage carries zero interactive elements',
  !/<button|<input|<select|<textarea|<a\s|<label|onclick=/i.test(stageHtml)
    && /id="cam"/.test(stageHtml) && /id="hud"/.test(stageHtml) && /id="status-left"/.test(stageHtml),
  stageHtml.includes('<button') ? 'an interactive tag sits inside #stage' : 'video, overlay canvas, status line — nothing else');

// A first-seen object is outlined and named on that very frame: no dwell, no
// confirmation, nothing to tap. age 0 / hits 1 is literally the first frame.
const outlineLog = [];
const probe = makeElement('hud-firstframe', 'canvas');
{
  const base = probe.getContext('2d');
  const recorder = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    if (typeof value === 'function') {
      recorder[key] = (...args) => {
        outlineLog.push([key, args[0]]);
        return key === 'measureText' ? { width: 10 } : undefined;
      };
    } else {
      recorder[key] = value;
    }
  }
  probe.getContext = () => recorder;
}
const hudProbe = new app.state.hud.constructor({ canvas: probe, video: {}, getSettings: () => app.state.settings });
hudProbe.render({
  frame: { width: 640, height: 480 },
  records: [{
    id: 7, label: 'espresso machine', cls: 'cup', noun: 'espresso machine', category: 'kitchen',
    confidence: 0.9, box: [100, 100, 200, 200], age: 0, hits: 1
  }],
  texts: [],
  facing: 'environment'
});
const drewOutline = outlineLog.some(([kind]) => kind === 'stroke');
const drewName = outlineLog.some(([kind, arg]) => kind === 'fillText' && /Espresso Machine/i.test(String(arg)));
const drewConfidence = outlineLog.some(([kind, arg]) => kind === 'fillText' && /90\s*%/.test(String(arg)));
test('outline, name and confidence land on the first frame an object is seen (age 0, hits 1)',
  drewOutline && drewName && drewConfidence,
  `${outlineLog.length} draw calls, name ${drewName ? 'drawn' : 'missing'}, confidence ${drewConfidence ? 'drawn' : 'missing'}`);

// People get their posture word as a quiet second line.
const personLog = [];
const probe2 = makeElement('hud-person', 'canvas');
{
  const base = probe2.getContext('2d');
  const recorder = {};
  for (const key of Object.keys(base)) {
    if (typeof base[key] === 'function') {
      recorder[key] = (...args) => { personLog.push([key, args[0]]); return key === 'measureText' ? { width: 10 } : undefined; };
    } else recorder[key] = base[key];
  }
  probe2.getContext = () => recorder;
}
const hudProbe2 = new app.state.hud.constructor({ canvas: probe2, video: {}, getSettings: () => app.state.settings });
hudProbe2.render({
  frame: { width: 640, height: 480 },
  records: [{
    id: 9, label: 'person', cls: 'person', noun: 'person', category: 'person',
    confidence: 0.84, box: [100, 60, 220, 420], age: 900, hits: 12,
    posture: 'sitting', activity: { id: 'sitting', label: 'seated', confidence: 0.6 }
  }],
  texts: [],
  facing: 'environment'
});
test('person tag carries the posture word', personLog.some(([kind, arg]) => kind === 'fillText' && /Seated/i.test(String(arg))),
  personLog.filter(([k]) => k === 'fillText').map(([, a]) => a).join(' | '));

// The old proactive channels (narrator, voice, ticker, subtitles, hazard
// toasts, memory) are gone for good: nothing in the app may import them.
const appSrc = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
test('no speech, agent, memory, install or hazard channels remain in the app',
  !/from '\.\/(agent|speech|install|memory|attributes)\.js'/.test(appSrc)
    && !/Narrator|voice\.say|VoiceInput|subtitle|ticker|toast\(|evaluateHazards/i.test(appSrc)
    && !existsSync(join(ROOT, 'js/agent.js')) && !existsSync(join(ROOT, 'js/speech.js'))
    && !existsSync(join(ROOT, 'js/install.js')) && !existsSync(join(ROOT, 'js/memory.js'))
    && !existsSync(join(ROOT, 'js/attributes.js')),
  'the five modules are removed and unimported');

/* ── demo entry recovers from the failure state ───────────────────────── */
section('demo feed entry');
app.state.bootFailed = false;
app.state.bootFailKind = null;
await app.startDemo();
// Models can never load in this harness (the runtime script errors on
// purpose): the honest outcome is a model error back on the boot screen —
// never a thrown rejection, and the demo button stays on offer.
test('demo entry with dead models reports instead of throwing', app.state.cameraStatus?.ok === true);
test('model failure is re-reported for the demo', elements.get('boot-error').hidden === false);
test('no unhandled rejections after demo attempt', errors.length === 0, errors.map((e) => e?.message).join('; '));

export default true;
