/**
 * ARGUS — Adaptive Recognition & Guidance Utility System
 * config.js — class taxonomy, theming, phrase bank and persisted settings.
 */

export const VERSION = '1.1.0';
export const BUILD = 'ARGUS-1.1.0/arm64';

/* ------------------------------------------------------------------ *
 * COCO-80 taxonomy (the classes the bundled YOLOv8-nano model emits)
 * ------------------------------------------------------------------ */
export const CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush'
];

/** Display names used in the HUD (short, upper-case friendly). */
export const DISPLAY_NAMES = {
  person: 'PERSON', bicycle: 'BICYCLE', car: 'CAR', motorcycle: 'MOTORCYCLE',
  airplane: 'AIRCRAFT', bus: 'BUS', train: 'TRAIN', truck: 'TRUCK', boat: 'VESSEL',
  'traffic light': 'SIGNAL', 'fire hydrant': 'HYDRANT', 'stop sign': 'STOP SIGN',
  'parking meter': 'METER', bench: 'BENCH', bird: 'BIRD', cat: 'CAT', dog: 'DOG',
  horse: 'HORSE', sheep: 'SHEEP', cow: 'COW', elephant: 'ELEPHANT', bear: 'BEAR',
  zebra: 'ZEBRA', giraffe: 'GIRAFFE', backpack: 'BACKPACK', umbrella: 'UMBRELLA',
  handbag: 'BAG', tie: 'TIE', suitcase: 'CASE', frisbee: 'FRISBEE', skis: 'SKIS',
  snowboard: 'SNOWBOARD', 'sports ball': 'BALL', kite: 'KITE', 'baseball bat': 'BAT',
  'baseball glove': 'GLOVE', skateboard: 'SKATEBOARD', surfboard: 'SURFBOARD',
  'tennis racket': 'RACKET', bottle: 'BOTTLE', 'wine glass': 'GLASS', cup: 'CUP',
  fork: 'FORK', knife: 'KNIFE', spoon: 'SPOON', bowl: 'BOWL', banana: 'BANANA',
  apple: 'APPLE', sandwich: 'SANDWICH', orange: 'ORANGE', broccoli: 'BROCCOLI',
  carrot: 'CARROT', 'hot dog': 'HOT DOG', pizza: 'PIZZA', donut: 'DONUT', cake: 'CAKE',
  chair: 'CHAIR', couch: 'SOFA', 'potted plant': 'PLANT', bed: 'BED',
  'dining table': 'TABLE', toilet: 'FIXTURE', tv: 'DISPLAY', laptop: 'LAPTOP',
  mouse: 'MOUSE', remote: 'REMOTE', keyboard: 'KEYBOARD', 'cell phone': 'PHONE',
  microwave: 'MICROWAVE', oven: 'OVEN', toaster: 'TOASTER', sink: 'SINK',
  refrigerator: 'FRIDGE', book: 'BOOK', clock: 'CLOCK', vase: 'VASE',
  scissors: 'SCISSORS', 'teddy bear': 'TEDDY', 'hair drier': 'DRYER',
  toothbrush: 'TOOTHBRUSH'
};

/** Groupings drive HUD colour and the spoken register. */
const CATEGORY_GROUPS = {
  crew: ['person'],
  vehicle: ['bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat'],
  animal: ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'],
  tech: ['tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
    'toaster', 'sink', 'refrigerator', 'clock', 'hair drier'],
  carry: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'],
  kit: ['frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat',
    'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'scissors', 'teddy bear',
    'toothbrush', 'vase', 'book', 'traffic light', 'fire hydrant', 'stop sign',
    'parking meter', 'bench'],
  table: ['bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl'],
  rations: ['banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog',
    'pizza', 'donut', 'cake'],
  interior: ['chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet']
};

