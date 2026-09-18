/**
 * ui.js — heads-up display and control surfaces.
 *
 * The HUD is drawn on a canvas over the camera feed at display refresh rate,
 * independently of inference, so brackets glide instead of stuttering at the
 * detector's 8 Hz. Three styles are provided and the differences are deliberate:
 *
 *   standard  full AR overlay — brackets, chips, radar, list
 *   glasses   larger type, thicker strokes, fewer elements: for a display a few
 *             centimetres from the eye, where density reads as noise
 *   minimal   brackets and speech only
 *   debug     everything, including timings and per-object model output
 *
 * Every panel is a bottom sheet so the interface works one-handed on a phone
 * and voice-first on glasses.
 */

import { categoryColour, formatDistance, bearingWord } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */

export class Hud {
  constructor({ canvas, video, getSettings, onSelect = null, onCapture = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.getSettings = getSettings;
    this.onSelect = onSelect;
    this.onCapture = onCapture;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.lastFrame = null;
    this._sweep = 0;
    this._toasts = [];
    this._tickerLines = [];
    this._flashUntil = 0;
    this._lastTickerSet = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this._bindDom();
    requestAnimationFrame((t) => this._loop(t));
  }

  get style() { return this.getSettings().hudStyle || 'standard'; }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.width = w;
    this.height = h;
    const radar = $('radar');
    if (radar) {
      const dpr = this.dpr;
      radar.width = 220 * dpr / 2;
      radar.height = 220 * dpr / 2;
      this.radarCtx = radar.getContext('2d');
    }
  }

  /** Map frame pixels → display pixels with the same cover maths the video uses. */
  coverTransform(frameW, frameH) {
    const scale = Math.max(this.width / frameW, this.height / frameH);
    const dispW = frameW * scale;
    const dispH = frameH * scale;
    return { scale, offsetX: (this.width - dispW) / 2, offsetY: (this.height - dispH) / 2, dispW, dispH };
  }

  /* ---------------------------------------------------------------- *
   * Frame loop — HUD renders every animation frame regardless of model rate
   * ---------------------------------------------------------------- */

