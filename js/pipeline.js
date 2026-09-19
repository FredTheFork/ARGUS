/**
 * pipeline.js — perception orchestration and evidence fusion.
 *
 * One frame in, a set of object records out. Each record is one honest answer
 * to "what is that":
 *
 *   { label: 'Samsung phone', category: 'device', confidence: 0.86,
 *     source: 'brand', box: [...], text: 'Galaxy S24', brand: {...},
 *     posture: 'standing', activity: { id: 'standing', label: 'standing' } }
 *
 * Two clocks run here. Detection and the classifier are *in the frame*: they
 * are cheap enough (tens of milliseconds) and the overlay needs them now — the
 * first tag must land on the first frame. OCR and pose are *behind* the frame:
 * they cost 100-600 ms each, so they run as background jobs and their results
 * attach to the next frame's records by geometry. A camera that stutters to
 * read a sign is worse than one that reads the sign a third of a second late.
 *
 * The fusion rules matter more than any single model. A detector saying
 * "phone", a classifier saying "iPod" and OCR reading "Samsung" produce one
 * answer, not three: brand text read off the object wins (it is printed on the
 * thing itself), then a confident classifier answer compatible with the
 * detected class, then the detected class.
 */

import { Detector } from './detector.js';
import { Classifier, refineFromClassifier } from './classify.js';
import { Ocr } from './ocr.js';
import { Pose, activityOf } from './pose.js';
import { Tracker } from './tracker.js';
import { Rolling, clamp, iou, nms, boxArea } from './core.js';
import {
  lookup, nameFor, tierOf, matchBrand, displayName, categoryOf
} from './kb.js';
import { COCO_META } from './config.js';

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
      smooth: settings.trackSmooth || 0.55
    });

    this.timers = { detect: 0, ocr: 0, pose: 0, hands: 0 };
    this.latency = new Rolling(24);
    this._frameMs = new Rolling(12);          // full-frame-only detector time
    this.scanSize = Number(settings.scanSize) || 416;
    this.lastRecords = [];
    this.lastTexts = [];
    this.lastInferMs = 0;
    this._textCache = new Map();
    this._bgOcr = false;
    this._bgPose = false;
    this._bgHands = false;
    this._running = false;
    this.stats = { frames: 0, detections: 0, classifications: 0, ocrRuns: 0, poseRuns: 0, frameMs: 0 };
  }

  /* ---------------------------------------------------------------- *\
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

  /** The detector is the core: without it there is no app. */
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

  /** Optional modules never hold up first light: failures are logged, not thrown. */
  async enableAll({ onProgress = () => {}, modules = null } = {}) {
    const wanted = modules || ['classifier', 'ocr', 'pose', 'hands'];
    const done = [];
    for (const m of wanted) {
      try { await this.enable(m, { onProgress }); done.push(m); }
      catch (err) { this.onLog(`warn: ${m} failed to load — ${err.message}`); }
    }
    return done;
  }

  /* ---------------------------------------------------------------- *\
   * Frame
   * ---------------------------------------------------------------- */

  /**
   * @param {ImageData} frame  the frame is read, never mutated, and may be
   *                           retained by background jobs.
   * @param {object} opts      { time }
   */
  async processFrame(frame, { time = performance.now() } = {}) {
    if (this._running) return this.snapshot();
    this._running = true;
    const started = performance.now();
    this.stats.frames++;

    try {
      /* --- 1. detect -------------------------------------------------
       * Always the full frame first: that is the instant path. On a device
       * that keeps it fast, 2×2 overlapping tiles run on top so small objects
       * (a plug socket, a key, a label) survive — the tile pass only happens
       * when the full frame stays inside its budget, so a slow phone never
       * pays for it. */
      const s = this.settings;
      const dets = await this.detector.detect(frame, {
        size: this.scanSize,
        minScore: s.minConfidence,
        tiles: 'off',
        maxDetections: s.maxDetections
      });
      const frameMs = this.detector.lastInferMs;
      this._frameMs.push(frameMs);
      let all = dets;
      const tiles = this._tileMode();
      if (tiles) {
        try {
          const tiled = await this.detector.detectTiles(frame, {
            size: this.scanSize,
            minScore: s.minConfidence,
            target: tiles,
            maxDetections: s.maxDetections
          });
          if (tiled.length) all = nms([...dets, ...tiled], 0.5, 'class').slice(0, s.maxDetections * 2);
        } catch (err) {
          this.onLog(`warn: tile pass failed — ${err.message}`);
        }
      }
      this.lastInferMs = Math.round(performance.now() - started);
      this.latency.push(this.lastInferMs);
      this._adaptScan(frameMs);
      this.timers.detect = time;
      this.stats.detections += all.length;

      const prepared = all.map((d) => this._prepareDetection(d));
      const { live } = this.tracker.update(prepared, time);

      /* --- 2. attach background evidence from the previous pass ------- */
      for (const line of this.lastTexts) line.attached = false;
      this._attachText(frame, time);
      this._attachPose(time);

      /* --- 3. classifier refinement (in frame, budgeted) -------------- */
      this._clsBudget = s.classifyBudget || 2;
      const records = [];
      for (const track of live) {
        await this._classify(track, frame, time);
        records.push(this._record(track, time));
      }

      /* --- 4. schedule background jobs -------------------------------- */
      this._scheduleBackground(frame, live, time);

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
      timing: { detect: this.lastInferMs, frame: this.stats.frameMs },
      scanSize: this.scanSize
    };
  }

  /** 'auto' → 2×2 tiles only while the full frame stays fast. */
  _tileMode() {
    const mode = this.settings.detailMode;
    if (mode === '4') return 2;
    if (mode === '9') return 3;
    if (mode === 'auto') {
      const n = this._frameMs.items.length;
      return n >= 3 && this._frameMs.mean < (this.settings.tileBudgetMs || 90) ? 2 : null;
    }
    return null;
  }

  /** Detector throughput governor: keep the full frame inside ~110 ms. */
  _adaptScan(ms) {
    const ceiling = Number(this.settings.scanSize) || 416;
    const floor = Number(this.settings.scanFloor) || 320;
    if (ms > 110 && this.scanSize > floor) this.scanSize = Math.max(floor, this.scanSize - 32);
    else if (ms < 55 && this.scanSize < ceiling) this.scanSize = Math.min(ceiling, this.scanSize + 32);
  }

  /** Map a raw detection into ARGUS vocabulary. */
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

  /* ---------------------------------------------------------------- *\
   * In-frame stage
   * ---------------------------------------------------------------- */

  /**
   * Refine the detector's answer with the 1000-class classifier. New tracks
   * are classified on their first pass (budget permitting); established ones
   * refresh at the configured cadence.
   */
  async _classify(track, frame, time) {
    const s = this.settings;
    if (!this.classifier.ready) return;
    if (this._clsBudget <= 0) return;
    const area = (track.box[2] - track.box[0]) * (track.box[3] - track.box[1]);
    if (area < frame.width * frame.height * (s.classifyMinArea || 0.002)) return;
    const due = !track.classifier || time - (track.lastClassified || 0) > (s.classifyEvery || 500);
    if (!due) return;
    this._clsBudget--;
    track.lastClassified = time;
    const crop = this._crop(frame, track.box, 0.08);
    if (!crop) return;
    try {
      const result = await this.classifier.classify(crop, { topK: s.classifyTopK || 5, embed: false });
      this.stats.classifications++;
      if (!result.top.length) return;
      track.classifier = result.top;
      const refined = refineFromClassifier(track.label || track.cls, result.top);
      if (refined.refined) {
        track.refined = refined.refined;
        track.refineConfidence = refined.confidence;
      } else {
        track.refined = null;
        track.refineConfidence = 0;
      }
    } catch (err) {
      this.onLog(`warn: classifier pass failed — ${err.message}`);
    }
  }

  /* ---------------------------------------------------------------- *\
   * Background jobs (never block a frame)
   * ---------------------------------------------------------------- */

  _scheduleBackground(frame, live, time) {
    const s = this.settings;

    if (this.ocr.ready && !this._bgOcr && time - this.timers.ocr > (s.ocrEvery || 1600)) {
      this._bgOcr = true;
      this.timers.ocr = time;
      Promise.resolve()
        .then(() => this.ocr.read(frame, { minConfidence: s.ocrMinConfidence, maxLines: s.ocrMaxLines }))
        .then((out) => {
          this.stats.ocrRuns++;
          this._recordTexts(out.lines, time);
        })
        .catch((err) => this.onLog(`warn: OCR pass failed — ${err.message}`))
        .finally(() => { this._bgOcr = false; });
    }

    // Pose only runs while a person is actually in view.
    const people = live.filter((t) => t.cls === 'person' || t.category === 'person');
    if (this.pose.bodyReady && people.length && !this._bgPose && time - this.timers.pose > (s.poseEvery || 550)) {
      this._bgPose = true;
      this.timers.pose = time;
      Promise.resolve()
        .then(() => this.pose.detectBodies(frame, { minScore: 0.35 }))
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
        .finally(() => { this._bgPose = false; });
    }

    if (this.pose.handReady && this.lastPoses?.length && !this._bgHands && time - this.timers.hands > (s.handEvery || 700)) {
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
  }

  /**
   * OCR lines are kept for ~4 s after last seen, so text chips do not flicker
   * between the 1.6 s OCR passes. A line sits on a track when it overlaps it;
   * on a track it becomes part of the object's name (brand / sign), and only
   * lines that sit on no object are drawn as their own quiet chip.
   */
  _recordTexts(lines, time) {
    for (const line of lines) {
      const key = `${Math.round(line.box[0] / 8)},${Math.round(line.box[1] / 8)}|${line.text.slice(0, 24)}`;
      const prev = this._textCache.get(key);
      if (prev) { prev.line = line; prev.seenAt = time; }
      else this._textCache.set(key, { line, seenAt: time });
    }
    for (const [key, entry] of this._textCache) {
      if (time - entry.seenAt > 4000) this._textCache.delete(key);
    }
    this.lastTexts = [...this._textCache.values()].map((e) => e.line);
  }

  /** Attach OCR lines to the tracks they sit on. */
  _attachText(frame, time) {
    if (!this.lastTexts.length) return;
    const frameArea = frame.width * frame.height || 1;
    for (const track of this.tracker.tracks) {
      if (!track.text) continue;
      // Text read a long time ago on this track is stale; drop it.
      if (time - (track.textAt || 0) > 8000) { track.text = null; track.brand = null; track.sign = null; }
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
        line.attached = true;
        if (best.text !== line.text) { best.text = line.text; best.textAt = time; }
        if (line.brand) best.brand = line.brand;
        if (line.sign) {
          best.sign = line.sign;
          best.signRatio = boxArea(line.box) / frameArea;
        }
      }
    }
  }

  /** Attach posture and gesture evidence to the person tracks. */
  _attachPose() {
    for (const track of this.tracker.tracks) {
      track.pose = null;
      track.posture = null;
      track.activity = null;
      track.hands = null;
      track.gesture = null;
    }
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
      track.gesture = hand.gesture?.name || null;
    }
    for (const track of this.tracker.tracks) {
      if (!track.pose) continue;
      track.activity = activityOf({ kpts: track.pose, posture: track.posture }, track.hands || []);
    }
  }

  /* ---------------------------------------------------------------- *\
   * Resolution
   * ---------------------------------------------------------------- */

  /**
   * One track → one answer. Order of authority for the label:
   *   safety sign read off it  >  brand text  >  classifier refinement  >  detector class
   */
  _record(track, time) {
    const signLabel = track.sign && track.sign.tier >= 3 && (track.category === 'sign' || track.signRatio < 0.25)
      ? track.sign.say
      : null;
    const brand = track.brand || (track.text ? matchBrand(track.text) : null);
    const label = signLabel || nameFor({ cls: track.cls, refined: track.refined, brand });
    const rec = lookup(track.refined || track.cls, { fuzzy: false });

    let confidence = track.smoothScore;
    if (track.refined && track.refineConfidence) confidence = clamp(confidence * 0.6 + track.refineConfidence * 0.5, 0, 0.97);
    if (brand) confidence = clamp(confidence * 1.05, 0, 0.98);

    return {
      id: track.id,
      cls: track.cls,
      noun: rec?.name || track.refined || track.cls,
      label,
      category: rec?.category || track.category || categoryOf(track.cls),
      tier: Math.max(track.tier || 1, rec?.tier || 1),
      confidence,
      box: [...track.box],
      refined: track.refined || null,
      classifier: track.classifier || null,
      text: track.text || null,
      brand: brand ? { name: brand.name, sector: brand.sector, exact: brand.exact } : null,
      sign: track.sign ? { kind: track.sign.kind, say: track.sign.say, tier: track.sign.tier } : null,
      posture: track.posture || null,
      gesture: track.gesture || null,
      activity: track.activity || null,
      firstSeen: track.firstSeen,
      age: time - track.firstSeen,
      hits: track.hits,
      source: signLabel ? 'sign' : brand ? 'brand' : track.refined ? 'classifier' : 'detector'
    };
  }

  /* ---------------------------------------------------------------- *\
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
      counts: this.stats
    };
  }
}
