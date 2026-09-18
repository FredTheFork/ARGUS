/**
 * attributes.js — colour, material, pattern, shape, range and light.
 *
 * Everything here is classical computer vision on the crop, and that is
 * deliberate: a network that answers "what is it" says nothing about what it is
 * made of or what colour it is, and those questions are usually the ones being
 * asked. The heuristics are physical — a mirror finish throws a highlight, a
 * weave scatters it, wood has a warm hue and a directional grain — so the output
 * can be hedged honestly ("looks like brushed metal, probably steel") instead of
 * asserted.
 *
 * The output of analyseAppearance() feeds the spoken description, the HUD chips
 * and the query language, and it is what makes the assistant able to answer
 * "what colour is that" without a second model.
 */

import {
  toLuma, gradient, boxBlur, entropy, mean, std, rgbToLab, rgbToHsv, kmeansLab,
  deltaE, clamp, boxArea, hexOf, fitSize
} from './core.js';
import { MATERIALS, FINISHES } from './data/kb-materials.js';
import { nearestColour, coloursFor, materialsFor, lookup, familySwatch } from './kb.js';

/* ------------------------------------------------------------------ *
 * Crop + mask
 * ------------------------------------------------------------------ */

function cropTo(img, box, pad = 0.06) {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const px = Math.round(w * pad);
  const py = Math.round(h * pad);
  const x = Math.max(0, Math.floor(box[0] - px));
  const y = Math.max(0, Math.floor(box[1] - py));
  const cw = Math.min(img.width - x, Math.ceil(w + px * 2));
  const ch = Math.min(img.height - y, Math.ceil(h + py * 2));
  if (cw < 4 || ch < 4) return null;
  const out = new ImageData(cw, ch);
  for (let row = 0; row < ch; row++) {
    const src = ((y + row) * img.width + x) * 4;
    out.data.set(img.data.subarray(src, src + cw * 4), row * cw * 4);
  }
  return out;
}

/** Downscale with the browser's own resampler — cheaper and better than JS. */
function downscale(img, target = 96) {
  const long = Math.max(img.width, img.height);
  if (long <= target) return img;
  const scale = target / long;
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(img, 0, 0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Region-growing foreground mask.
 *
 * Seeded from the border: a flood fill spreads while the colour stays close to
 * the border statistics, so plain backgrounds fall away and the object's own
 * pixels remain. This is the cheap, dependency-free version of grabcut and it is
 * good enough to stop a white background from turning every colour into white.
 */
function foregroundMask(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  let br = 0; let bg = 0; let bb = 0; let count = 0;
  const border = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= border && x < w - border && y >= border && y < h - border) continue;
      const i = (y * w + x) * 4;
      br += data[i]; bg += data[i + 1]; bb += data[i + 2]; count++;
    }
  }
  if (!count) return { mask: new Uint8Array(n).fill(1), coverage: 1 };
  br /= count; bg /= count; bb /= count;
  const borderLab = rgbToLab(br, bg, bb);
  const tolerance = 26;                       // ΔE units
  const mask = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = y * w + x;
      if (!mask[p]) { mask[p] = 1; stack[sp++] = p; }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const p = y * w + x;
      if (!mask[p]) { mask[p] = 1; stack[sp++] = p; }
    }
  }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w; const y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (mask[np]) continue;
      const i = np * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      if (deltaE(lab, borderLab) <= tolerance) { mask[np] = 1; stack[sp++] = np; }
    }
  }
  // Invert: 1 = object pixel.
  let fg = 0;
  for (let i = 0; i < n; i++) { mask[i] = mask[i] ? 0 : 1; if (mask[i]) fg++; }
  const coverage = fg / n;
  if (coverage < 0.12) return { mask: new Uint8Array(n).fill(1), coverage: 1, fallback: true };
  return { mask, coverage };
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

