/**
 * pose.js — body pose, hand keypoints, gesture and activity inference.
 *
 * Two YOLOv8-pose models, both INT8-quantised to ~3.6 MB:
 *
 *   body  17 COCO keypoints  (nose, eyes, ears, shoulders, elbows, wrists,
 *          hips, knees, ankles) — answers posture, stance, reach and gait
 *   hand  21 keypoints       (wrist, 4 joints × 5 fingers) — answers gesture
 *
 * For an assistant that is meant to be worn, this is the difference between
 * "person" and "person waving", "person crouching", "person pointing at the
 * panel to your left". Gestures also make the HUD usable without touching a
 * phone: a raised palm pauses narration, a point selects what you are pointing
 * at, a fist clears the lock.
 */

import { fitSize, toTensor, iou } from './core.js';

const BODY_URL = 'models/yolov8n-pose.onnx';
const HAND_URL = 'models/yolov8n-hand.onnx';

export const KEYPOINTS = [
  'nose', 'left eye', 'right eye', 'left ear', 'right ear',
  'left shoulder', 'right shoulder', 'left elbow', 'right elbow',
  'left wrist', 'right wrist', 'left hip', 'right hip',
  'left knee', 'right knee', 'left ankle', 'right ankle'
];

export const HAND_KEYPOINTS = [
  'wrist',
  'thumb cmc', 'thumb mcp', 'thumb ip', 'thumb tip',
  'index mcp', 'index pip', 'index dip', 'index tip',
  'middle mcp', 'middle pip', 'middle dip', 'middle tip',
  'ring mcp', 'ring pip', 'ring dip', 'ring tip',
  'pinky mcp', 'pinky pip', 'pinky dip', 'pinky tip'
];

/** Body skeleton — mirror pairs are drawn with one pass each. */
export const SKELETON = [
  ['left shoulder', 'right shoulder'],
  ['left shoulder', 'left elbow'], ['left elbow', 'left wrist'],
  ['right shoulder', 'right elbow'], ['right elbow', 'right wrist'],
  ['left shoulder', 'left hip'], ['right shoulder', 'right hip'],
  ['left hip', 'right hip'],
  ['left hip', 'left knee'], ['left knee', 'left ankle'],
  ['right hip', 'right knee'], ['right knee', 'right ankle'],
  ['nose', 'left shoulder'], ['nose', 'right shoulder'],
  ['left ear', 'left shoulder'], ['right ear', 'right shoulder']
];

export const POSE_INFO = {
  name: 'YOLOv8-pose',
  body: 'YOLOv8-nano pose, 17 keypoints, INT8 (3.6 MB)',
  hand: 'YOLOv8-nano hand pose, 21 keypoints, INT8 (3.5 MB)',
  note: 'Keypoint space is letterbox pixels; both heads share the YOLOv8 decoder.'
};

export class Pose {
  constructor({ runtime, onLog = () => {} } = {}) {
    this.runtime = runtime;
    this.onLog = onLog;
    this.body = null;
    this.hand = null;
    this.bodyReady = false;
    this.handReady = false;
    this.lastMs = 0;
    this.stage = document.createElement('canvas');
  }

  async loadBody({ onProgress = () => {} } = {}) {
    if (this.body) return this.body;
    this.body = await this.runtime.session(BODY_URL, { label: 'BODY POSE MODEL', onProgress });
    this.bodyReady = true;
    await this.body.warmup([1, 3, 320, 320]);
    this.onLog('pose online — 17-keypoint body tracking');
    return this.body;
  }

  async loadHand({ onProgress = () => {} } = {}) {
    if (this.hand) return this.hand;
    this.hand = await this.runtime.session(HAND_URL, { label: 'HAND MODEL', onProgress });
    this.handReady = true;
    this.onLog('hands online — 21-keypoint gesture tracking');
    return this.hand;
  }

  /* ---------------------------------------------------------------- *
   * Body
   * ---------------------------------------------------------------- */

