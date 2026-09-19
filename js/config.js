/**
 * config.js — version, taxonomy and the runtime tuning table.
 *
 * There is no user-facing settings surface in this build: the camera app has
 * nothing to configure, so the knobs live here as one hard-coded table with
 * values chosen for the two things the app exists to do — tag an object the
 * instant it is pointed at, and keep recognising as much of the scene as the
 * models can name.
 */

export const VERSION = '3.0.0';
export const BUILD = 'ARGUS-3.0.0/instant-recognition';

/* ------------------------------------------------------------------ *\
 * Category taxonomy
 *
 * The single source of truth for the overlay's category dot colour. It
 * covers everything the perception stack can say — not just the 80 COCO
 * classes but the ~2 800 things the knowledge base and ImageNet head name.
 * Colours are deliberately muted: a recognition overlay should read as an
 * instrument, not a scoreboard.
 * ------------------------------------------------------------------ */

export const CATEGORIES = {
  person:     { label: 'Person',     colour: '#59c2ff' },
  face:       { label: 'Face',       colour: '#7fd6ff' },
  vehicle:    { label: 'Vehicle',    colour: '#f2c94c' },
  animal:     { label: 'Animal',     colour: '#6fd98f' },
  plant:      { label: 'Plant',      colour: '#54c07c' },
  food:       { label: 'Food',       colour: '#f0d464' },
  kitchen:    { label: 'Kitchen',    colour: '#f0a35e' },
  appliance:  { label: 'Appliance',  colour: '#f0955c' },
  tech:       { label: 'Tech',       colour: '#9a8cf5' },
  device:     { label: 'Device',     colour: '#9a8cf5' },
  fitting:    { label: 'Fitting',    colour: '#e89ac2' },
  tool:       { label: 'Tool',       colour: '#7fa8f0' },
  furniture:  { label: 'Furniture',  colour: '#8fb3a8' },
  textile:    { label: 'Textile',    colour: '#c9a3f0' },
  clothing:   { label: 'Wearable',   colour: '#f09ad2' },
  container:  { label: 'Container',  colour: '#c3cedd' },
  stationery: { label: 'Stationery', colour: '#9cc9f0' },
  sign:       { label: 'Sign',       colour: '#6fe0c0' },
  building:   { label: 'Structure',  colour: '#b5bdc7' },
  medical:    { label: 'Medical',    colour: '#f08f8f' },
  safety:     { label: 'Safety',     colour: '#f06b6b' },
  hygiene:    { label: 'Hygiene',    colour: '#8fd9f0' },
  sport:      { label: 'Sport',      colour: '#f0c46e' },
  toy:        { label: 'Toy',        colour: '#f0b4dc' },
  musical:    { label: 'Music',      colour: '#bda0f0' },
  jewellery:  { label: 'Valuable',   colour: '#e8c87f' },
  money:      { label: 'Valuable',   colour: '#e8c87f' },
  weapon:     { label: 'Controlled', colour: '#f07070' },
  misc:       { label: 'Object',     colour: '#c3cedd' }
};

export const categoryColour = (category) => CATEGORIES[category]?.colour || CATEGORIES.misc.colour;

/* ------------------------------------------------------------------ *\
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

/* ------------------------------------------------------------------ *\
 * Runtime tuning
 *
 * The detector alone is a complete app — everything else sharpens the names
 * as it loads and runs in the background, so the first tag always lands as
 * fast as the detector can say so.
 * ------------------------------------------------------------------ */

export const CONFIG = {
  // frame loop
  minConfidence: 0.34,       // detector score floor
  scanSize: 416,             // detector input size (multiple of 32)
  scanFloor: 320,
  maxDetections: 32,
  backend: 'auto',           // auto | webgpu | wasm
  mirrorFront: true,

  // detail: 'auto' runs 2×2 overlapping tiles on top of the full frame while
  // the full frame stays fast enough to spare — small objects survive.
  detailMode: 'auto',
  tileBudgetMs: 90,

  // classifier (1000-class refinement, in frame, budgeted)
  classifyEvery: 500,
  classifyTopK: 5,
  classifyBudget: 2,
  classifyMinArea: 0.002,

  // OCR (background)
  ocrEvery: 1600,
  ocrMinConfidence: 0.55,
  ocrMaxLines: 16,

  // pose + hands (background, people only)
  poseEvery: 550,
  handEvery: 700,

  // tracker
  trackMaxAge: 1400,
  trackSmooth: 0.55,

  // overlay
  maxLabels: 16,
  labelFadeMs: 160
};

/* ------------------------------------------------------------------ *\
 * Helpers
 * ------------------------------------------------------------------ */

export const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const now = () => performance.now();
