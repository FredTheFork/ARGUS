/**
 * tracker.js — identity across frames.
 *
 * A detection is a measurement; a track is a thing. Tracks give every object a
 * stable identity so the overlay can tag the same object across frames, hold a
 * box steady while the detector flickers, and time how long something has been
 * in view (which drives the label fade-in).
 *
 * Matching is a greedy cost over three signals — IoU, centre distance
 * (normalised by size) and class agreement. Class is a soft signal, not a hard
 * gate, because the classifier legitimately changes its mind as an object
 * turns.
 */

import { iou, cosine, lerp, clamp } from './core.js';

let nextId = 1;

export class Tracker {
  constructor({ iouThreshold = 0.24, maxAge = 1400, smooth = 0.55, appearanceWeight = 0.35 } = {}) {
    this.iouThreshold = iouThreshold;
    this.maxAge = maxAge;
    this.smooth = smooth;
    this.appearanceWeight = appearanceWeight;
    this.tracks = [];
  }

  reset() {
    this.tracks = [];
  }

  update(detections, t = performance.now()) {
    const born = [];
    const lost = [];
    const claimed = new Set();
    const emptyKp = [];

    for (const det of detections) {
      let best = null;
      let bestCost = Infinity;
      const [dcx, dcy] = centre(det.box);
      const detSize = Math.hypot(det.box[2] - det.box[0], det.box[3] - det.box[1]) || 1;

      for (const track of this.tracks) {
        if (claimed.has(track.id)) continue;
        const overlap = iou(track.box, det.box);
        const [tcx, tcy] = centre(track.box);
        const proximity = 1 - Math.min(1, Math.hypot(dcx - tcx, dcy - tcy) / (detSize * 1.4));
        const classAgree = track.cls === det.cls ? 1 : 0;
        let appearance = 0;
        if (track.embedding && det.embedding) appearance = clamp(cosine(track.embedding, det.embedding), 0, 1);
        const cost = 0.45 * (1 - overlap) + 0.25 * (1 - proximity) + 0.15 * (1 - classAgree)
          + this.appearanceWeight * (1 - appearance);
        if (overlap < this.iouThreshold && proximity < 0.35) continue;
        if (cost < bestCost) { bestCost = cost; best = track; }
      }

      if (best) {
        claimed.add(best.id);
        best._update(det, t, this.smooth);
      } else {
        const track = new Track(det, t);
        this.tracks.push(track);
        born.push(track);
        claimed.add(track.id);
      }
    }

    for (const track of this.tracks) {
      if (!claimed.has(track.id)) {
        track.missing++;
        // Frames are not guaranteed to be periodic; use wall time for expiry.
        if (t - track.lastSeen > this.maxAge) {
          track.state = 'lost';
          lost.push(track);
        } else {
          // One missed frame is normal (occlusion, motion blur) — hold the box
          // and mark the track as coasting so the HUD can dim it.
          track.state = 'coasting';
        }
      }
    }
    this.tracks = this.tracks.filter((tr) => !(tr.state === 'lost' && t - tr.lastSeen > this.maxAge * 1.6));

    return { live: this.tracks.filter((tr) => tr.state !== 'lost'), born, lost };
  }

  snapshot(t = performance.now()) {
    return this.tracks.map((tr) => tr.snapshot(t));
  }
}

export class Track {
  constructor(det, t) {
    this.id = nextId++;
    this.cls = det.cls;
    this.clsId = det.clsId;
    this.label = det.label || det.cls;
    this.box = [...det.box];
    this.score = det.score;
    this.smoothScore = det.score;
    this.firstSeen = t;
    this.lastSeen = t;
    this.hits = 1;
    this.missing = 0;
    this.state = 'new';
    this.embedding = det.embedding || null;
    this.text = null;
    this.textAt = 0;
    this.brand = null;
    this.sign = null;
    this.signRatio = 1;
    this.pose = null;
    this.posture = null;
    this.poseScore = 0;
    this.hands = null;
    this.gesture = null;
    this.activity = null;
    this.classifier = null;
    this.refined = null;
    this.refineConfidence = 0;
    this.tier = det.tier || 1;
  }

  _update(det, t, smooth) {
    for (let i = 0; i < 4; i++) this.box[i] = lerp(this.box[i], det.box[i], smooth);
    this.score = det.score;
    this.smoothScore = lerp(this.smoothScore, det.score, 0.3);
    if (det.cls) this.cls = det.cls;
    if (det.clsId !== undefined) this.clsId = det.clsId;
    if (det.embedding) this.embedding = det.embedding;
    this.lastSeen = t;
    this.hits++;
    this.missing = 0;
    this.state = 'tracking';
  }

  snapshot(t = performance.now()) {
    return {
      id: this.id,
      cls: this.cls,
      label: this.label,
      box: [...this.box],
      score: this.smoothScore,
      rawScore: this.score,
      age: t - this.firstSeen,
      lastSeen: t - this.lastSeen,
      hits: this.hits,
      state: this.state,
      text: this.text,
      brand: this.brand,
      sign: this.sign,
      pose: this.pose,
      posture: this.posture,
      gesture: this.gesture,
      activity: this.activity,
      tier: this.tier
    };
  }
}

function centre(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