function colourAnalysis(img, mask, { priors }) {
  const { width: w, height: h, data } = img;
  const samples = [];
  const cx = w / 2; const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      const i = p * 4;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const lab = rgbToLab(r, g, b);
      // Centre weight: objects are framed centrally, so the middle counts twice.
      const weight = 1 + 0.6 * (1 - Math.hypot(x - cx, y - cy) / maxR);
      samples.push({ lab, rgb: [r, g, b], weight });
    }
  }
  if (samples.length < 16) return null;

  // Ignore near-black pixels for hue naming (shadow crushes hue) but keep them
  // for the brightness read, which is how "matte black" survives.
  const weighted = samples.map((s) => ({ lab: s.lab, rgb: s.rgb, weight: s.weight }));

  const clusters = kmeansLab(weighted, 4, 7).map((c) => {
    const named = nearestColour(c.lab, { prefer: priors });
    return {
      name: named?.name || 'unknown',
      hex: hexOf(...c.rgb),
      family: named?.family || 'neutral',
      lab: c.lab,
      weight: c.weight,
      rgb: c.rgb
    };
  });

  const total = clusters.reduce((a, c) => a + c.weight, 0) || 1;
  for (const c of clusters) c.weight /= total;

  // The dominant colour is the heaviest cluster, nudged toward the object's own
  // prior when two readings are close — that is what stops the grey/silver and
  // black/charcoal flip-flop between frames.
  const sorted = [...clusters].sort((a, b) => b.weight - a.weight);
  let dominant = sorted[0];
  if (priors.length) {
    const priorHit = sorted.find((c) => priors.includes(c.name) && c.weight > dominant.weight * 0.6);
    if (priorHit) dominant = priorHit;
  }

  const meanRgb = samples.reduce((acc, s) => [acc[0] + s.rgb[0] * s.weight, acc[1] + s.rgb[1] * s.weight, acc[2] + s.rgb[2] * s.weight], [0, 0, 0])
    .map((v) => v / samples.reduce((a, s) => a + s.weight, 0));
  const [hue, sat, val] = rgbToHsv(...meanRgb);
  const warmth = samples.reduce((a, s) => a + s.lab[2], 0) / samples.length;   // +b = warm

  return {
    name: dominant.name,
    hex: dominant.hex,
    family: dominant.family,
    swatch: familySwatch(dominant.family),
    palette: sorted.slice(0, 3).map((c) => ({ name: c.name, hex: c.hex, weight: Math.round(c.weight * 100) })),
    hue: Math.round(hue),
    saturation: sat,
    brightness: val,
    warmth,
    monochrome: clusters.filter((c) => deltaE(c.lab, dominant.lab) < 18).reduce((a, c) => a + c.weight, 0)
  };
}

/* ------------------------------------------------------------------ *
 * Material
 * ------------------------------------------------------------------ */

function cueProfile(img, mask) {
  const gray = toLuma(img);
  const { width: w, height: h, data } = img;
  const n = w * h;
  let bright = 0; let fg = 0;
  let satSum = 0; let valSum = 0; let labA = 0; let labB = 0;
  const lumaFg = [];
  for (let p = 0; p < n; p++) {
    if (!mask[p]) continue;
    fg++;
    const i = p * 4;
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const [, s, v] = rgbToHsv(r, g, b);
    satSum += s; valSum += v;
    const lab = rgbToLab(r, g, b);
    labA += lab[1]; labB += lab[2];
    lumaFg.push(gray[p]);
    if (v > 0.9 && s < 0.22) bright++;
  }
  if (!fg) return null;

  const blurred = boxBlur(gray, w, h, 1);
  let lap = 0; let lapCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      const v = 4 * gray[p] - (gray[p - 1] + gray[p + 1] + gray[p - w] + gray[p + w]);
      lap += v * v; lapCount++;
    }
  }
  const grad = gradient(blurred, w, h);
  let edge = 0; let edgeCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      edge += grad[p]; edgeCount++;
    }
  }
  const specular = bright / fg;
  const texture = clamp(Math.sqrt(lapCount ? lap / lapCount : 0) * 9, 0, 1);
  const edgeDensity = clamp((edgeCount ? edge / edgeCount : 0) * 6, 0, 1);
  const ent = entropy(Float32Array.from(lumaFg));
  const contrast = std(Float32Array.from(lumaFg));

  return {
    specular,
    texture,
    edge: edgeDensity,
    entropy: ent,
    contrast,
    saturation: satSum / fg,
    value: valSum / fg,
    warm: clamp((labB / fg + 40) / 80, 0, 1),         // b* in Lab: + = yellow/warm
    green: clamp((-(labA / fg) + 30) / 60, 0, 1),     // -a* = green cast
    coverage: fg / n
  };
}

