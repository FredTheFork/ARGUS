/**
 * ui.js — the heads-up display.
 *
 * Draws the AR overlay (target brackets, tracking vectors, reticle, sweep)
 * on a transparent canvas stacked over the camera feed, and owns the DOM
 * chrome: telemetry blocks, subtitles, toasts, filmstrip, boot sequence,
 * modals and the settings sheet.
 */

import { CATEGORIES, CLASS_META, THEMES, VERSION, clamp } from './config.js';

const $ = (id) => document.getElementById(id);

export function proximityOf(area) {
  if (area > 0.22) return 'NEAR';
  if (area > 0.07) return 'MID';
  return 'FAR';
}

export class Hud {
  constructor({ canvas, video, getSettings, onCapture = null }) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.getSettings = getSettings;
    this.accent = THEMES.arc.accent;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.tracks = [];
    this.lockedId = null;
    this.mirrored = false;
    this.sweep = null;
    this.sweepStarted = 0;
    this.flashUntil = 0;
    this._telemetryClock = 0;
    this._subtitleTimer = 0;
    this._lastFrame = performance.now();
    this._fpsEma = 0;
    this._bootPct = 0;
    this.onCapture = onCapture || (() => {});
    this._bindDom();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.resize());
  }

  setTheme(themeKey) {
    const theme = THEMES[themeKey] || THEMES.arc;
    this.accent = theme.accent;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /**
   * object-fit: cover mapping — source frame pixels to overlay CSS pixels.
   * @returns {{scale:number, ox:number, oy:number}} x_screen = x*scale + ox
   */
  coverTransform(frameW, frameH) {
    const fw = frameW || this.w;
    const fh = frameH || this.h;
    const scale = Math.max(this.w / fw, this.h / fh);
    return { scale, ox: (this.w - fw * scale) / 2, oy: (this.h - fh * scale) / 2 };
  }

  /* -------------------------------------------------------------- *
   * Per-frame draw
   * -------------------------------------------------------------- */
  render(state) {
    const t = performance.now();
    const dt = t - this._lastFrame;
    this._lastFrame = t;
    if (dt > 0 && dt < 500) this._fpsEma = this._fpsEma ? this._fpsEma * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;

    const s = this.getSettings();
    const ctx = this.ctx;
    const { tracks = [], lockedId = null, mirrored = false } = state;
    this.tracks = tracks;
    this.lockedId = lockedId;
    this.mirrored = mirrored;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (mirrored) { ctx.translate(this.w, 0); ctx.scale(-1, 1); }

    // The <video> is painted with object-fit: cover, so map source frame pixels
    // through the same "cover" transform before drawing the overlay.
    const { scale, ox, oy } = this.coverTransform(state.frameW, state.frameH);

    if (s.showHud) {
      this._drawFrameEdges(ctx, t);
      if (s.showReticle) this._drawReticle(ctx, t);
    }
    if (this.sweep) this._drawSweep(ctx, t - this.sweepStarted);

    if (s.showBoxes) {
      const ordered = [...tracks].sort((a, b) => (a.id === lockedId ? 1 : 0) - (b.id === lockedId ? 1 : 0));
      const drawable = [];
      for (const track of ordered) {
        const box = [
          track.box[0] * scale + ox, track.box[1] * scale + oy,
          track.box[2] * scale + ox, track.box[3] * scale + oy
        ];
        // Nothing useful to draw for an object entirely outside the viewport.
        if (box[2] < 0 || box[0] > this.w || box[3] < 0 || box[1] > this.h) continue;
        drawable.push({ track, box, locked: track.id === lockedId });
      }
      const chips = this._planChips(drawable, s);
      for (const item of drawable) {
        this._drawTrack(ctx, item.track, item.box, s, t, item.locked, chips.get(item.track.id));
      }
    }
    if (s.showHud) this._drawCrosshairLink(ctx, { scale, ox, oy }, lockedId, t);

    this._syncDom(state, t);
  }

  _drawFrameEdges(ctx, t) {
    const a = this.accent;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = a;
    ctx.lineWidth = 1;
    const pad = 10;
    const len = 26;
    const corners = [[pad, pad, 1, 1], [this.w - pad, pad, -1, 1], [pad, this.h - pad, 1, -1], [this.w - pad, this.h - pad, -1, -1]];
    for (const [x, y, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + dx * len, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * len);
      ctx.stroke();
    }
    // edge rulers: 10% ticks
    ctx.globalAlpha = 0.22;
    const tick = (x, y, hx, hy) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + hx, y + hy); ctx.stroke(); };
    for (let i = 1; i < 10; i++) {
      const x = (this.w * i) / 10;
      const y = (this.h * i) / 10;
      tick(x, pad, 0, i % 5 === 0 ? 9 : 5);
      tick(x, this.h - pad, 0, i % 5 === 0 ? -9 : -5);
      tick(pad, y, i % 5 === 0 ? 9 : 5, 0);
      tick(this.w - pad, y, i % 5 === 0 ? -9 : -5, 0);
    }
    ctx.restore();
    void t;
  }

  _drawReticle(ctx, t) {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const pulse = 0.55 + 0.25 * Math.sin(t / 620);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = this.accent;
    ctx.globalAlpha = pulse * 0.8;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(0, 0, 34, -0.5, 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 34, Math.PI - 0.5, Math.PI + 0.5); ctx.stroke();
    ctx.globalAlpha = pulse;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath();
      ctx.moveTo(dx * 24, dy * 24); ctx.lineTo(dx * 40, dy * 40);
      ctx.stroke();
    }
    // rotating outer index marks
    ctx.globalAlpha = 0.35;
    ctx.save();
    ctx.rotate((t / 5200) % (Math.PI * 2));
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(0, -46); ctx.lineTo(0, i % 3 === 0 ? -54 : -50);
      ctx.stroke();
      ctx.rotate(Math.PI / 6);
    }
    ctx.restore();
    ctx.restore();
  }

  _drawSweep(ctx, elapsed) {
    const dur = 2200;
    const p = clamp(elapsed / dur, 0, 1);
    if (p >= 1) { this.sweep = null; return; }
    const y = this.h * p;
    const grad = ctx.createLinearGradient(0, y - 60, 0, y + 60);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, this.accent);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalAlpha = 0.22 * (1 - Math.abs(p - 0.5) * 2 + 0.4);
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 60, this.w, 120);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
    ctx.restore();
  }

  /** The text shown on an object's chip — shared by the planner and the renderer. */
  _labelFor(track, locked, s) {
    const meta = CLASS_META[track.cls] || { display: track.cls.toUpperCase() };
    const bits = [meta.display];
    if (s.showConfidence) bits.push(`${(track.score * 100).toFixed(0)}%`);
    if (s.showProximity) bits.push(proximityOf(track.area || 0));
    if (locked) bits.unshift('LOCKED');
    return bits.join('  ');
  }

  /**
   * Reserve a slot for every label chip, nudging overlapping ones upward (or
   * below their box when there is no room). Crowded street scenes otherwise
   * stack several chips on top of each other.
   */
  _planChips(drawable, s) {
    const out = new Map();
    if (!s.showLabels) return out;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const used = [];
    for (const item of drawable) {
      const w = ctx.measureText(this._labelFor(item.track, item.locked, s)).width + 14;
      const h = 17;
      let x = clamp(item.box[0], 4, Math.max(4, this.w - w - 4));
      let y = clamp(item.box[1] - h - 3, 4, this.h - h - 4);
      let guard = 0;
      const hits = (yy) => used.some((r) => !(x + w < r.x || x > r.x + r.w || yy + h < r.y || yy > r.y + r.h));
      while (hits(y) && guard++ < 10) {
        const up = y - h - 2;
        if (up < 4) { y = clamp(item.box[1] + 3, 4, this.h - h - 4); break; }
        y = up;
      }
      const rect = { x, y, w, h };
      used.push(rect);
      out.set(item.track.id, rect);
    }
    ctx.restore();
    return out;
  }

  _drawTrack(ctx, track, box, s, t, locked, chip) {
    const [x1, y1, x2, y2] = box;
    const w = x2 - x1;
    const h = y2 - y1;
    const meta = CLASS_META[track.cls] || { display: track.cls.toUpperCase(), colour: this.accent, category: 'kit' };
    const category = CATEGORIES[meta.category] || { label: 'OBJECT', colour: this.accent };

    // Acquire animation: brackets fly in over ~280 ms.
    if (!track.acquireT) track.acquireT = t;
    const grow = clamp((t - track.acquireT) / 280, 0, 1);
    const ease = 1 - Math.pow(1 - grow, 3);
    const inset = (1 - ease) * 18;

    const colour = locked ? this.accent : category.colour;
    const lw = locked ? 2.6 : 1.6;
    const segX = clamp(w * 0.3, 12, 46);
    const segY = clamp(h * 0.3, 12, 46);

    ctx.save();
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = colour;
    ctx.lineWidth = lw;
    if (locked) { ctx.shadowColor = colour; ctx.shadowBlur = 14; }
    ctx.globalAlpha = locked ? 1 : 0.95;

    const bx1 = x1 + inset, by1 = y1 + inset, bx2 = x2 - inset, by2 = y2 - inset;
    const corners = [
      [bx1, by1, 1, 1], [bx2, by1, -1, 1], [bx1, by2, 1, -1], [bx2, by2, -1, -1]
    ];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * segX, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * segY);
      ctx.stroke();
    }
    // faint full perimeter
    ctx.globalAlpha = locked ? 0.32 : 0.16;
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.strokeRect(bx1, by1, Math.max(0, bx2 - bx1), Math.max(0, by2 - by1));
    ctx.setLineDash([]);

    // tracking vector: centre of mass drift
    if (track.prev) {
      const pcx = (track.prev[0] + track.prev[2]) / 2;
      const pcy = (track.prev[1] + track.prev[3]) / 2;
      const dx = (x1 + x2) / 2 - pcx;
      const dy = (y1 + y2) / 2 - pcy;
      if (Math.hypot(dx, dy) > 6) {
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(pcx, pcy);
        ctx.lineTo(pcx + dx * 3.2, pcy + dy * 3.2);
        ctx.stroke();
      }
    }

    // lock ring around the centre
    if (locked) {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const r = Math.min(w, h) * 0.22 + 6;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((t / 900) % (Math.PI * 2));
      ctx.setLineDash([5, 7]);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
    }

    // label chip (positioned by _planChips so chips never collide)
    if (s.showLabels) {
      const label = this._labelFor(track, locked, s);
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const textW = ctx.measureText(label).width;
      const chipH = 17;
      const chipX = chip ? chip.x : clamp(x1, 4, Math.max(4, this.w - textW - 18));
      const chipY = chip ? chip.y : clamp(y1 - chipH - 3, 4, this.h - chipH - 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(3,9,15,.72)';
      ctx.fillRect(chipX, chipY, textW + 14, chipH);
      ctx.fillStyle = colour;
      ctx.fillRect(chipX, chipY, 3, chipH);
      ctx.globalAlpha = 0.92;
      ctx.fillText(label, chipX + 8, chipY + 12);
      if (s.showConfidence && !locked) {
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = colour;
        ctx.fillRect(x1, y2 + 2, Math.max(0, w) * clamp(track.score, 0, 1), 2);
      }
    }
    ctx.restore();
  }

  _drawCrosshairLink(ctx, tf, lockedId, t) {
    const locked = this.tracks.find((tr) => tr.id === lockedId);
    if (!locked) return;
    const cx = ((locked.box[0] + locked.box[2]) / 2) * tf.scale + tf.ox;
    const cy = ((locked.box[1] + locked.box[3]) / 2) * tf.scale + tf.oy;
    ctx.save();
    ctx.strokeStyle = this.accent;
    ctx.globalAlpha = 0.4 + 0.2 * Math.sin(t / 300);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(this.w / 2, this.h / 2);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.restore();
  }

  /* -------------------------------------------------------------- *
   * DOM synchronisation
   * -------------------------------------------------------------- */
  _syncDom(state, t) {
    const s = this.getSettings();
    if (t - this._telemetryClock < 150) return;
    this._telemetryClock = t;
    const fps = state.fps !== undefined ? state.fps : this._fpsEma;
    const set = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
    set('tlm-fps', `${fps.toFixed(0).padStart(2, '0')} FPS`);
    set('tlm-lat', `${(state.inferMs || 0).toFixed(0)} MS`);
    set('tlm-scan', `${state.dims ? `${state.dims.w}×${state.dims.h}` : '—'}`);
    set('tlm-ep', (state.backend || 'idle').toUpperCase());
    set('tlm-model', 'YOLOv8N');
    set('stat-obj', String(this.tracks.length));
    set('stat-cats', String(new Set(this.tracks.map((tr) => tr.cls)).size));
    const locked = this.tracks.find((tr) => tr.id === this.lockedId);
    set('stat-lock', locked ? (CLASS_META[locked.cls] ? CLASS_META[locked.cls].display : locked.cls.toUpperCase()) : 'NONE');
    set('stat-batt', state.battery || '—');
    document.body.classList.toggle('no-hud', !s.showHud);
    this._renderTrackList();
  }

  _renderTrackList() {
    const list = $('tracklist');
    if (!list) return;
    const rows = [...this.tracks]
      .sort((a, b) => b.score * (b.area || 0) - a.score * (a.area || 0))
      .slice(0, 5);
    const html = rows.map((tr) => {
      const meta = CLASS_META[tr.cls] || { display: tr.cls.toUpperCase(), colour: this.accent };
      const prox = proximityOf(tr.area || 0);
      const pct = Math.round(tr.score * 100);
      return `<li${tr.id === this.lockedId ? ' class="locked"' : ''}>
        <i style="background:${meta.colour}"></i>
        <span class="nm">${meta.display}</span>
        <span class="px">${prox}</span>
        <span class="bar"><b style="width:${pct}%;background:${meta.colour}"></b></span>
        <span class="pc">${pct}</span></li>`;
    }).join('');
    if (list.dataset.sig !== html) { list.dataset.sig = html; list.innerHTML = html; }
  }

  /* -------------------------------------------------------------- *
   * Chrome: toasts, subtitles, filmstrip
   * -------------------------------------------------------------- */
  toast(text, kind = 'info', ttl = 2600) {
    const host = $('toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      setTimeout(() => el.remove(), 320);
    }, ttl);
    while (host.children.length > 4) host.firstChild.remove();
  }

  logLine(text, kind = 'sys') {
    const host = $('console-log');
    if (!host) return;
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const el = document.createElement('div');
    el.className = `logline ${kind}`;
    el.innerHTML = `<time>${stamp}</time><span>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>`;
    host.appendChild(el);
    while (host.children.length > 60) host.firstChild.remove();
    host.scrollTop = host.scrollHeight;
  }

  subtitle(text) {
    if (!this.getSettings().subtitles) return;
    const el = $('subtitle');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._subtitleTimer);
    this._subtitleTimer = setTimeout(() => el.classList.remove('show'), Math.max(2200, text.length * 62));
  }

  flash() {
    const el = $('shutter');
    if (!el) return;
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
  }

  startSweep() {
    this.sweep = true;
    this.sweepStarted = performance.now();
  }

  addToFilmstrip(dataUrl, stamp) {
    const strip = $('filmstrip');
    if (!strip) return;
    const btn = document.createElement('button');
    btn.className = 'shot';
    btn.innerHTML = `<img src="${dataUrl}" alt="capture ${stamp}"><span>${stamp}</span>`;
    btn.addEventListener('click', () => this.openPhoto(dataUrl, stamp));
    strip.prepend(btn);
    while (strip.children.length > 8) strip.lastChild.remove();
  }

  openPhoto(dataUrl, stamp) {
    const modal = $('photo-modal');
    if (!modal) return;
    $('photo-img').src = dataUrl;
    $('photo-dl').href = dataUrl;
    $('photo-dl').download = `argus-${stamp}.png`;
    modal.classList.add('open');
  }

  closePhoto() {
    const modal = $('photo-modal');
    if (modal) modal.classList.remove('open');
  }

  /* -------------------------------------------------------------- *
   * Boot sequence + modals
   * -------------------------------------------------------------- */
  _bindDom() {
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-close');
        const target = $(id);
        if (target) target.classList.remove('open');
      });
    });
    document.querySelectorAll('.overlay[data-dismiss]').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('open'); });
    });
    const pill = $('version-pill');
    if (pill) pill.textContent = `v${VERSION}`;
  }

  bootLine(text, kind = '') {
    const host = $('boot-lines');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `bootline ${kind}`;
    el.textContent = text;
    host.appendChild(el);
    while (host.children.length > 7) host.firstChild.remove();
    host.scrollTop = host.scrollHeight;
  }

  setBootStage(text, pct) {
    this._bootPct = pct;
    const ring = $('boot-ring-fg');
    if (ring) {
      const r = 42;
      const c = 2 * Math.PI * r;
      ring.style.strokeDasharray = String(c);
      ring.style.strokeDashoffset = String(c * (1 - clamp(pct, 0, 1)));
    }
    const pctEl = $('boot-pct');
    if (pctEl) pctEl.textContent = `${Math.round(clamp(pct, 0, 1) * 100)}%`;
  }

  bootReady(detail) {
    const boot = $('boot');
    if (boot) boot.classList.remove('failed');
    const btn = $('engage');
    if (btn) { btn.disabled = false; btn.classList.add('ready'); btn.classList.remove('failed'); }
    const lbl = $('engage-label');
    if (lbl) lbl.textContent = 'ENGAGE OPTICS';
    const retry = $('boot-retry');
    if (retry) retry.classList.add('hidden');
    const el = $('boot-error');
    if (el) { el.classList.remove('show'); el.textContent = ''; }
    const d = $('boot-detail');
    if (d) d.textContent = detail || '';
    this.setBootStage('NEURAL CORE ONLINE', 1);
  }

  /**
   * Failure must be honest and actionable: the engage control is disabled,
   * stripped of its accent styling, relabelled, and the only lit control left
   * is RETRY NEURAL CORE (which re-runs the whole load, tiers and all).
   */
  bootError(headline, detail = '', { core = true, label = 'CORE OFFLINE' } = {}) {
    const el = $('boot-error');
    if (el) {
      el.textContent = '';
      const head = document.createElement('b');
      head.className = 'boot-error-head';
      head.textContent = headline;
      el.appendChild(head);
      if (detail) {
        const tech = document.createElement('span');
        tech.className = 'boot-error-detail';
        tech.textContent = detail;
        el.appendChild(tech);
      }
      if (core) {
        const hint = document.createElement('span');
        hint.className = 'boot-error-hint';
        hint.textContent = 'Tap RETRY NEURAL CORE for a fresh runtime and a clean attempt. Nothing leaves this device.';
        el.appendChild(hint);
      }
      el.classList.add('show');
    }
    const btn = $('engage');
    // The control must never look ready when it cannot do anything. Only a core
    // failure offers the retry button — a camera problem is not fixed by
    // re-downloading a runtime, it is fixed by permissions.
    if (btn) { btn.disabled = true; btn.classList.remove('ready'); btn.classList.add('failed'); }
    const lbl = $('engage-label');
    if (lbl) lbl.textContent = label;
    const retry = $('boot-retry');
    if (retry) retry.classList.toggle('hidden', !core);
    const boot = $('boot');
    if (boot) boot.classList.add('failed');
    const pct = $('boot-pct');
    if (pct) pct.textContent = core ? 'OFFLINE' : 'BLOCKED';
  }

  hideBootError() {
    const el = $('boot-error');
    if (el) { el.classList.remove('show'); el.textContent = ''; }
    const retry = $('boot-retry');
    if (retry) retry.classList.add('hidden');
    const btn = $('demo-fallback');
    if (btn) btn.classList.add('hidden');
  }

  /**
   * Render the installation surface. Three states, three different truths:
   * an installed app should stop being asked to install; a browser that raised
   * its own prompt gets a button that fires it; everything else gets the
   * platform's real route written out, because that is the only way it works.
   */
  setInstall(snapshot, guide) {
    const { mode, platform, secure } = snapshot;
    const btn = $('install-btn');
    const btnLabel = $('install-btn-label');
    const chip = $('install-chip');
    const settingsBtn = $('install-settings-btn');
    const state = $('install-state');
    const heading = $('install-heading');
    const note = $('install-note');
    const stepsHost = $('install-steps');
    const after = $('install-after');
    const meta = $('install-meta');

    // Boot screen: a button when we can install, a statement when we already are.
    if (btn) btn.classList.toggle('hidden', mode === 'installed' || !secure);
    if (btn) btn.classList.toggle('primary-ghost', mode === 'prompt-available');
    if (btnLabel) {
      btnLabel.textContent = mode === 'prompt-available' ? 'INSTALL ARGUS NOW' : 'SHOW ME HOW TO INSTALL';
    }
    if (chip) chip.classList.toggle('hidden', mode !== 'installed');
    if (settingsBtn) {
      settingsBtn.disabled = mode === 'installed';
      settingsBtn.textContent = mode === 'installed' ? 'INSTALLED ON THIS DEVICE' : 'INSTALL ON THIS DEVICE';
    }
    if (state) {
      state.textContent = mode === 'installed' ? 'installed'
        : mode === 'prompt-available' ? 'ready to install'
          : 'manual install';
      state.className = `status-chip ${mode === 'installed' ? 'ok' : mode === 'prompt-available' ? 'hot' : ''}`;
    }

    if (heading) heading.textContent = guide ? guide.headline : 'Install as an app';
    if (note) note.textContent = secure ? (guide ? guide.note : '') : 'Installation needs HTTPS. This page is not in a secure context, so the phone cannot install it.';
    if (stepsHost) {
      stepsHost.innerHTML = '';
      for (const step of (guide && guide.steps) || []) {
        const li = document.createElement('li');
        li.innerHTML = step;                 // authored strings only, never user input
        stepsHost.appendChild(li);
      }
    }
    if (after) after.textContent = (guide && guide.after) || '';
    if (meta) {
      meta.textContent = `Platform: ${platform} · display mode: ${snapshot.installed ? 'standalone' : 'browser tab'} · ${secure ? 'secure origin' : 'insecure origin'}`;
    }
  }

  /** Clear the boot transcript so a retry reads as a fresh attempt. */
  clearBootLines() {
    const host = $('boot-lines');
    if (host) host.innerHTML = '';
  }

  /** Camera-less environments (desktop, sandboxed frames) still get to try it. */
  offerDemoFallback() {
    const btn = $('demo-fallback');
    if (btn) btn.classList.remove('hidden');
  }

  hideBoot() {
    const el = $('boot');
    if (el) el.classList.add('hidden');
  }

  showBoot() {
    const el = $('boot');
    if (el) el.classList.remove('hidden');
  }

  openModal(id) { const el = $(id); if (el) el.classList.add('open'); }
  closeModal(id) { const el = $(id); if (el) el.classList.remove('open'); }
}

