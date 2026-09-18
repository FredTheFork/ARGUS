/**
 * tracker.js — identity, motion and appearance memory across frames.
 *
 * A detection is a measurement; a track is a thing. Tracks give every object a
 * stable identity so the assistant can say "the mug has moved left", keep a lock
 * on a target, learn an appearance fingerprint once instead of re-classifying
 * every frame, and time how long something has been in view.
 *
 * Matching is a greedy cost over four signals — IoU, centre distance (normalised
 * by size), class agreement and appearance cosine (when a fingerprint exists).
 * Class is a soft signal, not a hard gate, because the classifier legitimately
 * changes its mind as an object turns.
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
    this.velocity = [0, 0];
    this.embedding = det.embedding || null;
    this.attributes = null;
    this.lastClassified = 0;
    this.lastAttributePass = 0;
    this.lastPose = 0;
    this.lastOcr = 0;
    this.text = null;
    this.brand = null;
    this.note = '';
    this.hazard = null;
    this.distance = null;
    this.pose = null;
    this.gesture = null;
    this.taught = null;
    this.classifier = null;
    this.refined = null;
    this.tier = det.tier || 1;
    this.framesSeen = 1;
    this.locked = false;
    this.watchHit = false;
    this.sessionNotes = [];
    this.history = [];
  }

  _update(det, t, smooth) {
    const dt = Math.max(1, t - this.lastSeen);
    const prevCentre = centre(this.box);
    for (let i = 0; i < 4; i++) this.box[i] = lerp(this.box[i], det.box[i], smooth);
    const nextCentre = centre(this.box);
    // Velocity in pixels per second, smoothed so a single frame cannot spike it.
    const vx = ((nextCentre[0] - prevCentre[0]) / dt) * 1000;
    const vy = ((nextCentre[1] - prevCentre[1]) / dt) * 1000;
    this.velocity = [lerp(this.velocity[0], vx, 0.4), lerp(this.velocity[1], vy, 0.4)];
    this.score = det.score;
    this.smoothScore = lerp(this.smoothScore, det.score, 0.3);
    if (det.cls) this.cls = det.cls;
    if (det.clsId !== undefined) this.clsId = det.clsId;
    if (det.embedding) this.embedding = det.embedding;
    this.lastSeen = t;
    this.hits++;
    this.framesSeen++;
    this.missing = 0;
    this.state = 'tracking';
  }

  speed() {
    return Math.hypot(this.velocity[0], this.velocity[1]);
  }

  motion(diag = 1) {
    const speed = this.speed() / Math.max(1, diag);
    if (speed < 0.12) return { id: 'stationary', label: 'still', speed };
    const [vx, vy] = this.velocity;
    const horizontal = Math.abs(vx) > Math.abs(vy) * 1.4;
    const dir = horizontal ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
    const towardsCamera = diagonallyTowards(this.box, this.velocity);
    if (towardsCamera === 'closer' && speed > 0.3) return { id: 'approaching', label: 'approaching', speed, dir };
    if (towardsCamera === 'further' && speed > 0.3) return { id: 'receding', label: 'receding', speed, dir };
    return { id: `moving ${dir}`, label: `moving ${dir}`, speed, dir };
  }

  centreOf() {
    return centre(this.box);
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
      velocity: [...this.velocity],
      attributes: this.attributes,
      classifier: this.classifier,
      refined: this.refined,
      distance: this.distance,
      text: this.text,
      brand: this.brand,
      pose: this.pose,
      gesture: this.gesture,
      note: this.note,
      hazard: this.hazard,
      tier: this.tier,
      taught: this.taught,
      locked: this.locked,
      embedding: this.embedding ? Array.from(this.embedding) : null
    };
  }
}

function centre(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/**
 * Is this box growing or shrinking? Area change over time is a far more stable
 * "coming at me" signal than raw vertical velocity.
 */
function diagonallyTowards(box, velocity) {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  const cx = (box[0] + box[2]) / 2;
  const approxGrowth = -velocity[1] * 0.4 + Math.abs(velocity[0]) * 0.2;
  if (approxGrowth > 45 && area > 0) return 'closer';
  if (approxGrowth < -45) return 'further';
  return null;
}
