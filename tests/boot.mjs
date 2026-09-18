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
import { readFileSync } from 'node:fs';
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
      arc() {}, stroke() {}, fill() {}, strokeRect() {}, fillText() {}, measureText: () => ({ width: 10 }),
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
for (const id of ['boot-error', 'demo-fallback', 'subtitle', 'stage']) {
  const el = elements.get(id);
  if (el) el.hidden = true;
}
// Elements the app creates itself (ui.js renders the install button).
for (const extra of ['install-btn']) elements.set(extra, makeElement(extra));

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
  querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? null : null),
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
// Earlier suites import app.js under the generic harness document, which is
// enough for the import-graph check but not for a real boot. Now that this
// suite's richer DOM is installed, boot again through the exported entry point.
await app.start();
await new Promise((r) => setTimeout(r, 500));

const bootError = elements.get('boot-error');
const bootDetail = elements.get('boot-detail');
const demoBtn = elements.get('demo-fallback');

test('boot() ran and read settings', !!app.state.settings, app.state.settings ? `${app.state.settings.theme}, conf ${app.state.settings.minConfidence}` : 'no settings');
test('camera failure is reported in the interface', bootError && bootError.hidden === false, bootDetail?.textContent?.slice(0, 80));
test('interface offers the demo feed', demoBtn && demoBtn.hidden === false);
test('no unhandled rejections during boot', errors.length === 0, errors.map((e) => e?.message).join('; '));
test('default settings applied', app.state.settings.minConfidence > 0 && app.state.settings.theme === 'arc', `theme ${app.state.settings.theme}`);
test('memory loaded', !!app.state.memory && typeof app.state.memory.summary === 'function');
test('speech object constructed', !!app.state.voice && typeof app.state.voice.say === 'function');
test('HUD constructed', !!app.state.hud && !!app.state.hud.ctx, app.state.hud ? 'canvas context bound' : 'no HUD');
test('element index covers index.html ids', [...html.matchAll(/id="([\w-]+)"/g)].every((m) => elements.has(m[1])));

section('demo fallback');
const before = elements.get('toasts').children.length;
await app.state.hud.toast('test toast', 'info');
test('toast renders', elements.get('toasts').children.length > before);

export default true;
