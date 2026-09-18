/**
 * tests/harness.mjs — the tiny DOM the modules need, plus a report tally.
 *
 * The perception code touches canvas only from inside functions, so the whole
 * stack can be exercised under Node with a software canvas. That is what makes
 * the logic tests below possible without a browser.
 */

class Ctx {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000';
    this.imageSmoothingEnabled = false;
    this.imageSmoothingQuality = 'low';
  }
  clearRect() { this.canvas._d.fill(0); }
  fillRect() {}
  putImageData(img, x = 0, y = 0) {
    const { width: w, height: h } = this.canvas;
    for (let row = 0; row < img.height; row++) {
      for (let col = 0; col < img.width; col++) {
        const dx = x + col; const dy = y + row;
        if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
        const si = (row * img.width + col) * 4;
        const di = (dy * w + dx) * 4;
        this.canvas._d[di] = img.data[si];
        this.canvas._d[di + 1] = img.data[si + 1];
        this.canvas._d[di + 2] = img.data[si + 2];
        this.canvas._d[di + 3] = img.data[si + 3];
      }
    }
  }
  drawImage(src, sx = 0, sy = 0, sw, sh, dx = 0, dy = 0, dw, dh) {
    const s = src._d || src.data || src;
    const sW = src._w || src.width; const sH = src._h || src.height;
    if (arguments.length <= 3) { sw = sW; sh = sH; dx = 0; dy = 0; dw = sW; dh = sH; }
    if (arguments.length === 5) { dx = sx; dy = sy; dw = sw; dh = sh; sx = 0; sy = 0; sw = sW; sh = sH; }
    dw = dw || sw; dh = dh || sh;
    const { width: ow, height: oh, _d: out } = this.canvas;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const ix = Math.min(sW - 1, Math.max(0, Math.round(sx + (x / dw) * sw)));
        const iy = Math.min(sH - 1, Math.max(0, Math.round(sy + (y / dh) * sh)));
        const si = (iy * sW + ix) * 4;
        const ox = Math.round(dx) + x; const oy = Math.round(dy) + y;
        if (ox < 0 || oy < 0 || ox >= ow || oy >= oh) continue;
        const di = (oy * ow + ox) * 4;
        out[di] = s[si]; out[di + 1] = s[si + 1]; out[di + 2] = s[si + 2]; out[di + 3] = s[si + 3] ?? 255;
      }
    }
  }
  getImageData(x, y, w, h) {
    const out = new ImageData(w, h);
    const { width: cw, _d: src } = this.canvas;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const si = ((y + row) * cw + (x + col)) * 4;
        const di = (row * w + col) * 4;
        out.data[di] = src[si]; out.data[di + 1] = src[si + 1];
        out.data[di + 2] = src[si + 2]; out.data[di + 3] = src[si + 3];
      }
    }
    return out;
  }
  setTransform() {}
  translate() {}
  rotate() {}
  scale() {}
  beginPath() {}
  arc() {}
  fill() {}
  stroke() {}
  save() {}
  restore() {}
}

class Canvas {
  constructor(w = 300, h = 150) {
    this._w = w; this._h = h;
    this._d = new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4);
    this._ctx = new Ctx(this);
  }
  // Real canvas semantics: assigning width/height reallocates and clears the
  // bitmap. Getting this wrong silently truncates any image larger than the
  // default 300x150, which is exactly what a 1080p photograph is.
  get width() { return this._w; }
  set width(v) {
    const w = Math.max(1, v | 0);
    if (w === this._w) return;
    this._w = w;
    this._d = new Uint8ClampedArray(this._w * this._h * 4);
  }
  get height() { return this._h; }
  set height(v) {
    const hgt = Math.max(1, v | 0);
    if (hgt === this._h) return;
    this._h = hgt;
    this._d = new Uint8ClampedArray(this._w * this._h * 4);
  }
  getContext() { return this._ctx; }
  toDataURL() { return 'data:image/png;base64,'; }
  addEventListener() {}
}

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(w, h) {
      if (typeof w === 'object' && w?.data) { this.width = w.width; this.height = w.height; this.data = w.data; return; }
      this.width = w; this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  };
}
/**
 * A generic element for any id the app asks for. It is deliberately permissive:
 * the point of the shared harness is that importing a module never explodes, so
 * the suites that care about DOM behaviour (boot.mjs) build their own richer
 * document on top.
 */
function stubElement(id) {
  return {
    id,
    style: {},
    dataset: {},
    hidden: false,
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    clientWidth: 390,
    clientHeight: 640,
    children: [],
    childElementCount: 0,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); this.childElementCount = this.children.length; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    click() {},
    scrollTo() {},
    getContext: () => new Ctx(new Canvas()),
    toDataURL: () => 'data:image/png;base64,'
  };
}

const elementCache = new Map();
globalThis.document = {
  readyState: 'loading',
  createElement: () => new Canvas(),
  getElementById: (id) => {
    if (!elementCache.has(id)) elementCache.set(id, stubElement(id));
    return elementCache.get(id);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: { style: { setProperty() {} }, dataset: {} },
  body: { dataset: {} }
};
globalThis.window = {
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  devicePixelRatio: 1,
  isSecureContext: true,
  location: { href: 'http://localhost/' }
};
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', hardwareConcurrency: 4, language: 'en-GB' },
    configurable: true
  });
} catch { /* newer Node defines navigator itself */ }
globalThis.self = globalThis;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};
globalThis.confirm = () => true;

export const results = { pass: 0, fail: 0, failures: [] };

export function section(title) {
  console.log(`\n== ${title} ==`);
}

export function test(name, condition, extra = '') {
  if (condition) {
    results.pass++;
    console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    results.fail++;
    results.failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
  return !!condition;
}

export { Canvas, Ctx };
