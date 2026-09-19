/**
 * ui.js — the overlay: what a high-end recognition camera draws.
 *
 * One thin rounded outline per object, one crisp label chip beside it:
 * the name, its confidence, a quiet category dot, and — for people — a short
 * posture/gesture word. Text read by OCR that sits on no object gets its own
 * small quiet chip. Nothing else: no glow, no sweep, no radar. The overlay
 * renders on the display clock (every animation frame) while inference runs
 * on its own, so tags land the frame an object is first seen and glide as it
 * moves instead of stepping at the detector's rate.
 *
 * The boot console below is unchanged in spirit: startup honesty (stages,
 * progress, failure headlines, retry) is what makes a control-free camera
 * trustworthy.
 */

import { categoryColour, titleCase, clamp } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => clamp(v, 0, 1);
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const INK = '246, 249, 252';

export class Hud {
  constructor({ canvas, video, getSettings } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.getSettings = getSettings;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.lastFrame = null;
    this._toasts = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    requestAnimationFrame((t) => this._loop(t));
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.width = w;
    this.height = h;
  }

  /** Map frame pixels → display pixels with the same cover maths the video uses. */
  coverTransform(frameW, frameH) {
    const scale = Math.max(this.width / frameW, this.height / frameH);
    const dispW = frameW * scale;
    const dispH = frameH * scale;
    return { scale, offsetX: (this.width - dispW) / 2, offsetY: (this.height - dispH) / 2, dispW, dispH };
  }

  /* ---------------------------------------------------------------- *\
   * Frame loop
   * ---------------------------------------------------------------- */

  _loop(t) {
    // One bad frame must not stop the HUD: without this guard a single
    // exception here ends the requestAnimationFrame chain for good.
    try {
      if (this.lastFrame) this.render(this.lastFrame);
    } catch (err) {
      if (!this._loopWarned) {
        this._loopWarned = true;
        console.warn('[argus-hud] frame render failed:', err && err.message);
      }
    }
    requestAnimationFrame((tt) => this._loop(tt));
  }

