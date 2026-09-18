/**
 * config.js — taxonomy, themes, phrase bank, settings.
 *
 * The category table is the single source of truth for HUD colour, spoken
 * register and scene inference, so it covers everything the perception stack can
 * say — not just the 80 COCO classes but the ~1800 things the knowledge base and
 * ImageNet head can name.
 */

export const VERSION = '2.0.0';
export const BUILD = 'ARGUS-2.0.0/vision-agent';

/* ------------------------------------------------------------------ *
 * Category taxonomy
 * ------------------------------------------------------------------ */

export const CATEGORIES = {
  person:     { label: 'CREW',      colour: '#4ce0ff', register: 'crew' },
  face:       { label: 'FACE',      colour: '#7fe8ff', register: 'crew' },
  vehicle:    { label: 'VEHICLE',   colour: '#ffd166', register: 'vehicle' },
  animal:     { label: 'BIOTA',     colour: '#7dff9b', register: 'animal' },
  plant:      { label: 'FLORA',     colour: '#5fd27a', register: 'flora' },
  food:       { label: 'RATION',    colour: '#ffe066', register: 'ration' },
  kitchen:    { label: 'SERVICE',   colour: '#ffa14c', register: 'service' },
  appliance:  { label: 'APPLIANCE', colour: '#ff9d5c', register: 'appliance' },
  tech:       { label: 'TECH',      colour: '#9d8bff', register: 'tech' },
  device:     { label: 'DEVICE',    colour: '#9d8bff', register: 'tech' },
  fitting:    { label: 'FITTING',   colour: '#ffb2d8', register: 'fitting' },
  tool:       { label: 'TOOL',      colour: '#8ab4ff', register: 'tool' },
  furniture:  { label: 'FURNISH',   colour: '#8fb3a8', register: 'furniture' },
  textile:    { label: 'TEXTILE',   colour: '#d4a5ff', register: 'textile' },
  clothing:   { label: 'WEARABLE',  colour: '#ff9de0', register: 'clothing' },
  container:  { label: 'CONTAINER', colour: '#c9d4e4', register: 'container' },
  stationery: { label: 'STATIONERY', colour: '#a8d5ff', register: 'stationery' },
  sign:       { label: 'SIGNAGE',   colour: '#7dffd4', register: 'sign' },
  building:   { label: 'STRUCTURE', colour: '#b8b8b8', register: 'building' },
  medical:    { label: 'MEDICAL',   colour: '#ff8f8f', register: 'medical' },
  safety:     { label: 'SAFETY',    colour: '#ff6b6b', register: 'safety' },
  hygiene:    { label: 'HYGIENE',   colour: '#9be8ff', register: 'hygiene' },
  sport:      { label: 'SPORT',     colour: '#ffcf70', register: 'sport' },
  toy:        { label: 'TOY',       colour: '#ffd1f0', register: 'toy' },
  musical:    { label: 'MUSIC',     colour: '#c9a7ff', register: 'music' },
  jewellery:  { label: 'VALUABLE',  colour: '#ffe08a', register: 'jewellery' },
  money:      { label: 'VALUABLE',  colour: '#ffe08a', register: 'jewellery' },
  weapon:     { label: 'CONTROLLED', colour: '#ff5b5b', register: 'weapon' },
  misc:       { label: 'OBJECT',    colour: '#c9d4e4', register: 'misc' }
};

export const categoryColour = (category) => CATEGORIES[category]?.colour || CATEGORIES.misc.colour;
export const categoryLabel = (category) => CATEGORIES[category]?.label || 'OBJECT';

