/**
 * app.js — ARGUS v3.0: boot, camera and the frame loop.
 *
 * One job: point the camera at the world and every object seen is outlined
 * and named on the feed, from the first frame it appears. There is nothing to
 * press, nothing to configure — the stage carries zero interactive elements —
 * and nothing in this file besides the boot, the camera, the loop and the
 * status line.
 *
 * The loop runs on two clocks on purpose. The display half renders the
 * overlay every animation frame; the inference half runs when the previous
 * pass has finished and enough time has elapsed, so a slow frame never blocks
 * the HUD and a fast device is never throttled by a fixed timer. Everything
 * that could stall a frame — model loads, OCR, pose — happens behind the
 * previous result, with the overlay showing the last known state rather than
 * a frozen screen.
 */

import { Runtime } from './core.js';
import { Pipeline } from './pipeline.js';
import { Hud } from './ui.js';
import { VERSION, CONFIG } from './config.js';
import { stats as kbStats } from './kb.js';

/* ------------------------------------------------------------------ *\
 * State
 * ------------------------------------------------------------------ */

const state = {
  settings: CONFIG,
  runtime: null,
  pipeline: null,
  hud: null,
  video: null,
  stream: null,
  facing: 'environment',
  frame: null,
  frameCanvas: null,
  frameCtx: null,
  lastResult: null,
  // True once a full inference pass has landed. Until then "nothing in view"
  // means the pipeline is still warming up, and the status dot stays amber.
  live: false,
  busy: false,
  fps: 0,
  wakeLock: null,
  demo: false,
  demoCanvas: null,
  startedAt: Date.now(),
  // boot bookkeeping — the parallel camera/model race settles through these
  cameraStatus: null,
  modelStatus: null,
  modelPromise: null,
  bootFailed: false,
  bootFailKind: null,
  enteredStage: false,
  wasStreaming: false
};

/** How long the camera get is allowed to sit unanswered before boot says so. */
const CAMERA_TIMEOUT_MS = 25000;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *\
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  state.video = $('cam');
  state.hud = new Hud({
    canvas: $('hud'),
    video: state.video,
    getSettings: () => state.settings
  });

  state.hud.setBootStage('CHECKING HARDWARE', 0.08);
  log(`ARGUS ${VERSION} — ${new Date().toLocaleString()}`);
  const kb = kbStats();
  log(`vocabulary: ${kb.objects} objects, ${kb.aliases} aliases, ${kb.brands} brands, ${kb.imagenet} ImageNet classes — ${kb.vocabulary} names total`);

  bindUI();

  // The worker registers before anything heavy moves: it gives the page its
  // offline shell and the update channel regardless of how the camera and
  // model steps play out below.
  registerServiceWorker();

  if (!secureContextOk()) {
    log('error: camera needs a secure context');
    failBoot('Insecure context', 'Camera access requires https:// or localhost. Open the site over TLS, or use the demo feed.', 'camera');
    return;
  }

  // ?demo=1 — skip the camera entirely (kiosks, CI, no-permission browsers).
  const params = new URLSearchParams((window.location && window.location.search) || '');
  if (['1', 'true', 'yes'].includes(String(params.get('demo') || '').toLowerCase())) {
    log('demo: requested via URL — camera step skipped');
    await startDemo();
    return;
  }

  /* Camera and models boot in parallel, deliberately. Serial boot meant the
   * permission prompt held a ~12 MB download hostage (and vice versa), which
   * on mobile data looked exactly like a wedged loading screen. Each side
   * reports its own outcome; the stage opens only when both have succeeded,
   * and each failure gets its own honest error instead of a silent hang. */
  ensureModels().then((r) => {
    if (!r.ok) {
      log(`error: core load failed — ${r.error.message}`);
      failBoot('Model load failed', r.error.message, 'models');
    }
    maybeEnterStage();
  });

  runCameraBoot().then((r) => {
    state.cameraStatus = r;
    if (!r.ok) {
      log(`error: camera unavailable — ${r.error.message}`);
      failBoot('Camera unavailable', `${r.error.message}. Grant camera permission, or run the demo feed.`, 'camera');
    }
    maybeEnterStage();
  });
}

