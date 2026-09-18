/**
 * pipeline.js — perception orchestration and evidence fusion.
 *
 * One frame in, a set of object records out. Each record is the union of every
 * piece of evidence the modules produced about one tracked object, resolved into
 * a single honest statement:
 *
 *   { label: 'Apple iPhone', noun: 'phone', confidence: 0.86, source: 'brand',
 *     attributes: { colour: {...}, material: {...}, pattern, shape },
 *     distance: { metres: 0.9, bearing: -6 }, text: 'iPhone 15 Pro',
 *     hazard: null, tier: 3, motion: {...} }
 *
 * Two clocks run here. Detection, tracking, colour/material attributes and the
 * classifier are *in the frame*: they are cheap enough (tens of milliseconds)
 * and everything downstream — narration, the lock, the HUD — needs them now.
 * OCR and pose are *behind* the frame: they cost 100-600 ms each, so they run
 * as background jobs and their results are attached to the next frame's records
 * by geometry. A worn assistant that stutters to read a sign is worse than one
 * that reads the sign a third of a second late.
 *
 * The fusion rules matter more than any single model. A detector saying "phone",
 * a classifier saying "iPod" and OCR reading "iPhone" should produce one answer,
 * not three: brand text read off the object wins (it is printed on the thing
 * itself), then a confident classifier answer compatible with the detected
 * class, then the detected class, then a taught example — which is user-asserted
 * ground truth and therefore outranks everything.
 */

import { Detector } from './detector.js';
import { Classifier, TeachStore, refineFromClassifier } from './classify.js';
import { Ocr } from './ocr.js';
import { Pose, activityOf } from './pose.js';
import { analyseAppearance, estimateRange, lightingOf, inferScene } from './attributes.js';
import { Tracker } from './tracker.js';
import { Rolling, clamp, iou } from './core.js';
import {
  lookup, nameFor, tierOf, tagsFor, noteFor, heightFor, matchBrand,
  displayName, categoryOf
} from './kb.js';
import { COCO_META } from './config.js';

const BG = { IDLE: 'idle', OCR: 'ocr', POSE: 'pose' };

export class Pipeline {
  constructor({ runtime, settings, onLog = () => {}, onStatus = () => {} } = {}) {
    this.runtime = runtime;
    this.settings = settings;
    this.onLog = onLog;
    this.onStatus = onStatus;

    this.detector = new Detector({ runtime, onLog });
    this.classifier = new Classifier({ runtime, onLog });
    this.ocr = new Ocr({ runtime, onLog });
    this.pose = new Pose({ runtime, onLog });
    this.tracker = new Tracker({
      iouThreshold: 0.24,
      maxAge: settings.trackMaxAge || 1400,
      smooth: settings.appearanceSmoothing || 0.55
    });
    this.teach = new TeachStore();

    this.timers = { detect: 0, classify: 0, ocr: 0, pose: 0, hands: 0, attributes: 0, scene: 0 };
    this.latency = new Rolling(24);
    this.scanSize = Number(settings.scanSize) || 416;
    this.lastRecords = [];
    this.lastTexts = [];
    this.lastBrands = [];
    this.lastScene = null;
    this.lastLighting = null;
    this.lastInferMs = 0;
    this.stats = {
      frames: 0, detections: 0, classifications: 0, ocrRuns: 0, poseRuns: 0,
      frameMs: 0, dropped: 0, bgOcrPending: false, bgPosePending: false
    };
    this._clsBudget = 0;
    this._live = [];
    this._born = [];
    this._lost = [];
  }

  /* ---------------------------------------------------------------- *
   * Module lifecycle
   * ---------------------------------------------------------------- */

  get moduleState() {
    return {
      detector: this.detector.ready,
      classifier: this.classifier.ready,
      ocr: this.ocr.ready,
      pose: this.pose.bodyReady,
      hands: this.pose.handReady
    };
  }

  async loadCore({ onProgress = () => {} } = {}) {
    await this.detector.load({ onProgress });
    this.onStatus('detector', 'ready');
  }

  async enable(module, { onProgress = () => {} } = {}) {
    switch (module) {
      case 'classifier':
        if (!this.classifier.ready) await this.classifier.load({ onProgress });
        break;
      case 'ocr':
        if (!this.ocr.ready) await this.ocr.load({ onProgress });
        break;
      case 'pose':
        if (!this.pose.bodyReady) await this.pose.loadBody({ onProgress });
        break;
      case 'hands':
        if (!this.pose.handReady) await this.pose.loadHand({ onProgress });
        break;
      default:
        throw new Error(`unknown module ${module}`);
    }
    this.onStatus(module, 'ready');
    return true;
  }