  async detectBodies(img, { size = 320, minScore = 0.35, maxPeople = 8 } = {}) {
    if (!this.bodyReady) return [];
    const started = performance.now();
    const size32 = Math.max(256, Math.round(size / 32) * 32);
    const { canvas, padW, padH, scale } = this._letterbox(img, size32);
    const tensor = toTensor(canvas, { layout: 'NCHW', scale: 1 / 255 });
    const feeds = {};
    feeds[this.body.inputs[0]] = new (this.runtime.ort.Tensor)('float32', tensor, [1, 3, size32, size32]);
    const out = await this.body.run(feeds);
    const raw = out[this.body.outputs[0]];
    const { data, dims } = raw;
    const channelFirst = dims[1] < dims[2];
    const channels = channelFirst ? dims[1] : dims[2];
    const anchors = channelFirst ? dims[2] : dims[1];
    const at = (a, c) => (channelFirst ? data[c * anchors + a] : data[a * channels + c]);
    const kptCount = Math.floor((channels - 5) / 3);
    const people = [];
    for (let a = 0; a < anchors; a++) {
      const score = at(a, 4);
      if (score < minScore) continue;
      const cx = at(a, 0); const cy = at(a, 1); const bw = at(a, 2); const bh = at(a, 3);
      const kpts = [];
      for (let k = 0; k < kptCount; k++) {
        const x = (at(a, 5 + k * 3) - padW) / scale;
        const y = (at(a, 6 + k * 3) - padH) / scale;
        const c = at(a, 7 + k * 3);
        kpts.push({ x, y, c, name: KEYPOINTS[k] || `kp${k}` });
      }
      people.push({
        score,
        box: [(cx - bw / 2 - padW) / scale, (cy - bh / 2 - padH) / scale, (cx + bw / 2 - padW) / scale, (cy + bh / 2 - padH) / scale],
        kpts,
        posture: postureOf(kpts),
        activity: null
      });
    }
    const kept = [];
    for (const p of people.sort((a, b) => b.score - a.score)) {
      if (kept.some((k) => iou(k.box, p.box) > 0.55)) continue;
      kept.push(p);
      if (kept.length >= maxPeople) break;
    }
    this.lastMs = Math.round(performance.now() - started);
    return kept;
  }

  /* ---------------------------------------------------------------- *
   * Hands
   * ---------------------------------------------------------------- */

  async detectHands(img, { minScore = 0.4, size = 224 } = {}) {
    if (!this.handReady) return [];
    return this._handsIn(img, { minScore, size });
  }

  /**
   * Run the hand model around known wrist positions — how it is actually used in
   * the pipeline, because hands at arm's length are far too small for a
   * full-frame pass to see.
   */
  async handsNear(img, wrists, { minScore = 0.35, padding = 1.6 } = {}) {
    if (!this.handReady || !wrists.length) return [];
    const out = [];
    for (const wrist of wrists) {
      const span = wrist.span || Math.max(60, Math.min(img.width, img.height) * 0.18);
      const half = (span * padding) / 2;
      const x = Math.max(0, Math.round(wrist.x - half));
      const y = Math.max(0, Math.round(wrist.y - half));
      const w = Math.min(img.width - x, Math.round(half * 2));
      const h = Math.min(img.height - y, Math.round(half * 2));
      if (w < 24 || h < 24) continue;
      const crop = new ImageData(w, h);
      for (let row = 0; row < h; row++) {
        const src = ((y + row) * img.width + x) * 4;
        crop.data.set(img.data.subarray(src, src + w * 4), row * w * 4);
      }
      const dets = await this._handsIn(crop, { minScore, size: 224 });
      for (const d of dets) {
        out.push({
          ...d,
          box: [d.box[0] + x, d.box[1] + y, d.box[2] + x, d.box[3] + y],
          kpts: d.kpts.map((k) => ({ ...k, x: k.x + x, y: k.y + y })),
          gesture: gestureOf(d.kpts),
          side: wrist.side || null
        });
      }
    }
    return out;
  }

