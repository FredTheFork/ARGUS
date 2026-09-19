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
 * The budget rules in here are what make the app feel instant, and they are
 * all measured (tools/bench-perf.mjs prints the per-stage costs they were
 * set from):
 *
 *   · the full-frame detector is the only work that happens *in* the frame,
 *     at an adaptive scan size that starts small and grows only when the
 *     device proves it can afford more;
 *   · the detail sweep is interleaved — one 2×2 tile per frame on a fast
 *     device, never the whole block on top of every frame;
 *   · the classifier, OCR, pose and hands run behind the frame, one job at a
 *     time, and a job that cannot earn its cost on the current device simply
 *     never starts;
 *   · a job's results attach to the next frame's records, so the feed never
 *     waits for a refinement.
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
import { COCO_META, CONFIG } from './config.js';

export class Pipeline {
  constructor({ runtime, settings, onLog = () => {}, onStatus = () => {} } = {}) {
    this.runtime = runtime;
    this.settings = settings;
    this.onLog = onLog;
    this.onStatus = onStatus;

    this.detector = new Detector({ runtime, onLog, defaultSize: Number(settings.scanSize) || CONFIG.scanSize });
    this.classifier = new Classifier({ runtime, onLog });
    this.ocr = new Ocr({ runtime, onLog });
    this.pose = new Pose({ runtime, onLog });
    this.tracker = new Tracker({
      iouThreshold: 0.24,
      maxAge: settings.trackMaxAge || 1400,
      smooth: settings.trackSmooth || 0.55
    });

    this.timers = { detect: 0, ocr: 0, pose: 0, hands: 0, tile: 0, adapt: 0 };
    this.latency = new Rolling(24);
    this._frameMs = new Rolling(10);          // full-frame-only detector time
    this.scanSize = Number(settings.scanSize) || CONFIG.scanSize;
    this.lastRecords = [];
    this.lastTexts = [];
    this.lastInferMs = 0;
    this._textCache = new Map();
    this._bgOcr = false;
    this._bgPose = false;
    this._bgHands = false;
    this._running = false;
    this._tileCursor = 0;                     // round-robin over the 2×2 plan
    this._bgQueue = Promise.resolve();        // background jobs run one at a time
    this._firstFrameAt = 0;
    this._lastOcrSignature = null;
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

  /**
   * Optional modules never hold up first light: failures are logged, not
   * thrown. With `stagger`, a short gap separates each module's download and
   * session build, so four graphs never compile back-to-back at boot while
   * the user is already pointing the camera at things.
   */
  async enableAll({ onProgress = () => {}, modules = null, stagger = false } = {}) {
    const wanted = modules || ['classifier', 'ocr', 'pose', 'hands'];
    const done = [];
    for (let i = 0; i < wanted.length; i++) {
      if (stagger && i > 0) await new Promise((r) => setTimeout(r, 800));
      try { await this.enable(wanted[i], { onProgress }); done.push(wanted[i]); }
      catch (err) { this.onLog(`warn: ${wanted[i]} failed to load — ${err.message}`); }
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
    if (!this._firstFrameAt) this._firstFrameAt = time;
    const started = performance.now();
    this.stats.frames++;

    try {
      /* --- 1. detect -------------------------------------------------
       * Always the full frame first: that is the instant path. The scan
       * size is governed by measured cost — small at boot (a tag on the
       * first frame beats a sharper tag on the tenth), growing only while
       * the device keeps its budget. On a device that keeps the full frame
       * comfortably fast, ONE tile of the 2×2 plan joins the pass — a full
       * small-object sweep every four frames, interleaved, so detail never
       * multiplies the frame cost the way an every-frame tile block did. */
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
      if (this._tileDue(time)) {
        try {
          const tiled = await this.detector.detectTile(frame, {
            index: this._tileCursor++,
            size: s.tileSize || 288,
            minScore: s.minConfidence,
            maxDetections: 8
          });
          if (tiled.length) all = nms([...dets, ...tiled], 0.5, 'class').slice(0, (s.maxDetections || 24) * 2);
          this.timers.tile = time;
        } catch (err) {
          this.onLog(`warn: tile pass failed — ${err.message}`);
        }
      }
      this.lastInferMs = Math.round(performance.now() - started);
      this.latency.push(this.lastInferMs);
      this._adaptScan(frameMs, time);
      this.timers.detect = time;
      this.stats.detections += all.length;

      const prepared = all.map((d) => this._prepareDetection(d));
      const { live, born } = this.tracker.update(prepared, time);

      /* --- 2. attach background evidence from the previous pass ------- */
      for (const line of this.lastTexts) line.attached = false;
      this._attachText(frame, time);
      this._attachPose();

      /* --- 3. classify (background, budgeted) --------------------------
       * The 1000-class pass is real work (hundreds of milliseconds on a
       * phone), so it no longer rides inside the frame. New tracks jump the
       * queue — the refinement lands a beat after the tag, not before it —
       * and the result is written onto the track for the next frame's
       * record. The first-frame tag is never delayed by it. */
      this._scheduleClassify(live, born, frame, time);

      /* --- 4. schedule background jobs -------------------------------- */
      this._scheduleBackground(frame, live, time);

      this.lastRecords = live.map((track) => this._record(track, time));
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

  /* ---------------------------------------------------------------- *\
   * Detectors: the detail sweep and the throughput governor
   * ---------------------------------------------------------------- */

  /**
   * The detail sweep fires one tile when: the device has proved the full
   * frame is cheap (rolling mean under tileBudgetMs) and at least tileGapMs
   * has passed since the last tile. Slow devices never see a tile; fast ones
   * get the whole 2×2 sweep between full-frame passes for free.
   */
  _tileDue(time) {
    const mode = this.settings.detailMode;
    if (mode !== 'auto' && mode !== '4' && mode !== '9') return false;
    if (this._frameMs.items.length < 3) return false;
    if (this._frameMs.mean >= (this.settings.tileBudgetMs || 55)) return false;
    return time - this.timers.tile >= (this.settings.tileGapMs || 450);
  }

  /**
   * Detector throughput governor. The measured full-frame cost walks the
   * scan size between the floor and the ceiling: above ~1.5× the budget it
   * sheds 32 px, below ~0.7× it buys 32 px back. Re-evaluated at most twice
   * a second so a single slow frame (a hand across the lens) cannot thrash
   * the size.
   */
  _adaptScan(ms, time) {
    const ceiling = Number(this.settings.scanCeiling) || 416;
    const floor = Number(this.settings.scanFloor) || 256;
    const budget = Number(this.settings.scanBudgetMs) || 70;
    if (time - this.timers.adapt < 500) return;
    if (this._frameMs.items.length < 2) return;
    const mean = this._frameMs.mean;
    let next = this.scanSize;
    if (mean > budget * 1.5 && this.scanSize > floor) next = Math.max(floor, this.scanSize - 32);
    else if (mean < budget * 0.7 && this.scanSize < ceiling) next = Math.min(ceiling, this.scanSize + 32);
    if (next !== this.scanSize) {
      this.scanSize = next;
      this.timers.adapt = time;
      this.onLog(`scan: ${next}px (full frame ${Math.round(mean)} ms)`);
    }
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
   * Classifier refinement (background, budgeted, new tracks first)
   * ---------------------------------------------------------------- */

  /**
   * Queue classifier work for this frame: at most classifyBudget crops, new
   * tracks first (their first refinement is the one the user is waiting
   * for), then the stalest refresh. The crop is taken immediately — frames
   * are not retained — and the inference joins the serial background queue,
   * so it never delays the frame that scheduled it.
   */
  _scheduleClassify(live, born, frame, time) {
    const s = this.settings;
    if (!this.classifier.ready) return;
    const budget = Math.max(1, s.classifyBudget || 1);
    const minArea = frame.width * frame.height * (s.classifyMinArea || 0.002);

    const due = live.filter((track) => {
      if (track._clsInFlight) return false;
      if (boxArea(track.box) < minArea) return false;
      return !track.classifier || time - (track.lastClassified || 0) > (s.classifyEvery || 2000);
    });
    if (!due.length) return;
    const bornIds = new Set(born.map((t) => t.id));
    due.sort((a, b) => (bornIds.has(b.id) ? 1 : 0) - (bornIds.has(a.id) ? 1 : 0)
      || (a.lastClassified || 0) - (b.lastClassified || 0));

    for (const track of due.slice(0, budget)) {
      const crop = this._crop(frame, track.box, 0.08);
      if (!crop) continue;
      track._clsInFlight = true;
      track.lastClassified = time;
      this._enqueue(async () => {
        try {
          const result = await this.classifier.classify(crop, { topK: s.classifyTopK || 5, embed: false });
          this.stats.classifications++;
          if (result.top.length) {
            track.classifier = result.top;
            const refined = refineFromClassifier(track.label || track.cls, result.top);
            track.refined = refined.refined;
            track.refineConfidence = refined.refined ? refined.confidence : 0;
          }
        } catch (err) {
          this.onLog(`warn: classifier pass failed — ${err.message}`);
        } finally {
          track._clsInFlight = false;
        }
      }, 'classifier pass');
    }
  }

  /* ---------------------------------------------------------------- *\
   * Background jobs (never block a frame, never overlap each other)
   * ---------------------------------------------------------------- */

  /**
   * Serial background work. One job runs at a time, in priority order
   * (classifier > OCR > pose > hands): on the CPU tier every inference is
   * real compute, and two jobs at once halve the detector's throughput for
   * their whole overlap.
   */
  _enqueue(job, kind = 'job') {
    this._bgQueue = this._bgQueue
      .then(job)
      .catch((err) => this.onLog(`warn: ${kind} failed — ${err.message || err}`));
    return this._bgQueue;
  }

  _scheduleBackground(frame, live, time) {
    const s = this.settings;

    /* OCR — naming-critical, so it runs on every device, but it earns its
     * cost honestly: after the first tags have settled, on a cadence, and
     * never twice for an unchanged scene. */
    if (this.ocr.ready && !this._bgOcr
      && time - this._firstFrameAt > (s.ocrSettleMs || 1200)
      && time - this.timers.ocr > (s.ocrEvery || 2400)
      && !this._sceneUnchanged(frame)) {
      this._bgOcr = true;
      this.timers.ocr = time;
      this._lastOcrSignature = this._sceneSignature(frame);   // reference: the frame we are about to read
      this._enqueue(() => this.ocr.read(frame, {
        minConfidence: s.ocrMinConfidence,
        maxLines: s.ocrMaxLines,
        maxSide: s.ocrMaxSide || 512
      }).then((out) => {
        this.stats.ocrRuns++;
        this._recordTexts(out.lines, time);
      }).finally(() => { this._bgOcr = false; }), 'OCR pass');
    }

    // Pose only while a person is actually in view, and only while the device
    // is keeping up — the pose graph's fixed 640 px input costs more than the
    // detector itself on the CPU tier, and a posture word is not worth frames.
    const deviceFast = this._frameMs.items.length >= 3 && this._frameMs.mean < (s.bgFrameBudgetMs || 45);
    if (!deviceFast) return;

    const people = live.filter((t) => t.cls === 'person' || t.category === 'person');
    if (this.pose.bodyReady && people.length && !this._bgPose && time - this.timers.pose > (s.poseEvery || 4000)) {
      this._bgPose = true;
      this.timers.pose = time;
      this._enqueue(() => this.pose.detectBodies(frame, { minScore: 0.35 }).then((bodies) => {
        this.stats.poseRuns++;
        this.lastPoses = bodies.map((body) => {
          let best = null; let bestIou = 0.2;
          for (const p of people) {
            const overlap = iou(p.box, body.box);
            if (overlap > bestIou) { bestIou = overlap; best = p.id; }
          }
          return { id: best, box: body.box, kpts: body.kpts, posture: body.posture, score: body.score };
        });
      }).finally(() => { this._bgPose = false; }), 'pose pass');
    }

    if (this.pose.handReady && this.lastPoses?.length && !this._bgHands && time - this.timers.hands > (s.handEvery || 3000)) {
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
      this._enqueue(() => (wrists.length ? this.pose.handsNear(frame, wrists, { minScore: 0.3 }) : [])
        .then((hands) => { this.lastHands = hands; })
        .catch(() => { /* gestures are a bonus, never an error */ })
        .finally(() => { this._bgHands = false; }), 'hands pass');
    }
  }

  /**
   * A 32×18 luma signature of the frame, sampled in well under a
   * millisecond. OCR compares against the last frame it actually read: a
   * still scene is not read again, but slow drift accumulates against a
   * fixed reference, so any real change triggers a fresh read promptly.
   */
  _sceneSignature(frame) {
    const cols = 32; const rows = 18;
    const sig = new Float32Array(cols * rows);
    const { width: w, height: h, data } = frame;
    for (let ry = 0; ry < rows; ry++) {
      const y = Math.min(h - 1, ((ry + 0.5) * h / rows) | 0);
      for (let cx = 0; cx < cols; cx++) {
        const x = Math.min(w - 1, ((cx + 0.5) * w / cols) | 0);
        const i = (y * w + x) * 4;
        sig[ry * cols + cx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
    }
    return sig;
  }

  _sceneUnchanged(frame) {
    const prev = this._lastOcrSignature;
    if (!prev) return false;
    const sig = this._sceneSignature(frame);
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff += Math.abs(sig[i] - prev[i]);
    return diff / sig.length < (this.settings.ocrStillSkip || 5.5);
  }

  /**
   * OCR lines are kept for ~4 s after last seen, so text chips do not flicker
   * between passes. A line sits on a track when it overlaps it; on a track it
   * becomes part of the object's name (brand / sign), and only lines that sit
   * on no object are drawn as their own quiet chip.
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