/* ------------------------------------------------------------------ *
 * Settings sheet binding — keeps app.js free of DOM plumbing.
 * ------------------------------------------------------------------ */
export function bindSettingsSheet(settings, { onChange, onTheme, onAction }) {
  const sync = () => {
    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.getAttribute('data-setting');
      if (!(key in settings)) return;
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
    });
    document.querySelectorAll('[data-setting-out]').forEach((el) => {
      const key = el.getAttribute('data-setting-out');
      const fmt = el.getAttribute('data-format');
      const v = settings[key];
      el.textContent = fmt === 'pct' ? `${Math.round(v * 100)}%` : String(v);
    });
    document.querySelectorAll('[data-theme-opt]').forEach((el) => {
      el.classList.toggle('sel', el.getAttribute('data-theme-opt') === settings.theme);
    });
  };

  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.getAttribute('data-setting');
    const handler = () => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'range' || el.type === 'number') value = Number(el.value);
      else value = el.value;
      settings[key] = value;
      if (key === 'theme') onTheme(value);
      onChange(key, value);
      sync();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });

  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => onAction(el.getAttribute('data-action'), el));
  });

  // Palette swatches are buttons rather than form controls, so wire them here.
  document.querySelectorAll('[data-theme-opt]').forEach((el) => {
    el.addEventListener('click', () => {
      const themeKey = el.getAttribute('data-theme-opt');
      if (settings.theme === themeKey) return;
      settings.theme = themeKey;
      onTheme(themeKey);
      onChange('theme', themeKey);
      sync();
    });
  });

  sync();
  return { sync };
}
