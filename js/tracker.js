/**
 * tracker.js — lightweight IoU tracker with exponential box smoothing.
 * Gives every detection a stable identity so the HUD can lock, label and
 * narrate objects across frames without flicker.
 */

import { now } from './config.js';

let nextId = 1;

export class Tracker {
  constructor({ iouThreshold = 0.25, maxAge = 1100, smooth = 0.5 } = {}) {
    this.iouThreshold = iouThreshold;
    this.maxAge = maxAge;
    this.smooth = smooth;          // 0 = frozen box, 1 = raw detection
    this.tracks = [];
  }

  reset() {
    this.tracks = [];
  }

  static iou(a, b) {
    const ix1 = Math.max(a[0], b[0]);
    const iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]);
    const iy2 = Math.min(a[3], b[3]);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
  }

  /**
   * @param {Array<{cls:string, score:number, box:number[]}>} detections
   * @returns {{live:Array, lost:Array, born:Array}} track snapshots
   */
  update(detections, t = now()) {
    const born = [];
    const claimed = new Set();

    for (const det of detections) {
      let best = null;
      let bestIou = this.iouThreshold;
      for (const track of this.tracks) {
        if (track.cls !== det.cls || claimed.has(track.id)) continue;
        const iou = Tracker.iou(track.box, det.box);
        // Centre distance helps when objects move fast between frames.
        const cx1 = (track.box[0] + track.box[2]) / 2;
        const cy1 = (track.box[1] + track.box[3]) / 2;
        const cx2 = (det.box[0] + det.box[2]) / 2;
        const cy2 = (det.box[1] + det.box[3]) / 2;
        const diag = Math.hypot(
          (det.box[2] - det.box[0]) + (track.box[2] - track.box[0]),
          (det.box[3] - det.box[1]) + (track.box[3] - track.box[1])
        ) / 2 || 1;
        const near = 1 - Math.min(1, Math.hypot(cx2 - cx1, cy2 - cy1) / diag) * 0.35;
        const score = iou * near;
        if (score > bestIou) { bestIou = score; best = track; }
      }

      if (best) {
        claimed.add(best.id);
        const s = this.smooth;
        for (let i = 0; i < 4; i++) best.box[i] = best.box[i] * (1 - s) + det.box[i] * s;
        best.score = best.score * 0.6 + det.score * 0.4;
        best.missed = 0;
        best.lastSeen = t;
        best.hits += 1;
        best.isNew = false;
      } else {
        const track = {
          id: nextId++,
          cls: det.cls,
          score: det.score,
          box: det.box.slice(),
          born: t,
          lastSeen: t,
          hits: 1,
          missed: 0,
          isNew: true,
          announced: false,
          announcedAt: 0,
          acquireT: 0
        };
        this.tracks.push(track);
        claimed.add(track.id);
        born.push(track);
      }
    }

    const live = [];
    const lost = [];
    for (const track of this.tracks) {
      if (!claimed.has(track.id)) {
        track.missed += 1;
        track.lastSeen = track.lastSeen || t;
        if (t - track.lastSeen > this.maxAge) lost.push(track);
      }
    }

    const deadIds = new Set(lost.map((t) => t.id));
    this.tracks = this.tracks.filter((t) => !deadIds.has(t.id));
    for (const track of this.tracks) if (claimed.has(track.id)) live.push(track);

    return { live, lost, born };
  }
}