/* ------------------------------------------------------------------ *
 * COCO-80 (the detector head)
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

/** Detector classes → ARGUS vocabulary + category. */
export const COCO_META = {
  person: ['person', 'person'], bicycle: ['bicycle', 'vehicle'], car: ['car', 'vehicle'],
  motorcycle: ['motorbike', 'vehicle'], airplane: ['airplane', 'vehicle'], bus: ['bus', 'vehicle'],
  train: ['train', 'vehicle'], truck: ['truck', 'vehicle'], boat: ['boat', 'vehicle'],
  'traffic light': ['traffic light', 'sign'], 'fire hydrant': ['fire hydrant', 'fitting'],
  'stop sign': ['stop sign', 'sign'], 'parking meter': ['parking meter', 'sign'],
  bench: ['bench', 'furniture'], bird: ['bird', 'animal'], cat: ['cat', 'animal'],
  dog: ['dog', 'animal'], horse: ['horse', 'animal'], sheep: ['sheep', 'animal'],
  cow: ['cow', 'animal'], elephant: ['elephant', 'animal'], bear: ['bear', 'animal'],
  zebra: ['zebra', 'animal'], giraffe: ['giraffe', 'animal'], backpack: ['backpack', 'container'],
  umbrella: ['umbrella', 'clothing'], handbag: ['handbag', 'container'], tie: ['tie', 'clothing'],
  suitcase: ['suitcase', 'container'], frisbee: ['frisbee', 'sport'], skis: ['skis', 'sport'],
  snowboard: ['snowboard', 'sport'], 'sports ball': ['ball', 'sport'], kite: ['kite', 'toy'],
  'baseball bat': ['baseball bat', 'sport'], 'baseball glove': ['gloves', 'sport'],
  skateboard: ['skateboard', 'sport'], surfboard: ['surfboard', 'sport'],
  'tennis racket': ['tennis racket', 'sport'], bottle: ['bottle', 'container'],
  'wine glass': ['wine glass', 'kitchen'], cup: ['cup', 'kitchen'], fork: ['fork', 'kitchen'],
  knife: ['knife', 'kitchen'], spoon: ['spoon', 'kitchen'], bowl: ['bowl', 'kitchen'],
  banana: ['banana', 'food'], apple: ['apple', 'food'], sandwich: ['sandwich', 'food'],
  orange: ['orange', 'food'], broccoli: ['broccoli', 'food'], carrot: ['carrot', 'food'],
  'hot dog': ['hot dog', 'food'], pizza: ['pizza', 'food'], donut: ['donut', 'food'],
  cake: ['cake', 'food'], chair: ['chair', 'furniture'], couch: ['sofa', 'furniture'],
  'potted plant': ['houseplant', 'plant'], bed: ['bed', 'furniture'],
  'dining table': ['table', 'furniture'], toilet: ['toilet', 'fitting'], tv: ['television', 'tech'],
  laptop: ['laptop', 'device'], mouse: ['mouse', 'device'], remote: ['remote control', 'device'],
  keyboard: ['keyboard', 'device'], 'cell phone': ['phone', 'device'],
  microwave: ['microwave', 'appliance'], oven: ['oven', 'appliance'], toaster: ['toaster', 'appliance'],
  sink: ['sink', 'fitting'], refrigerator: ['refrigerator', 'appliance'], book: ['book', 'stationery'],
  clock: ['clock', 'misc'], vase: ['vase', 'misc'], scissors: ['scissors', 'tool'],
  'teddy bear': ['teddy bear', 'toy'], 'hair drier': ['hair dryer', 'appliance'],
  toothbrush: ['toothbrush', 'hygiene']
};

export const DISPLAY_NAMES = Object.fromEntries(
  Object.entries(COCO_META).map(([k, [name]]) => [k, name.toUpperCase().replace(' ', ' ')])
);

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

export const THEMES = {
  arc: {
    label: 'ARC', accent: '#4ce0ff',
    vars: {
      '--accent': '#4ce0ff', '--accent-dim': '#1b6f8c', '--accent-glow': 'rgba(76,224,255,.35)',
      '--bg-0': '#02060c', '--bg-1': '#061420', '--bg-2': 'rgba(6,20,32,.72)',
      '--ink': '#dff6ff', '--line': 'rgba(76,224,255,.22)'
    }
  },
  mark7: {
    label: 'MARK VII', accent: '#ffb347',
    vars: {
      '--accent': '#ffb347', '--accent-dim': '#8a5a12', '--accent-glow': 'rgba(255,179,71,.32)',
      '--bg-0': '#0b0703', '--bg-1': '#1a1005', '--bg-2': 'rgba(26,16,5,.72)',
      '--ink': '#ffeed6', '--line': 'rgba(255,179,71,.22)'
    }
  },
  ghost: {
    label: 'GHOST', accent: '#e8f4ff',
    vars: {
      '--accent': '#e8f4ff', '--accent-dim': '#6d8296', '--accent-glow': 'rgba(232,244,255,.22)',
      '--bg-0': '#05070a', '--bg-1': '#0d1219', '--bg-2': 'rgba(13,18,25,.72)',
      '--ink': '#eef6ff', '--line': 'rgba(232,244,255,.18)'
    }
  },
  matrix: {
    label: 'GREEN', accent: '#6dff9b',
    vars: {
      '--accent': '#6dff9b', '--accent-dim': '#1f6b3c', '--accent-glow': 'rgba(109,255,155,.3)',
      '--bg-0': '#010604', '--bg-1': '#03150c', '--bg-2': 'rgba(3,21,12,.72)',
      '--ink': '#d8ffe8', '--line': 'rgba(109,255,155,.22)'
    }
  },
  amber: {
    label: 'AMBER HUD', accent: '#ff8a00',
    vars: {
      '--accent': '#ff8a00', '--accent-dim': '#7a3f00', '--accent-glow': 'rgba(255,138,0,.3)',
      '--bg-0': '#000000', '--bg-1': '#0a0600', '--bg-2': 'rgba(10,6,0,.7)',
      '--ink': '#ffd9a0', '--line': 'rgba(255,138,0,.22)'
    }
  },
  ice: {
    label: 'ICE', accent: '#a7d8ff',
    vars: {
      '--accent': '#a7d8ff', '--accent-dim': '#4a7ba6', '--accent-glow': 'rgba(167,216,255,.28)',
      '--bg-0': '#04070d', '--bg-1': '#0a1220', '--bg-2': 'rgba(10,18,32,.7)',
      '--ink': '#e8f4ff', '--line': 'rgba(167,216,255,.2)'
    }
  }
};

