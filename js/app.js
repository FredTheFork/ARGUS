/**
 * app.js — ARGUS runtime.
 *
 * Boots the neural core, drives the camera + two render loops (60 Hz HUD,
 * adaptive-rate inference), owns target locking, capture, voice command
 * parsing and every control binding.
 */

import {
  BUILD, CLASS_META, DEFAULTS, LINES, THEMES, VERSION,
  applyTheme, loadSettings, pick, saveSettings, template, titleCase
} from './config.js';
import { Detector, MODEL_INFO } from './detector.js';
import { Tracker } from './tracker.js';
import { Voice, VoiceInput } from './speech.js';
import { Installer, installGuide } from './install.js';
import { Hud, bindSettingsSheet } from './ui.js';

const SCAN_STEPS = [320, 416, 512, 640];

/**
 * Turn a runtime failure into a sentence a person can act on. The exact cause
 * still goes on the console and under the message — but the headline should not
 * be a raw emscripten abort.
 */
function describeBootFailure(message) {
  const m = String(message || '');
  if (/stall|stopped responding|no response|unreachable/i.test(m)) {
    return 'The runtime download stalled — this host stopped sending data.';
  }
  if (/HTTP \d|interrupted|truncated|too small|not a WebAssembly binary|failed verification/i.test(m)) {
    return 'This host served a damaged or incomplete runtime file.';
  }
  if (/initWasm|no available backend|CompileError|backend/i.test(m)) {
    return 'The compute runtime would not start on this device.';
  }
  return 'The neural core failed to initialise.';
}

class Argus {
  constructor() {
    this.settings = loadSettings();
    this.tracker = new Tracker({ iouThreshold: 0.28, maxAge: 1200, smooth: 0.5 });
    this.detector = new Detector({ onLog: (m) => this.log(m) });
    this.voice = new Voice(() => this.settings, {
      onCaption: (t) => this.hud.subtitle(t),
      onLog: (m) => this.log(m)
    });
    this.hud = new Hud({
      canvas: document.getElementById('hud'),
      video: document.getElementById('cam'),
      getSettings: () => this.settings
    });
    this.video = document.getElementById('cam');
    this.stream = null;
    this.facing = 'environment';
    this.running = false;
    this.standby = false;
    this.lockedId = null;
    this.lockedSince = 0;
    this.budget = Number(this.settings.scanSize) || 416;
    this.lastInferMs = 0;
    this.lastDims = null;
    this.frameObjects = [];
    this.fps = 0;
    this._adaptClock = 0;
    this._battery = '—';
    this.minInterval = 24;
    this.wakeLock = null;
    this.voiceInput = null;
    // Install surface: tracks the browser's install prompt, the display mode and
    // the platform's real install route. Constructed eagerly so a
    // `beforeinstallprompt` fired during boot is never missed.
    this.installer = new Installer({
      onState: (snapshot, reason) => this.hud.setInstall(snapshot, installGuide(snapshot.platform)),
      onLog: (m, kind) => this.log(m, kind)
    });
    this._lastStatus = 0;
    this._pressTimer = null;
    this._lastTap = 0;
    // Boot bookkeeping: _booting stops overlapping boots (retry spam),
    // _retryBound/_bound keep the listeners installed exactly once.
    this._booting = false;
    this._retryBound = false;
    this._bound = false;
  }

  log(message, kind = 'sys') {
    const lower = String(message);
    const level = /^warn/.test(lower) ? 'warn' : /^err/.test(lower) ? 'err' : kind;
    this.hud.logLine(lower, level);
  }