const CUE_WEIGHTS = { specular: 2.2, texture: 1.4, edge: 1.1, saturation: 1.2, value: 0.9, warm: 0.8, green: 0.5 };

/**
 * Score every material against the measured cues plus the class prior. The
 * exp(-d²) form keeps scores in 0-1 and lets a prior lift a physically plausible
 * answer over a marginal cue difference without ever inventing evidence.
 */
export function scoreMaterials(cues, cls) {
  if (!cues) return [];
  const priors = materialsFor(cls).map((m) => m.toLowerCase());
  const rows = MATERIALS.map((row) => {
    const [name, adjectives, spec, tex, edge, sat, val, hue] = row.split('|');
    const profile = {
      specular: Number(spec), texture: Number(tex), edge: Number(edge),
      saturation: Number(sat), value: Number(val)
    };
    let d = 0; let wsum = 0;
    for (const [key, weight] of Object.entries(CUE_WEIGHTS)) {
      if (!(key in profile)) continue;
      const diff = cues[key] - profile[key];
      d += weight * diff * diff;
      wsum += weight;
    }
    let score = Math.exp(-d / (wsum * 0.055));
    const base = name.toLowerCase();
    if (priors.some((p) => base.includes(p) || p.includes(base))) score += 0.28;
    if (hue === 'warm' && cues.warm > 0.62) score += 0.03;
    if (hue === 'cool' && cues.warm < 0.42) score += 0.03;
    if (hue === 'dark' && cues.value > 0.45) score -= 0.06;
    if (hue === 'green' && cues.green > 0.62) score += 0.05;
    return { name, adjectives: adjectives ? adjectives.split(',').map((s) => s.trim()) : [], score: clamp(score, 0, 0.99) };
  });
  return rows.filter((r) => r.name !== 'unknown').sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ *
 * Pattern
 * ------------------------------------------------------------------ */

/** Autocorrelation along rows and columns: periodicity is what makes a stripe. */
function periodicity(gray, w, h, mask) {
  const profile = (axis) => {
    const len = axis === 'x' ? w : h;
    const series = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let sum = 0; let count = 0;
      if (axis === 'x') {
        for (let y = 0; y < h; y++) { const p = y * w + i; if (mask[p]) { sum += gray[p]; count++; } }
      } else {
        for (let x = 0; x < w; x++) { const p = i * w + x; if (mask[p]) { sum += gray[p]; count++; } }
      }
      series[i] = count ? sum / count : 0;
    }
    const m = mean(series);
    let best = 0; let bestLag = 0;
    for (let lag = 3; lag < Math.floor(len / 2); lag++) {
      let acc = 0;
      for (let i = 0; i + lag < len; i++) acc += (series[i] - m) * (series[i + lag] - m);
      acc /= (len - lag);
      if (acc > best) { best = acc; bestLag = lag; }
    }
    const variance = series.reduce((a, v) => a + (v - m) ** 2, 0) / len;
    return { strength: variance > 1e-6 ? clamp(best / variance, 0, 1) : 0, lag: bestLag };
  };
  return { x: profile('x'), y: profile('y') };
}

function patternAnalysis(img, mask, colours) {
  const gray = toLuma(img);
  const { x, y } = periodicity(gray, img.width, img.height, mask);
  const clusterCount = colours?.palette?.length || 0;
  const contrast = std(gray);
  const strongX = x.strength > 0.28 && x.lag >= 3;
  const strongY = y.strength > 0.28 && y.lag >= 3;

  if (strongX && strongY) return { id: 'check', label: 'checked', confidence: clamp((x.strength + y.strength) / 1.6, 0, 0.9) };
  if (strongX || strongY) {
    const s = Math.max(x.strength, y.strength);
    const spacing = strongX ? x.lag : y.lag;
    const fine = spacing < 8;
    return {
      id: fine ? 'pinstripe' : 'striped',
      label: fine ? 'finely striped' : 'striped',
      confidence: clamp(s, 0, 0.9)
    };
  }
  if (contrast > 0.26 && clusterCount >= 3) return { id: 'printed', label: 'printed', confidence: 0.45 };
  if (contrast > 0.18) return { id: 'textured', label: 'textured', confidence: 0.4 };
  return { id: 'solid', label: 'plain', confidence: 0.5 };
}

