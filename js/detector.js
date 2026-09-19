/**
 * detector.js — YOLOv8 object detection with tiled (SAHI-style) inference.
 *
 * The bundled model is YOLOv8-nano on COCO-80: 3.2 M parameters, 12 MB, and
 * good enough to be useful on a phone. Its weakness is small objects, which is
 * exactly what a worn camera sees most of the time — a plug socket, a key, a
 * label. So the detector runs the frame twice over when detail mode is on:
 * once whole, once as overlapping tiles, and the results are merged with
 * class-aware non-maximum suppression.
 *
 * Everything is model-agnostic: the head decoder accepts both `[1,84,N]` and
 * `[1,N,84]` layouts, and any /32-multiple input size is valid because the
 * export is dynamic.
 */

import { Runtime, fitSize, toTensor, nms, iou, boxArea, clamp, scratch, ctx2d, putFrame } from './core.js';
import { CLASSES } from './config.js';

const MODEL_URL = 'models/yolov8n.onnx';

export const MODEL_INFO = {
  name: 'YOLOv8-nano',
  architecture: 'CSPDarknet + PAN-FPN, anchor-free decoupled head',
  opset: 12,
  params: 3151904,
  classes: CLASSES.length,
  dataset: 'COCO 2017 (80 classes)',
  onDisk: '12.1 MB',
  note: 'Dynamic-shape export: any /32 stride input (256-704 px per axis) is valid.'
};

export class Detector {
  constructor({ runtime, onLog = () => {}, defaultSize = 320 } = {}) {
    this.runtime = runtime;
    this.onLog = onLog;
    this.session = null;
    this.ready = false;
    this.lastInferMs = 0;
    this.defaultSize = defaultSize;
  }

  async load({ onProgress = () => {} } = {}) {
    if (this.session) return this.session;
    this.session = await this.runtime.session(MODEL_URL, {
      label: 'YOLOv8-NANO DETECTOR',
      onProgress,
      verify: true
    });
    this.inputName = this.session.inputs[0];
    this.outputName = this.session.outputs[0];
    this.ready = true;
    await this.session.warmup([1, 3, this.defaultSize, this.defaultSize]);
    return this.session;
  }

  /**
   * Run the detector over one image.
   *
   * @param {ImageData} img      full frame
   * @param {object}   opts
   * @param {number}   opts.size scan size (multiple of 32)
   * @param {number}   opts.minScore
   * @param {'off'|'auto'|'4'|'9'} opts.tiles detail mode
   * @returns {Array<{box:number[], score:number, cls:string, clsId:number, tile:number}>}
   */
  async detect(img, { size = 320, minScore = 0.32, tiles = 'off', iouThreshold = 0.5, maxDetections = 40 } = {}) {
    const started = performance.now();
    const all = [];
    const plan = this._tilePlan(img, size, tiles);
    for (let ti = 0; ti < plan.length; ti++) {
      for (const d of await this._runRegion(img, plan[ti], size, minScore, ti)) all.push(d);
    }
    const merged = this._merge(all, iouThreshold, maxDetections);
    this.lastInferMs = Math.round(performance.now() - started);
    return merged;
  }

  /**
   * Run exactly one region of the 2×2 tile plan — the pipeline's interleaved
   * detail sweep: one tile per frame on a fast device, a full small-object
   * sweep over four frames, at a quarter of the old every-frame cost.
   *
   * @param {number} index which tile of the current plan to run (0-3)
   */
  async detectTile(img, { index = 0, size = 288, minScore = 0.32, iouThreshold = 0.5, maxDetections = 40 } = {}) {
    const started = performance.now();
    const plan = this._tilePlan(img, size, '4').slice(1);
    const region = plan[((index % plan.length) + plan.length) % plan.length];
    const dets = await this._runRegion(img, region, size, minScore, index);
    const merged = this._merge(dets, iouThreshold, maxDetections);
    this.lastInferMs = Math.round(performance.now() - started);
    return merged;
  }

  /**
   * Run only the overlapping tile plan (no full frame) — a whole sweep in one
   * call. The pipeline prefers the interleaved detectTile(); this remains for
   * tools that want the complete detail pass in one step.
   */
  async detectTiles(img, { size = 288, minScore = 0.32, target = 2, iouThreshold = 0.5, maxDetections = 40 } = {}) {
    const started = performance.now();
    const all = [];
    const plan = this._tilePlan(img, size, target === 3 ? '9' : '4').slice(1);   // drop the full frame
    for (let ti = 0; ti < plan.length; ti++) {
      for (const d of await this._runRegion(img, plan[ti], size, minScore, ti)) all.push(d);
    }
    const merged = this._merge(all, iouThreshold, maxDetections);
    this.lastInferMs = Math.round(performance.now() - started);
    return merged;
  }

  /** Crop one plan region (or take the whole frame), infer, map back to frame coordinates. */
  async _runRegion(img, region, size, minScore, tileIndex) {
    const crop = region.full ? img : this._crop(img, region);
    const dets = await this._infer(crop, Math.max(256, Math.round(size / 32) * 32), minScore);
    const scaleX = region.full ? 1 : region.w / crop.width;
    const scaleY = region.full ? 1 : region.h / crop.height;
    return dets.map((d) => ({
      ...d,
      box: [
        d.box[0] * scaleX + region.x,
        d.box[1] * scaleY + region.y,
        d.box[2] * scaleX + region.x,
        d.box[3] * scaleY + region.y
      ],
      tile: tileIndex
    }));
  }