export const CATEGORIES = {
  crew:     { label: 'CREW',     colour: '#4ce0ff' },
  vehicle:  { label: 'VEHICLE',  colour: '#ffd166' },
  animal:   { label: 'BIOTA',    colour: '#7dff9b' },
  tech:     { label: 'TECH',     colour: '#9d8bff' },
  carry:    { label: 'KIT',      colour: '#ff9de0' },
  kit:      { label: 'OBJECT',   colour: '#c9d4e4' },
  table:    { label: 'SERVICE',  colour: '#ffa14c' },
  rations:  { label: 'RATION',   colour: '#ffe066' },
  interior: { label: 'FURNISH',  colour: '#8fb3a8' }
};

/** Interest tier: 3 = call out the moment it appears, 1 = log quietly. */
const PRIORITY_3 = new Set([
  'person', 'car', 'bus', 'truck', 'motorcycle', 'bicycle', 'train', 'boat', 'airplane',
  'dog', 'cat', 'bird', 'horse', 'cell phone', 'laptop', 'knife', 'fire hydrant', 'stop sign'
]);
const PRIORITY_2 = new Set([
  'cow', 'sheep', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'suitcase', 'handbag',
  'bottle', 'cup', 'book', 'tv', 'chair', 'umbrella', 'skateboard', 'sports ball',
  'traffic light', 'scissors'
]);

export const CLASS_META = (() => {
  const meta = {};
  for (const name of CLASSES) {
    let category = 'kit';
    for (const [key, list] of Object.entries(CATEGORY_GROUPS)) if (list.includes(name)) { category = key; break; }
    meta[name] = {
      name,
      display: DISPLAY_NAMES[name] || name.toUpperCase(),
      category,
      colour: CATEGORIES[category].colour,
      priority: PRIORITY_3.has(name) ? 3 : PRIORITY_2.has(name) ? 2 : 1
    };
  }
  return meta;
})();

const AN_EXCEPTIONS = new Set(['airplane', 'apple', 'elephant', 'orange', 'umbrella', 'oven', 'orange']);
export const articleFor = (word) => (AN_EXCEPTIONS.has(word) ? 'an' : 'a');

/* ------------------------------------------------------------------ *
 * Themes — each theme supplies CSS variables + the HUD accent colour.
 * ------------------------------------------------------------------ */
export const THEMES = {
  arc: {
    label: 'ARC',
    accent: '#4ce0ff',
    vars: {
      '--accent': '#4ce0ff', '--accent-dim': '#1b6f8c', '--accent-glow': 'rgba(76,224,255,.35)',
      '--bg-0': '#02060c', '--bg-1': '#061420', '--bg-2': 'rgba(6,20,32,.72)',
      '--ink': '#dff6ff', '--line': 'rgba(76,224,255,.22)'
    }
  },
  mark7: {
    label: 'MARK VII',
    accent: '#ffb347',
    vars: {
      '--accent': '#ffb347', '--accent-dim': '#8a5a12', '--accent-glow': 'rgba(255,179,71,.32)',
      '--bg-0': '#0b0703', '--bg-1': '#1a1005', '--bg-2': 'rgba(26,16,5,.72)',
      '--ink': '#ffeed6', '--line': 'rgba(255,179,71,.22)'
    }
  },
  ghost: {
    label: 'GHOST',
    accent: '#e8f4ff',
    vars: {
      '--accent': '#e8f4ff', '--accent-dim': '#6d8296', '--accent-glow': 'rgba(232,244,255,.22)',
      '--bg-0': '#05070a', '--bg-1': '#0d1219', '--bg-2': 'rgba(13,18,25,.72)',
      '--ink': '#eef6ff', '--line': 'rgba(232,244,255,.18)'
    }
  },
  matrix: {
    label: 'GREEN',
    accent: '#6dff9b',
    vars: {
      '--accent': '#6dff9b', '--accent-dim': '#1f6b3c', '--accent-glow': 'rgba(109,255,155,.3)',
      '--bg-0': '#010604', '--bg-1': '#03150c', '--bg-2': 'rgba(3,21,12,.72)',
      '--ink': '#d8ffe8', '--line': 'rgba(109,255,155,.22)'
    }
  }
};

/* ------------------------------------------------------------------ *
 * Phrase bank — the "personality" of the assistant.
 * ------------------------------------------------------------------ */
