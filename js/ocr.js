/**
 * ocr.js — PP-OCRv4 text recognition, the module that names brands.
 *
 * Three PaddleOCR models run in sequence (16 MB total):
 *
 *   det  DBNet text-region segmentation   -> probability map
 *   cls  0°/180° orientation classifier   -> upright crops
 *   rec  CRNN + CTC recogniser (6623 char) -> the actual characters
 *
 * What makes this module matter for ARGUS is not "reading text" in the abstract,
 * it is that the trademark is usually printed on the object: OCR is how "phone"
 * becomes "iPhone" and "power tool" becomes "Bosch". The language model in kb.js
 * then binds that token to the detected class.
 *
 * Two implementation notes worth keeping:
 *   • Text regions are found as connected components and each component's
 *     oriented box comes from a PCA of its pixels, so rotated and vertical text
 *     is rectified rather than boxed axis-aligned.
 *   • Unclipping uses PaddleOCR's own formula (d = area × ratio / length) so the
 *     crops match what the recogniser was trained on.
 */

import { toTensor, warpQuad, rotate180, boxArea } from './core.js';
import { OCR_CHARSET, OCR_SPACE_INDEX } from './data/ocrchars.js';
import { matchBrand, matchSign } from './kb.js';

const DET_URL = 'models/ppocr-det.onnx';
const REC_URL = 'models/ppocr-rec.onnx';
const CLS_URL = 'models/ppocr-cls.onnx';

export const OCR_INFO = {
  name: 'PP-OCRv4',
  detection: 'PP-OCRv4 DBNet (4.5 MB)',
  recognition: 'PP-OCRv4 CRNN + CTC, 6623 symbols (10.4 MB)',
  orientation: 'PP-OCR mobile 0/180 classifier (0.6 MB)',
  languages: 'Latin + CJK + digits + punctuation',
  note: 'Unclipped oriented boxes, PCA-rectified crops, greedy CTC decode.'
};

export class Ocr {
  constructor({ runtime, onLog = () => {} } = {}) {
    this.runtime = runtime;
    this.onLog = onLog;
    this.det = null;
    this.rec = null;
    this.cls = null;
    this.ready = false;
    this.lastMs = 0;
    this.regions = 0;
  }

  async load({ onProgress = () => {}, orientation = true } = {}) {
    if (this.det && this.rec) return true;
    const ep = this.runtime.tier === 'webgpu' ? ['wasm'] : null;
    this.det = await this.runtime.session(DET_URL, { verify: true, label: 'OCR TEXT DETECTOR', ep, onProgress });
    this.rec = await this.runtime.session(REC_URL, { verify: true, label: 'OCR RECOGNISER', ep, onProgress });
    if (orientation) this.cls = await this.runtime.session(CLS_URL, { verify: true, label: 'OCR ORIENTATION', ep, onProgress });
    this.ready = true;
    this.onLog('OCR online — PP-OCRv4 detection + recognition');
    return true;
  }

  /**
   * Read every piece of text in an image.
   *
   * @param {ImageData} img
   * @param {object} opts
   * @param {number} opts.minConfidence   recogniser confidence floor (0-1)
   * @param {number} opts.maxLines
   * @param {boolean} opts.brands         attach brand/sign matches
   * @returns {Promise<{lines:Array, ms:number}>}
   */
  async read(img, { minConfidence = 0.55, maxLines = 24, brands = true, orientation = true } = {}) {
    if (!this.ready) return { lines: [], ms: 0 };
    const started = performance.now();
    const boxes = await this._detect(img);
    const lines = [];
    for (const region of boxes.slice(0, maxLines)) {
      const line = await this._recognise(img, region, { orientation });
      if (line && line.confidence >= minConfidence && line.text.trim()) lines.push(line);
    }
    if (brands) {
      for (const line of lines) {
        const brand = matchBrand(line.text);
        if (brand) line.brand = { name: brand.name, sector: brand.sector, products: brand.products, exact: brand.exact };
        const sign = matchSign(line.text);
        if (sign) line.sign = { kind: sign.kind, tier: sign.tier, say: sign.say };
      }
    }
    this.regions = boxes.length;
    this.lastMs = Math.round(performance.now() - started);
    return { lines, ms: this.lastMs, regions: boxes.length };
  }