  /** Single letterboxed inference pass. */
  async _infer(img, size, minScore) {
    if (!this.ready) return [];
    const fit = fitSize(img.width, img.height, size, 'max');
    const w = Math.max(32, Math.round(fit.w / 32) * 32);
    const h = Math.max(32, Math.round(fit.h / 32) * 32);
    const letterboxed = this._letterbox(img, w, h);
    const tensor = toTensor(letterboxed, { layout: 'NCHW', scale: 1 / 255, mean: 0, std: 1 });
    const feeds = {};
    feeds[this.inputName] = new (this.runtime.ort.Tensor)('float32', tensor, [1, 3, h, w]);
    const out = await this.session.run(feeds);
    const raw = out[this.outputName];
    return this._decode(raw, { w, h, srcW: img.width, srcH: img.height, padW: this._padW, padH: this._padH, scale: this._scale, minScore });
  }

  /** Decide how to slice the frame. Keeps the tile count bounded on purpose. */
  _tilePlan(img, size, mode) {
    const full = { full: true, x: 0, y: 0, w: img.width, h: img.height, idx: 0 };
    if (mode === 'off') return [full];
    const target = mode === '9' || mode === 'auto-9' ? 3 : 2;
    const tileW = Math.round(img.width / target * 1.12);   // ~12 % overlap
    const tileH = Math.round(img.height / target * 1.12);
    const plan = [full];
    for (let r = 0; r < target; r++) {
      for (let c = 0; c < target; c++) {
        const x = Math.max(0, Math.min(img.width - tileW, Math.round(c * img.width / target - (tileW - img.width / target) / 2)));
        const y = Math.max(0, Math.min(img.height - tileH, Math.round(r * img.height / target - (tileH - img.height / target) / 2)));
        plan.push({ full: false, x, y, w: Math.min(tileW, img.width - x), h: Math.min(tileH, img.height - y), idx: plan.length });
      }
    }
    return plan;
  }

  _crop(img, region) {
    // Pooled canvases: the old version allocated two fresh canvases and copied
    // the whole frame into a new one for every tile, every frame.
    const src = putFrame(img, 'det-src');
    const c = scratch('det-crop', region.w, region.h);
    const ctx = ctx2d(c);
    ctx.clearRect(0, 0, region.w, region.h);
    ctx.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    return ctx.getImageData(0, 0, region.w, region.h);
  }

  _letterbox(img, w, h) {
    const scale = Math.min(w / img.width, h / img.height);
    const nw = Math.round(img.width * scale);
    const nh = Math.round(img.height * scale);
    const padW = Math.floor((w - nw) / 2);
    const padH = Math.floor((h - nh) / 2);
    const c = scratch('det-box', w, h);
    const ctx = ctx2d(c);
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(putFrame(img, 'det-src'), padW, padH, nw, nh);
    this._padW = padW; this._padH = padH; this._scale = scale;
    return ctx.getImageData(0, 0, w, h);
  }

  /**
   * Decode the YOLOv8 head. Accepts both channel-first and channel-last exports
   * and maps boxes from letterbox space back to source pixels.
   */
  _decode(tensor, { w, h, padW, padH, scale, minScore, srcW = Infinity, srcH = Infinity }) {
    const { data, dims } = tensor;
    const channelFirst = dims[1] < dims[2];
    const channels = channelFirst ? dims[1] : dims[2];
    const anchors = channelFirst ? dims[2] : dims[1];
    const numClasses = channels - 4;
    const at = (a, c) => (channelFirst ? data[c * anchors + a] : data[a * channels + c]);
    const results = [];
    for (let a = 0; a < anchors; a++) {
      let best = -1; let bestScore = minScore;
      for (let c = 0; c < numClasses; c++) {
        const s = at(a, 4 + c);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (best < 0) continue;
      const cx = at(a, 0); const cy = at(a, 1);
      const bw = at(a, 2); const bh = at(a, 3);
      const box = [
        (cx - bw / 2 - padW) / scale,
        (cy - bh / 2 - padH) / scale,
        (cx + bw / 2 - padW) / scale,
        (cy + bh / 2 - padH) / scale
      ];
      // A detector will happily predict a box that runs off the edge of the
      // frame; every consumer downstream (crops, ranges, the HUD) wants
      // coordinates inside the image, so clamp here rather than in ten places.
      box[0] = clamp(box[0], 0, srcW);
      box[1] = clamp(box[1], 0, srcH);
      box[2] = clamp(box[2], 0, srcW);
      box[3] = clamp(box[3], 0, srcH);
      if (box[2] - box[0] < 2 || box[3] - box[1] < 2) continue;
      results.push({
        box,
        score: bestScore,
        clsId: best,
        cls: CLASSES[best] || `class ${best}`
      });
    }
    return nms(results, 0.5, 'class');
  }

  /** Merge tiled results: same-class overlaps keep the highest score. */
  _merge(dets, iouThreshold, maxDetections) {
    const sorted = [...dets].sort((a, b) => b.score - a.score);
    const keep = [];
    for (const d of sorted) {
      let drop = false;
      for (const k of keep) {
        if (k.cls !== d.cls) continue;
        const overlap = iou(k.box, d.box);
        const areaRatio = Math.min(boxArea(k.box), boxArea(d.box)) / Math.max(1e-6, Math.max(boxArea(k.box), boxArea(d.box)));
        if (overlap > iouThreshold || (areaRatio > 0.7 && overlap > 0.3)) { drop = true; break; }
      }
      if (!drop) keep.push(d);
      if (keep.length >= maxDetections) break;
    }
    return keep;
  }

  /** Convenience for the diagnostics panel. */
  info() {
    return {
      ...MODEL_INFO,
      loaded: this.ready,
      lastInferMs: this.lastInferMs,
      providers: this.session?.meta?.providers || []
    };
  }
}