  /* ================================================================ *
   * Boot
   * ================================================================ */
  /**
   * Run one async boot stage, but never let it run forever. The load reports
   * progress as it goes; if that progress stops for `idleMs` the stage is
   * abandoned with a precise error, so a dropped connection or a runtime that
   * never settles surfaces on screen instead of leaving a dead boot page.
   */
  async watchdog(run, { idleMs = 60000, label = 'the neural core', onStage = null } = {}) {
    let arm = () => {};
    let stop = () => {};
    const guard = new Promise((_, reject) => {
      let timer = null;
      arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error(`${label} stopped responding — no progress for ${Math.round(idleMs / 1000)}s`)), idleMs);
      };
      stop = () => clearTimeout(timer);
    });
    const task = run((text, pct) => { arm(); if (onStage) onStage(text, pct); });
    task.catch(() => {});                        // the guard may win the race
    try { return await Promise.race([task, guard]); } finally { stop(); }
  }

  /**
   * Bind the install controls immediately and mark them, so an operator can
   * install the app even if the neural core never comes up. The generic
   * `[data-act]` sweep in bindControls() skips anything already marked.
   */
  bindInstallButtons() {
    for (const btn of document.querySelectorAll('[data-act="install"]')) {
      if (btn.dataset.actBound) continue;
      btn.dataset.actBound = '1';
      btn.addEventListener('click', () => this.offerInstall());
    }
  }

  async boot() {
    if (this._booting) return;
    this._booting = true;
    this.theme = applyTheme(this.settings.theme);
    this.hud.setTheme(this.settings.theme);
    this.hud.showBoot();
    // The only control that must survive a failure is the one that gets you out
    // of it, so it is bound before anything can go wrong — exactly once.
    if (!this._retryBound) {
      const retryBtn = document.getElementById('boot-retry');
      if (retryBtn) retryBtn.addEventListener('click', () => this.retryBoot());
      this._retryBound = true;
    }
    this.hud.setBootStage('POST', 0.02);
    // Installation is independent of inference: publish its state first, so the
    // install controls work even when the neural core does not.
    this.installer.refresh('boot-start');
    this.bindInstallButtons();
    this.hud.bootLine(`${BUILD} — start-up self test`);
    this.hud.bootLine(`User agent: ${navigator.userAgent.slice(0, 70)}…`);
    this.hud.bootLine(`Secure context: ${window.isSecureContext ? 'YES' : 'NO'} · WebGPU: ${Detector.webgpuAvailable ? 'AVAILABLE' : 'ABSENT'}`);
    this.hud.bootLine(`Logical cores: ${navigator.hardwareConcurrency || 'unknown'} · isolated: ${self.crossOriginIsolated ? 'yes' : 'no'}`);

    if (!window.isSecureContext) {
      this._booting = false;
      this.hud.bootError('Camera and neural inference require a secure context. Open this app over HTTPS (or localhost) — an http:// LAN address will not work.',
        '', { core: false, label: 'HTTPS REQUIRED' });
      this.hud.bootLine('err: insecure context — camera APIs blocked by the browser', 'err');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._booting = false;
      this.hud.bootError('This browser exposes no camera API. Chrome, Edge, Samsung Internet or Safari 16+ on iOS are supported.',
        '', { core: false, label: 'OPTICS UNAVAILABLE' });
      return;
    }

    const t0 = performance.now();
    const stage = (text, pct) => { this.hud.setBootStage(text, pct); this.hud.bootLine(text.toLowerCase()); };
    try {
      const result = await this.watchdog(
        (report) => this.detector.load({
          backend: this.settings.backend,
          onStage: report,
          onRetry: (tier, attempt) => {
            this.hud.bootLine(`retry: ${tier.id} tier, attempt ${attempt} — fresh runtime, cache bypassed`, 'warn');
            this.hud.setBootStage('RE-ARMING RUNTIME', 0.25);
          }
        }),
        { idleMs: 60000, label: 'the compute runtime', onStage: stage }
      );
      this.hud.bootLine(`ok: ${MODEL_INFO.name} ready on ${result.backend} in ${result.loadMs} ms`);
      this.hud.setBootStage('WARMING GRAPH', 0.97);
      await this.watchdog(() => this.detector.warmup(this.budget), { idleMs: 45000, label: `the ${result.backend} graph` });
      const total = Math.round(performance.now() - t0);
      this.hud.bootLine(`ok: warm-up complete, total ${total} ms`);
      this.hud.bootReady(`${MODEL_INFO.name.toUpperCase()} · ${result.backend.toUpperCase()} · ${total} MS BOOT`);
      this.hud.setBootStage('NEURAL CORE ONLINE', 1);
      this.log(`core online: ${MODEL_INFO.name} (${MODEL_INFO.onDisk}) via ${result.backend}, boot ${total}ms`);
    } catch (err) {
      this._booting = false;
      const msg = (err && err.message) ? err.message : String(err);
      this.hud.bootLine(`err: ${msg}`, 'err');
      // One sentence the operator can act on, with the runtime's own wording
      // kept underneath for anyone who wants it.
      this.hud.bootError(describeBootFailure(msg), msg);
      this.log(`err: neural core failed to initialise — ${msg}`);
      return;
    }

    // Bindings are installed once: a successful retry must not double them up.
    if (!this._bound) {
      this.handleUrlIntent();
      this.bindControls();
      this.bindSettings();
      this.bindGestures();
      this.watchBattery();
      this.watchVisibility();
      this._bound = true;
    }
    this._booting = false;
    this.installer.refresh('boot');
    if (!this.installer.installed && this.installer.canPrompt) {
      this.log('note: this browser can install ARGUS — tap INSTALL ARGUS NOW', 'ok');
    } else if (!this.installer.installed) {
      this.log(`note: install from the browser menu (${this.installer.platform}) — see the field manual`);
    }
    this.log('Awaiting optical engagement. Tap ENGAGE OPTICS.');
  }

  /* ================================================================ *
   * Installation
   * ================================================================ */
  /**
   * Where a Chromium browser raised its own install prompt we fire it, right
   * here — that is a real one-tap install. Everywhere else (iOS above all,
   * where the event does not exist) there is nothing to fire, so the honest
   * move is to open the field manual on the exact steps for this platform.
   */
  async offerInstall() {
    const snapshot = this.installer.refresh('operator');
    if (snapshot.installed) {
      this.hud.toast('Already running as an installed app', 'ok');
      return;
    }
    if (!snapshot.secure) {
      this.hud.toast('Installation needs HTTPS', 'warn');
      this.log('install: blocked — this page is not a secure context', 'warn');
    }
    if (this.installer.canPrompt) {
      const outcome = await this.installer.promptInstall();
      if (outcome === 'accepted') this.hud.toast('Installing ARGUS…', 'ok', 4200);
      else if (outcome === 'dismissed') this.hud.toast('Install dismissed — the manual route is in the manual', 'warn', 4200);
      this.hud.setInstall(this.installer.snapshot(), installGuide(this.installer.platform));
      return;
    }
    this.hud.openModal('help-modal');
    this.log('install: opening the platform guide');
  }

  /* ================================================================ *
   * Retry — the recovery path off a failed boot screen
   * ================================================================ */
  async retryBoot() {
    if (this._booting) return;
    this.hud.hideBootError();
    this.hud.clearBootLines();
    this.hud.bootLine('retry: relaunching neural core from scratch — all tiers, fresh downloads');
    this.log('retry: operator requested a neural-core restart');
    await this.boot();
  }

  /* ================================================================ *
   * Engagement — camera + loops
   * ================================================================ */
  async engage() {
    try {
      await this.startCamera('environment');
    } catch (err) {
      const reason = `${err.name || 'CameraError'}: ${err.message}`;
      this.hud.bootError(`Camera refused — ${reason}.`, 'Grant camera permission in the browser\'s site settings and reload, or run the bundled sample feed instead.',
        { core: false, label: 'CAMERA BLOCKED' });
      this.hud.bootLine(`err: ${err.message}`, 'err');
      this.hud.offerDemoFallback();
      return;
    }
    if (this.demoPending) await this.useDemoFeed();
    this.startRuntime();
  }

  /** Engage using the bundled sample photograph — desktop, iframe, no camera. */
  async engageDemo() {
    this.hud.hideBootError();
    await this.useDemoFeed();
    this.startRuntime();
  }

  /** Shared tail of both engagement paths. */
  startRuntime() {
    this.hud.hideBoot();
    this.running = true;
    this.standby = false;
    this.requestWakeLock();
    this.hud.toast('Optics engaged', 'ok');
    this.log('optical sensor engaged — scanning');
    this.voice.say(this.voice.greeting(), { priority: 3, interrupt: true });
    setTimeout(() => this.voice.say(pick(LINES.engage), { priority: 3 }), 3600);
    this.loopHud();
    this.tick();
    if (this.pendingAction) {
      const action = this.pendingAction;
      this.pendingAction = null;
      setTimeout(() => this.action(action), 2500);
    }
  }

  async startCamera(facing) {
    this.stopCamera();
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 }
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.facing = facing;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    this.torchSupported = !!caps.torch;
    this.updateTorchButton();
    const settings = track.getSettings ? track.getSettings() : {};
    this.log(`camera: ${settings.width || '?'}x${settings.height || '?'} @${Math.round(settings.frameRate || 0)}fps, lens=${settings.facingMode || facing}${this.torchSupported ? ', torch available' : ''}`);
    const w = this.video.videoWidth || 1280;
    const h = this.video.videoHeight || 720;
    this.frameW = w; this.frameH = h;
    this.hud.resize();
    this.tracker.reset();
    this.lockedId = null;
  }

  stopCamera() {
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.torchOn = false;
  }

  async switchCamera() {
    const next = this.facing === 'environment' ? 'user' : 'environment';
    try {
      await this.startCamera(next);
      this.voice.say(template(pick(LINES.cameraSwitch), { lens: next === 'user' ? 'front' : 'rear' }), { priority: 2 });
      this.hud.toast(next === 'user' ? 'Front optics' : 'Rear optics', 'info');
    } catch (err) {
      this.hud.toast(`Lens switch failed: ${err.message}`, 'err');
    }
  }

  /* ================================================================ *
   * Loops
   * ================================================================ */
  loopHud() {
    if (!this.running) return;
    const mirrored = this.facing === 'user' && this.settings.mirrorFront;
    this.hud.render({
      tracks: this.tracker.tracks.filter((t) => t.missed === 0),
      lockedId: this.lockedId,
      mirrored,
      frameW: this.frameW || this.video.videoWidth || 1280,
      frameH: this.frameH || this.video.videoHeight || 720,
      fps: this.fps,
      inferMs: this.lastInferMs,
      dims: this.lastDims,
      backend: this.detector.backend,
      battery: this._battery
    });
    this._hudRaf = requestAnimationFrame(() => this.loopHud());
  }

  async tick() {
    if (!this.running) return;
    const t0 = performance.now();
    let res = null;
    if (!this.standby && this.video.readyState >= 2) {
      try {
        res = await this.detector.infer(this.video, {
          budget: this.budget,
          confidence: this.settings.minConfidence,
          iou: 0.45,
          maxDetections: this.settings.maxDetections
        });
      } catch (err) {
        this.log(`err: inference failed — ${err.message}`, 'err');
        await new Promise((r) => setTimeout(r, 600));
      }
      const wall = performance.now() - t0;
      if (res && !res.skipped) {
        this.lastInferMs = res.inferMs;
        this.lastDims = res.dims;
        this.fps = wall > 0 ? 1000 / wall : 0;
        try {
          this.consume(res);
          this.maybeAdapt(res.inferMs);
        } catch (err) {
          this.log(`warn: frame handling error — ${err.message}`);
        }
        // Duty-cycle pacing: keep the main thread ~40% free so the HUD stays
        // smooth even when the WASM provider runs inference inline.
        this.minInterval = Math.min(400, Math.max(12, wall * 0.55));
      }
    }
    const spent = performance.now() - t0;
    setTimeout(() => this.tick(), Math.max(4, this.minInterval - spent));
  }

  consume({ objects }) {
    const frameW = this.frameW || this.video.videoWidth || 1;
    const frameH = this.frameH || this.video.videoHeight || 1;
    const area = frameW * frameH;
    const seen = objects.map((o) => ({
      cls: o.cls,
      score: o.score,
      box: o.box
    }));
    const { live, lost, born } = this.tracker.update(seen);
    for (const tr of live) {
      tr.area = ((tr.box[2] - tr.box[0]) * (tr.box[3] - tr.box[1])) / area;
      tr.centre = [(tr.box[0] + tr.box[2]) / 2, (tr.box[1] + tr.box[3]) / 2];
    }

    // Did we lose the locked target?
    if (this.lockedId !== null) {
      const locked = this.tracker.tracks.find((t) => t.id === this.lockedId);
      if (!locked) {
        const gone = this._lockedSnapshot;
        this.lockedId = null;
        if (gone) this.voice.announceLoss(gone);
        this.hud.toast('Target lost', 'warn');
      }
    }
    const locked = this.tracker.tracks.find((t) => t.id === this.lockedId) || null;
    if (locked) this._lockedSnapshot = { ...locked, box: locked.box.slice() };

    // Auto-lock: grab the highest-interest object when idle.
    if (this.settings.autoLock && !locked) {
      const candidate = [...live]
        .filter((t) => (CLASS_META[t.cls] || {}).priority === 3 && t.hits >= 4)
        .sort((a, b) => (b.area || 0) - (a.area || 0) || b.score - a.score)[0];
      if (candidate) this.lockTarget(candidate, { quiet: true });
    }

    this.frameObjects = live;
    this.voice.narrate({ live, born, lost, locked });

    // Haptics on fresh high-interest arrivals.
    if (this.settings.haptics && navigator.vibrate) {
      const spicy = born.find((tr) => (CLASS_META[tr.cls] || {}).priority === 3);
      if (spicy && performance.now() - (this._lastBuzz || 0) > 1200) {
        this._lastBuzz = performance.now();
        navigator.vibrate(8);
      }
    }
  }

  maybeAdapt(inferMs) {
    if (!this.settings.adaptive) return;
    const t = performance.now();
    if (t - this._adaptClock < 2500) return;
    this._adaptClock = t;
    const idx = SCAN_STEPS.indexOf(this.budget);
    if (inferMs > 190 && idx > 0) {
      this.budget = SCAN_STEPS[idx - 1];
      this.log(`adapt: latency ${Math.round(inferMs)}ms — reducing scan to ${this.budget}px`);
    } else if (inferMs < 65 && idx < SCAN_STEPS.length - 1 && this.budget < Number(this.settings.scanSize)) {
      this.budget = SCAN_STEPS[idx + 1];
      this.log(`adapt: latency ${Math.round(inferMs)}ms — raising scan to ${this.budget}px`);
    }
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* non-fatal */ }
  }

  watchVisibility() {
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        this.voice.stop();
        this.log('paused — document hidden');
      } else if (this.running) {
        this.requestWakeLock();
      }
    });
  }

  async watchBattery() {
    try {
      if (!navigator.getBattery) return;
      const b = await navigator.getBattery();
      const update = () => { this._battery = `${Math.round(b.level * 100)}%${b.charging ? '+' : ''}`; };
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    } catch { /* ignore */ }
  }

  /* ================================================================ *
   * Targeting
   * ================================================================ */
  lockTarget(track, { quiet = false } = {}) {
    const first = this.lockedId === null;
    this.lockedId = track.id;
    this.lockedSince = performance.now();
    this._lockedSnapshot = { ...track, box: track.box.slice() };
    track.acquireT = 0;
    if (this.settings.haptics && navigator.vibrate) navigator.vibrate([12, 40, 12]);
    if (!quiet) this.hud.toast(`Locked: ${(CLASS_META[track.cls] || {}).display || track.cls}`, 'ok');
    this.voice.announceTarget(track, { reacquire: !first });
    this.log(`lock: #${track.id} ${track.cls} ${(track.score * 100).toFixed(0)}%${first ? '' : ' (re-acquire)'}`, 'ok');
  }

  releaseLock({ quiet = false } = {}) {
    if (this.lockedId === null) return;
    this.lockedId = null;
    this._lockedSnapshot = null;
    if (!quiet) {
      this.hud.toast('Lock released', 'info');
      this.voice.say(pick(LINES.targetCleared), { priority: 2 });
    }
  }

  hitTest(px, py) {
    // px/py in canvas CSS pixels -> find the topmost track containing the point.
    const s = this.settings;
    const frameW = this.frameW || this.video.videoWidth || 1;
    const frameH = this.frameH || this.video.videoHeight || 1;
    const tf = this.hud.coverTransform(frameW, frameH);
    const mirrored = this.facing === 'user' && s.mirrorFront;
    const x = mirrored ? this.hud.w - px : px;
    const candidates = this.tracker.tracks.filter((t) => t.missed === 0);
    let best = null;
    for (const tr of candidates) {
      const b = [
        tr.box[0] * tf.scale + tf.ox, tr.box[1] * tf.scale + tf.oy,
        tr.box[2] * tf.scale + tf.ox, tr.box[3] * tf.scale + tf.oy
      ];
      if (x >= b[0] && x <= b[2] && py >= b[1] && py <= b[3]) {
        if (!best || (tr.area || 0) < (best.area || 0)) best = tr;
      }
    }
    return best;
  }

  queryTrack(track) {
    const meta = CLASS_META[track.cls] || { display: track.cls.toUpperCase() };
    const area = track.area || 0;
    const prox = area > 0.22 ? 'very close' : area > 0.07 ? 'at mid range' : 'distant';
    const cat = (meta.category || 'object').toUpperCase();
    this.voice.say(`${meta.display}. Confidence ${Math.round(track.score * 100)} percent. ${titleCase(prox)}, filling ${Math.round(area * 100)} percent of the frame. Class group ${cat}.`, { priority: 3, interrupt: true });
    this.hud.toast(`${meta.display} · ${Math.round(track.score * 100)}% · ${prox}`, 'info');
  }

  /* ================================================================ *
   * Capture
   * ================================================================ */
  snapshot({ download = true } = {}) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw) { this.hud.toast('No frame to capture', 'warn'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');
    const mirrored = this.facing === 'user' && this.settings.mirrorFront;
    const tf = this.hud.coverTransform(vw, vh);
    ctx.save();
    if (mirrored) { ctx.translate(vw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(this.video, 0, 0, vw, vh);
    // The live overlay only covers the on-screen crop; map it back onto the
    // full sensor frame so brackets land on the right pixels in the saved PNG.
    const srcX = -tf.ox / tf.scale;
    const srcY = -tf.oy / tf.scale;
    const srcW = this.hud.w / tf.scale;
    const srcH = this.hud.h / tf.scale;
    ctx.drawImage(this.hud.canvas, 0, 0, this.hud.canvas.width, this.hud.canvas.height, srcX, srcY, srcW, srcH);
    ctx.restore();

    const stamp = new Date();
    const pad = Math.round(vw * 0.018);
    ctx.font = `600 ${Math.round(vw * 0.022)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = 'rgba(3,9,15,.72)';
    const counts = new Map();
    for (const tr of this.frameObjects) counts.set(tr.cls, (counts.get(tr.cls) || 0) + 1);
    const summary = counts.size
      ? [...counts.entries()].map(([c, n]) => `${n}× ${c.toUpperCase()}`).join('   ')
      : 'NO OBJECTS OF INTEREST';
    const line1 = `ARGUS CAPTURE · ${stamp.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
    const line2 = `${summary} · ${(counts.size ? this.frameObjects.length : 0)} TARGETS · ${this.detector.backend.toUpperCase()}`;
    const width = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
    ctx.fillRect(pad, vh - pad - Math.round(vw * 0.075), width + pad, Math.round(vw * 0.075));
    ctx.fillStyle = this.theme.accent;
    ctx.fillText(line1, pad * 1.5, vh - pad - Math.round(vw * 0.038));
    ctx.fillStyle = 'rgba(223,246,255,.85)';
    ctx.fillText(line2, pad * 1.5, vh - pad - Math.round(vw * 0.008));

    const dataUrl = canvas.toDataURL('image/png');
    const fileStamp = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
    this.hud.flash();
    this.hud.addToFilmstrip(dataUrl, fileStamp);
    if (download) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `argus-${fileStamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    this.hud.toast('Capture stored', 'ok');
    this.voice.say(pick(LINES.captured), { priority: 1 });
    this.log(`capture: argus-${fileStamp}.png (${counts.size} categories)`);
  }

  /* ================================================================ *
   * Controls + gestures
   * ================================================================ */
  bindControls() {
    document.getElementById('engage').addEventListener('click', () => this.engage());
    const demoBtn = document.getElementById('demo-fallback');
    if (demoBtn) demoBtn.addEventListener('click', () => this.engageDemo());
    document.querySelectorAll('[data-act]').forEach((btn) => {
      if (btn.dataset.actBound) return;              // bound early (install) or already done
      btn.dataset.actBound = '1';
      btn.addEventListener('click', () => this.action(btn.getAttribute('data-act')));
    });
    const canvas = this.hud.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this._downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      this._longFired = false;
      this._pressTimer = setTimeout(() => {
        this._longFired = true;
        this.statusReport();
      }, 620);
    });
    canvas.addEventListener('pointerup', (e) => {
      clearTimeout(this._pressTimer);
      if (this._longFired) return;
      if (!this._downAt) return;
      const moved = Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y);
      const quick = performance.now() - this._downAt.t < 600;
      if (moved > 24 || !quick) return;
      const rect = canvas.getBoundingClientRect();
      const track = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      const double = performance.now() - this._lastTap < 320;
      this._lastTap = performance.now();
      if (track) {
        if (double) this.queryTrack(track);
        else if (this.lockedId === track.id) this.releaseLock();
        else this.lockTarget(track);
      } else if (this.lockedId !== null) {
        this.releaseLock();
      } else {
        this.hud.startSweep();
        this.hud.toast('Wide scan', 'info', 1400);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); this.snapshot(); }
      if (k === 'l') this.autoSelectTarget();
      if (k === 's') this.statusReport();
      if (k === 'c') this.switchCamera();
      if (k === 't') this.toggleTorch();
      if (k === 'm') this.toggleVoice();
      if (k === 'x') this.releaseLock();
      if (k === 'h') this.hud.openModal('help-modal');
      if (k === 'escape') { this.hud.closeModal('help-modal'); this.hud.closeModal('photo-modal'); }
    });
  }

  action(name) {
    switch (name) {
      case 'camera': this.switchCamera(); break;
      case 'torch': this.toggleTorch(); break;
      case 'voice': this.toggleVoice(); break;
      case 'snap': this.snapshot(); break;
      case 'scan': this.hud.startSweep(); this.voice.say(pick(LINES.scanStart), { priority: 2 }); break;
      case 'status': this.statusReport(); break;
      case 'lock': this.autoSelectTarget(); break;
      case 'standby': this.toggleStandby(); break;
      case 'install': this.offerInstall(); break;
      case 'help': this.hud.openModal('help-modal'); break;
      case 'menu': this.toggleSheet('settings-sheet'); break;
      case 'console': this.toggleSheet('console-sheet'); break;
      case 'mic': this.toggleVoiceCommands(); break;
      case 'reset': {
        this.settings = { ...DEFAULTS };
        saveSettings(this.settings);
        this.budget = this.settings.scanSize;
        this.theme = applyTheme(this.settings.theme);
        this.hud.setTheme(this.settings.theme);
        if (this.sheetSync) this.sheetSync();
        this.hud.toast('Settings restored to defaults', 'ok');
        this.log('settings reset to factory defaults');
        break;
      }
      case 'test-voice':
        this.voice._select();
        this.voice.say(`Voice check. I am Argus, running ${MODEL_INFO.name} on ${this.detector.backend}. All systems nominal.`, { priority: 3, interrupt: true });
        break;
      case 'greet': this.voice.say(this.voice.greeting(), { priority: 3, interrupt: true }); break;
      default: break;
    }
  }

  autoSelectTarget() {
    const live = this.tracker.tracks.filter((t) => t.missed === 0);
    if (!live.length) { this.hud.toast('No targets in view', 'warn'); return; }
    const ranked = [...live].sort((a, b) => {
      const pa = (CLASS_META[a.cls] || { priority: 1 }).priority;
      const pb = (CLASS_META[b.cls] || { priority: 1 }).priority;
      return pb - pa || (b.area || 0) - (a.area || 0) || b.score - a.score;
    });
    const pickTarget = ranked.find((t) => t.id !== this.lockedId) || ranked[0];
    this.lockTarget(pickTarget);
  }

  statusReport() {
    this.voice.statusReport({
      tracks: this.tracker.tracks.filter((t) => t.missed === 0),
      backend: this.detector.backend,
      inferMs: this.lastInferMs,
      fps: this.fps,
      scanLabel: this.lastDims ? `${this.lastDims.w} by ${this.lastDims.h}` : 'unknown'
    });
  }

  toggleStandby() {
    this.standby = !this.standby;
    document.body.classList.toggle('standby', this.standby);
    this.hud.toast(this.standby ? 'Standby — inference halted' : 'Scanning resumed', this.standby ? 'warn' : 'ok');
    this.voice.say(this.standby ? 'Standing down optics. Say wake to resume.' : 'Optics back online.', { priority: 3, interrupt: true });
    if (this.standby) this.tracker.reset();
  }

  async toggleTorch() {
    if (!this.torchSupported) { this.hud.toast('No torch on this lens', 'warn'); return; }
    try {
      const track = this.stream.getVideoTracks()[0];
      this.torchOn = !this.torchOn;
      await track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      this.hud.toast(this.torchOn ? 'Illuminator on' : 'Illuminator off', 'info');
      document.body.classList.toggle('torch-on', this.torchOn);
    } catch (err) {
      this.hud.toast(`Torch failed: ${err.message}`, 'err');
    }
  }

  updateTorchButton() {
    const btn = document.querySelector('[data-act="torch"]');
    if (btn) btn.classList.toggle('hidden', !this.torchSupported);
  }

  toggleVoice() {
    this.settings.voiceEnabled = !this.settings.voiceEnabled;
    saveSettings(this.settings);
    if (this.sheetSync) this.sheetSync();
    if (this.settings.voiceEnabled) this.voice.say(pick(LINES.unmuted), { priority: 3, interrupt: true });
    else this.voice.say(pick(LINES.muted), { priority: 3, interrupt: true, caption: true }) || this.voice.stop();
    this.hud.toast(this.settings.voiceEnabled ? 'Audio on' : 'Audio muted', 'info');
    document.body.classList.toggle('muted', !this.settings.voiceEnabled);
  }

  toggleVoiceCommands() {
    if (!this.voiceInput) {
      this.voiceInput = new VoiceInput({
        onFinal: (text) => this.handleCommand(text),
        onInterim: (text) => { const el = document.getElementById('mic-interim'); if (el) el.textContent = text; },
        onState: (active, err) => {
          document.body.classList.toggle('mic-on', !!active);
          if (err) this.hud.toast(`Microphone ${err}`, 'err');
        }
      });
    }
    if (!this.voiceInput.supported) {
      this.hud.toast('Voice commands need Chrome/Edge/Safari', 'warn');
      return;
    }
    this.settings.voiceCommands = !this.settings.voiceCommands;
    saveSettings(this.settings);
    if (this.settings.voiceCommands) {
      this.voiceInput.start();
      this.voice.say(pick(LINES.voiceOn), { priority: 3, interrupt: true });
      this.log('voice command channel open', 'ok');
    } else {
      this.voiceInput.stop();
      this.voice.say(pick(LINES.voiceOff), { priority: 3 });
      this.log('voice command channel closed');
    }
    if (this.sheetSync) this.sheetSync();
  }

  /* ================================================================ *
   * Voice command parsing — keyword grammar over the transcript.
   * ================================================================ */
  handleCommand(transcript) {
    const text = transcript.toLowerCase().trim();
    if (!text) return;
    this.log(`voice: "${text}"`, 'voice');
    const has = (...words) => words.some((w) => text.includes(w));

    if (has('stand down', 'shut down', 'engine off', 'power down')) { if (!this.standby) this.toggleStandby(); return; }
    if (has('wake up', 'wake', 'resume', 'engine on')) { if (this.standby) this.toggleStandby(); return; }
    if (has('status', 'report', 'sit rep', 'sitrep', 'what do you see')) { this.statusReport(); return; }
    if (/(stop|release|clear|drop)\s+(tracking|track|lock|target)/.test(text) || text === 'unlock') { this.releaseLock(); return; }
    if (has('mute', 'quiet', 'silence', 'be quiet')) { if (this.settings.voiceEnabled) this.toggleVoice(); return; }
    if (has('unmute', 'talk to me', 'speak to me')) { if (!this.settings.voiceEnabled) this.toggleVoice(); return; }
    if (has('snapshot', 'capture', 'photo', 'picture', 'screenshot')) { this.snapshot(); return; }
    if (has('torch', 'flashlight', 'illuminator', 'light on')) { this.toggleTorch(); return; }
    if (has('switch camera', 'flip camera', 'front camera', 'selfie', 'rear camera', 'back camera')) { this.switchCamera(); return; }
    if (has('sweep', 'rescan', 'scan now', 'full scan')) { this.hud.startSweep(); this.voice.say(pick(LINES.scanStart), { priority: 2 }); return; }
    if (has('install', 'add to home screen', 'home screen')) { this.offerInstall(); return; }
    if (has('help', 'commands', 'what can you do')) { this.voice.say(pick(LINES.help), { priority: 3, interrupt: true }); return; }
    if (has('palette', 'theme', 'colour scheme', 'color scheme')) {
      const wanted = Object.entries(THEMES).find(([key, t]) => text.includes(key) || text.includes(t.label.toLowerCase()));
      const next = wanted ? wanted[0] : Object.keys(THEMES)[(Object.keys(THEMES).indexOf(this.settings.theme) + 1) % Object.keys(THEMES).length];
      this.settings.theme = next;
      saveSettings(this.settings);
      this.theme = applyTheme(next);
      this.hud.setTheme(next);
      if (this.sheetSync) this.sheetSync();
      this.voice.say(template(pick(LINES.themeSwitch), { theme: THEMES[next].label }), { priority: 3, interrupt: true });
      return;
    }
    if (has('lock on', 'lock onto', 'track the', 'track a', 'target the')) {
      const cls = Object.keys(CLASS_META).find((c) => text.includes(c));
      if (cls) {
        const candidates = this.tracker.tracks.filter((t) => t.missed === 0 && t.cls === cls);
        if (candidates.length) {
          const best = candidates.sort((a, b) => (b.area || 0) - (a.area || 0))[0];
          this.lockTarget(best);
        } else {
          this.voice.say(`I have no ${cls} in view, ${this.settings.address || 'sir'}.`, { priority: 3, interrupt: true });
        }
        return;
      }
    }
    const stripped = text.replace(/^(argus|hey argus|jarvis|computer|assistant)[ ,]+/, '');
    if (stripped !== text) this.log(`voice: addressed — no matching action`, 'warn');
  }

  /* ================================================================ *
   * Settings + sheets
   * ================================================================ */
  bindSettings() {
    // bindSettingsSheet returns { sync }; keep the function itself so callers
    // can simply do `if (this.sheetSync) this.sheetSync()`.
    const sheet = bindSettingsSheet(this.settings, {
      onChange: (key, value) => {
        saveSettings(this.settings);
        switch (key) {
          case 'theme': {
            this.theme = applyTheme(value);
            this.hud.setTheme(value);
            this.voice.say(template(pick(LINES.themeSwitch), { theme: THEMES[value].label }), { priority: 1 });
            break;
          }
          case 'scanSize': this.budget = Number(value); break;
          case 'voiceURI': this.voice._select(); break;
          case 'voiceCommands': this.toggleVoiceCommands(); break;
          default: break;
        }
      },
      onTheme: () => {},
      onAction: (name) => this.action(name)
    });
    this.sheetSync = sheet.sync;
    const voiceList = document.getElementById('voice-list');
    const populateVoices = () => {
      if (!voiceList) return;
      const voices = this.voice.voices.filter((v) => /^en/i.test(v.lang));
      voiceList.innerHTML = ['<option value="">Auto (best British voice)</option>']
        .concat(voices.map((v) => `<option value="${v.voiceURI}"${v.voiceURI === this.settings.voiceURI ? ' selected' : ''}>${v.name} — ${v.lang}${v.localService ? ' · offline' : ' · network'}</option>`))
        .join('');
    };
    populateVoices();
    setTimeout(populateVoices, 1200);
    const info = document.getElementById('model-info');
    if (info) {
      info.innerHTML = Object.entries({
        'Model': `${MODEL_INFO.name} (${MODEL_INFO.classes} classes)`,
        'Backbone': MODEL_INFO.architecture,
        'Training data': MODEL_INFO.dataset,
        'Parameters': MODEL_INFO.params.toLocaleString('en-GB'),
        'ONNX opset': String(MODEL_INFO.opset),
        'Weights on disk': MODEL_INFO.onDisk,
        'Runtime': 'onnxruntime-web 1.20.1 (WebGPU → WASM fallback)',
        'Execution provider': this.detector.backend,
        'Build': BUILD
      }).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    }
    // Install copy is rendered by Hud.setInstall() from the installer's live
    // state, so there is one source of truth for it.
    const swStatus = document.getElementById('sw-status');
    if (swStatus) {
      swStatus.textContent = 'serviceWorker' in navigator
        ? (navigator.onLine ? 'online · cache warming' : 'offline · running from cache')
        : 'service worker unavailable in this browser';
    }
    const greeting = document.getElementById('address-input');
    if (greeting) greeting.addEventListener('change', () => { saveSettings(this.settings); });
  }

  /** Manifest shortcuts and deep links: ?action=capture|status|settings|demo */
  handleUrlIntent() {
    const params = new URLSearchParams(location.search);
    const action = params.get('action');
    if (params.get('demo') !== null || action === 'demo') this.demoPending = true;
    if (action === 'settings') this.toggleSheet('settings-sheet');
    if (action === 'console') this.toggleSheet('console-sheet');
    if (action === 'capture') this.pendingAction = 'snap';
    if (action === 'status') this.pendingAction = 'status';
    if (action) this.log(`deep link: action=${action}`);
  }

  /**
   * Desktop / no-camera fallback: feed the bundled sample photograph through
   * the same pipeline so the whole stack can be exercised on a laptop.
   */
  async useDemoFeed() {
    try {
      const img = new Image();
      img.src = 'tools/sample-bus.jpg';
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const stream = canvas.captureStream(24);
      this.stopCamera();
      this.video.srcObject = stream;
      await this.video.play();
      this.stream = stream;
      this.frameW = canvas.width;
      this.frameH = canvas.height;
      this.hud.resize();
      this.tracker.reset();
      this.hud.toast('Demo feed engaged — sample photograph', 'warn', 4200);
      this.log('demo: sample photograph streaming through the live pipeline');
    } catch (err) {
      this.log(`warn: demo feed unavailable (${err.message})`);
    }
  }

  toggleSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const wasOpen = el.classList.contains('open');
    document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open'));
    if (!wasOpen) el.classList.add('open');
  }

  bindGestures() {
    const stage = document.getElementById('stage');
    let startY = null;
    stage.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (startY === null) return;
      const dy = e.changedTouches[0].clientY - startY;
      const fromBottom = e.changedTouches[0].clientY > window.innerHeight * 0.72;
      if (dy < -90 && fromBottom) this.toggleSheet('settings-sheet');
      if (dy > 90 && document.querySelector('.sheet.open')) document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open'));
      startY = null;
    }, { passive: true });
  }
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */
const argus = new Argus();
window.argus = argus;                     // debug handle
document.getElementById('boot-ver').textContent = `v${VERSION}`;
argus.boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      argus.log('service worker registered — offline cache active');
      reg.addEventListener('updatefound', () => argus.hud.toast('Update available — reload to apply', 'info', 4000));
    }).catch((err) => argus.log(`warn: service worker failed (${err.message})`));

    // The worker revalidates cached code in the background; when it spots a
    // change it tells us, so the user is never silently running an old build.
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.type !== 'argus-update-cached') return;
      if (argus._updateNotified) return;
      argus._updateNotified = true;
      argus.log(`update: newer build cached (${data.url}) — reload to apply`, 'ok');
      argus.hud.toast('New build cached — reload to apply', 'ok', 5200);
    });
  });
}