/** A camera needs https:// or localhost; anything else cannot ask permission. */
function secureContextOk() {
  try {
    return (typeof window !== 'undefined' && window.isSecureContext === true)
      || window.location.hostname === 'localhost'
      || window.location.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** First terminal failure wins the boot-screen headline; later ones just log. */
function failBoot(title, detail, kind) {
  if (state.bootFailed) return false;
  state.bootFailed = true;
  state.bootFailKind = kind || null;
  state.hud.bootError(title, detail);
  return true;
}

/** Open the stage exactly once, and only when camera AND models are confirmed. */
function maybeEnterStage() {
  if (state.enteredStage) return false;
  if (!state.cameraStatus?.ok || !state.modelStatus?.ok) return false;
  state.enteredStage = true;
  enterStage();
  return true;
}

/** The boot screen comes down and the loop starts. The feed is the interface. */
function enterStage() {
  if (!state.pipeline) { log('warn: enterStage before the pipeline exists — ignored'); return; }
  state.hud.hideBootError();
  state.hud.bootReady(`${state.pipeline.detector.info().name} · ${kbStats().vocabulary} names in vocabulary`);
  state.hud.hideBoot();
  startLoop();
  requestOfflineFill();
}

/** Model loading is a singleton: a retry never runs two downloads side by side. */
function ensureModels() {
  if (!state.modelPromise) {
    state.modelPromise = runModelBoot().then((r) => {
      state.modelStatus = r;
      return r;
    });
  }
  return state.modelPromise;
}

/** getUserMedia with a watchdog and a late-grant recovery. */
async function runCameraBoot() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return { ok: false, error: new Error('this browser exposes no camera API (getUserMedia missing)') };
  }
  // startCamera's verdict is mapped, never thrown: the timeout must not leave a
  // late rejection floating after the watchdog has already reported.
  const pending = startCamera(state.facing).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const verdict = await withDeadline(pending, CAMERA_TIMEOUT_MS,
    () => new Error(`the camera produced no answer within ${CAMERA_TIMEOUT_MS / 1000} seconds — the permission prompt may be hidden in this browser`));
  if (verdict.ok || !verdict.timedOut) return verdict;
  pending.then((late) => {
    if (!late.ok || state.cameraStatus?.ok || state.enteredStage) return;
    log('note: camera answered after the watchdog fired — finishing startup with it');
    state.cameraStatus = { ok: true };
    if (state.bootFailKind === 'camera' || !state.bootFailed) {
      state.bootFailed = false;
      state.bootFailKind = null;
      if (state.modelStatus && !state.modelStatus.ok) {
        failBoot('Model load failed', state.modelStatus.error.message, 'models');
        return;
      }
      state.hud.hideBootError();
    }
    maybeEnterStage();
  });
  return { ok: false, error: verdict.error };
}

/** Race a promise against a timer; on timeout the timer is cleared and flagged. */
function withDeadline(promise, ms, makeError) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  return Promise.race([promise, timeout]).then((r) => {
    clearTimeout(timer);
    return r && r.timedOut ? { ok: false, timedOut: true, error: makeError() } : r;
  });
}

/**
 * Load the compute runtime and the detector, then kick off the perception
 * modules in the background. Returns a verdict — `{ ok: true }` or
 * `{ ok: false, error }` — and never throws, because boot decisions are made
 * by the caller, not by a rejection landing somewhere nobody is watching.
 *
 * The detector alone is a complete app, so the optional modules load without
 * holding up first light. The model manifest is the contract between the
 * shipped files and this code: checking the digests turns "the fetch returned
 * 200" into "these are the bytes that were tested".
 */