  /** Text inside one box only — used when the user asks "read that". */
  async readBox(img, box, opts = {}) {
    const pad = Math.round(Math.max(box[2] - box[0], box[3] - box[1]) * 0.06);
    const x = Math.max(0, Math.floor(box[0] - pad));
    const y = Math.max(0, Math.floor(box[1] - pad));
    const w = Math.min(img.width - x, Math.ceil(box[2] - box[0] + pad * 2));
    const h = Math.min(img.height - y, Math.ceil(box[3] - box[1] + pad * 2));
    if (w < 8 || h < 8) return { lines: [] };
    const crop = new ImageData(w, h);
    for (let row = 0; row < h; row++) {
      const srcStart = ((y + row) * img.width + x) * 4;
      crop.data.set(img.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
    }
    return this.read(crop, opts);
  }

  /* ---------------------------------------------------------------- *
   * Stage 1 — detection
   * ---------------------------------------------------------------- */

  async _detect(img) {
    const limit = 736;
    const minSide = Math.min(img.width, img.height);
    let scale = minSide < limit ? limit / minSide : 1;
    if (Math.max(img.width, img.height) * scale > 2000) scale = 2000 / Math.max(img.width, img.height);
    const w = Math.max(32, Math.round(img.width * scale / 32) * 32);
    const h = Math.max(32, Math.round(img.height * scale / 32) * 32);
    const resized = this._resize(img, w, h);
    const tensor = toTensor(resized, { layout: 'NCHW', scale: 1 / 255, mean: 0.5, std: 0.5 });
    const feeds = {};
    feeds[this.det.inputs[0]] = new (this.runtime.ort.Tensor)('float32', tensor, [1, 3, h, w]);
    const out = await this.det.run(feeds);
    const prob = out[this.det.outputs[0]];
    const map = prob.data;
    const regions = this._components(map, w, h, { threshold: 0.3, boxThreshold: 0.5, unclip: 1.6 });
    // Map back into source-image coordinates.
    return regions.map((r) => ({
      quad: r.quad.map(([x, y]) => [x / scale, y / scale]),
      score: r.score,
      box: [
        Math.min(...r.quad.map((p) => p[0])) / scale,
        Math.min(...r.quad.map((p) => p[1])) / scale,
        Math.max(...r.quad.map((p) => p[0])) / scale,
        Math.max(...r.quad.map((p) => p[1])) / scale
      ]
    }));
  }

  /**
   * Binarise the probability map and turn connected components into oriented
   * boxes. Component geometry is accumulated as second moments so memory stays
   * flat regardless of how much text is in frame.
   */
  _components(map, w, h, { threshold, boxThreshold, unclip }) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = map[i] > threshold ? 1 : 0;
    const visited = new Uint8Array(w * h);
    const regions = [];
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || visited[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sScore = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const x = p % w;
        const y = (p / w) | 0;
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
        sScore += map[p];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const np = ny * w + nx;
            if (mask[np] && !visited[np]) { visited[np] = 1; stack[sp++] = np; }
          }
        }
      }
      if (n < 12) continue;                                   // specks
      const score = sScore / n;
      if (score < boxThreshold) continue;
      const cx = sx / n; const cy = sy / n;
      const covXX = sxx / n - cx * cx;
      const covXY = sxy / n - cx * cy;
      const covYY = syy / n - cy * cy;
      // Principal axis of the pixel cloud — the text baseline direction.
      const theta = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
      const ux = Math.cos(theta); const uy = Math.sin(theta);
      const vx = -uy; const vy = ux;
      // Extents along the two axes are cheaper as a second pass over the box.
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (let y = Math.max(0, minY - 2); y <= Math.min(h - 1, maxY + 2); y++) {
        for (let x = Math.max(0, minX - 2); x <= Math.min(w - 1, maxX + 2); x++) {
          if (!mask[y * w + x]) continue;
          const dx = x - cx; const dy = y - cy;
          const u = dx * ux + dy * uy;
          const v = dx * vx + dy * vy;
          if (u < uMin) uMin = u;
          if (u > uMax) uMax = u;
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
        }
      }
      let bw = uMax - uMin; let bh = vMax - vMin;
      if (bw <= 1 || bh <= 1) continue;
      if (bw < bh) {   // make u the long axis (vertical text rotated upright)
        const t = bw; bw = bh; bh = t;
        const tu = ux; ux = vx; uy = vy; vx = -tu; vy = -uy;
      }
      // PaddleOCR unclip: extend both axes by d = area * ratio / perimeter.
      const d = ((bw + 2) * (bh + 2) * unclip) / (2 * ((bw + 2) + (bh + 2)));
      const hu = bw / 2 + d;
      const hv = bh / 2 + d;
      const corners = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([u, v]) => [
        cx + u * ux + v * vx,
        cy + u * uy + v * vy
      ]);
      regions.push({ quad: corners, score, textBoxPx: bw * bh });
    }
    return regions.sort((a, b) => b.score - a.score).slice(0, 64);
  }

  /* ---------------------------------------------------------------- *
   * Stage 2 + 3 — orientation and recognition
   * ---------------------------------------------------------------- */

  async _recognise(img, region, { orientation }) {
    const quad = [...region.quad];
    // Quad area sanity: skip anything degenerate (column warps from thin masks).
    let aspect = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1])
      / Math.max(1, Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]));
    if (aspect < 1) {   // rotate corner order so the long side is the reading side
      const [a, b, c, d] = quad;
      quad.length = 0;
      quad.push(d, [d[0] + (c[0] - d[0]), d[1] + (c[1] - d[1])], c, [c[0] + (b[0] - c[0]) * 0 + (a[0] - d[0]), c[1] + (a[1] - d[1])]);
      aspect = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1])
        / Math.max(1, Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]));
    }
    const cropH = 48;
    const cropW = Math.max(16, Math.min(320, Math.round(cropH * aspect)));
    let crop = warpQuad(img, quad, cropW, cropH);

    if (orientation && this.cls && cropW >= 24) {
      try {
        const clsTensor = toTensor(this._padTo(crop, 192, 48), { layout: 'NCHW', scale: 1 / 255, mean: 0.5, std: 0.5 });
        const feeds = {};
        feeds[this.cls.inputs[0]] = new (this.runtime.ort.Tensor)('float32', clsTensor, [1, 3, 48, 192]);
        const out = await this.cls.run(feeds);
        const p = out[this.cls.outputs[0]].data;
        if (p[1] > p[0] && p[1] > 0.9) crop = rotate180(crop);
      } catch { /* orientation is a nicety, never fatal */ }
    }

    // Recognition wants W padded to a multiple of 32.
    const recW = Math.max(32, Math.round(cropW / 32) * 32);
    const padded = recW === crop.width ? crop : this._padTo(crop, recW, cropH);
    const tensor = toTensor(padded, { layout: 'NCHW', scale: 1 / 255, mean: 0.5, std: 0.5 });
    const feeds = {};
    feeds[this.rec.inputs[0]] = new (this.runtime.ort.Tensor)('float32', tensor, [1, 3, cropH, recW]);
    const out = await this.rec.run(feeds);
    const raw = out[this.rec.outputs[0]];
    const { text, confidence, chars } = this._ctc(raw);
    return {
      text,
      confidence,
      chars,
      quad,
      box: region.box || [Math.min(...quad.map((p) => p[0])), Math.min(...quad.map((p) => p[1])),
        Math.max(...quad.map((p) => p[0])), Math.max(...quad.map((p) => p[1]))],
      height: Math.abs(quad[3][1] - quad[0][1]) || Math.abs(quad[2][1] - quad[1][1]),
      cjk: /[\u3000-\u9fff\uff00-\uffef]/.test(text)
    };
  }

  /** Greedy CTC decode with per-character confidence. */
  _ctc(tensor) {
    const { data, dims } = tensor;
    const [n, steps, classes] = dims.length === 3 ? dims : [1, dims[0], dims[1]];
    let out = '';
    const chars = [];
    let confSum = 0;
    let confCount = 0;
    let prev = 0;
    for (let t = 0; t < steps; t++) {
      let best = 0; let bestP = -1;
      const base = t * classes;
      for (let c = 0; c < classes; c++) {
        const v = data[base + c];
        if (v > bestP) { bestP = v; best = c; }
      }
      if (best !== 0 && best !== prev) {
        const ch = best === OCR_SPACE_INDEX ? ' ' : (OCR_CHARSET[best - 1] ?? '');
        if (ch) {
          out += ch;
          chars.push({ ch, p: bestP });
          confSum += bestP;
          confCount++;
        }
      }
      prev = best;
    }
    return { text: out.trim(), confidence: confCount ? confSum / confCount : 0, chars };
  }

  _resize(img, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const src = document.createElement('canvas');
    src.width = img.width; src.height = img.height;
    src.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** Right-pad with mid grey so a short crop fills the recogniser's canvas. */
  _padTo(img, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(127,127,127)';
    ctx.fillRect(0, 0, w, h);
    const src = document.createElement('canvas');
    src.width = img.width; src.height = img.height;
    src.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  }

  info() {
    return { ...OCR_INFO, loaded: this.ready, regions: this.regions, lastMs: this.lastMs };
  }
}

/** Group recogniser lines into a sentence-shaped summary for the HUD ticker. */
export function summariseText(lines, maxChars = 90) {
  if (!lines.length) return '';
  const joined = lines
    .slice()
    .sort((a, b) => (a.box?.[1] ?? 0) - (b.box?.[1] ?? 0))
    .map((l) => l.text)
    .join(' · ');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}


