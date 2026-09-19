/**
 * ui.js — the v2.1 overlay: outlines and names drawn on the feed.
 *
 * The HUD is drawn on a canvas over the camera feed at display refresh rate,
 * independently of inference, so brackets glide instead of stuttering at the
 * detector's 8 Hz. Every object in view gets corner brackets in its category
 * colour and its name; a hazard object is named in red. There is nothing to
 * tap, drag or type — the stage carries zero interactive elements — and the
 * only surface this class can raise by itself is the hazard toast.
 *
 * The boot console survives unchanged: startup honesty (stages, progress,
 * failure headlines, retry) is what makes a control-free interface trustworthy.
 */

import { categoryColour } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */

export class Hud {
  constructor({ canvas, video, getSettings } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.getSettings = getSettings;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.lastFrame = null;
    this._sweep = 0;
    this._toasts = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    requestAnimationFrame((t) => this._loop(t));
  }

  get style() { return this.getSettings().hudStyle || 'standard'; }

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

  /* ---------------------------------------------------------------- *
   * Frame loop — the HUD renders every animation frame regardless of model rate
   * ---------------------------------------------------------------- */

  _loop(t) {
    this._sweep = t;
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
    const scale = s.hudStyle === 'glasses' ? 1.35 : 1;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const frame = state.frame;                       // {width, height}
    if (!frame) return;
    const map = this.coverTransform(frame.width, frame.height);
    const mirror = s.mirrorFront && state.facing === 'user';
    const px = (x) => (mirror ? this.width - (x * map.scale + map.offsetX) : x * map.scale + map.offsetX);
    const py = (y) => y * map.scale + map.offsetY;

    const records = (state.records || []).filter((r) => r.box && !r.synthetic);
    const drawable = records
      .map((r) => ({ record: r, box: [px(r.box[0]), py(r.box[1]), px(r.box[2]), py(r.box[3])] }))
      .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));

    const display = drawable.slice(0, 14);

    // Pose skeletons and hands first, so brackets sit on top of them.
    for (const { record } of display) {
      if (record.pose) this._skeleton(ctx, record.pose, px, py);
      if (record.hands) for (const hand of record.hands) this._hand(ctx, hand, px, py);
    }
    // Text regions from the OCR pass — outlined, with the words read aloud on
    // the feed as they were found.
    for (const line of (state.texts || [])) this._textBox(ctx, line, px, py, scale);

    for (const { record, box } of display) {
      this._bracket(ctx, record, box, scale);
    }
  }

  /* ---------------------------------------------------------------- *
   * Elements
   * ---------------------------------------------------------------- */

  /**
   * Corner brackets in the category colour, the object's name beside them.
   * The outline lands the first frame the object is tracked — no dwell, no
   * confirmation, no tap: if the detector names it, the feed says it.
   */
  _bracket(ctx, record, box, scale) {
    const colour = categoryColour(record.category) || '#c9d4e4';
    const x = Math.min(box[0], box[2]);
    const y = Math.min(box[1], box[3]);
    const w = Math.abs(box[2] - box[0]);
    const h = Math.abs(box[3] - box[1]);
    const len = Math.max(8, Math.min(26, Math.min(w, h) * 0.28));

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5 * (this.style === 'glasses' ? 1.35 : 1);
    ctx.shadowColor = colour;
    ctx.shadowBlur = 4;
    const segs = [
      [[x, y + len], [x, y], [x + len, y]],
      [[x + w - len, y], [x + w, y], [x + w, y + len]],
      [[x + w, y + h - len], [x + w, y + h], [x + w - len, y + h]],
      [[x + len, y + h], [x, y + h], [x, y + h - len]]
    ];
    for (const seg of segs) {
      ctx.beginPath();
      ctx.moveTo(seg[0][0], seg[0][1]);
      ctx.lineTo(seg[1][0], seg[1][1]);
      ctx.lineTo(seg[2][0], seg[2][1]);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    const label = String(record.label || record.noun || record.cls || 'object').toUpperCase();
    const hazard = record.hazard ? (record.hazard.note || record.hazard.kind || 'hazard').toUpperCase() : null;

    const fontTitle = 11.5 * (this.style === 'glasses' ? 1.25 : 1);
    const fontBody = 10 * (this.style === 'glasses' ? 1.3 : 1);
    ctx.textBaseline = 'top';
    ctx.font = `600 ${fontTitle}px ui-monospace, monospace`;
    const widest = Math.max(
      ctx.measureText(label).width,
      hazard ? (ctx.font = `600 ${fontBody}px ui-monospace, monospace`, ctx.measureText(hazard).width) : 0
    );
    const padX = 7;
    const lineH = fontTitle + 4;
    const lines = hazard ? 2 : 1;
    const boxW = widest + padX * 2;
    const boxH = lines * lineH + 6;
    let bx = x;
    let by = y - boxH - 6;
    if (by < 4) by = y + h + 6;
    if (bx + boxW > this.width - 4) bx = this.width - 4 - boxW;
    bx = Math.max(2, bx);

    ctx.fillStyle = 'rgba(2,6,12,.62)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + boxW, by);
    ctx.stroke();

    ctx.font = `600 ${fontTitle}px ui-monospace, monospace`;
    ctx.fillStyle = hazard ? '#ff5b5b' : colour;
    ctx.fillText(label, bx + padX, by + 4);
    if (hazard) {
      ctx.font = `600 ${fontBody}px ui-monospace, monospace`;
      ctx.fillText(hazard, bx + padX, by + 4 + lineH);
    }
    ctx.restore();
  }

  _skeleton(ctx, kpts, px, py) {
    ctx.save();
    ctx.strokeStyle = 'rgba(76,224,255,.85)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(76,224,255,.6)';
    ctx.shadowBlur = 6;
    const pairs = [
      ['left shoulder', 'right shoulder'], ['left shoulder', 'left elbow'], ['left elbow', 'left wrist'],
      ['right shoulder', 'right elbow'], ['right elbow', 'right wrist'], ['left shoulder', 'left hip'],
      ['right shoulder', 'right hip'], ['left hip', 'right hip'], ['left hip', 'left knee'],
      ['left knee', 'left ankle'], ['right hip', 'right knee'], ['right knee', 'right ankle']
    ];
    const find = (name) => kpts.find((k) => k.name === name && k.c > 0.3);
    for (const [a, b] of pairs) {
      const ka = find(a); const kb = find(b);
      if (!ka || !kb) continue;
      ctx.beginPath();
      ctx.moveTo(px(ka.x), py(ka.y));
      ctx.lineTo(px(kb.x), py(kb.y));
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    for (const k of kpts) {
      if (k.c < 0.3) continue;
      ctx.beginPath();
      ctx.arc(px(k.x), py(k.y), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _hand(ctx, hand, px, py) {
    ctx.save();
    ctx.strokeStyle = 'rgba(125,255,155,.9)';
    ctx.fillStyle = 'rgba(125,255,155,.9)';
    ctx.lineWidth = 1.6;
    const chains = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]];
    for (const chain of chains) {
      ctx.beginPath();
      for (let i = 0; i < chain.length; i++) {
        const k = hand.kpts[chain[i]];
        if (!k) continue;
        const x = px(k.x);
        const y = py(k.y);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const k of hand.kpts) {
      ctx.beginPath();
      ctx.arc(px(k.x), py(k.y), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (hand.gesture?.name && hand.gesture.name !== 'hand' && hand.gesture.confidence > 0.6) {
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.fillText(hand.gesture.name.toUpperCase(), px(hand.kpts[0].x), py(hand.kpts[0].y) - 8);
    }
    ctx.restore();
  }

  _textBox(ctx, line, px, py, scale) {
    const q = line.quad;
    if (!q) return;
    ctx.save();
    ctx.strokeStyle = line.sign ? 'rgba(255,140,140,.75)' : 'rgba(180,220,255,.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px(q[0][0]), py(q[0][1]));
    for (let i = 1; i < q.length; i++) ctx.lineTo(px(q[i][0]), py(q[i][1]));
    ctx.lineTo(px(q[0][0]), py(q[0][1]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `400 ${9.5 * scale}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(223,246,255,.85)';
    const x = px(q[0][0]);
    const y = py(q[0][1]) - 3;
    ctx.fillText(line.text, x, y);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * Imperative bits — the hazard toast is the only proactive surface
   * ---------------------------------------------------------------- */

  toast(text, kind = 'info', ttl = 2600) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts')?.appendChild(el);
    setTimeout(() => el.remove(), ttl);
    if (navigator.vibrate && this.getSettings().haptics) navigator.vibrate(kind === 'alert' ? [30, 40, 30] : 18);
  }

  /* boot console ---------------------------------------------------- */

  bootLine(text, kind = '') {
    const box = $('boot-lines');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = text;
    if (kind) line.className = kind;
    box.appendChild(line);
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
    const ring = $('boot-ring-fg');
    if (ring) ring.style.strokeDashoffset = String(327 * (1 - clamp01(pct)));
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