  render(state) {
    this.lastFrame = state;
    const ctx = this.ctx;
    const s = this.getSettings();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const frame = state.frame;                       // {width, height}
    if (!frame) return;
    const map = this.coverTransform(frame.width, frame.height);
    const mirror = s.mirrorFront && state.facing === 'user';
    const px = (x) => (mirror ? this.width - (x * map.scale + map.offsetX) : x * map.scale + map.offsetX);
    const py = (y) => y * map.scale + map.offsetY;

    // Text read off the scene that sits on no tracked object: quiet chips.
    for (const line of (state.texts || [])) {
      if (line.attached) continue;
      this._textChip(ctx, line, px, py);
    }

    // Objects: largest first, so small objects' labels sit on top.
    const maxLabels = s.maxLabels || 16;
    const drawable = (state.records || [])
      .filter((r) => r.box)
      .map((r) => ({ r, box: [px(r.box[0]), py(r.box[1]), px(r.box[2]), py(r.box[3])] }))
      .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))
      .slice(0, maxLabels);
    for (const { r, box } of drawable) this._tag(ctx, r, box, s);
  }

  /* ---------------------------------------------------------------- *\
   * Elements
   * ---------------------------------------------------------------- */

  /**
   * The whole tag: one thin rounded outline and one chip with the name,
   * confidence and — for people — the posture word. A new object fades in
   * over a few frames; that is all the animation there is.
   */
  _tag(ctx, record, box, s) {
    const x = Math.min(box[0], box[2]);
    const y = Math.min(box[1], box[3]);
    const w = Math.abs(box[2] - box[0]);
    const h = Math.abs(box[3] - box[1]);
    // First frame is already visible (15 %); full strength after a short
    // fade-in. The tag must never appear to lag the object.
    const alpha = clamp01(0.15 + 0.85 * ((record.age ?? 0) / (s.labelFadeMs || 160)));
    const rise = (1 - alpha) * 4;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Outline: a dark under-stroke for contrast on bright scenes, then the
    // thin light line on top.
    const r = Math.min(5, w / 4, h / 4);
    ctx.lineJoin = 'round';
    this._rr(ctx, x, y + rise, w, h, r);
    ctx.strokeStyle = 'rgba(5, 8, 11, 0.55)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    this._rr(ctx, x, y + rise, w, h, r);
    ctx.strokeStyle = `rgba(${INK}, 0.95)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Chip
    const label = titleCase(record.label || record.noun || record.cls || 'Object');
    const conf = Math.round((record.confidence || 0) * 100);
    const sub = record.category === 'person' && record.activity?.label
      ? titleCase(record.activity.label)
      : null;

    const fMain = `600 12.5px ${FONT}`;
    const fSmall = `500 10.5px ${FONT}`;
    const fSub = `400 10.5px ${FONT}`;

    ctx.font = fMain;
    const labelW = ctx.measureText(label).width;
    ctx.font = fSmall;
    const confW = ctx.measureText(`${conf}%`).width;
    ctx.font = fSub;
    const subW = sub ? ctx.measureText(sub).width : 0;

    const padX = 9;
    const dot = 5;
    const gap = 6;
    const line1W = dot + gap + labelW + gap + confW;
    const chipW = Math.max(line1W, subW) + padX * 2;
    const chipH = sub ? 38 : 25;
    let bx = x;
    let by = y + rise - chipH - 7;
    if (by < 4) by = y + h + rise + 7;
    if (bx + chipW > this.width - 4) bx = this.width - 4 - chipW;
    bx = Math.max(4, bx);

    ctx.fillStyle = 'rgba(7, 10, 14, 0.74)';
    this._rr(ctx, bx, by, chipW, chipH, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    this._rr(ctx, bx, by, chipW, chipH, 7);
    ctx.stroke();

    // category dot
    const dotColour = categoryColour(record.category) || '#c3cedd';
    ctx.fillStyle = dotColour;
    ctx.beginPath();
    const dotY = sub ? by + 11 : by + chipH / 2;
    ctx.arc(bx + padX + dot / 2, dotY, dot / 2, 0, Math.PI * 2);
    ctx.fill();

    // main line
    ctx.textBaseline = 'middle';
    ctx.font = fMain;
    ctx.fillStyle = `rgba(${INK}, 0.97)`;
    ctx.fillText(label, bx + padX + dot + gap, sub ? by + 11 : dotY);
    ctx.font = fSmall;
    ctx.fillStyle = `rgba(${INK}, 0.58)`;
    ctx.fillText(`${conf}%`, bx + padX + dot + gap + labelW + gap, sub ? by + 11 : dotY);

    if (sub) {
      ctx.font = fSub;
      ctx.fillStyle = `rgba(${INK}, 0.55)`;
      ctx.fillText(sub, bx + padX, by + 26);
    }

    ctx.restore();
  }

  /** A quiet chip for text the OCR read that does not belong to any object. */
  _textChip(ctx, line, px, py) {
    const text = String(line.text || '').slice(0, 26) + (String(line.text || '').length > 26 ? '…' : '');
    if (!text) return;
    const [x1, y1] = [px(line.box[0]), py(line.box[1])];
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.font = `400 10.5px ${FONT}`;
    const w = ctx.measureText(text).width + 14;
    const h = 19;
    let bx = x1;
    let by = y1 - h - 5;
    if (by < 4) by = y1 + 5;
    if (bx + w > this.width - 4) bx = this.width - 4 - w;
    bx = Math.max(4, bx);
    ctx.fillStyle = 'rgba(7, 10, 14, 0.6)';
    this._rr(ctx, bx, by, w, h, 6);
    ctx.fill();
    ctx.fillStyle = `rgba(${INK}, 0.8)`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 7, by + h / 2 + 0.5);
    ctx.restore();
  }

  /** Rounded-rect path without relying on the newer roundRect API. */
  _rr(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- *\
   * Boot console
   * ---------------------------------------------------------------- */

  bootLine(text, kind = '') {
    const box = $('boot-lines');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = text;
    if (kind) line.className = kind;
    box.appendChild(line);
    while (box.children.length > 8) box.removeChild(box.children[0]);
    box.scrollTop = box.scrollHeight;
  }

  setBootStage(text, pct) {
    // The standalone watchdog in index.html keys off this flag: a stage that
    // stops changing for a long time is a wedged load, not a slow one.
    try { window.__argusPhase = text; } catch { /* outside a real window */ }
    const stage = $('boot-stage');
    if (stage) stage.textContent = text;
    const bar = $('boot-pct');
    if (bar) bar.style.width = `${Math.round(clamp01(pct) * 100)}%`;
  }

  bootReady(detail = '') {
    this.setBootStage('ONLINE', 1);
    try { window.__argusReady = true; } catch { /* outside a real window */ }
    if (detail) this.bootLine(detail, 'ok');
  }

  bootError(headline, detail = '') {
    try { window.__argusFailed = true; } catch { /* outside a real window */ }
    const box = $('boot-error');
    if (!box) return;
    box.hidden = false;
    $('boot-error-title').textContent = headline;
    $('boot-detail').textContent = detail;
    this.setBootStage('OFFLINE', 0);
    const demo = $('demo-fallback');
    if (demo) demo.hidden = false;
  }

  hideBootError() {
    try { window.__argusFailed = false; } catch { /* outside a real window */ }
    const box = $('boot-error');
    if (box) box.hidden = true;
  }

  hideBoot() {
    try { window.__argusReady = true; } catch { /* outside a real window */ }
    const boot = $('boot');
    if (boot) {
      boot.style.transition = 'opacity .35s ease';
      boot.style.opacity = '0';
      setTimeout(() => { boot.hidden = true; }, 380);
    }
    const stage = $('stage');
    if (stage) stage.hidden = false;
  }
}