async function runModelBoot() {
  try {
    if (!state.runtime) {
      state.runtime = new Runtime({ onLog: (msg) => log(msg) });
      state.pipeline = new Pipeline({
        runtime: state.runtime,
        settings: state.settings,
        onLog: (msg) => log(msg),
        onStatus: (module, status) => {
          if (status === 'ready') {
            log(`module online: ${module}`);
            state.hud.bootLine(`${module} online`);
          }
        }
      });
    }

    state.hud.setBootStage('LOADING COMPUTE RUNTIME', 0.2);
    const info = await state.runtime.boot({
      backend: state.settings.backend,
      onStage: (stage, pct) => state.hud.setBootStage(stage, pct)
    });
    log(`compute: ${info.label}, ${info.threads} thread${info.threads > 1 ? 's' : ''}`);
    state.hud.bootLine(`compute runtime ready — ${info.label}${info.threads > 1 ? `, ${info.threads} threads` : ''}`);

    state.hud.setBootStage('LOADING DETECTOR', 0.45);
    await state.pipeline.loadCore({
      onProgress: (pct, msg) => state.hud.setBootStage(msg || 'LOADING DETECTOR', 0.45 + 0.3 * (pct || 0))
    });
  } catch (err) {
    return { ok: false, error: err };
  }

  state.modelManifest = await fetchManifest();
  if (state.modelManifest) {
    const expected = {
      detector: state.modelManifest.models?.detector?.sha256,
      classifier: state.modelManifest.models?.classifier?.sha256,
      pose: state.modelManifest.models?.pose?.sha256,
      hands: state.modelManifest.models?.hand?.sha256,
      ocr: [state.modelManifest.models?.ocrDet?.sha256, state.modelManifest.models?.ocrRec?.sha256, state.modelManifest.models?.ocrCls?.sha256]
    };
    state.expectedHashes = expected;
  }

  state.hud.setBootStage('PERCEPTION MODULES', 0.8);
  // Staggered on purpose: classifier first (it sharpens names soonest), then
  // OCR, then pose and hands. Each module's download + session build is real
  // work; spacing them means the first seconds of live recognition are never
  // competing with four graphs compiling at once.
  state.pipeline.enableAll({ stagger: true }).then(() => {
    const exp = state.expectedHashes || {};
    verifySession(state.pipeline.detector.session, exp.detector);
    verifySession(state.pipeline.classifier.session, exp.classifier);
    verifySession(state.pipeline.pose.body, exp.pose);
    verifySession(state.pipeline.pose.hand, exp.hands);
    if (exp.ocr) {
      verifySession(state.pipeline.ocr.det, exp.ocr[0]);
      verifySession(state.pipeline.ocr.rec, exp.ocr[1]);
      verifySession(state.pipeline.ocr.cls, exp.ocr[2]);
    }
  }).catch((err) => log(`warn: module load — ${err.message}`));

  return { ok: true };
}