  async _handsIn(img, { minScore, size }) {
    const { canvas, padW, padH, scale } = this._letterbox(img, size);
    const tensor = toTensor(canvas, { layout: 'NCHW', scale: 1 / 255 });
    const feeds = {};
    feeds[this.hand.inputs[0]] = new (this.runtime.ort.Tensor)('float32', tensor, [1, 3, size, size]);
    const out = await this.hand.run(feeds);
    const raw = out[this.hand.outputs[0]];
    const { data, dims } = raw;
    const channelFirst = dims[1] < dims[2];
    const channels = channelFirst ? dims[1] : dims[2];
    const anchors = channelFirst ? dims[2] : dims[1];
    const at = (a, c) => (channelFirst ? data[c * anchors + a] : data[a * channels + c]);
    const kptCount = Math.floor((channels - 5) / 3);
    const hands = [];
    for (let a = 0; a < anchors; a++) {
      const score = at(a, 4);
      if (score < minScore) continue;
      const cx = at(a, 0); const cy = at(a, 1); const bw = at(a, 2); const bh = at(a, 3);
      const kpts = [];
      for (let k = 0; k < kptCount; k++) {
        kpts.push({
          x: (at(a, 5 + k * 3) - padW) / scale,
          y: (at(a, 6 + k * 3) - padH) / scale,
          c: at(a, 7 + k * 3),
          name: HAND_KEYPOINTS[k] || `h${k}`
        });
      }
      hands.push({
        score,
        box: [(cx - bw / 2 - padW) / scale, (cy - bh / 2 - padH) / scale, (cx + bw / 2 - padW) / scale, (cy + bh / 2 - padH) / scale],
        kpts,
        gesture: gestureOf(kpts)
      });
      if (hands.length >= 4) break;
    }
    return hands;
  }

  _letterbox(img, size) {
    const fit = fitSize(img.width, img.height, size, 'max');
    const w = Math.max(32, Math.round(fit.w / 32) * 32);
    const h = Math.max(32, Math.round(fit.h / 32) * 32);
    const scale = Math.min(w / img.width, h / img.height);
    const nw = Math.round(img.width * scale);
    const nh = Math.round(img.height * scale);
    const padW = Math.floor((w - nw) / 2);
    const padH = Math.floor((h - nh) / 2);
    const c = this.stage;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, w, h);
    const src = document.createElement('canvas');
    src.width = img.width; src.height = img.height;
    src.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, padW, padH, nw, nh);
    return { canvas: ctx.getImageData(0, 0, w, h), padW, padH, scale };
  }

  info() {
    return {
      ...POSE_INFO,
      bodyLoaded: this.bodyReady,
      handLoaded: this.handReady,
      lastMs: this.lastMs
    };
  }
}

/* ------------------------------------------------------------------ *
 * Interpretation
 * ------------------------------------------------------------------ */

const kp = (kpts, name) => kpts.find((k) => k.name === name && k.c > 0.25);

export function postureOf(kpts) {
  const lh = kp(kpts, 'left hip'); const rh = kp(kpts, 'right hip');
  const lk = kp(kpts, 'left knee'); const rk = kp(kpts, 'right knee');
  const la = kp(kpts, 'left ankle'); const ra = kp(kpts, 'right ankle');
  const ls = kp(kpts, 'left shoulder'); const rs = kp(kpts, 'right shoulder');
  if (!ls || !rs) return 'unknown';
  const shoulderY = (ls.y + rs.y) / 2;
  const hipY = lh && rh ? (lh.y + rh.y) / 2 : null;
  const kneeY = lk && rk ? (lk.y + rk.y) / 2 : null;
  const ankleY = la && ra ? (la.y + ra.y) / 2 : null;
  if (ankleY && shoulderY && Math.abs(ankleY - shoulderY) < Math.abs((ankleY - shoulderY) * 0.05)) return 'lying';
  if (hipY && kneeY && hipY > kneeY) return 'upright';
  const torso = hipY ? Math.abs(hipY - shoulderY) : 0;
  const legVisible = ankleY && hipY ? Math.abs(ankleY - hipY) : 0;
  if (hipY && ankleY && legVisible < torso * 1.6) return 'sitting';
  if (hipY && torso < 0.06 * (kpts.length ? 1 : 1) && legVisible > 0) return 'crouching';
  if (ankleY && hipY && legVisible >= torso * 1.6) return 'standing';
  return hipY ? 'standing' : 'unknown';
}

/**
 * Hand gesture from 21 landmarks (MediaPipe ordering). Finger "extended" is
 * decided by projecting the tip beyond the middle joint along the palm axis —
 * scale invariant, so it works at any distance.
 */