  _loop(t) {
    this._sweep = t;
    if (this.lastFrame) this.render(this.lastFrame);
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

    if (s.showReticle) this._reticle(ctx, state, t);
    if (state.paused) this._pausedBadge(ctx);

    const records = (state.records || []).filter((r) => r.box && !r.synthetic);
    const drawable = records
      .map((r) => ({ record: r, box: [px(r.box[0]), py(r.box[1]), px(r.box[2]), py(r.box[3])] }))
      .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));

    const display = this.style === 'glasses' ? drawable.slice(0, 4) : drawable.slice(0, 14);

    // Pose skeletons and hands first, so brackets sit on top of them.
    for (const { record } of display) {
      if (record.pose) this._skeleton(ctx, record.pose, px, py);
      if (record.hands) for (const hand of record.hands) this._hand(ctx, hand, px, py);
    }
    // Text regions from the OCR pass.
    for (const line of (state.texts || [])) this._textBox(ctx, line, px, py, scale);

    for (const { record, box } of display) {
      this._bracket(ctx, record, box, scale, state);
    }

    this._edges(ctx, state);
    if (state.lockedId) this._lockLink(ctx, display, state.lockedId);
    if (this._flashUntil > performance.now()) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 * (1 - (performance.now() - (this._flashUntil - 180)) / 180)})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    this._syncDom(state);
    if (s.showRadar && this.radarCtx) this._radar(state);
  }

  /* ---------------------------------------------------------------- *
   * Elements
   * ---------------------------------------------------------------- */

  _reticle(ctx, state, t) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const r = state.lockedId ? 26 : 20;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,.55)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * (r + 4), cy + dy * (r + 4));
      ctx.lineTo(cx + dx * (r + 11), cy + dy * (r + 11));
    }
    ctx.stroke();
    // Slow sweep arc, purely a "working" indicator.
    ctx.strokeStyle = 'var(--accent)';
    ctx.strokeStyle = state.paused ? 'rgba(255,180,71,.6)' : 'rgba(76,224,255,.65)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const a0 = ((t / 900) % (Math.PI * 2));
    ctx.arc(cx, cy, r + 7, a0, a0 + 0.7);
    ctx.stroke();
    ctx.restore();
  }

  _pausedBadge(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(0, this.height / 2 - 16, this.width, 32);
    ctx.fillStyle = '#ffb347';
    ctx.font = '600 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('OPTICS PAUSED', this.width / 2, this.height / 2 + 5);
    ctx.restore();
  }

  _edges(ctx, state) {
    const s = this.getSettings();
    if (!s.showBoxes) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(76,224,255,.35)';
    ctx.lineWidth = 1;
    const L = 16;
    const pad = 6;
    const corners = [[pad, pad, 1, 1], [this.width - pad, pad, -1, 1], [pad, this.height - pad, 1, -1], [this.width - pad, this.height - pad, -1, -1]];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + sx * L, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * L);
      ctx.stroke();
    }
    ctx.restore();
  }

  _bracket(ctx, record, box, scale, state) {
    const s = this.getSettings();
    const locked = record.id === state.lockedId;
    const colour = categoryColour(record.category) || '#c9d4e4';
    const x = Math.min(box[0], box[2]);
    const y = Math.min(box[1], box[3]);
    const w = Math.abs(box[2] - box[0]);
    const h = Math.abs(box[3] - box[1]);
    const len = Math.max(8, Math.min(26, Math.min(w, h) * 0.28));

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = (locked ? 2.4 : 1.5) * (this.style === 'standard' || this.style === 'minimal' ? 1 : scale * 0.85);
    ctx.shadowColor = colour;
    ctx.shadowBlur = locked ? 12 : 4;
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
    if (locked) {
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    ctx.shadowBlur = 0;

    if (s.showLabels) {
      const label = record.label || record.noun || record.cls;
      const conf = s.showConfidence ? ` ${Math.round((record.confidence || 0) * 100)}%` : '';
      const lines = [];
      lines.push({ text: `${label.toUpperCase()}${conf}`, kind: 'title' });
      const attr = this._attrLine(record);
      if (s.showAttributes && attr) lines.push({ text: attr, kind: 'attr', colour: record.attributes?.colour?.hex });
      if (s.showDistance && record.distance?.metres) {
        lines.push({ text: `${formatDistance(record.distance.metres, s.units)} · ${bearingWord(record.distance.bearing)}`, kind: 'meta' });
      }
      if (record.text && this.style !== 'glasses') lines.push({ text: `“${record.text}”`, kind: 'text' });
      if (record.hazard && this.style !== 'glasses') lines.push({ text: (record.hazard.note || record.hazard.kind).toUpperCase(), kind: 'hazard' });
      if (record.taught) lines.push({ text: `TAUGHT ${Math.round(record.taught.score * 100)}%`, kind: 'good' });
      if (this.style === 'debug') {
        lines.push({ text: `#${record.id} ${record.source} hits=${record.hits} age=${(record.age / 1000).toFixed(1)}s`, kind: 'meta' });
        if (record.classifier?.length) lines.push({ text: record.classifier.slice(0, 3).map((t) => `${t.name} ${Math.round(t.prob * 100)}`).join(' · '), kind: 'meta' });
      }

      const fontTitle = 11.5 * (this.style === 'glasses' ? 1.25 : 1);
      const fontBody = 10 * (this.style === 'glasses' ? 1.3 : 1);
      ctx.textBaseline = 'top';
      ctx.font = `600 ${fontTitle}px ui-monospace, monospace`;
      const widest = Math.max(...lines.map((l) => {
        ctx.font = l.kind === 'title' ? `600 ${fontTitle}px ui-monospace, monospace` : `400 ${fontBody}px ui-monospace, monospace`;
        return ctx.measureText(l.text).width;
      }));
      const padX = 7;
      const lineH = fontTitle + 4;
      const boxW = widest + padX * 2;
      const boxH = lines.length * lineH + 6;
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

      let ty = by + 4;
      for (const line of lines) {
        if (line.kind === 'title') {
          ctx.font = `600 ${fontTitle}px ui-monospace, monospace`;
          ctx.fillStyle = colour;
        } else if (line.kind === 'hazard') {
          ctx.font = `600 ${fontBody}px ui-monospace, monospace`;
          ctx.fillStyle = '#ff5b5b';
        } else if (line.kind === 'good') {
          ctx.font = `400 ${fontBody}px ui-monospace, monospace`;
          ctx.fillStyle = '#6dff9b';
        } else if (line.kind === 'text') {
          ctx.font = `italic 400 ${fontBody}px ui-monospace, monospace`;
          ctx.fillStyle = 'rgba(223,246,255,.9)';
        } else {
          ctx.font = `400 ${fontBody}px ui-monospace, monospace`;
          ctx.fillStyle = 'rgba(223,246,255,.78)';
        }
        let tx = bx + padX;
        if (line.kind === 'attr' && line.colour) {
          ctx.fillStyle = line.colour;
          ctx.fillRect(tx, ty + 3, 8, 8);
          ctx.strokeStyle = 'rgba(255,255,255,.4)';
          ctx.strokeRect(tx, ty + 3, 8, 8);
          tx += 12;
          ctx.fillStyle = 'rgba(223,246,255,.86)';
        }
        ctx.fillText(line.text, tx, ty);
        ty += lineH;
      }
    }
    ctx.restore();
  }

  _attrLine(record) {
    const bits = [];
    const attrs = record.attributes;
    if (attrs?.colour?.name) bits.push(attrs.colour.name);
    if (attrs?.finish && attrs.finish !== 'matte') bits.push(attrs.finish);
    if (attrs?.material && attrs.material.confidence > 0.3) bits.push(attrs.material.name);
    if (attrs?.pattern && !['solid', 'textured'].includes(attrs.pattern.id)) bits.push(attrs.pattern.label);
    if (attrs?.shape?.form && attrs.shape.form !== 'blocky') bits.push(attrs.shape.form);
    if (record.brand?.name) bits.push(record.brand.name);
    if (record.gesture) bits.push(record.gesture);
    if (record.posture && record.posture !== 'unknown') bits.push(record.posture);
    return bits.join(' · ');
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
    const s = this.getSettings();
    if (!s.showLabels) return;
    const q = line.quad;
    if (!q) return;
    ctx.save();
    ctx.strokeStyle = line.sign ? 'rgba(255,140,140,.75)' : 'rgba(180,220,255,.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px(q[0][0]), py(q[0][1]));
    for (let i = 1; i < q.length; i++) ctx.lineTo(px(q[i][0]), py(q[i][1]));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (this.style !== 'standard' && this.style !== 'debug') { ctx.restore(); return; }
    ctx.font = `400 ${9.5 * scale}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(223,246,255,.85)';
    const x = px(q[0][0]);
    const y = py(q[0][1]) - 3;
    ctx.fillText(line.text, x, y);
    ctx.restore();
  }

  _lockLink(ctx, display, lockedId) {
    const entry = display.find((d) => d.record.id === lockedId);
    if (!entry) return;
    const cx = (entry.box[0] + entry.box[2]) / 2;
    const cy = (entry.box[1] + entry.box[3]) / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(76,224,255,.35)';
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(this.width / 2, this.height / 2);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.restore();
  }

  _radar(state) {
    const ctx = this.radarCtx;
    const w = 110;
    const h = 110;
    ctx.setTransform(this.dpr / 2, 0, 0, this.dpr / 2, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = this.getSettings();
    const cx = w / 2;
    const cy = h - 8;
    ctx.save();
    ctx.strokeStyle = 'rgba(76,224,255,.28)';
    ctx.lineWidth = 1;
    for (const r of [22, 44, 66]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, 0);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 74);
    ctx.stroke();
    for (const record of (state.records || [])) {
      if (!record.distance || record.distance.metres == null) continue;
      const bearing = Math.max(-45, Math.min(45, record.distance.bearing));
      const dist = Math.min(1, record.distance.metres / 12);
      const angle = (bearing * Math.PI) / 180;
      const r = 14 + dist * 60;
      const x = cx + Math.sin(angle) * r;
      const y = cy - Math.cos(angle) * r;
      ctx.fillStyle = categoryColour(record.category) || '#c9d4e4';
      ctx.beginPath();
      ctx.arc(x, y, record.hazard ? 3.4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
      if (record.id === state.lockedId) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.beginPath();
        ctx.arc(x, y, 5.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * DOM surfaces
   * ---------------------------------------------------------------- */

  _syncDom(state) {
    const s = this.getSettings();
    const tlm = {
      'tlm-fps': `${Math.round(state.fps || 0)} fps`,
      'tlm-lat': `${state.timing?.detect ?? 0} ms`,
      'tlm-scan': `${state.scanSize || 0} px`,
      'tlm-ep': state.backend || '—',
      'tlm-batt': state.battery || '—'
    };
    for (const [id, text] of Object.entries(tlm)) {
      const el = $(id);
      if (el && el.textContent !== text) el.textContent = text;
    }

    const sceneLabel = $('scene-label');
    if (sceneLabel) sceneLabel.textContent = state.scene?.label ? state.scene.label : 'scanning';
    const sceneSub = $('scene-sub');
    if (sceneSub) {
      const l = state.lighting;
      sceneSub.textContent = l ? `${l.key} · ${l.kelvin}K · ${Math.round(l.brightness * 100)}% light` : '—';
    }
    const sceneText = $('scene-text');
    if (sceneText) {
      const text = (state.texts || []).slice(0, 2).map((t) => t.text).join(' · ');
      sceneText.textContent = text ? `“${text}”` : '';
    }

    const chips = $('module-chips');
    if (chips) {
      const modules = state.modules || {};
      const wanted = [['DET', modules.detector], ['1K', modules.classifier], ['OCR', modules.ocr], ['POSE', modules.pose], ['HAND', modules.hands], ['MEM', (state.memorySummary?.taught || 0) > 0]];
      if (chips.childElementCount !== wanted.length) {
        chips.innerHTML = wanted.map(([name]) => `<span data-m="${name}">${name}</span>`).join('');
      }
      [...chips.children].forEach((el, i) => {
        const on = wanted[i][1];
        el.className = on ? 'on' : 'off';
      });
    }

    // Object list (hidden in glasses and minimal styles by CSS).
    const list = $('tracklist');
    if (list && this.style !== 'minimal') {
      const rows = (state.records || []).slice(0, 8).map((r) => {
        const colour = categoryColour(r.category);
        const meta = [
          r.attributes?.colour?.name,
          r.attributes?.material?.confidence > 0.3 ? r.attributes.material.name : null,
          r.distance?.metres ? formatDistance(r.distance.metres, s.units) : null,
          r.accuracyHint || null
        ].filter(Boolean).join(' · ');
        return `<div class="track-row${(r.id === state.lockedId) ? ' sel' : ''}" data-id="${r.id}">
          <span class="dot" style="background:${colour}"></span>
          <span><span class="label">${escapeHtml(r.label)}</span><br><span class="meta">${escapeHtml(meta)}</span></span>
          <span class="meta">${Math.round((r.confidence || 0) * 100)}%</span>
        </div>`;
      }).join('');
      if (list.dataset.sig !== rows) {
        list.dataset.sig = rows;
        list.innerHTML = rows;
        list.querySelectorAll('[data-id]').forEach((el) => {
          el.addEventListener('click', () => this.onSelect?.(Number(el.dataset.id)));
        });
      }
    }

    const ticker = $('ticker');
    if (ticker && s.showTicker) {
      const now = performance.now();
      if (now - this._lastTickerSet > 900) {
        this._lastTickerSet = now;
        const line = state.tickerLine || state.lastSpoken || '';
        if (line && ticker.textContent !== line) ticker.textContent = line;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Imperative bits
   * ---------------------------------------------------------------- */

  toast(text, kind = 'info', ttl = 2600) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts')?.appendChild(el);
    setTimeout(() => el.remove(), ttl);
    if (navigator.vibrate && this.getSettings().haptics) navigator.vibrate(kind === 'alert' ? [30, 40, 30] : 18);
  }

  subtitle(text) {
    const el = $('subtitle');
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    clearTimeout(this._subTimer);
    this._subTimer = setTimeout(() => { el.hidden = true; }, Math.max(2600, text.length * 62));
  }

  logLine(text, kind = 'sys') {
    const log = $('console-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = kind;
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    line.textContent = `${stamp}  ${text}`;
    log.appendChild(line);
    while (log.childElementCount > 400) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  flash() {
    this._flashUntil = performance.now() + 180;
  }

  addToFilmstrip(dataUrl, stamp) {
    const strip = $('filmstrip');
    if (!strip) return;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = stamp;
    img.addEventListener('click', () => this.openPhoto(dataUrl, stamp));
    strip.appendChild(img);
    while (strip.childElementCount > 4) strip.firstChild.remove();
  }

  openPhoto(dataUrl, stamp) {
    $('photo-img').src = dataUrl;
    $('photo-stamp').textContent = stamp;
    $('photo-dl').href = dataUrl;
    this.openModal('photo-modal');
  }

  openModal(id) { $(id)?.classList.add('open'); }
  closeModal(id) { $(id)?.classList.remove('open'); }

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
    const stage = $('boot-stage');
    if (stage) stage.textContent = text;
    const bar = $('boot-pct');
    if (bar) bar.style.width = `${Math.round(clamp01(pct) * 100)}%`;
    const ring = $('boot-ring-fg');
    if (ring) ring.style.strokeDashoffset = String(327 * (1 - clamp01(pct)));
  }

  bootReady(detail = '') {
    this.setBootStage('ONLINE', 1);
    if (detail) this.bootLine(detail, 'ok');
  }

  bootError(headline, detail = '') {
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
    const box = $('boot-error');
    if (box) box.hidden = true;
  }

  hideBoot() {
    const boot = $('boot');
    if (boot) {
      boot.style.transition = 'opacity .35s ease';
      boot.style.opacity = '0';
      setTimeout(() => { boot.hidden = true; }, 380);
    }
    const stage = $('stage');
    if (stage) stage.hidden = false;
  }

  showBoot() {
    const boot = $('boot');
    if (boot) { boot.hidden = false; boot.style.opacity = '1'; }
    $('stage').hidden = true;
  }

  setInstall(snapshot, guide) {
    const panel = $('install-panel');
    if (!panel) return;
    const state = snapshot?.installed ? 'Installed' : snapshot?.canInstall ? 'Ready to install' : 'Not installed';
    const steps = (guide?.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    panel.innerHTML = `
      <div class="state">${escapeHtml(state)}${snapshot?.display ? ` · ${escapeHtml(snapshot.display)}` : ''}</div>
      ${steps ? `<ol>${steps}</ol>` : ''}
      ${snapshot?.canInstall ? '<button class="btn" id="install-btn">Install ARGUS</button>' : ''}
    `;
    const btn = $('install-btn');
    if (btn) btn.addEventListener('click', () => snapshot.prompt?.());
  }

  _bindDom() {
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => this.closeModal(el.dataset.close));
    });
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ *
 * Settings sheet
 * ------------------------------------------------------------------ */

/**
 * Wire every control in the settings sheet. Handlers receive the mutated
 * settings object plus the field name, so the app can react to just the things
 * that need a reload.
 */
export function bindSettingsSheet(settings, { onChange = () => {}, onTheme = () => {}, onAction = () => {} } = {}) {
  const set = (key, value) => {
    settings[key] = value;
    onChange(key, value);
  };

  const bind = (id, key, { type = 'checkbox', transform = (v) => v } = {}) => {
    const el = $(id);
    if (!el) return;
    if (type === 'checkbox') {
      el.checked = !!settings[key];
      el.addEventListener('change', () => set(key, el.checked));
    } else if (type === 'number') {
      el.value = settings[key];
      el.addEventListener('input', () => set(key, Number(el.value)));
      el.addEventListener('change', () => set(key, Number(el.value)));
    } else if (type === 'select') {
      el.value = String(settings[key]);
      el.addEventListener('change', () => set(key, transform(el.value)));
    } else {
      el.value = settings[key] ?? '';
      el.addEventListener('change', () => set(key, transform(el.value)));
      el.addEventListener('input', () => { if (key === 'address') set(key, el.value); });
    }
  };

  // interface
  const themeSelect = $('set-theme');
  if (themeSelect) {
    themeSelect.innerHTML = Object.entries(THEME_OPTIONS)
      .map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
    themeSelect.value = settings.theme;
    themeSelect.addEventListener('change', () => { onTheme(themeSelect.value); });
  }
  bind('set-hud', 'hudStyle', { type: 'select', transform: (v) => v });
  bind('set-units', 'units', { type: 'select' });
  bind('set-boxes', 'showBoxes');
  bind('set-labels', 'showLabels');
  bind('set-attrs', 'showAttributes');
  bind('set-distance', 'showDistance');
  bind('set-radar', 'showRadar');
  bind('set-reticle', 'showReticle');
  bind('set-scene', 'showScene');
  bind('set-ticker', 'showTicker');
  bind('set-subtitles', 'subtitles');
  bind('set-mirror', 'mirrorFront');
  bind('set-haptics', 'haptics');

  // detection
  bind('set-conf', 'minConfidence', { type: 'number' });
  bind('set-scan', 'scanSize', { type: 'select', transform: (v) => Number(v) });
  bind('set-detail', 'detailMode', { type: 'select' });
  bind('set-adaptive', 'adaptive');
  const gpu = $('set-backend-gpu');
  if (gpu) {
    gpu.checked = settings.backend !== 'wasm';
    gpu.addEventListener('change', () => set('backend', gpu.checked ? 'auto' : 'wasm'));
  }

  // perception
  bind('set-cls', 'moduleClassifier');
  bind('set-ocr', 'moduleOcr');
  bind('set-pose', 'modulePose');
  bind('set-hands', 'moduleHands');
  bind('set-clsrate', 'classifyEvery', { type: 'number' });
  bind('set-ocrrate', 'ocrEvery', { type: 'number' });
  bind('set-fov', 'fovHorizontal', { type: 'number' });

  // assistant
  bind('set-address', 'address', { type: 'text', transform: (v) => v || 'sir' });
  bind('set-narration', 'narration', { type: 'select' });
  bind('set-tier', 'minTierToSpeak', { type: 'select', transform: (v) => Number(v) });
  bind('set-voice', 'voiceEnabled');
  bind('set-hazard', 'hazardAlerts');
  bind('set-brands', 'narrateBrands');
  bind('set-materials', 'narrateMaterials');
  bind('set-narrdist', 'narrateDistance');
  bind('set-voicecmd', 'voiceCommands');
  bind('set-voiceuri', 'voiceURI', { type: 'select' });
  bind('set-rate', 'voiceRate', { type: 'number' });
  bind('set-pitch', 'voicePitch', { type: 'number' });

  $('set-reset')?.addEventListener('click', () => onAction('reset'));
  $('set-diagnostics')?.addEventListener('click', () => onAction('diagnostics'));

  return {
    sync() {
      for (const [id, key] of Object.entries({
        'set-hud': 'hudStyle', 'set-units': 'units', 'set-conf': 'minConfidence', 'set-scan': 'scanSize',
        'set-detail': 'detailMode', 'set-address': 'address', 'set-narration': 'narration',
        'set-tier': 'minTierToSpeak', 'set-rate': 'voiceRate', 'set-pitch': 'voicePitch', 'set-fov': 'fovHorizontal',
        'set-clsrate': 'classifyEvery', 'set-ocrrate': 'ocrEvery'
      })) { const el = $(id); if (el) el.value = String(settings[key]); }
      const checks = {
        'set-boxes': 'showBoxes', 'set-labels': 'showLabels', 'set-attrs': 'showAttributes',
        'set-distance': 'showDistance', 'set-radar': 'showRadar', 'set-reticle': 'showReticle',
        'set-scene': 'showScene', 'set-ticker': 'showTicker', 'set-subtitles': 'subtitles',
        'set-mirror': 'mirrorFront', 'set-haptics': 'haptics', 'set-adaptive': 'adaptive',
        'set-cls': 'moduleClassifier', 'set-ocr': 'moduleOcr', 'set-pose': 'modulePose', 'set-hands': 'moduleHands',
        'set-voice': 'voiceEnabled', 'set-hazard': 'hazardAlerts', 'set-brands': 'narrateBrands',
        'set-materials': 'narrateMaterials', 'set-narrdist': 'narrateDistance', 'set-voicecmd': 'voiceCommands'
      };
      for (const [id, key] of Object.entries(checks)) { const el = $(id); if (el) el.checked = !!settings[key]; }
      const gpuEl = $('set-backend-gpu');
      if (gpuEl) gpuEl.checked = settings.backend !== 'wasm';
      const themeEl = $('set-theme');
      if (themeEl) themeEl.value = settings.theme;
    }
  };
}

const THEME_OPTIONS = {
  arc: 'ARC — cyan', mark7: 'MARK VII — amber', ghost: 'GHOST — white',
  matrix: 'GREEN — matrix', amber: 'AMBER HUD — orange', ice: 'ICE — pale blue'
};