async function fetchManifest() {
  try {
    const res = await fetch('models/manifest.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    log(`note: model manifest unavailable (${err.message}) — integrity checks skipped`);
    return null;
  }
}

/** Compare a loaded session's digest with the manifest, once per model. */
function verifySession(session, expected) {
  if (!session || !expected) return;
  const got = session.sha256;
  if (!got) return;
  if (got === expected) log(`verified: ${session.meta.label} sha256 ${got.slice(0, 12)}…`);
  else log(`warn: ${session.meta.label} digest mismatch — expected ${expected.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
}

function registerServiceWorker() {
  // serviceWorker is *absent* on plain http (non-localhost) and can even be
  // present-but-undefined in embedded webviews — feature-detect with optional
  // chaining everywhere, because a throw here would take the whole boot down.
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener?.('message', (event) => {
    const data = event.data || {};
    if (data.type === 'argus-offline-ready') {
      log(`offline cache verified — ${data.total - data.missing}/${data.total} payloads held, ${data.filled} filled`);
    }
    if (data.type === 'argus-update-cached') {
      log('update: a refreshed build has been cached — it applies on the next launch');
    }
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    log('service worker registered — offline shell active, models fill in the background');
    reg.addEventListener?.('updatefound', () => log('update: new build found, will apply on next launch'));
  }).catch((err) => log(`warn: service worker failed — ${err.message}`));
}

/**
 * Ask the worker to make sure the runtime and model payloads are cached. This
 * runs only after first light: the user's first successful launch should not
 * compete with a second copy of the payloads moving in the background, and on
 * later launches the bytes are already there.
 */
async function requestOfflineFill() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await withDeadline(navigator.serviceWorker.ready, 15000, () => new Error('no active worker'));
    if (!reg || reg.timedOut || !reg.active) {
      setTimeout(() => {
        navigator.serviceWorker.getRegistration?.().then((r) => r?.active?.postMessage({ type: 'argus-ensure-offline' })).catch(() => {});
      }, 4000);
      return;
    }
    reg.active.postMessage({ type: 'argus-ensure-offline' });
  } catch { /* offline fill is opportunistic */ }
}

/* ------------------------------------------------------------------ *\
 * Camera
 * ------------------------------------------------------------------ */

async function startCamera(facing = state.facing) {
  state.facing = facing;
  const constraints = {
    audio: false,
    video: {
      facingMode: facing === 'user' ? 'user' : { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 }
    }
  };
  stopCamera();
  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.video.srcObject = state.stream;
  await state.video.play();
  requestWakeLock();
  const track = state.stream.getVideoTracks()[0];
  const caps = track.getSettings?.() || {};
  log(`camera: ${caps.width || '?'}×${caps.height || '?'} @ ${caps.frameRate || '?'} fps, ${facing === 'user' ? 'front' : 'rear'}`);
  // Mirror only the front camera — the rear camera's view is not a mirror.
  document.body.dataset.mirror = (facing === 'user' && state.settings.mirrorFront) ? '1' : '0';
  return track;
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
}

/* ------------------------------------------------------------------ *\
 * Frame grabbing
 * ------------------------------------------------------------------ */

function grabFrame() {
  if (state.demoCanvas) {
    return state.demoCanvas.getContext('2d').getImageData(0, 0, state.demoCanvas.width, state.demoCanvas.height);
  }
  const v = state.video;
  if (!v || !v.videoWidth) return null;
  // A fixed processing width. The models letterbox internally anyway; 640 px
  // keeps the readback copy cheap while leaving the OCR head enough
  // resolution to read a label at arm's length.
  const target = Math.min(960, Math.max(480, state.settings.grabWidth || 640));
  const scale = target / v.videoWidth;
  const w = Math.round(v.videoWidth * scale);
  const h = Math.round(v.videoHeight * scale);
  if (!state.frameCanvas) {
    state.frameCanvas = document.createElement('canvas');
    state.frameCtx = state.frameCanvas.getContext('2d', { willReadFrequently: true });
  }
  const c = state.frameCanvas;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  state.frameCtx.drawImage(v, 0, 0, w, h);
  try {
    return state.frameCtx.getImageData(0, 0, w, h);
  } catch (err) {
    log(`warn: frame read failed — ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *\
 * Loop
 * ------------------------------------------------------------------ */

function startLoop() {
  let last = performance.now();
  let fpsAcc = 0;
  let fpsCount = 0;
  let lastInferAt = 0;
  let loggedFirst = false;
  let loggedPerfAt = 0;

  const tick = async (t) => {
    requestAnimationFrame(tick);
    const dt = t - last;
    last = t;
    fpsAcc += dt;
    fpsCount++;
    if (fpsAcc > 400) {
      state.fps = 1000 / (fpsAcc / fpsCount);
      fpsAcc = 0; fpsCount = 0;
    }

    if (!state.busy && t - lastInferAt > (state.settings.inferGapMs || 40)) {
      let frame = null;
      try { frame = grabFrame(); }
      catch (err) { warnOnce('grab', `warn: frame grab failed repeatedly — ${err.message}`); }
      if (frame) {
        lastInferAt = t;
        state.frame = frame;
        state.busy = true;
        runInference(frame, t).finally(() => { state.busy = false; });
      }
    }
    renderHud();

    // Two one-line perf reports: the first pass (the moment a tag became
    // possible) and then a steady-state line every few seconds, so a field
    // log answers "how fast is recognition actually running on this device".
    if (!loggedFirst && state.live) {
      loggedFirst = true;
      loggedPerfAt = t;
      const info = state.pipeline.info();
      log(`live: first pass done — scan ${info.scanSize}px, detect ${info.lastInferMs} ms`);
    } else if (loggedFirst && t - loggedPerfAt > 4000) {
      loggedPerfAt = t;
      const info = state.pipeline.info();
      log(`perf: ${state.fps.toFixed(0)} fps display, detect mean ${info.latency.mean} ms (p90 ${info.latency.p90} ms), scan ${info.scanSize}px, modules ${JSON.stringify(info.modules)}`);
    }
  };
  requestAnimationFrame(tick);
}

/** One broken frame must never kill the display loop. */
function renderHud() {
  try {
    state.hud.render(hudState());
    updateStatus();
  } catch (err) {
    warnOnce('render', `warn: HUD render failed repeatedly — ${err.message}`);
  }
}

/** Log a repeating failure once, not every frame. */
function warnOnce(key, message) {
  state._warned = state._warned || new Set();
  if (state._warned.has(key)) return;
  state._warned.add(key);
  log(message);
}

async function runInference(frame, t) {
  try {
    const result = await state.pipeline.processFrame(frame, { time: t });
    state.lastResult = result;
    // The first completed pass is the moment seeing becomes knowing: from
    // here on an empty result describes the scene, not the startup.
    state.live = true;
  } catch (err) {
    log(`warn: frame failed — ${err.message}`);
  }
}

function hudState() {
  const result = state.lastResult;
  const frame = state.frame ? { width: state.frame.width, height: state.frame.height } : null;
  return {
    frame,
    records: result?.records || [],
    texts: result?.texts || [],
    facing: state.facing
  };
}

/** The only two lines of chrome: what is in view, and where it all happens. */
function updateStatus() {
  try {
    const n = state.lastResult?.records?.length || 0;
    const left = $('status-left');
    const right = $('status-right');
    // Three honest states, never blurred: still warming up, looking and
    // finding nothing, and looking and finding something.
    const l = n
      ? `${n} ${n === 1 ? 'object' : 'objects'} recognised`
      : (state.live ? 'no matches in view' : 'recognising');
    if (left && left.textContent !== l) left.textContent = l;
    if (right && right.textContent !== 'on-device · nothing leaves this phone') right.textContent = 'on-device · nothing leaves this phone';
    // Amber while warming, green once recognition is live. "Is it working?"
    // is answered on the feed itself, without a tap or a settings screen.
    const dot = $('status-dot');
    if (dot && dot.classList) {
      if (state.live) dot.classList.remove('warm');
      else dot.classList.add('warm');
    }
  } catch { /* status is cosmetic, never fatal */ }
}

/* ------------------------------------------------------------------ *\
 * Wiring — deliberately almost nothing. The stage has no controls, so the
 * only listeners left are boot recovery and lifecycle hygiene.
 * ------------------------------------------------------------------ */

function bindUI() {
  // Boot-screen recovery: an honest, always-wired retry. A reload re-runs the
  // whole verified boot path, which is the only retry that can fix a wedged
  // download or a permission prompt the browser has forgotten about.
  $('boot-retry')?.addEventListener('click', () => { try { window.location.reload(); } catch { /* a sandboxed frame cannot reload */ } });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // A backgrounded PWA that keeps the camera lit is a privacy bug and a
      // battery bug. Suspend the optics; resume them on return.
      if (!state.demo && state.stream) {
        state.wasStreaming = true;
        stopCamera();
        log('camera: suspended with the page');
      }
    } else if (state.wasStreaming && !state.demo) {
      state.wasStreaming = false;
      startCamera(state.facing)
        .then(() => log('camera: resumed'))
        .catch((err) => log(`warn: camera resume failed — ${err.message}`));
    }
  });
}