/* ------------------------------------------------------------------ *
 * Shape + geometry
 * ------------------------------------------------------------------ */

export function shapeOf(box, mask, img) {
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  const aspect = bw / Math.max(1, bh);
  let fill = 1;
  if (mask && img) {
    let fg = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) fg++;
    fill = clamp(fg / mask.length, 0, 1);
  }
  let form = 'blocky';
  if (fill > 0.82 && aspect > 0.85 && aspect < 1.18) form = 'square';
  else if (fill > 0.7 && aspect > 1.35) form = 'wide';
  else if (fill > 0.7 && aspect < 0.74) form = 'tall';
  else if (fill < 0.55) form = aspect > 1 ? 'irregular wide' : 'irregular tall';
  else if (aspect > 1.5) form = 'elongated';
  return { aspect, fill, form };
}

/* ------------------------------------------------------------------ *
 * Range
 * ------------------------------------------------------------------ */

/**
 * Monocular range from a known object size.
 *
 *   distance = (real height × focal length in px) / apparent height in px
 *
 * The focal length comes from the camera's horizontal field of view, which the
 * user can calibrate; the real height comes from the knowledge base, so a bus is
 * ranged as a bus (3.2 m) and a mug as a mug (10 cm). That is why the KB carries
 * a size for every object: it turns a bounding box into metres.
 */
export function estimateRange({
  box, frameWidth, frameHeight, fovDeg = 62, heightPrior = 0, personKpts = null
}) {
  const px = box[3] - box[1];
  if (px < 6) return null;
  const focal = (frameWidth / 2) / Math.tan((fovDeg * Math.PI / 180) / 2);
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const bearing = Math.atan2(cx - frameWidth / 2, focal) * 180 / Math.PI;
  const elevation = Math.atan2(frameHeight / 2 - cy, focal) * 180 / Math.PI;

  let realHeight = heightPrior;
  let method = 'size prior';
  let uncertainty = 0.38;
  if (personKpts && personKpts.length) {
    const head = personKpts.find((k) => k.name === 'nose' && k.c > 0.3);
    const ankle = personKpts.filter((k) => /ankle/.test(k.name) && k.c > 0.3);
    if (head && ankle.length) {
      const ankleY = ankle.reduce((a, k) => a + k.y, 0) / ankle.length;
      const span = Math.abs(ankleY - head.y) / 0.88;    // nose sits ~88 % of height
      if (span > 12) {
        return {
          metres: (1.75 * focal) / span,
          min: (1.55 * focal) / span,
          max: (1.95 * focal) / span,
          bearing, elevation, method: 'pose height', uncertainty: 0.2
        };
      }
    }
  }
  if (!realHeight) return { metres: null, bearing, elevation, method: 'no size prior', uncertainty: 1 };
  const metres = (realHeight * focal) / px;
  return {
    metres,
    min: metres * (1 - uncertainty),
    max: metres * (1 + uncertainty),
    bearing,
    elevation,
    method,
    uncertainty
  };
}

/* ------------------------------------------------------------------ *
 * Light + scene
 * ------------------------------------------------------------------ */