/* ------------------------------------------------------------------ *
 * Phrase bank
 * ------------------------------------------------------------------ */

export const LINES = {
  boot: [
    'Initialising optical sensor.',
    'Loading neural core.',
    'Calibrating visual cortex.',
    'Systems nominal.'
  ],
  greetingMorning: ['Good morning, {addr}. All systems online.'],
  greetingAfternoon: ['Good afternoon, {addr}. Standing by.'],
  greetingEvening: ['Good evening, {addr}. Optics engaged.'],
  greetingNight: ['Working late, {addr}? Argus is online.'],
  engage: ['Optics engaged. I will call out anything of interest.'],
  cameraSwitch: ['Switching to {lens} optics.'],
  targetAcquired: ['Target acquired: {name}.'],
  targetLocked: ['Locked onto {name}.'],
  targetLost: ['{Name} lost. Resuming wide scan.'],
  targetCleared: ['Lock released. Wide scan restored.'],
  foundOne: ['{Article} {name} in view.', '{Article} {name} detected.', 'I have {article} {name}.'],
  foundMany: ['{Count} {plural} in view.', 'I count {count} {plural}.'],
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
  help: ['Tap the ring to switch modes. Hold the display to lock. Tap an object for its full read.'],
  // v2 voice: description with attributes
  describe: ['{Article} {name}, {attributes}.'],
  describeDistance: ['{Article} {name} at about {distance}.'],
  materialRead: ['{Name}: {material}, {confidence} percent.'],
  colourRead: ['{Name} reads as {colour}.'],
  textFound: ['Text in view: {text}.'],
  brandFound: ['That is a {name}.'],
  poseFound: ['{Count} {plural} in view.'],
  handsSeen: ['Hands detected: {gesture}.'],
  sceneSummary: ['{Scene}. {Count} objects of interest.'],
  teachPrompt: ['Select a box, then name the object. I will remember it.'],
  teachStored: ['Learned: {name}. I will recognise it from now on.'],
  teachForgotten: ['Forgotten: {name}.'],
  watchAdded: ['Watching for {name}.'],
  watchRemoved: ['No longer watching for {name}.'],
  watchHit: ['{Name} in view.'],
  hazardFound: ['Caution, {addr}: {note}'],
  queryUnknown: ['I do not have that in view.'],
  queryFound: ['{Name}, {position}, {distance}.'],
  memoryReport: ['I have seen {count} {plural} today.'],
  moduleLoading: ['Loading {module}.'],
  moduleReady: ['{Module} online.'],
  moduleFailed: ['{Module} failed to load.'],
  detailReport: ['{name}. {attributes}. {extra}'],
  noText: ['No readable text in view.'],
  readOut: ['Reading: {text}.'],
  movement: ['{Name} moving {direction}.'],
  distanceReport: ['{Name} is about {distance} away.'],
  conditionFound: ['{Name} looks {condition}. {note}']
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export const STORAGE_KEY = 'argus.settings.v2';
export const MEMORY_KEY = 'argus.memory.v2';

export const DEFAULTS = {
  // interface
  theme: 'arc',
  hudStyle: 'standard',        // standard | glasses | minimal | debug
  showBoxes: true,
  showLabels: true,
  showConfidence: true,
  showAttributes: true,
  showDistance: true,
  showRadar: true,
  showReticle: true,
  showScene: true,
  showTicker: true,
  subtitles: true,
  mirrorFront: true,
  haptics: true,
  units: 'metric',             // metric | imperial

  // detector
  minConfidence: 0.34,
  scanSize: 416,               // 320 | 416 | 512 | 640
  adaptive: true,
  detailMode: 'off',           // off | auto | 4 | 9  (tiled inference)
  maxDetections: 32,
  backend: 'auto',             // auto | webgpu | wasm

  // modules
  moduleClassifier: true,
  moduleOcr: true,
  modulePose: true,
  moduleHands: false,
  classifyEvery: 700,          // ms between classifier passes per object
  classifyTopK: 5,
  classThreshold: 0.28,
  ocrEvery: 2200,
  ocrMinConfidence: 0.55,
  poseEvery: 550,
  handEvery: 700,
  attributesEvery: 900,

  // perception
  fovHorizontal: 62,           // degrees — used by the range solver
  fovCalibrated: false,
  teachThreshold: 0.62,
  appearanceSmoothing: 0.55,
  trackMaxAge: 1400,

  // agent
  narration: 'standard',       // quiet | standard | chatty
  address: 'sir',
  voiceEnabled: true,
  voiceURI: '',
  voiceRate: 1.02,
  voicePitch: 0.92,
  voiceVolume: 1,
  voiceCommands: false,
  autoLock: false,
  alerts: true,
  hazardAlerts: true,
  watchlist: [],
  narrateBrands: true,
  narrateMaterials: true,
  narrateDistance: true,
  minTierToSpeak: 3,
  captionsOnHud: true,

  // I/O
  captureFormat: 'png',
  saveSessionLog: true
};

export function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { stored = {}; }
  const s = { ...DEFAULTS, ...stored };
  if (!THEMES[s.theme]) s.theme = DEFAULTS.theme;
  if (![320, 416, 512, 640].includes(Number(s.scanSize))) s.scanSize = DEFAULTS.scanSize;
  if (!['standard', 'glasses', 'minimal', 'debug'].includes(s.hudStyle)) s.hudStyle = DEFAULTS.hudStyle;
  if (!Array.isArray(s.watchlist)) s.watchlist = [];
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

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const AN_EXCEPTIONS = new Set(['airplane', 'apple', 'elephant', 'orange', 'umbrella', 'oven', 'iron', 'axe', 'inhaler', 'auger', 'hourglass', 'iPod', 'iPad', 'anti-static strap', 'exhaust fan', 'instant camera']);
export const articleFor = (word) => (AN_EXCEPTIONS.has(word) || /^[aeiou]/i.test(String(word).trim()) ? 'an' : 'a');

export const plural = (word, n) => {
  if (n === 1) return word;
  if (/(s|x|ch|sh|z)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
};

export const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const now = () => performance.now();

export function template(str, vars = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, key) => {
    if (key in vars) return vars[key];
    const lc = key.toLowerCase();
    if (lc in vars) return vars[lc];
    const tc = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
    if (tc in vars) return vars[tc];
    return '';
  }).replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export function pick(list, seed) {
  if (!list || !list.length) return '';
  const i = seed === undefined ? Math.floor(Math.random() * list.length) : Math.abs(Math.floor(seed)) % list.length;
  return list[i];
}

/** Format a distance in the user's chosen units, with honest precision. */
export function formatDistance(metres, units = 'metric') {
  if (metres == null || !Number.isFinite(metres)) return '';
  if (units === 'imperial') {
    const feet = metres * 3.28084;
    if (feet < 10) return `${feet.toFixed(1)} ft`;
    return `${Math.round(feet)} ft`;
  }
  if (metres < 10) return `${metres.toFixed(1)} m`;
  return `${Math.round(metres)} m`;
}

/** Bearing in words — used in spoken answers ("to your left"). */
export function bearingWord(deg) {
  const d = ((deg + 180) % 360) - 180;   // -180..180, negative = left of centre
  const a = Math.abs(d);
  if (a < 6) return 'dead ahead';
  if (a < 18) return d < 0 ? 'slightly left' : 'slightly right';
  if (a < 45) return d < 0 ? 'to your left' : 'to your right';
  if (a < 80) return d < 0 ? 'well to your left' : 'well to your right';
  return d < 0 ? 'hard left' : 'hard right';
}