/* ------------------------------------------------------------------ *\
 * Demo feed (no camera: uses the bundled sample frame)
 * ------------------------------------------------------------------ */

async function startDemo() {
  log('demo: using bundled sample frame — no camera');
  state.demo = true;
  // A previous failure (camera denied, a stalled download) must not block the
  // demo: it is precisely the fallback for those cases.
  state.bootFailed = false;
  state.bootFailKind = null;
  state.hud.hideBootError();
  prepareDemoFrame();
  const models = await ensureModels();
  state.cameraStatus = { ok: true, demo: true };
  if (!models.ok) {
    failBoot('Model load failed', models.error.message, 'models');
    return;
  }
  if (maybeEnterStage()) log('demo: still frame feeding the full pipeline');
}

/** Decode the bundled sample into a canvas the frame grabber can read. */
function prepareDemoFrame() {
  if (state.demoCanvas || typeof Image === 'undefined') return;
  try {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || 640;
        const h = img.naturalHeight || 480;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        state.demoCanvas = c;
        log(`demo: sample frame ready (${w}×${h})`);
      } catch (err) {
        log(`warn: demo frame could not be drawn — ${err.message}`);
      }
    };
    img.onerror = () => log('warn: demo frame missing (tools/sample-bus.jpg)');
    img.src = 'tools/sample-bus.jpg';
  } catch (err) {
    log(`warn: demo frame unavailable — ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *\
 * Lifecycle helpers
 * ------------------------------------------------------------------ */

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
    log('screen wake lock held');
  } catch { /* not fatal */ }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestWakeLock();
});

/* ------------------------------------------------------------------ *\
 * Start
 * ------------------------------------------------------------------ */

window.addEventListener('error', (event) => log(`error: ${event.message}`));
window.addEventListener('unhandledrejection', (event) => log(`warn: unhandled rejection — ${event.reason?.message || event.reason}`));

function log(message) {
  console.log(`[argus] ${String(message)}`);
}

function start() {
  // Idempotent: module re-import, a duplicated DOMContentLoaded, or a caller
  // that also invokes start() must never run two boots — two camera prompts,
  // two model downloads — side by side.
  if (state.bootPromise) return state.bootPromise;
  state.bootPromise = boot().catch((err) => {
    log(`error: boot failed — ${err.stack || err.message}`);
    const box = document.getElementById('boot-error');
    if (box) box.hidden = false;
    const detail = document.getElementById('boot-detail');
    if (detail) detail.textContent = err.message;
    const demo = document.getElementById('demo-fallback');
    if (demo) demo.hidden = false;
  });
  return state.bootPromise;
}

// A module script runs before DOMContentLoaded, but if the page was already
// parsed (slow module graph, bfcache restore) starting from readyState is safer
// than waiting for an event that has already fired.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

export { state, start, enterStage, maybeEnterStage, startDemo };