/** Grey-world white balance + luminance statistics: how is this place lit? */
export function lightingOf(img) {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.floor((w * h) / 20000));
  let r = 0; let g = 0; let b = 0; let n = 0;
  const luma = [];
  for (let i = 0; i < w * h; i += step) {
    const p = i * 4;
    r += data[p]; g += data[p + 1]; b += data[p + 2];
    luma.push((data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) / 255);
    n++;
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  const grey = (r + g + b) / 3;
  const rb = r / Math.max(1, b);                    // > 1 means tungsten, < 1 means shade
  // Rough correlated colour temperature from the red/blue balance.
  const kelvin = clamp(6600 / Math.max(0.35, rb), 1800, 14000);
  const brightness = mean(luma);
  const contrast = std(luma);
  let key = 'flat';
  if (contrast > 0.24) key = 'hard key light';
  else if (contrast > 0.15) key = 'directional light';
  const quadrant = (x0, y0, x1, y1) => {
    let sum = 0; let count = 0;
    for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++) {
      for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
        const p = (y * w + x) * 4;
        sum += (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) / 255;
        count++;
      }
    }
    return count ? sum / count : 0;
  };
  const quadrants = [
    { name: 'upper left', v: quadrant(0, 0, 0.5, 0.5) },
    { name: 'upper right', v: quadrant(0.5, 0, 1, 0.5) },
    { name: 'lower left', v: quadrant(0, 0.5, 0.5, 1) },
    { name: 'lower right', v: quadrant(0.5, 0.5, 1, 1) }
  ].sort((a, b) => b.v - a.v);
  return {
    kelvin: Math.round(kelvin / 100) * 100,
    brightness,
    contrast,
    key,
    direction: quadrants[0].name,
    indoorGuess: brightness < 0.55 ? 'indoor' : 'outdoor',
    exposure: brightness > 0.78 ? 'blown highlights' : brightness < 0.16 ? 'very dark' : 'normal'
  };
}

const ROOM_RULES = [
  { id: 'kitchen', label: 'kitchen', triggers: ['sink', 'kettle', 'microwave', 'oven', 'hob', 'fridge', 'refrigerator', 'toaster', 'dishwasher', 'chopping board', 'frying pan', 'mug', 'cutlery'] },
  { id: 'bathroom', label: 'bathroom', triggers: ['toilet', 'shower', 'bath', 'sink', 'towel', 'razor', 'toothbrush', 'soap', 'tile', 'mirror'] },
  { id: 'office', label: 'office', triggers: ['keyboard', 'monitor', 'desk', 'office chair', 'printer', 'laptop', 'mouse', 'folder', 'whiteboard'] },
  { id: 'bedroom', label: 'bedroom', triggers: ['bed', 'wardrobe', 'pillow', 'duvet', 'lamp', 'mattress'] },
  { id: 'living room', label: 'living room', triggers: ['sofa', 'television', 'coffee table', 'armchair', 'rug', 'bookcase'] },
  { id: 'street', label: 'street', triggers: ['car', 'bus', 'van', 'truck', 'road sign', 'traffic light', 'kerb', 'bicycle', 'pedestrian', 'traffic cone'] },
  { id: 'shop', label: 'shop', triggers: ['cash register', 'shelf', 'shopping basket', 'shopping trolley', 'price tag', 'barcode', 'freezer', 'till'] },
  { id: 'restaurant', label: 'restaurant', triggers: ['menu', 'table', 'chair', 'wine glass', 'plate', 'napkin', 'cutlery', 'bar'] },
  { id: 'workshop', label: 'workshop', triggers: ['power drill', 'saw', 'workbench', 'tool chest', 'vice', 'ladder', 'screwdriver', 'hammer', 'clamp'] },
  { id: 'warehouse', label: 'warehouse', triggers: ['pallet', 'crate', 'forklift', 'shelf', 'cardboard box', 'packing tape'] },
  { id: 'construction', label: 'construction site', triggers: ['scaffold', 'hard hat', 'hi-vis vest', 'bulldozer', 'crane', 'barrier', 'wheelbarrow'] },
  { id: 'hospital', label: 'clinical setting', triggers: ['syringe', 'stethoscope', 'hospital bed', 'sharps bin', 'iv stand', 'glucometer', 'first aid'] },
  { id: 'laboratory', label: 'laboratory', triggers: ['test tube', 'beaker', 'microscope', 'pipette', 'lab coat', 'fume cupboard', 'petri dish'] },
  { id: 'garden', label: 'garden', triggers: ['hedge', 'lawn mower', 'shrub', 'flower', 'watering can', 'garden hose', 'tree'] },
  { id: 'gym', label: 'gym', triggers: ['dumbbell', 'barbell', 'treadmill', 'kettlebell', 'yoga mat', 'gym equipment'] },
  { id: 'classroom', label: 'classroom', triggers: ['whiteboard', 'desk', 'chair', 'book', 'projector', 'lectern', 'notebook'] },
  { id: 'server room', label: 'server room', triggers: ['server rack', 'network switch', 'patch panel', 'battery bank', 'cable tray'] },
  { id: 'vehicle interior', label: 'vehicle interior', triggers: ['seatbelt', 'steering wheel', 'dashboard', 'car seat', 'gear stick', 'rear view mirror'] },
  { id: 'park', label: 'park', triggers: ['bench', 'tree', 'grass', 'bird', 'picnic table', 'swing', 'seesaw'] },
  { id: 'station', label: 'station', triggers: ['platform', 'train', 'ticket', 'departure board', 'turnstile', 'tram'] }
];