export function gestureOf(kpts) {
  if (!kpts || kpts.length < 21) return { name: 'unknown', confidence: 0 };
  const P = kpts.map((k) => ({ x: k.x, y: k.y, c: k.c ?? 1 }));
  const wrist = P[0];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const palmSize = Math.max(1, (d(P[0], P[5]) + d(P[0], P[9]) + d(P[0], P[13]) + d(P[0], P[17])) / 4);
  const fingers = [
    { name: 'thumb', tip: 4, pip: 2, base: 1 },
    { name: 'index', tip: 8, pip: 6, base: 5 },
    { name: 'middle', tip: 12, pip: 10, base: 9 },
    { name: 'ring', tip: 16, pip: 14, base: 13 },
    { name: 'pinky', tip: 20, pip: 18, base: 17 }
  ];
  const extended = {};
  for (const f of fingers) {
    if (f.name === 'thumb') {
      extended.thumb = d(P[f.tip], P[17]) > d(P[f.pip], P[17]) * 1.06;
    } else {
      extended[f.name] = d(P[f.tip], wrist) > d(P[f.pip], wrist) * 1.12;
    }
  }
  const count = Object.values(extended).filter(Boolean).length;
  const pinch = d(P[4], P[8]) / palmSize;
  const mid = P[9];
  const up = mid.y < wrist.y;

  let name = 'hand';
  let confidence = 0.5;
  if (pinch < 0.32) { name = 'pinch'; confidence = 0.8; }
  else if (count === 0) { name = 'fist'; confidence = 0.85; }
  else if (count === 5) { name = 'open palm'; confidence = 0.85; }
  else if (count === 1 && extended.index) { name = 'pointing'; confidence = 0.8; }
  else if (count === 2 && extended.index && extended.middle) { name = 'peace sign'; confidence = 0.8; }
  else if (count === 1 && extended.thumb && up) { name = 'thumbs up'; confidence = 0.8; }
  else if (count === 2 && extended.index && extended.pinky) { name = 'rock sign'; confidence = 0.6; }
  else if (count === 3 && extended.thumb && extended.index && extended.middle) { name = 'three'; confidence = 0.5; }
  else if (count >= 4) { name = 'open hand'; confidence = 0.6; }
  else { name = `${count} fingers extended`; confidence = 0.4; }

  // Direction of a pointing hand, as a unit vector from wrist to index tip.
  const dir = { x: P[8].x - wrist.x, y: P[8].y - wrist.y };
  const len = Math.hypot(dir.x, dir.y) || 1;
  return { name, confidence, extended, count, direction: { x: dir.x / len, y: dir.y / len }, palmSize: Math.round(palmSize) };
}

/** Body activity from posture plus the hand's position relative to the head. */
export function activityOf(person, hands = []) {
  const posture = person.posture || postureOf(person.kpts);
  const ls = kp(person.kpts, 'left shoulder');
  const rs = kp(person.kpts, 'right shoulder');
  const lw = kp(person.kpts, 'left wrist');
  const rw = kp(person.kpts, 'right wrist');
  const nose = kp(person.kpts, 'nose');
  const shoulderY = ls && rs ? (ls.y + rs.y) / 2 : null;
  const wristAbove = (lw && shoulderY && lw.y < shoulderY - 10) || (rw && shoulderY && rw.y < shoulderY - 10);
  const handAtHead = nose && ((lw && Math.hypot(lw.x - nose.x, lw.y - nose.y) < 60) || (rw && Math.hypot(rw.x - nose.x, rw.y - nose.y) < 60));

  const gestures = hands.map((h) => h.gesture?.name).filter(Boolean);
  if (gestures.includes('open palm') && wristAbove) return { id: 'waving', label: 'waving', confidence: 0.7 };
  if (gestures.includes('pointing')) return { id: 'pointing', label: 'pointing', confidence: 0.7 };
  if (gestures.includes('thumbs up')) return { id: 'approving', label: 'thumbs up', confidence: 0.65 };
  if (gestures.includes('peace sign')) return { id: 'peace', label: 'peace sign', confidence: 0.6 };
  if (handAtHead) return { id: 'on-phone', label: 'hand to head', confidence: 0.5 };
  if (posture === 'lying') return { id: 'lying', label: 'lying down', confidence: 0.6 };
  if (posture === 'sitting') return { id: 'sitting', label: 'seated', confidence: 0.6 };
  if (posture === 'crouching') return { id: 'crouching', label: 'crouching', confidence: 0.5 };
  if (wristAbove) return { id: 'arms-up', label: 'arms raised', confidence: 0.5 };
  return { id: 'standing', label: 'standing', confidence: 0.5 };
}