  async enableAll({ onProgress = () => {}, modules = null } = {}) {
    const wanted = modules || ['classifier', 'ocr', 'pose'];
    const done = [];
    for (const m of wanted) {
      try { await this.enable(m, { onProgress }); done.push(m); }
      catch (err) { this.onLog(`warn: ${m} failed — ${err.message}`); }
    }
    return done;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  /**
   * @param {ImageData} frame  the frame is read, never mutated, and may be
   *                           retained by background jobs.
   * @param {object} opts      { time }
   */
  async processFrame(frame, { time = performance.now() } = {}) {
    if (this._running) { this.stats.dropped++; return this.snapshot(); }
    this._running = true;
    const started = performance.now();
    this.stats.frames++;

    try {
      /* --- 1. detect ------------------------------------------------- */
      const dets = await this.detector.detect(frame, {
        size: this.scanSize,
        minScore: this.settings.minConfidence,
        tiles: this._tileMode(),
        maxDetections: this.settings.maxDetections
      });
      const delay = performance.now() - time;
      this.lastInferMs = Math.round(performance.now() - started);
      this.latency.push(this.lastInferMs);
      this._adaptScan(this.lastInferMs - delay);
      this.timers.detect = time;
      this.stats.detections += dets.length;

      const prepared = dets.map((d) => this._prepareDetection(d));
      const { live, born, lost } = this.tracker.update(prepared, time);
      this._live = live;
      this._born = born;
      this._lost = lost;

      /* --- 2. attach background evidence from the previous pass ------- */
      this._attachText();
      this._attachPose();

      /* --- 3. per-object evidence (in frame) -------------------------- */
      this._clsBudget = 2;
      const records = [];
      for (const track of live) {
        this._attributes(track, frame);
        await this._classify(track, frame, time);
        this._range(track, frame);
        records.push(this._record(track, time));
      }

      /* --- 4. schedule background jobs -------------------------------- */
      this._scheduleBackground(frame, records, time);
      this._sceneCache(records, time);

      this.lastRecords = records;
      this.stats.frameMs = Math.round(performance.now() - started);
      return this.snapshot();
    } finally {
      this._running = false;
    }
  }

  snapshot() {
    return {
      records: this.lastRecords,
      texts: this.lastTexts,
      scene: this.lastScene,
      lighting: this.lastLighting,
      born: this._born,
      lost: this._lost,
      timing: { detect: this.lastInferMs, frame: this.stats.frameMs },
      scanSize: this.scanSize
    };
  }

  _tileMode() {
    const mode = this.settings.detailMode;
    if (mode === 'auto') return 'auto';
    if (mode === '4' || mode === '9') return mode;
    return 'off';
  }

  /** Detector throughput governor: keep inference inside ~70 ms. */
  _adaptScan(ms) {
    if (!this.settings.adaptive) return;
    const ceiling = Number(this.settings.scanSize) || 416;
    const floor = 320;
    if (ms > 110 && this.scanSize > floor) this.scanSize = Math.max(floor, this.scanSize - 32);
    else if (ms < 55 && this.scanSize < ceiling) this.scanSize = Math.min(ceiling, this.scanSize + 32);
  }

  /** Map a raw detection into ARGUS vocabulary and attach its KB record. */
  _prepareDetection(det) {
    const [name, category] = COCO_META[det.cls] || [det.cls, categoryOf(det.cls)];
    const rec = lookup(name, { fuzzy: false });
    return {
      ...det,
      label: displayName(rec?.name || name),
      category: rec?.category || category,
      tier: rec?.tier ?? tierOf(name),
      embedding: null
    };
  }

  /* ---------------------------------------------------------------- *
   * In-frame stages
   * ---------------------------------------------------------------- */

  _attributes(track, frame) {
    if (track.attributes && performance.now() - (track.attrAt || 0) < (this.settings.attributesEvery || 900)) {
      // Keep the cached read; refresh slowly so a turning object catches up.
      return;
    }
    const appearance = analyseAppearance(frame, track.box, { cls: track.label || track.cls, maxSize: 96 });
    if (appearance) {
      track.attributes = appearance;
      track.attrAt = performance.now();
    }
  }

  async _classify(track, frame, time) {
    const s = this.settings;
    if (!this.classifier.ready || !s.moduleClassifier) return;
    const area = (track.box[2] - track.box[0]) * (track.box[3] - track.box[1]);
    if (area < frame.width * frame.height * 0.002) return;      // too small to hold detail
    const due = time - (track.lastClassified || 0) > (s.classifyEvery || 700);
    if (!due && track.classifier) return;
    if (this._clsBudget <= 0 && track.classifier) return;
    track.lastClassified = time;
    this._clsBudget--;
    const crop = this._crop(frame, track.box, 0.08);
    if (!crop) return;
    try {
      const result = await this.classifier.classify(crop, { topK: s.classifyTopK, embed: true });
      this.stats.classifications++;
      if (!result.top.length) return;
      track.classifier = result.top;
      if (result.embedding) track.embedding = result.embedding;
      const refined = refineFromClassifier(track.label || track.cls, result.top);
      if (refined.refined) { track.refined = refined.refined; track.refineConfidence = refined.confidence; }
      const taught = Classifier.matchTaught(track.embedding, this.teach, { minScore: s.teachThreshold });
      if (taught) { track.taught = taught; track.tier = Math.max(track.tier || 1, 3); }
      else if (track.taught && track.taught.label) { track.taught = null; }
    } catch (err) {
      this.onLog(`warn: classifier pass failed — ${err.message}`);
    }
  }

  _range(track, frame) {
    const s = this.settings;
    if (!s.showDistance && !s.narrateDistance) return;
    const prior = heightFor(track.refined || track.label || track.cls) || heightFor(track.cls);
    const est = estimateRange({
      box: track.box,
      frameWidth: frame.width,
      frameHeight: frame.height,
      fovDeg: s.fovHorizontal,
      heightPrior: prior,
      personKpts: track.pose || null
    });
    if (est) track.distance = est;
  }

  /* ---------------------------------------------------------------- *
   * Background jobs (never block a frame)
   * ---------------------------------------------------------------- */

  _scheduleBackground(frame, records, time) {
    const s = this.settings;

    if (s.moduleOcr && this.ocr.ready && !this._bgOcr && time - this.timers.ocr > (s.ocrEvery || 2200)) {
      this._bgOcr = true;
      this.stats.bgOcrPending = true;
      this.timers.ocr = time;
      Promise.resolve()
        .then(() => this.ocr.read(frame, { minConfidence: s.ocrMinConfidence, maxLines: 20 }))
        .then((out) => {
          this.stats.ocrRuns++;
          this.lastTexts = out.lines || [];
        })
        .catch((err) => this.onLog(`warn: OCR pass failed — ${err.message}`))
        .finally(() => { this._bgOcr = false; this.stats.bgOcrPending = false; });
    }

    if (s.modulePose && this.pose.bodyReady && !this._bgPose && time - this.timers.pose > (s.poseEvery || 550)) {
      this._bgPose = true;
      this.stats.bgPosePending = true;
      this.timers.pose = time;
      const people = records.filter((r) => r.category === 'person').map((r) => ({ id: r.id, box: r.box }));
      Promise.resolve()
        .then(() => this.pose.detectBodies(frame, { size: 320, minScore: 0.35 }))
        .then((bodies) => {
          this.stats.poseRuns++;
          this.lastPoses = bodies.map((body) => {
            let best = null; let bestIou = 0.2;
            for (const p of people) {
              const overlap = iou(p.box, body.box);
              if (overlap > bestIou) { bestIou = overlap; best = p.id; }
            }
            return { id: best, box: body.box, kpts: body.kpts, posture: body.posture, score: body.score };
          });
        })
        .catch((err) => this.onLog(`warn: pose pass failed — ${err.message}`))
        .finally(() => { this._bgPose = false; this.stats.bgPosePending = false; });
    }

    if (s.moduleHands && this.pose.handReady && this.lastPoses?.length && !this._bgHands && time - this.timers.hands > (s.handEvery || 700)) {
      this._bgHands = true;
      this.timers.hands = time;
      const wrists = [];
      for (const p of this.lastPoses) {
        for (const k of p.kpts || []) {
          if (/wrist/.test(k.name) && k.c > 0.3) {
            wrists.push({ x: k.x, y: k.y, id: p.id, span: Math.hypot(p.box[2] - p.box[0], p.box[3] - p.box[1]) * 0.22 });
          }
        }
      }
      Promise.resolve()
        .then(() => (wrists.length ? this.pose.handsNear(frame, wrists, { minScore: 0.3 }) : []))
        .then((hands) => { this.lastHands = hands; })
        .catch(() => { /* gestures are a bonus, never an error */ })
        .finally(() => { this._bgHands = false; });
    }

    // Frame-level colour and lighting statistics are cheap and help the scene read.
    if (!this._bgLight && time - this.timers.scene > 1500) {
      this.timers.scene = time;
      this._bgLight = true;
      Promise.resolve()
        .then(() => lightingOf(frame))
        .then((light) => { this.lastLighting = light; })
        .catch(() => {})
        .finally(() => { this._bgLight = false; });
    }
  }

  /** Attach OCR lines to the records they sit on. */
  _attachText() {
    if (!this.lastTexts?.length || !this.lastRecords.length) return;
    for (const track of this.tracker.tracks) {
      if (!track.text) continue;
      // Clear stale text: a label read three seconds ago on this track is still
      // valid, but text from a previous track of the same box is not.
      if (performance.now() - (track.textAt || 0) > 8000) { track.text = null; track.brand = null; track.sign = null; }
    }
    for (const line of this.lastTexts) {
      let best = null; let bestScore = 0;
      for (const track of this.tracker.tracks) {
        const overlap = iou(track.box, line.box);
        const inside = line.box[0] >= track.box[0] - 8 && line.box[2] <= track.box[2] + 8
          && line.box[1] >= track.box[1] - 8 && line.box[3] <= track.box[3] + 8;
        const score = inside ? Math.max(0.45, overlap) : overlap;
        if (score > bestScore) { bestScore = score; best = track; }
      }
      if (best && bestScore > 0.12) {
        if (best.text !== line.text) { best.text = line.text; best.textAt = performance.now(); }
        if (line.brand) best.brand = line.brand;
        if (line.sign) best.sign = line.sign;
      }
    }
    this.lastBrands = [...new Set(this.lastTexts.filter((l) => l.brand).map((l) => l.brand.name))];
  }

  /** Attach pose, posture and gesture evidence to the person tracks. */
  _attachPose() {
    if (!this.lastPoses?.length) return;
    for (const p of this.lastPoses) {
      const track = p.id != null ? this.tracker.tracks.find((t) => t.id === p.id) : null;
      const target = track || this.tracker.tracks.find((t) => (t.category === 'person' || t.cls === 'person') && iou(t.box, p.box) > 0.25);
      if (!target) continue;
      target.pose = p.kpts;
      target.posture = p.posture;
      target.poseScore = p.score;
    }
    for (const hand of this.lastHands || []) {
      const track = this.tracker.tracks.find((t) => iou(t.box, hand.box) > 0.1)
        || this.tracker.tracks.find((t) => (t.category === 'person' || t.cls === 'person') && iou(t.box, hand.box) > 0.05);
      if (!track) continue;
      track.hands = [hand];
    }
    for (const track of this.tracker.tracks) {
      if (!track.pose) continue;
      track.activity = activityOf({ kpts: track.pose, posture: track.posture }, track.hands || []);
      // Pose keypoints measure a body better than a bounding box measures a
      // person, so the range estimate is upgraded when they exist.
      if (track.distance) track.distanceFromPose = true;
    }
  }

  _sceneCache(records, time) {
    if (time - (this._sceneAt || 0) < 1800) return;
    this._sceneAt = time;
    try {
      this.lastScene = inferScene({ objects: records, lighting: this.lastLighting, textLines: this.lastTexts });
    } catch { /* descriptive only */ }
  }

  /* ---------------------------------------------------------------- *
   * Resolution
   * ---------------------------------------------------------------- */

  _record(track, time) {
    const taught = track.taught;
    const noun = taught?.label || track.refined || displayName(track.label || track.cls);
    const rec = lookup(noun, { fuzzy: false }) || lookup(track.cls, { fuzzy: false });
    const brand = track.brand || (track.text ? matchBrand(track.text) : null);
    const label = taught?.label
      || nameFor({ cls: track.cls, refined: track.refined, brand: this.settings.narrateBrands ? brand : null });

    let confidence = track.smoothScore;
    if (taught) confidence = Math.max(confidence, taught.score);
    else if (track.refined && track.refineConfidence) confidence = clamp(confidence * 0.6 + track.refineConfidence * 0.5, 0, 0.97);
    if (brand) confidence = clamp(confidence * 1.05, 0, 0.98);

    const tags = tagsFor(noun);
    const hazard = this._hazard(track, tags);

    return {
      id: track.id,
      cls: track.cls,
      noun: rec?.name || noun,
      label,
      category: taught?.category || rec?.category || track.category || categoryOf(track.cls),
      tier: Math.max(track.tier || 1, rec?.tier || 1, taught ? 3 : 1),
      confidence,
      box: [...track.box],
      attributes: track.attributes,
      classifier: track.classifier,
      refined: track.refined,
      taught: taught ? { label: taught.label, score: taught.score, samples: taught.samples } : null,
      distance: track.distance,
      text: track.text || null,
      brand: brand ? { name: brand.name, sector: brand.sector, products: brand.products, exact: brand.exact } : null,
      sign: track.sign || null,
      pose: track.pose || null,
      posture: track.posture || null,
      hands: track.hands || null,
      gesture: track.hands?.[0]?.gesture?.name || null,
      activity: track.activity || null,
      motion: track.motion(Math.hypot(track.box[2] - track.box[0], track.box[3] - track.box[1])),
      note: noteFor(noun) || '',
      hazard,
      tags: [...tags],
      firstSeen: track.firstSeen,
      age: time - track.firstSeen,
      hits: track.hits,
      embeddingVec: track.embedding || null,
      source: taught ? 'taught' : brand && this.settings.narrateBrands ? 'brand' : track.refined ? 'classifier' : 'detector'
    };
  }

  _hazard(track, tags) {
    if (track.sign && track.sign.tier >= 3) {
      return { kind: track.sign.kind, note: `${track.sign.say}${track.text ? `: “${track.text}”` : ''}` };
    }
    const hazards = ['hazard', 'electrical', 'hot', 'sharp', 'flammable', 'gas', 'biohazard', 'safety', 'medical'];
    const hit = hazards.find((h) => tags.has(h));
    if (!hit) return null;
    const note = noteFor(track.refined || track.label || track.cls);
    return { kind: hit, note: note || '' };
  }

  /* ---------------------------------------------------------------- *
   * Utilities
   * ---------------------------------------------------------------- */

  /** Crop by pixel copy — no canvas allocation per call, so this is cheap. */
  _crop(img, box, pad = 0) {
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    const px = Math.round(w * pad);
    const py = Math.round(h * pad);
    const x = Math.max(0, Math.floor(box[0] - px));
    const y = Math.max(0, Math.floor(box[1] - py));
    const cw = Math.min(img.width - x, Math.ceil(w + px * 2));
    const ch = Math.min(img.height - y, Math.ceil(h + py * 2));
    if (cw < 6 || ch < 6) return null;
    const out = new ImageData(cw, ch);
    for (let row = 0; row < ch; row++) {
      const src = ((y + row) * img.width + x) * 4;
      out.data.set(img.data.subarray(src, src + cw * 4), row * cw * 4);
    }
    return out;
  }

  /** Crop for the UI / teach store thumbnails (canvas here is fine — it is rare). */
  cropForDisplay(img, box, size = 96) {
    const crop = this._crop(img, box, 0.05);
    if (!crop) return null;
    const scale = size / Math.max(crop.width, crop.height);
    const c = document.createElement('canvas');
    c.width = Math.round(crop.width * scale);
    c.height = Math.round(crop.height * scale);
    const src = document.createElement('canvas');
    src.width = crop.width; src.height = crop.height;
    src.getContext('2d').putImageData(crop, 0, 0);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  }

  /** Store a named example so the object is recognised from now on. */
  teachObject(record, label, { cropDataUrl = null } = {}) {
    const embedding = record.embeddingVec || null;
    if (!embedding) return null;
    return this.teach.add({
      label,
      embedding,
      category: categoryOf(label),
      tags: record.tags || [],
      note: noteFor(label),
      crop: cropDataUrl
    });
  }

  info() {
    return {
      scanSize: this.scanSize,
      lastInferMs: this.lastInferMs,
      latency: { mean: Math.round(this.latency.mean), p90: Math.round(this.latency.p90) },
      modules: this.moduleState,
      models: {
        detector: this.detector.info(),
        classifier: this.classifier.info(),
        ocr: this.ocr.info(),
        pose: this.pose.info()
      },
      counts: this.stats,
      taught: this.teach.examples.length,
      scene: this.lastScene
    };
  }
}

export { BG };