/** Guess the setting from what is in the frame rather than from pixels alone. */
export function inferScene({ objects = [], lighting = null, textLines = [] } = {}) {
  const scores = new Map();
  for (const obj of objects) {
    const name = (obj.label || obj.cls || '').toLowerCase();
    for (const rule of ROOM_RULES) {
      for (const trigger of rule.triggers) {
        if (name.includes(trigger)) scores.set(rule.id, (scores.get(rule.id) || 0) + (1 + (obj.tier || 1) * 0.2));
      }
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const rule = best ? ROOM_RULES.find((r) => r.id === best[0]) : null;
  const indoor = rule ? !['street', 'park', 'construction', 'garden'].includes(rule.id)
    : (lighting ? lighting.indoorGuess === 'indoor' : null);
  return {
    id: rule?.id || (indoor === false ? 'outdoors' : indoor === true ? 'indoors' : 'scene'),
    label: rule?.label || (indoor === false ? 'outdoors' : indoor === true ? 'indoors' : 'general scene'),
    confidence: best ? clamp(best[1] / 4, 0.2, 0.9) : 0.2,
    indoor,
    alternatives: ranked.slice(1, 3).map(([id]) => ROOM_RULES.find((r) => r.id === id)?.label).filter(Boolean),
    textPresent: textLines.length > 0
  };
}

/* ------------------------------------------------------------------ *
 * Public entry
 * ------------------------------------------------------------------ */

/**
 * Full appearance read for one detection.
 *
 * @param {ImageData} frame
 * @param {number[]}  box
 * @param {object}    opts  { cls, maxSize }
 */
export function analyseAppearance(frame, box, { cls = '', maxSize = 96 } = {}) {
  const crop = cropTo(frame, box);
  if (!crop) return null;
  const small = downscale(crop, maxSize);
  const { mask, coverage, fallback } = foregroundMask(small);
  const priors = coloursFor(cls);
  const colour = colourAnalysis(small, mask, { priors });
  const cues = cueProfile(small, mask);
  const materials = scoreMaterials(cues, cls);
  const pattern = patternAnalysis(small, mask, colour);
  const finish = FINISHES.find((f) => (cues?.specular ?? 0) >= f.min)?.word || 'matte';
  const shape = shapeOf(box, mask, small);

  return {
    colour,
    materials: materials.slice(0, 4),
    material: materials[0] ? { name: materials[0].name, confidence: materials[0].score } : null,
    finish,
    pattern,
    shape,
    cues,
    coverage,
    masked: !fallback,
    priorColours: priors
  };
}

/** One-line description used by the HUD chip and the spoken register. */
export function appearancePhrase(appearance, { max = 3 } = {}) {
  if (!appearance) return '';
  const parts = [];
  if (appearance.colour) parts.push(`${appearance.colour.name}`);
  if (appearance.finish && appearance.material) parts.push(appearance.finish);
  if (appearance.material && appearance.material.confidence > 0.3) parts.push(appearance.material.name);
  const short = parts.slice(0, max).join(' ');
  return short;
}

export { lookup, boxArea, fitSize, boxBlur, entropy, mean, std, gradient, toLuma };