export const LINES = {
  boot: [
    'Initialising optical sensor.',
    'Loading neural core.',
    'Calibrating visual cortex.',
    'Systems nominal.'
  ],
  greetingMorning: ['Good morning. {addr}. All systems are online.'],
  greetingAfternoon: ['Good afternoon, {addr}. Standing by.'],
  greetingEvening: ['Good evening, {addr}. Optics engaged.'],
  greetingNight: ['Working late, {addr}? Argus is online.'],
  engage: ['Optics engaged. I will call out anything of interest.'],
  cameraSwitch: ['Switching to {lens} optics.'],
  targetAcquired: ['Target acquired: {name}.'],
  targetLocked: ['Locked onto {name}.'],
  targetLost: ['{Name} lost. Resuming wide scan.'],
  targetCleared: ['Lock released. Wide scan restored.'],
  foundOne: ['{Addr}, I have {article} {name} in view.', '{Article} {name} detected.', 'I see {article} {name}, {addr}.'],
  foundMany: ['{Count} {plural} detected.', 'I count {count} {plural}.', '{Count} {plural} in view.'],
  reacquired: ['{Name} reacquired.'],
  lost: ['{Name} no longer in view.'],
  proximityNear: ['{Name} is very close.', '{Name} right ahead, {addr}.'],
  voiceOn: ['Voice command channel open. I am listening.'],
  voiceOff: ['Voice command channel closed.'],
  muted: ['Audio muted.'],
  unmuted: ['Audio restored.'],
  captured: ['Capture stored.'],
  quiet: ['Standing by.'],
  themeSwitch: ['Interface set to {theme} palette.'],
  scanStart: ['Running a full spectrum sweep.'],
  nothing: ['Nothing of interest in view, {addr}.'],
  help: ['Tap the ring to switch optics. Hold the display to lock a target. Tap a bracket to query an object.']
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */
export const STORAGE_KEY = 'argus.settings.v1';

export const DEFAULTS = {
  theme: 'arc',
  minConfidence: 0.42,
  scanSize: 416,              // 320 | 416 | 512 | 640
  adaptive: true,             // step scan size with measured latency
  maxDetections: 24,
  showBoxes: true,
  showLabels: true,
  showConfidence: true,
  showProximity: true,
  showHud: true,
  showReticle: true,
  mirrorFront: true,
  voiceEnabled: true,
  voiceURI: '',               // '' = auto-pick best en-GB voice
  voiceRate: 1.02,
  voicePitch: 0.92,
  voiceVolume: 1,
  cadence: 'standard',        // quiet | standard | chatty
  address: 'sir',             // how Argus addresses you
  subtitles: true,
  haptics: true,
  voiceCommands: false,
  autoLock: false,
  backend: 'auto'             // auto | webgpu | wasm
};

export function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { stored = {}; }
  const s = { ...DEFAULTS, ...stored };
  if (!THEMES[s.theme]) s.theme = DEFAULTS.theme;
  if (![320, 416, 512, 640].includes(Number(s.scanSize))) s.scanSize = DEFAULTS.scanSize;
  return s;
}

export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function applyTheme(themeKey) {
  const theme = THEMES[themeKey] || THEMES.arc;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.vars['--bg-0']);
  root.dataset.theme = themeKey;
  return theme;
}

/* Small string helpers -------------------------------------------------- */
export const plural = (word, n) => (n === 1 ? word : /(s|x|ch|sh)$/.test(word) ? `${word}es` : `${word}s`);
export const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const now = () => performance.now();

/** Fill {Placeholders} inside a phrase-bank line. */
export function template(str, vars = {}) {
  return str.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in vars) return vars[key];
    const lc = key.toLowerCase();
    if (lc in vars) return vars[lc];
    return '';
  }).replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export function pick(list, seed) {
  if (!list || !list.length) return '';
  const i = seed === undefined ? Math.floor(Math.random() * list.length) : Math.abs(Math.floor(seed)) % list.length;
  return list[i];
}
