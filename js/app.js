/**
 * app.js — ARGUS boot, camera, frame loop and the glue between the agent
 * modules.
 *
 * The loop runs on two clocks on purpose. The display half runs every animation
 * frame so brackets glide; the inference half runs when the previous pass has
 * finished and enough time has elapsed, so a slow frame never blocks the HUD and
 * a fast device is never throttled by a fixed timer. Everything that could stall
 * a frame — model loads, OCR, pose — happens behind the previous result, with the
 * HUD showing the last known state rather than a frozen screen.
 */

import { Runtime } from './core.js';
import { Pipeline } from './pipeline.js';
import { Memory } from './memory.js';
import { Hud, bindSettingsSheet } from './ui.js';
import { Voice, VoiceInput } from './speech.js';
import { Installer, installGuide, detectPlatform, isSecureContextOk } from './install.js';
import { respond, describeRecord, matchRecord, Narrator } from './agent.js';
import {
  VERSION, loadSettings, saveSettings, applyTheme, resetSettings, LINES, THEMES,
  pick, template, formatDistance, bearingWord, articleFor, categoryColour
} from './config.js';
import { stats as kbStats } from './kb.js';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  settings: null,
  runtime: null,
  pipeline: null,
  memory: null,
  hud: null,
  voice: null,
  voiceInput: null,
  installer: null,
  narrator: null,
  video: null,
  stream: null,
  facing: 'environment',
  paused: false,
  lockedId: null,
  lockedRecord: null,
  frame: null,
  frameCanvas: null,
  frameCtx: null,
  lastResult: null,
  busy: false,
  fps: 0,
  battery: '—',
  wakeLock: null,
  demo: false,
  demoTimer: null,
  queryPending: null,
  teachTarget: null,
  startedAt: Date.now(),
  captureCount: 0,
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

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  state.settings = loadSettings();
  applyTheme(state.settings.theme);
  document.body.dataset.hud = state.settings.hudStyle;
  document.body.dataset.mirror = state.settings.mirrorFront ? '1' : '0';

  state.voice = new Voice(() => state.settings, {
    onCaption: (text, tone) => {
      if (state.settings.subtitles) state.hud?.subtitle(text);
      state.lastSpoken = text;
    },
    onLog: (msg) => log(msg)
  });

  state.installer = new Installer({
    onState: (snap) => state.hud?.setInstall(snap, installGuide(detectPlatform())),
    onLog: (msg) => log(msg)
  });

  state.memory = new Memory({ onLog: (msg) => log(msg) }).load();
  state.memory.beginSession();
  state.narrator = new Narrator({ onLog: (msg) => log(msg) });

  state.video = $('cam');
  state.hud = new Hud({
    canvas: $('hud'),
    video: state.video,
    getSettings: () => state.settings,
    onSelect: (id) => openDetail(id)
  });

  state.hud.setBootStage('READING SETTINGS', 0.05);
  log(`ARGUS ${VERSION} — ${new Date().toLocaleString()}`);
  const kb = kbStats();
  log(`vocabulary: ${kb.objects} objects, ${kb.aliases} aliases, ${kb.brands} brands — ${kb.vocabulary} names total`);

  bindUI();

  // The worker registers before anything heavy moves: it gives the page its
  // offline shell, the install prompt and the update channel regardless of how
  // the camera and model steps play out below.
  registerServiceWorker();

  if (state.settings.voiceCommands && state.voiceInput?.supported) state.voiceInput.start({ continuous: true });

  state.hud.setBootStage('CHECKING HARDWARE', 0.12);
  if (!isSecureContextOk()) {
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
   * permission prompt held a 25 MB download hostage (and vice versa), which on
   * mobile data looked exactly like a wedged loading screen. Each side reports
   * its own outcome; the stage opens only when both have succeeded, and each
   * failure gets its own honest error instead of a silent hang. */
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

/** First terminal failure wins the boot-screen headline; later ones just log. */
function failBoot(title, detail, kind) {
  if (state.bootFailed) return false;
  state.bootFailed = true;
  state.bootFailKind = kind || null;
  state.hud.bootError(title, detail);
  offerDemo();
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

/** The boot screen comes down, the loop starts, the assistant speaks. */
function enterStage() {
  if (!state.pipeline) { log('warn: enterStage before the pipeline exists — ignored'); return; }
  state.hud.hideBootError();
  state.hud.bootReady(`${state.pipeline.detector.info().name} · ${kbStats().objects} objects in vocabulary`);
  state.hud.hideBoot();
  startLoop();
  greet();
  requestOfflineFill();
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const update = () => { state.battery = `${Math.round(b.level * 100)}%${b.charging ? '⚡' : ''}`; };
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    }).catch(() => {});
  }
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
 * Load the compute runtime and the detector, and kick off the optional
 * perception modules in the background. Returns a verdict — `{ ok: true }` or
 * `{ ok: false, error }` — and never throws, because boot decisions are made by
 * the caller, not by a rejection landing somewhere nobody is watching.
 *
 * The detector alone is a usable assistant, so the optional modules load
 * without holding up first light. The model manifest is the contract between
 * the shipped files and this code: checking the digests turns "the fetch
 * returned 200" into "these are the bytes that were tested".
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
          const chips = state.modulesStatus || (state.modulesStatus = {});
          chips[module] = status === 'ready';
          renderModules();
        }
      });
      state.pipeline.teach = state.memory.teach;
      state.pipeline.onVerified = verifySession;
    }

    state.hud.setBootStage('LOADING COMPUTE RUNTIME', 0.2);
    const info = await state.runtime.boot({
      backend: state.settings.backend,
      onStage: (stage, pct) => state.hud.setBootStage(stage, pct)
    });
    log(`compute: ${info.label}, ${info.threads} thread${info.threads > 1 ? 's' : ''}`);
    state.backendLabel = `${info.label}${info.threads > 1 ? ` ×${info.threads}` : ''}`;

    state.hud.setBootStage('LOADING DETECTOR', 0.45);
    await state.pipeline.loadCore({
      onProgress: (pct, msg) => state.hud.setBootStage(msg || 'LOADING DETECTOR', 0.45 + 0.25 * (pct || 0))
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

  state.hud.setBootStage('PERCEPTION MODULES', 0.75);
  enableBySettings({ onProgress: (pct, msg) => {
    if (msg) state.hud.bootStageHint = msg;
  } }).then(() => {
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

async function offerDemo() {
  const btn = $('demo-fallback');
  if (btn) {
    btn.hidden = false;
    btn.onclick = () => startDemo();
  }
}

function greet() {
  const hour = new Date().getHours();
  const key = hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : hour < 23 ? 'greetingEvening' : 'greetingNight';
  const line = template(pick(LINES[key]), { addr: state.settings.address });
  state.voice.say(line, { priority: 2, once: 'greeting' });
}

function registerServiceWorker() {
  // serviceWorker is *absent* on plain http (non-localhost) and can even be
  // present-but-undefined in embedded webviews — feature-detect with optional
  // chaining everywhere, because a throw here would take the whole boot down.
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener?.('message', (event) => {
    const data = event.data || {};
    if (data.type === 'argus-offline-ready') {
      log(`offline cache verified — ${data.total - data.missing}/${data.total} payloads already held, ${data.filled} filled${data.missing - data.filled ? `, ${data.missing - data.filled} deferred to the next online run` : ''}`);
    }
    if (data.type === 'argus-update-cached') {
      log('update: a refreshed build has been cached — it applies on the next launch');
      if (state.enteredStage) state.hud?.toast('Update ready — applies on next launch', 'info', 3600);
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
 * compete with a second copy of 47 MB moving in the background, and on later
 * launches the bytes are already there (the worker cached them as they passed
 * through on their way to the loader).
 */
async function requestOfflineFill() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await withDeadline(navigator.serviceWorker.ready, 15000, () => new Error('no active worker'));
    if (!reg || reg.timedOut || !reg.active) {
      // Not controlled yet (first ever visit): the worker activates itself, so
      // a short delay and one retry lands the message even without a reload.
      setTimeout(() => {
        navigator.serviceWorker.getRegistration?.().then((r) => r?.active?.postMessage({ type: 'argus-ensure-offline' })).catch(() => {});
      }, 4000);
      return;
    }
    reg.active.postMessage({ type: 'argus-ensure-offline' });
  } catch { /* offline fill is opportunistic */ }
}

/* ------------------------------------------------------------------ *
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
  try {
    const gpuCap = track.getCapabilities?.();
    if (gpuCap?.torch) log('note: torch capability present — low light could use it');
  } catch { /* not supported */ }
  return track;
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
}

async function switchCamera() {
  state.voice.say(template(pick(LINES.cameraSwitch), { lens: state.facing === 'user' ? 'forward' : 'self' }), { priority: 2, once: `cam-${Date.now()}` });
  try {
    await startCamera(state.facing === 'user' ? 'environment' : 'user');
  } catch (err) {
    log(`warn: camera switch failed — ${err.message}`);
    state.hud.toast('Camera switch failed', 'warn');
  }
}

/* ------------------------------------------------------------------ *
 * Frame grabbing
 * ------------------------------------------------------------------ */

function grabFrame() {
  // Demo mode has no <video>: the same still frame is re-read every pass so the
  // whole pipeline (detector, classifier, OCR, HUD) runs exactly as it would.
  if (state.demoCanvas) return state.demoCanvas.getContext('2d').getImageData(0, 0, state.demoCanvas.width, state.demoCanvas.height);
  const v = state.video;
  if (!v || !v.videoWidth) return null;
  // Work at a fixed processing width; the detector resizes internally anyway and
  // a smaller buffer keeps the copy (the expensive part) cheap.
  const target = Math.min(960, Math.max(480, state.settings.scanSize * 1.6));
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

/* ------------------------------------------------------------------ *
 * Loop
 * ------------------------------------------------------------------ */

function startLoop() {
  let last = performance.now();
  let fpsAcc = 0;
  let fpsCount = 0;
  let lastInferAt = 0;

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

    if (state.paused || state.demoPending) {
      renderHud();
      return;
    }

    if (!state.busy && t - lastInferAt > 60) {
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
  };
  requestAnimationFrame(tick);
}

/** One broken frame must never kill the display loop. */
function renderHud() {
  try {
    state.hud.render(hudState());
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

    // Lock follows the tracked identity, not the box.
    if (state.lockedId != null) {
      const match = result.records.find((r) => r.id === state.lockedId);
      if (match) {
        state.lockedRecord = match;
        if (state.autoLockClaim !== state.lockedId) {
          state.autoLockClaim = state.lockedId;
          state.voice.say(template(LINES.targetAcquired, { name: match.label }), { priority: 1, once: `lock-${state.lockedId}` });
        }
      } else if (state.lockedRecord && state.frameSeenWithout === undefined) {
        state.frameSeenWithout = 0;
      }
    }

    for (const record of result.records) {
      const obs = state.memory.observe(record);
      if (obs.novel && record.tier >= 3 && record.confidence > 0.5) {
        state.memory.addTimeline({ kind: 'sighting', text: `First sighting: ${record.label}`, label: record.label });
      }
    }

    // Guided search ("find my keys"): keep the user oriented instead of just
    // repeating that the object is not in view.
    const find = evaluateFind(result);

    // Proactive narration.
    const lines = state.narrator.evaluate(result, { settings: state.settings, memory: state.memory, paused: state.paused });
    for (const line of lines) {
      const spoken = normaliseForSpeech(line.text);
      state.voice.say(spoken, { tone: line.tone === 'alert' ? 'alert' : 'info', priority: line.tone === 'alert' ? 3 : 1 });
      state.lastSpoken = spoken;
      if (line.tone === 'alert') state.hud.toast(spoken, 'alert');
      if (line.record) state.tickerId = line.record.id;
    }
    if (find?.line) {
      state.voice.say(normaliseForSpeech(find.line), { priority: find.found ? 2 : 1, tone: find.found ? 'good' : 'info' });
      state.lastSpoken = find.line;
    }
    state.hud._tickerLine = lines[0]?.text || find?.line || state.lastSpoken || '';
  } catch (err) {
    log(`warn: frame failed — ${err.message}`);
  }
}

/**
 * Guided search loop. Once the user asks for something, every frame answers the
 * only question that matters — which way to turn and whether it is getting
 * closer — capped at one utterance every few seconds so it guides without
 * chattering.
 */
function evaluateFind(result) {
  const term = state.findTarget;
  if (!term) return null;
  const records = result?.records || [];
  const rec = matchRecord(records, term);
  const now = performance.now();
  if (rec) {
    const bearing = rec.distance?.bearing ?? 0;
    const dist = rec.distance?.metres ?? null;
    const range = dist != null ? `, about ${formatDistance(dist, state.settings.units)} away` : '';
    let line = null;
    if (now - (state.findLastSpoke || 0) > 3200) {
      const prev = state.findPrev;
      const direction = bearing > 0 ? 'right' : 'left';
      line = Math.abs(bearing) < 8
        ? template(pick(LINES.findCentred), { Name: rec.label, range })
        : template(pick(LINES.findTurn), { Name: rec.label, range, direction });
      if (prev?.dist != null && dist != null) {
        if (dist < prev.dist - Math.max(0.15, prev.dist * 0.08)) line = template(pick(LINES.findClosing), { Name: rec.label, range });
        else if (dist > prev.dist + Math.max(0.25, prev.dist * 0.15)) line = template(pick(LINES.findReceding), { Name: rec.label, range });
      }
      state.findLastSpoke = now;
      state.findFound = true;
    }
    state.findPrev = { dist, bearing };
    return { found: true, record: rec, line };
  }
  state.findPrev = { dist: null, bearing: null };
  state.findFound = false;
  if (now - (state.findLastSpoke || 0) > 9000) {
    state.findLastSpoke = now;
    return { found: false, line: template(pick(LINES.findWait), { term }) };
  }
  return { found: false, line: null };
}

function hudState() {
  const result = state.lastResult;
  const frame = state.frame ? { width: state.frame.width, height: state.frame.height } : null;
  return {
    frame,
    records: result?.records || [],
    texts: result?.texts || [],
    scene: result?.scene || null,
    lighting: result?.lighting || null,
    timing: { detect: result?.timing?.detect || state.pipeline?.lastInferMs || 0 },
    scanSize: result?.scanSize || state.settings.scanSize,
    backend: state.backendLabel || '—',
    fps: state.fps,
    battery: state.battery,
    modules: state.pipeline?.moduleState || {},
    memorySummary: { taught: state.memory.teach.examples.length, known: state.memory.history.size },
    lockedId: state.lockedId,
    paused: state.paused,
    facing: state.facing,
    tickerLine: state.hud?._tickerLine || '',
    find: state.findTarget ? { term: state.findTarget, line: state.findLine || '', found: !!state.findFound } : null,
    lastSpoken: state.lastSpoken || ''
  };
}

/* ------------------------------------------------------------------ *
 * Query handling
 * ------------------------------------------------------------------ */

async function handleQuery(text, { spoken = false } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  log(`query: ${trimmed}`);
  state.hud.subtitle(`“${trimmed}”`);

  const ctx = {
    records: state.lastResult?.records || [],
    scene: state.lastResult?.scene,
    lighting: state.lastResult?.lighting,
    texts: state.lastResult?.texts || [],
    memory: state.memory,
    settings: state.settings,
    locked: state.lockedRecord ? { record: state.lockedRecord } : null
  };

  const reply = respond(trimmed, ctx);
  if (reply.action === 'status') {
    const info = state.pipeline.info();
    const summary = state.memory.summary();
    const line = `${state.backendLabel}. ${state.fps.toFixed(0)} frames per second. Detector ${info.lastInferMs} milliseconds, scanning ${info.scanSize} pixels. ${summary.knownObjects} objects logged, ${summary.taught} taught. ${summary.watching} watch entries.`;
    state.voice.say(line, { priority: 2 });
    return;
  }
  if (reply.action === 'modules') {
    const info = state.pipeline.info();
    const on = Object.entries(state.pipeline.moduleState).filter(([, v]) => v).map(([k]) => k);
    state.voice.say(`Online: ${on.join(', ')}. Detector ${info.models.detector.name}, classifier ${info.models.classifier.dataset}, OCR ${info.models.ocr.name}, pose ${info.models.pose.name}.`, { priority: 2 });
    renderModules();
    state.hud.openModal('modules-sheet');
    return;
  }

  await applyAction(reply);
  const spokenText = reply.detail?.summary || reply.say;
  if (spokenText) {
    state.voice.say(normaliseForSpeech(spokenText), { priority: spoken ? 2 : 2, tone: reply.tone === 'alert' ? 'alert' : 'info' });
    state.lastSpoken = spokenText;
  }
}

async function applyAction(reply) {
  switch (reply.action) {
    case 'highlight':
      state.lockedId = reply.id ?? state.lockedId;
      state.lockedRecord = (state.lastResult?.records || []).find((r) => r.id === reply.id) || state.lockedRecord;
      break;
    case 'lock': {
      const rec = (state.lastResult?.records || []).find((r) => r.id === reply.id);
      state.lockedId = reply.id ?? null;
      state.lockedRecord = rec || null;
      state.hud.toast(`Locked: ${rec?.label || 'target'}`, 'good');
      break;
    }
    case 'unlock':
      state.lockedId = null;
      state.lockedRecord = null;
      state.autoLockClaim = null;
      state.hud.toast('Lock released', 'info');
      break;
    case 'capture':
      await capture();
      break;
    case 'mute':
      state.voice.setMuted(true);
      state.hud.toast('Audio muted', 'warn');
      break;
    case 'unmute':
      state.voice.setMuted(false);
      state.hud.toast('Audio restored', 'good');
      break;
    case 'pause':
      setPaused(true);
      break;
    case 'resume':
      setPaused(false);
      break;
    case 'stop':
      setPaused(true);
      break;
    case 'theme': {
      const wanted = (reply.theme && Object.keys(THEMES).find((k) => k.includes(reply.theme))) || null;
      if (wanted) {
        state.settings.theme = wanted;
        applyTheme(wanted);
        saveSettings(state.settings);
        syncSettingsSheet();
      }
      break;
    }
    case 'detail':
      state.settings.detailMode = state.settings.detailMode === 'off' ? '4' : 'off';
      saveSettings(state.settings);
      syncSettingsSheet();
      state.hud.toast(`Detail mode ${state.settings.detailMode === 'off' ? 'off' : 'on'}`, 'info');
      break;
    case 'fast':
      state.settings.scanSize = 320;
      state.settings.detailMode = 'off';
      saveSettings(state.settings);
      syncSettingsSheet();
      state.hud.toast('Performance mode', 'info');
      break;
    case 'scan':
      state.hud.toast('Full sweep — detail mode for one pass', 'info');
      state.settings.detailMode = '9';
      await new Promise((r) => setTimeout(r, 12000));
      state.settings.detailMode = 'off';
      syncSettingsSheet();
      break;
    case 'voice':
      if (!state.voiceInput?.supported) { state.hud.toast('Voice input unsupported', 'warn'); break; }
      state.voiceInput.start({ continuous: true });
      state.hud.toast('Listening', 'good');
      break;
    case 'find': {
      state.findTarget = reply.term;
      state.findPrev = null;
      state.findFound = false;
      state.findLastSpoke = 0;
      state.hud.toast(`Searching: ${reply.term}`, 'info');
      break;
    }
    case 'unwatch':
      if (state.findTarget && (!reply.term || String(state.findTarget).includes(String(reply.term)))) state.findTarget = null;
      break;
    case 'watch':
      state.hud.toast(`Watching for ${reply.entry?.label || ''}`, 'good');
      break;
    case 'teach': {
      const target = (state.lastResult?.records || []).find((r) => r.id === reply.id) || state.lockedRecord;
      if (target) learnObject(target, reply.label);
      break;
    }
    case 'teach-prompt':
      state.teachTarget = (state.lastResult?.records || []).find((r) => r.id === reply.id) || null;
      openTeach(state.teachTarget);
      break;
    case 'texts':
      if (reply.texts?.length) state.hud.openModal('console-sheet');
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Persistence actions
 * ------------------------------------------------------------------ */

function learnObject(record, label, { thumb = null } = {}) {
  if (!record) return null;
  const embedding = record.embeddingVec || null;
  if (!embedding) {
    state.hud.toast('No appearance fingerprint yet — hold steady and retry', 'warn');
    return null;
  }
  const entry = state.memory.learn({ label, embedding, category: null, tags: record.tags || [], note: record.note || '', crop: thumb });
  state.hud.toast(`Learned: ${label}`, 'good');
  state.voice.say(template(LINES.teachStored, { name: label }), { priority: 2 });
  state.narrator.forget(label);
  renderMemory();
  return entry;
}

function setPaused(flag) {
  state.paused = !!flag;
  const btn = $('btn-pause');
  if (btn) btn.textContent = state.paused ? 'RESUME' : 'PAUSE';
  if (navigator.vibrate && state.settings.haptics) navigator.vibrate(12);
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

async function capture() {
  if (!state.frame) return;
  const w = state.frame.width;
  const h = state.frame.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(state.frame, 0, 0);
  ctx.drawImage(src, 0, 0);
  // Draw the detection layer into the capture so a saved frame is self-explaining.
  const hudCanvas = $('hud');
  if (hudCanvas) {
    try { ctx.drawImage(hudCanvas, 0, 0, w, h); } catch { /* ignore */ }
  }
  const stamp = new Date().toLocaleString();
  const dataUrl = c.toDataURL(`image/${state.settings.captureFormat === 'jpg' ? 'jpeg' : 'png'}`, 0.92);
  state.captureCount++;
  state.hud.addToFilmstrip(dataUrl, stamp);
  state.hud.flash();
  state.voice.say(pick(LINES.captured), { priority: 1, once: `capture-${state.captureCount}` });
  const records = state.lastResult?.records || [];
  state.memory.addTimeline({ kind: 'capture', text: `Captured ${records.length} objects`, count: records.length });
  if (state.settings.saveSessionLog) {
    try {
      const logKey = 'argus.captures.v2';
      const list = JSON.parse(localStorage.getItem(logKey) || '[]');
      list.push({
        at: Date.now(),
        objects: records.slice(0, 20).map((r) => ({
          label: r.label, confidence: Number((r.confidence || 0).toFixed(3)),
          colour: r.attributes?.colour?.name || null,
          material: r.attributes?.material?.name || null,
          distance: r.distance?.metres ? Number(r.distance.metres.toFixed(2)) : null,
          text: r.text || null
        })),
        scene: state.lastResult?.scene?.label || null
      });
      localStorage.setItem(logKey, JSON.stringify(list.slice(-60)));
    } catch { /* storage full */ }
  }
  state.hud.toast('Capture stored', 'good');
}

/* ------------------------------------------------------------------ *
 * Detail sheet
 * ------------------------------------------------------------------ */

function openDetail(id) {
  const rec = (state.lastResult?.records || []).find((r) => r.id === id);
  if (!rec) return;
  state.lockedRecord = rec;
  renderDetail(rec);
  state.hud.openModal('detail-sheet');
}

function renderDetail(rec, { silent = false } = {}) {
  const body = $('detail-body');
  const title = $('detail-title');
  const foot = $('detail-foot');
  if (!body || !rec) return;
  title.textContent = rec.label;
  const thumb = state.frame ? state.pipeline.cropForDisplay(state.frame, rec.box, 128) : null;

  const rows = [];
  rows.push(['category', rec.category]);
  rows.push(['confidence', `${Math.round((rec.confidence || 0) * 100)}% (${rec.source})`]);
  if (rec.brand) rows.push(['brand', `${rec.brand.name}${rec.brand.exact ? '' : ' (partial match)'}`]);
  if (rec.text) rows.push(['text read', `“${rec.text}”`]);
  if (rec.attributes?.colour) rows.push(['colour', `${rec.attributes.colour.name} · ${rec.attributes.colour.hex} · hue ${rec.attributes.colour.hue}°`]);
  if (rec.attributes?.finish) rows.push(['finish', rec.attributes.finish]);
  if (rec.attributes?.pattern && rec.attributes.pattern.id !== 'solid') rows.push(['pattern', rec.attributes.pattern.label]);
  if (rec.attributes?.shape?.form) rows.push(['shape', `${rec.attributes.shape.form} (fill ${Math.round(rec.attributes.shape.fill * 100)}%)`]);
  if (rec.distance?.metres) {
    rows.push(['distance', `${formatDistance(rec.distance.metres, state.settings.units)} (${formatDistance(rec.distance.min, state.settings.units)}–${formatDistance(rec.distance.max, state.settings.units)}, ${rec.distance.method})`]);
    rows.push(['bearing', `${bearingWord(rec.distance.bearing)} (${rec.distance.bearing.toFixed(1)}°)`]);
  }
  if (rec.pose) rows.push(['posture', rec.posture || 'unknown']);
  if (rec.activity) rows.push(['activity', rec.activity.label]);
  if (rec.gesture) rows.push(['gesture', rec.gesture]);
  if (rec.motion && rec.motion.id !== 'stationary') rows.push(['motion', `${rec.motion.label} (${Math.round(rec.motion.speed)} px/s)`]);
  if (rec.tier) rows.push(['interest tier', String(rec.tier)]);
  if (rec.note) rows.push(['note', rec.note]);
  if (rec.hazard) rows.push(['hazard', rec.hazard.note || rec.hazard.kind]);
  if (rec.taught) rows.push(['taught', `${rec.taught.label} · ${(rec.taught.score * 100).toFixed(0)}% match · ${rec.taught.samples} samples`]);
  if (rec.age) rows.push(['tracked for', `${(rec.age / 1000).toFixed(1)} s`]);
  if (rec.on) rows.push(['resting on', rec.on]);
  if (rec.supports?.length) rows.push(['on it', rec.supports.join(', ')]);
  if (rec.attributes?.samples) rows.push(['appearance reads', String(rec.attributes.samples)]);

  const mats = (rec.attributes?.materials || []).slice(0, 4);
  const cls = (rec.classifier || []).slice(0, 5);
  const palette = rec.attributes?.colour?.palette || [];

  body.innerHTML = `
    <div class="detail-hero">
      ${thumb ? `<img src="${thumb}" alt="object">` : ''}
      <div>
        <h3>${escapeHtml(rec.label)}</h3>
        <p>${escapeHtml(rec.note || rec.category)}</p>
        ${rec.hazard ? `<p style="color:#ff5b5b">⚠ ${escapeHtml(rec.hazard.note || rec.hazard.kind)}</p>` : ''}
      </div>
    </div>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
    ${palette.length ? `<h3>Palette</h3><div class="swatches">${palette.map((p) => `<span class="swatch"><i style="background:${p.hex}"></i>${escapeHtml(p.name)} ${p.weight}%</span>`).join('')}</div>` : ''}
    ${mats.length ? `<h3>Material composition</h3><div class="bars">${mats.map((m) => `<div class="bar"><span>${escapeHtml(m.name)}</span><i style="width:${Math.round(m.score * 100)}%"></i><em>${Math.round(m.score * 100)}%</em></div>`).join('')}</div>` : ''}
    ${cls.length ? `<h3>Classifier</h3><div class="bars">${cls.map((c) => `<div class="bar"><span>${escapeHtml(c.name)}</span><i style="width:${Math.round(c.prob * 100)}%"></i><em>${Math.round(c.prob * 100)}%</em></div>`).join('')}</div>` : ''}
    <div class="pill-row">
      <span class="tag">id ${rec.id}</span>
      <span class="tag">hits ${rec.hits}</span>
      ${rec.tags?.length ? rec.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : ''}
    </div>
  `;

  foot.innerHTML = `
    <button class="btn ghost" data-act="say">Read aloud</button>
    <button class="btn ghost" data-act="teach">Teach</button>
    <button class="btn ghost" data-act="watch">Watch for</button>
    <button class="btn" data-act="lock">${state.lockedId === rec.id ? 'Unlock' : 'Lock'}</button>
  `;
  foot.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'say') state.voice.say(describeRecord(rec, state.settings), { priority: 2 });
      if (act === 'teach') openTeach(rec);
      if (act === 'watch') { state.memory.watch(rec.label); state.hud.toast(`Watching for ${rec.label}`, 'good'); }
      if (act === 'lock') {
        if (state.lockedId === rec.id) { state.lockedId = null; state.lockedRecord = null; }
        else { state.lockedId = rec.id; state.lockedRecord = rec; state.hud.toast(`Locked: ${rec.label}`, 'good'); }
        renderDetail(rec);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Teach
 * ------------------------------------------------------------------ */

function openTeach(rec) {
  if (!rec) { state.hud.toast('Select an object first', 'warn'); return; }
  state.teachTarget = rec;
  const preview = $('teach-preview');
  const thumb = state.frame ? state.pipeline.cropForDisplay(state.frame, rec.box, 128) : null;
  if (preview) preview.innerHTML = thumb ? `<img src="${thumb}" alt="teach">` : '';
  const input = $('teach-label');
  if (input) { input.value = ''; input.placeholder = `e.g. my ${rec.label}`; }
  const suggest = $('teach-suggest');
  if (suggest) {
    const guesses = [rec.label, ...(rec.classifier || []).slice(0, 3).map((c) => c.name)].filter((v, i, a) => a.indexOf(v) === i);
    suggest.innerHTML = guesses.map((g) => `<button data-g="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
    suggest.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (input) input.value = b.dataset.g; }));
  }
  state.hud.openModal('teach-sheet');
}

function confirmTeach() {
  const input = $('teach-label');
  const label = (input?.value || '').trim();
  if (!label) { state.hud.toast('Type a name first', 'warn'); return; }
  const rec = state.teachTarget;
  const thumb = rec && state.frame ? state.pipeline.cropForDisplay(state.frame, rec.box, 96) : null;
  if (rec) learnObject(rec, label, { thumb });
  state.hud.closeModal('teach-sheet');
}

/* ------------------------------------------------------------------ *
 * Sheets: memory / modules / console
 * ------------------------------------------------------------------ */

function renderMemory() {
  const body = $('memory-body');
  if (!body) return;
  const summary = state.memory.summary();
  const taught = state.memory.teach.labels();
  const watch = state.memory.watchlist;
  const recent = state.memory.recent(10);
  body.innerHTML = `
    <h3>Summary</h3>
    <dl class="kv">
      <dt>sessions</dt><dd>${summary.sessions}</dd>
      <dt>objects known</dt><dd>${summary.knownObjects}</dd>
      <dt>observations</dt><dd>${summary.observations}</dd>
      <dt>taught</dt><dd>${summary.taught}</dd>
      <dt>watching</dt><dd>${summary.watching}</dd>
      <dt>hazards logged</dt><dd>${summary.hazards}</dd>
    </dl>
    <h3>Taught objects</h3>
    ${taught.length ? taught.map((t) => `
      <div class="mem-row">
        <span><b>${escapeHtml(t.label)}</b><br><span>${t.samples} sample${t.samples > 1 ? 's' : ''}</span></span>
        <span class="mem-actions"><button data-forget="${escapeHtml(t.label)}">Forget</button></span>
      </div>`).join('') : '<p class="hint">Nothing taught yet. “Teach this as my inhaler.”</p>'}
    <h3>Watchlist</h3>
    ${watch.length ? watch.map((w) => `
      <div class="mem-row">
        <span><b>${escapeHtml(w.label)}</b><br><span>${w.hits} hit${w.hits === 1 ? '' : 's'}</span></span>
        <span class="mem-actions"><button data-unwatch="${escapeHtml(w.term)}">Remove</button></span>
      </div>`).join('') : '<p class="hint">Nothing on the watchlist.</p>'}
    <h3>Recently seen</h3>
    ${recent.length ? recent.map((r) => `
      <div class="mem-row">
        <span><b>${escapeHtml(r.label)}</b><br><span>${r.count}× · ${new Date(r.lastSeen).toLocaleTimeString()}</span></span>
        <span class="mem-actions"><button data-count="${escapeHtml(r.label)}">Count</button></span>
      </div>`).join('') : '<p class="hint">Nothing logged yet.</p>'}
  `;
  body.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', () => {
    state.memory.forget(b.dataset.forget);
    renderMemory();
  }));
  body.querySelectorAll('[data-unwatch]').forEach((b) => b.addEventListener('click', () => {
    state.memory.unwatch(b.dataset.unwatch);
    renderMemory();
  }));
  body.querySelectorAll('[data-count]').forEach((b) => b.addEventListener('click', () => {
    const res = state.memory.countOf(b.dataset.count);
    state.hud.toast(`${b.dataset.count}: ${res.total} sighting${res.total === 1 ? '' : 's'}`, 'info');
  }));
}

function renderModules() {
  const body = $('modules-body');
  if (!body || !state.pipeline) return;
  const info = state.pipeline.info();
  const defs = [
    ['detector', 'Detector', `${info.models.detector.name} · COCO-80, tiled detail pass`, true, null],
    ['classifier', 'Classifier', `${info.models.classifier.name} · ${info.models.classifier.dataset} · ${info.counts.classifications} calls`, state.settings.moduleClassifier, 'classifier'],
    ['ocr', 'Text & brands', `${info.models.ocr.name} · ${info.counts.ocrRuns} reads`, state.settings.moduleOcr, 'ocr'],
    ['pose', 'Body pose', `${info.models.pose.name} · ${info.counts.poseRuns} passes`, state.settings.modulePose, 'pose'],
    ['hands', 'Hands & gestures', 'YOLOv8n-hand int8 · 21 keypoints', state.settings.moduleHands, 'hands']
  ];
  body.innerHTML = defs.map(([key, name, detail, wanted, toggle]) => {
    const ready = !!info.modules[key];
    const klass = ready ? 'on' : wanted ? 'busy' : '';
    const label = ready ? 'online' : wanted ? 'loading' : 'off';
    return `<div class="module">
      <div>
        <h4>${name}</h4>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div style="text-align:right">
        <span class="state ${klass}">${label}</span>
        ${toggle ? `<div style="margin-top:6px"><button class="tag" data-toggle="${toggle}">${wanted ? 'disable' : 'enable'}</button></div>` : ''}
      </div>
    </div>`;
  }).join('') + `<p class="hint">Vocabulary: ${kbStats().objects} objects, ${kbStats().imagenet} ImageNet classes, ${kbStats().brands} brands — ${kbStats().vocabulary} names in total. Taught examples: ${state.memory.teach.examples.length}.</p>`;

  body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const mod = b.dataset.toggle;
    const key = { classifier: 'moduleClassifier', ocr: 'moduleOcr', pose: 'modulePose', hands: 'moduleHands' }[mod];
    state.settings[key] = !state.settings[key];
    saveSettings(state.settings);
    syncSettingsSheet();
    if (state.settings[key]) {
      b.textContent = 'loading…';
      try { await state.pipeline.enable(mod); } catch (err) { log(`warn: ${mod} — ${err.message}`); }
    }
    renderModules();
  }));
}

function renderConsole() {
  const body = $('console-log');
  if (body) body.scrollTop = body.scrollHeight;
}

function log(message) {
  const line = String(message);
  console.log(`[argus] ${line}`);
  state.hud?.logLine(line, /^warn|error/.test(line) ? 'warn' : /^note/.test(line) ? 'note' : 'sys');
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

let settingsSheet = null;

function bindUI() {
  settingsSheet = bindSettingsSheet(state.settings, {
    onChange: onSettingChange,
    onTheme: (theme) => {
      state.settings.theme = theme;
      applyTheme(theme);
      saveSettings(state.settings);
      state.hud.toast(`Theme: ${THEMES[theme]?.label || theme}`, 'info');
    },
    onAction: (action) => {
      if (action === 'reset') {
        state.settings = resetSettings();
        applyTheme(state.settings.theme);
        syncSettingsSheet();
        state.hud.toast('Settings reset', 'good');
      }
      if (action === 'diagnostics') {
        state.hud.openModal('console-sheet');
        log(JSON.stringify(state.pipeline?.info() || {}, null, 1).slice(0, 1200));
      }
    }
  });
  syncSettingsSheet();

  $('btn-settings')?.addEventListener('click', () => { syncSettingsSheet(); state.hud.openModal('settings-sheet'); });
  $('btn-console')?.addEventListener('click', () => { renderConsole(); state.hud.openModal('console-sheet'); });
  $('btn-memory')?.addEventListener('click', () => { renderMemory(); state.hud.openModal('memory-sheet'); });
  $('btn-modules')?.addEventListener('click', () => { renderModules(); state.hud.openModal('modules-sheet'); });
  $('btn-mic')?.addEventListener('click', () => onMic());
  $('btn-ask')?.addEventListener('click', submitQuery);
  $('query-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuery(); });
  $('engage')?.addEventListener('click', switchCamera);
  $('shutter')?.addEventListener('click', capture);
  $('btn-pause')?.addEventListener('click', () => setPaused(!state.paused));
  $('btn-detail')?.addEventListener('click', async () => {
    state.settings.detailMode = state.settings.detailMode === 'off' ? '4' : state.settings.detailMode === '4' ? '9' : 'off';
    saveSettings(state.settings);
    syncSettingsSheet();
    state.hud.toast(`Detail: ${state.settings.detailMode}`, 'info');
  });
  $('btn-mode-scan')?.addEventListener('click', () => {
    const sizes = [320, 416, 512, 640];
    const i = sizes.indexOf(Number(state.settings.scanSize));
    state.settings.scanSize = sizes[(i + 1) % sizes.length];
    saveSettings(state.settings);
    syncSettingsSheet();
    state.hud.toast(`Scan size ${state.settings.scanSize}px`, 'info');
  });
  // Boot-screen recovery: an honest, always-wired retry. A reload re-runs the
  // whole verified boot path, which is the only retry that can fix a wedged
  // download or a permission prompt the browser has forgotten about.
  $('boot-retry')?.addEventListener('click', () => { try { window.location.reload(); } catch { /* a sandboxed frame cannot reload */ } });

  $('teach-save')?.addEventListener('click', confirmTeach);
  $('teach-cancel')?.addEventListener('click', () => state.hud.closeModal('teach-sheet'));
  $('memory-export')?.addEventListener('click', exportMemory);
  $('memory-import')?.addEventListener('click', importMemory);
  $('memory-clear')?.addEventListener('click', () => {
    if (confirm('Forget every taught object and all history?')) {
      state.memory.clear();
      renderMemory();
      state.hud.toast('Memory cleared', 'warn');
    }
  });

  const voiceList = $('set-voiceuri');
  if (voiceList) {
    voiceList.innerHTML = '<option value="">System default</option>';
    setTimeout(() => {
      const voices = state.voice.listVoices();
      for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.uri;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceList.appendChild(opt);
      }
    }, 800);
  }

  state.voiceInput = new VoiceInput({
    onFinal: (text) => { if (text) handleQuery(text, { spoken: true }); },
    onInterim: (text) => state.hud.subtitle(`… ${text}`),
    onState: (s) => {
      const mic = $('btn-mic');
      if (mic) mic.style.borderColor = s === 'listening' ? '#6dff9b' : '';
    },
    onLog: (msg) => log(msg)
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.voice.flush();
      setPaused(true);
      // A backgrounded PWA that keeps the camera lit is a privacy bug and a
      // battery bug. Suspend the optics; resume them on return.
      if (!state.demo && state.stream) {
        state.wasStreaming = true;
        stopCamera();
        log('camera: suspended with the page');
      }
    } else {
      if (state.wasStreaming && !state.demo) {
        state.wasStreaming = false;
        startCamera(state.facing)
          .then(() => log('camera: resumed'))
          .catch((err) => {
            log(`warn: camera resume failed — ${err.message}`);
            state.hud?.toast('Camera resume failed — tap Retry on relaunch', 'warn');
          });
      }
      setPaused(false);
    }
  });

  // Handle manifest shortcuts: ?action=capture|status|settings
  const action = new URLSearchParams(window.location.search || '').get('action');
  if (action === 'capture') setTimeout(() => capture(), 2500);
  if (action === 'status') setTimeout(() => handleQuery('status'), 2500);
  if (action === 'settings') setTimeout(() => state.hud.openModal('settings-sheet'), 1200);
}

function onMic() {
  if (!state.voiceInput?.supported) {
    state.hud.toast('Voice input needs Chrome or Safari', 'warn');
    return;
  }
  state.voiceInput.toggle();
  state.hud.subtitle('Listening…');
}

function submitQuery() {
  const input = $('query-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (state.teachTarget && $('teach-sheet')?.classList.contains('open')) {
    if (input) input.value = text;
    return;
  }
  handleQuery(text);
}

function onSettingChange(key, value) {
  saveSettings(state.settings);
  switch (key) {
    case 'hudStyle':
      document.body.dataset.hud = value;
      break;
    case 'mirrorFront':
      document.body.dataset.mirror = (state.settings.mirrorFront && state.facing === 'user') ? '1' : '0';
      break;
    case 'voiceEnabled':
      if (!value) state.voice.flush();
      break;
    case 'voiceURI':
      state.voice._loadVoices();
      break;
    case 'backend':
      log('note: backend change applies on next launch');
      break;
    case 'moduleClassifier':
    case 'moduleOcr':
    case 'modulePose':
    case 'moduleHands': {
      const module = { moduleClassifier: 'classifier', moduleOcr: 'ocr', modulePose: 'pose', moduleHands: 'hands' }[key];
      if (value) state.pipeline.enable(module).then(() => renderModules()).catch((err) => log(`warn: ${module} — ${err.message}`));
      break;
    }
    default:
      break;
  }
}

function syncSettingsSheet() {
  settingsSheet?.sync();
}

/* ------------------------------------------------------------------ *
 * Memory import / export
 * ------------------------------------------------------------------ */

function exportMemory() {
  const blob = new Blob([state.memory.export()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `argus-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  state.hud.toast('Memory exported', 'good');
}

function importMemory() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = state.memory.import(await file.text());
      state.pipeline.teach = state.memory.teach;
      state.pipeline.onVerified = verifySession;
      renderMemory();
      state.hud.toast(`Imported ${result.taught} taught, ${result.known} known`, 'good');
    } catch (err) {
      state.hud.toast(`Import failed: ${err.message}`, 'alert');
    }
  };
  input.click();
}

/* ------------------------------------------------------------------ *
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
  if (maybeEnterStage()) state.hud.toast('Demo feed active — bundled still frame', 'info');
  log('demo: still frame feeding the full pipeline');
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

/* ------------------------------------------------------------------ *
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Speech-friendly text: expand symbols the synthesiser reads badly. */
function normaliseForSpeech(text) {
  return String(text)
    .replace(/·/g, ',')
    .replace(/%/g, ' percent')
    .replace(/&/g, ' and ')
    .replace(/“|”/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function enableBySettings({ onProgress } = {}) {
  const modules = [];
  if (state.settings.moduleClassifier) modules.push('classifier');
  if (state.settings.moduleOcr) modules.push('ocr');
  if (state.settings.modulePose) modules.push('pose');
  if (state.settings.moduleHands) modules.push('hands');
  return state.pipeline.enableAll({ modules, onProgress: (pct, msg) => onProgress?.(pct, msg) });
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

window.addEventListener('error', (event) => log(`error: ${event.message}`));
window.addEventListener('unhandledrejection', (event) => log(`warn: unhandled rejection — ${event.reason?.message || event.reason}`));

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

export { state, start, enterStage, maybeEnterStage, startDemo, handleQuery, capture, learnObject, normaliseForSpeech };
