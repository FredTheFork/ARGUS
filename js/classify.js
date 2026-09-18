/**
 * classify.js — 1000-class ImageNet recognition + 1280-d embeddings + few-shot.
 *
 * The detector answers "there is a blob of class X". This module answers "and
 * what exactly is that blob", three different ways:
 *
 *   1. TAXONOMY. EfficientNet-Lite4 (INT8, 12.9 MB) classifies the crop over
 *      1000 ImageNet classes — the vocabulary that contains "espresso maker",
 *      "power drill", "hard disc", "iPod" and "plug", none of which COCO has.
 *
 *   2. EMBEDDING. The same graph exposes its 1280-d pooled features, so every
 *      crop gets a compact appearance fingerprint at no extra inference cost.
 *      Fingerprints power the similarity search ("show me more like this") and
 *      the tracker's appearance check.
 *
 *   3. FEW-SHOT LEARNING. Fingerprints are also the mechanism behind TEACH: the
 *      user names an object once, its fingerprint is stored, and every later
 *      frame matches against the store by cosine similarity. That is how the
 *      assistant can honestly learn "plug socket" — a class no public detector
 *      ships with — in one tap, and how it recognises objects specific to one
 *      person's life: their keys, their mug, their inhaler.
 */

import { l2normalise, cosine, toTensor } from './core.js';
import { IMAGENET_KB, IMAGENET_NOISE, displayName, lookup, categoryOf } from './kb.js';

const MODEL_URL = 'models/imagenet-lite4.onnx';
const INPUT = 224;

export const CLASSIFIER_INFO = {
  name: 'EfficientNet-Lite4',
  dataset: 'ImageNet-1k (1000 classes)',
  quantised: 'INT8 QDQ',
  embedding: 1280,
  onDisk: '12.9 MB',
  note: 'Outputs both softmax probabilities and the pooled feature vector.'
};

export class Classifier {
  constructor({ runtime, onLog = () => {} } = {}) {
    this.runtime = runtime;
    this.onLog = onLog;
    this.session = null;
    this.ready = false;
    this.calls = 0;
    this.lastMs = 0;
    this._canvas = null;
  }

  async load({ onProgress = () => {} } = {}) {
    if (this.session) return this.session;
    // Quantised graph: explicitly prefer WASM, where ORT has native QLinear ops.
    this.session = await this.runtime.session(MODEL_URL, {
      verify: true,
      label: 'IMAGENET CLASSIFIER',
      ep: this.runtime.tier === 'webgpu' ? ['wasm'] : null,
      onProgress
    });
    this.inputName = this.session.inputs[0];
    this.probName = this.session.outputs[0];
    this.embName = this.session.outputs[1];
    this.ready = true;
    await this.session.warmup([1, INPUT, INPUT, 3]);
    this.onLog(`classifier ready — ${CLASSIFIER_INFO.name}, ${CLASSIFIER_INFO.dataset}`);
    return this.session;
  }

  /**
   * Classify a crop.
   *
   * @param {ImageData} crop
   * @param {object} opts
   * @param {number} opts.topK
   * @param {boolean} opts.embed  also return the L2-normalised fingerprint
   * @returns {{top:Array<{name:string,label:string,prob:number,index:number}>, embedding:Float32Array|null, ms:number}}
   */
  async classify(crop, { topK = 5, embed = true } = {}) {
    if (!this.ready || !crop || crop.width < 8 || crop.height < 8) return { top: [], embedding: null, ms: 0 };
    const started = performance.now();
    const square = this._square(crop);
    const tensor = toTensor(square, { layout: 'NHWC', scale: 2 / 255, mean: 1, std: 1 });
    const feeds = {};
    feeds[this.inputName] = new (this.runtime.ort.Tensor)('float32', tensor, [1, INPUT, INPUT, 3]);
    const out = await this.session.run(feeds);
    const probs = out[this.probName].data;
    const idx = Array.from(probs, (_, i) => i);
    idx.sort((a, b) => probs[b] - probs[a]);
    const top = [];
    for (let i = 0; i < Math.min(topK * 2, idx.length) && top.length < topK; i++) {
      const j = idx[i];
      const rec = IMAGENET_KB[j];
      if (!rec) continue;
      if (IMAGENET_NOISE.has(rec.imagenetLabel) && top.length >= 2) continue;
      top.push({
        name: displayName(rec.name),
        label: rec.imagenetLabel,
        prob: probs[j],
        index: j,
        category: rec.category,
        tier: rec.tier
      });
    }
    const embRaw = out[this.embName]?.data;
    this.calls++;
    this.lastMs = Math.round(performance.now() - started);
    return {
      top,
      embedding: embed && embRaw ? l2normalise(embRaw) : null,
      ms: this.lastMs
    };
  }

  /** Match a crop against taught examples. Returns best hit or null. */
  static matchTaught(embedding, store, { minScore = 0.62 } = {}) {
    if (!embedding || !store?.examples?.length) return null;
    let best = null;
    for (const ex of store.examples) {
      const score = cosine(embedding, ex.embedding);
      if (!best || score > best.score) best = { ...ex, score };
    }
    if (!best || best.score < minScore) return null;
    return best;
  }

  _square(crop) {
    const size = Math.max(crop.width, crop.height);
    if (!this._canvas) this._canvas = document.createElement('canvas');
    const c = this._canvas;
    c.width = INPUT; c.height = INPUT;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(127,127,127)';
    ctx.fillRect(0, 0, INPUT, INPUT);
    const src = document.createElement('canvas');
    src.width = crop.width; src.height = crop.height;
    src.getContext('2d').putImageData(crop, 0, 0);
    const scale = INPUT / size;
    const w = Math.round(crop.width * scale);
    const h = Math.round(crop.height * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, Math.round((INPUT - w) / 2), Math.round((INPUT - h) / 2), w, h);
    return ctx.getImageData(0, 0, INPUT, INPUT);
  }

  info() {
    return { ...CLASSIFIER_INFO, loaded: this.ready, calls: this.calls, lastMs: this.lastMs };
  }
}

/**
 * Teachable similarity store. Kept deliberately small and in-memory here; the
 * persistence layer (memory.js) serialises it to localStorage/IndexedDB.
 */
export class TeachStore {
  constructor({ limit = 400 } = {}) {
    this.examples = [];
    this.limit = limit;
    this.version = 1;
  }

  add({ label, embedding, category = null, tags = [], note = '', crop = null, box = null }) {
    if (!embedding) return null;
    const existing = this.examples.filter((e) => e.label === label);
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label,
      category: category || categoryOf(label),
      tags,
      note,
      embedding: Array.from(embedding),
      thumb: crop || null,
      samples: existing.length + 1,
      created: Date.now()
    };
    this.examples.push(entry);
    if (this.examples.length > this.limit) this.examples.splice(0, this.examples.length - this.limit);
    return entry;
  }

  /** Rebuild Float32 views after a JSON round-trip. */
  hydrate() {
    for (const e of this.examples) if (!(e.embedding instanceof Float32Array)) e.embedding = Float32Array.from(e.embedding);
    return this;
  }

  forget(label) {
    const before = this.examples.length;
    this.examples = this.examples.filter((e) => e.label !== label);
    return before - this.examples.length;
  }

  labels() {
    const counts = new Map();
    for (const e of this.examples) counts.set(e.label, (counts.get(e.label) || 0) + 1);
    return [...counts.entries()].map(([label, samples]) => ({ label, samples }));
  }

  toJSON() {
    return { version: this.version, examples: this.examples };
  }

  static fromJSON(obj) {
    const store = new TeachStore();
    if (obj?.examples) store.examples = obj.examples.map((e) => ({ ...e, embedding: Float32Array.from(e.embedding || []) }));
    return store;
  }
}

/** Combine a detector class and classifier votes into one refined answer. */
export function refineFromClassifier(cls, top = []) {
  if (!top.length) return { refined: null, confidence: 0, agree: false };
  const clsRec = lookup(cls, { fuzzy: false });
  const clsCategory = clsRec?.category || categoryOf(cls);
  const best = top[0];
  const sameCategory = best.category === clsCategory;
  const isSubtype = clsRec && (clsRec.aliases.some((a) => best.name.includes(a)) || best.name.includes(clsRec.name));

  if (isSubtype) return { refined: best.name, confidence: best.prob, agree: true };
  if (sameCategory && best.prob > 0.42) return { refined: best.name, confidence: best.prob, agree: true };
  // A confident, unrelated answer (e.g. detector "cup", classifier "espresso
  // maker") is worth reporting, but only when the detector itself was unsure.
  if (best.prob > 0.66 && best.tier >= 2) return { refined: best.name, confidence: best.prob * 0.85, agree: false };
  const second = top.find((t) => t.category === clsCategory && t.prob > 0.12);
  if (second) return { refined: second.name, confidence: second.prob, agree: true };
  return { refined: null, confidence: 0, agree: false };
}
