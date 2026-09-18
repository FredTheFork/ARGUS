/**
 * tests/logic.mjs — headless logic tests.
 *
 * No browser, no camera, no GPU: the suites below drive the knowledge base,
 * configuration helpers, appearance analysis, tracking, memory and the language
 * layer with synthetic data, and check the answers they produce. Run with
 * `npm test`.
 */

import { test, section } from './harness.mjs';

/* ---------------- imports ---------------- */
section('module imports (syntax + top-level safety)');
const mods = {};
for (const path of [
  '../js/core.js', '../js/config.js', '../js/kb.js',
  '../js/detector.js', '../js/classify.js', '../js/ocr.js',
  '../js/pose.js', '../js/attributes.js', '../js/tracker.js',
  '../js/pipeline.js', '../js/memory.js', '../js/agent.js',
  '../js/ui.js', '../js/speech.js', '../js/install.js',
  '../js/app.js'
]) {
  const name = path.split('/').pop();
  try { mods[name] = await import(path); test(`import ${name}`, true); }
  catch (err) { test(`import ${name}`, false, err.message.split('\n')[0]); }
}

const kb = mods['kb.js'];
const config = mods['config.js'];
const agent = mods['agent.js'];
const attributes = mods['attributes.js'];
const TrackerMod = mods['tracker.js'];
const MemoryMod = mods['memory.js'];

/* ---------------- knowledge base ---------------- */
section('knowledge base');
const stats = kb.stats();
test('vocabulary size', stats.vocabulary > 2000, `${stats.vocabulary} names`);
test('objects', stats.objects > 800, `${stats.objects}`);
test('brands', stats.brands > 200, `${stats.brands}`);

for (const [query, expect] of [
  ['plug socket', 'plug socket'], ['socket', 'socket'], ['iphone', 'phone'], ['keys', 'keys'],
  ['power drill', 'drill'], ['kettle', 'kettle'], ['fridge', 'refrigerator'], ['tv', 'television']
]) {
  const hit = kb.lookup(query, { fuzzy: true });
  test(`lookup "${query}"`, !!hit, hit ? `→ ${hit.name} (${hit.category})` : 'no hit');
}
test('hasExact("plug socket")', kb.hasExact('plug socket') === true);
test('hasExact("car keys") false', kb.hasExact('car keys') === false);

const brand = kb.matchBrand('APPLE IPHONE 15 PRO');
test('brand from OCR text', !!brand && /apple/i.test(brand.name), brand ? brand.name : 'none');
const sign = kb.matchSign('FIRE EXIT');
test('sign lexicon', !!sign, sign ? sign.kind : 'none');
const colourRec = kb.nearestColour([53, 40, 30]);
test('colour naming', !!colourRec && !!colourRec.name, colourRec?.name);
test('categoryOf drill', kb.categoryOf('power drill') !== 'misc', kb.categoryOf('power drill'));
test('tierOf', typeof kb.tierOf('keys') === 'number', `keys tier ${kb.tierOf('keys')}`);
test('height prior', kb.heightFor('bus') > 2, `bus ${kb.heightFor('bus')} m`);

/* ---------------- config helpers ---------------- */
section('config');
test('articleFor orange', config.articleFor('orange') === 'an');
test('articleFor mug', config.articleFor('mug') === 'a');
test('plural box → boxes', config.plural('box', 2) === 'boxes');
test('template', config.template('The {name} is {distance} away.', { name: 'mug', distance: '2 m' }) === 'The mug is 2 m away.');
test('bearing dead ahead', config.bearingWord(2) === 'dead ahead');
test('bearing left', config.bearingWord(-30) === 'to your left');
test('formatDistance metric', config.formatDistance(1.23) === '1.2 m');
test('formatDistance imperial', config.formatDistance(1.23, 'imperial') === '4.0 ft');

/* ---------------- synthetic frame ---------------- */
function frameOf(colour, w = 320, h = 240) {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w; const y = (i / w) | 0;
    // object in the middle, dark grey background at the edges
    const inside = x > w * 0.25 && x < w * 0.75 && y > h * 0.25 && y < h * 0.75;
    const c = inside ? colour : [40, 42, 45];
    const jitter = ((i * 37) % 11) - 5;
    img.data[i * 4] = Math.max(0, Math.min(255, c[0] + jitter));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, c[1] + jitter));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, c[2] + jitter));
    img.data[i * 4 + 3] = 255;
  }
  return img;
}
const frame = frameOf([190, 40, 45]);          // a red object
const box = [80, 60, 240, 180];

section('attributes (colour / material / range / light / scene)');
const appearance = attributes.analyseAppearance(frame, box, { cls: 'mug' });
test('appearance produced', !!appearance);
test('colour is red-family', /red|crimson|scarlet|brick|ruby|maroon/i.test(appearance.colour.name), appearance.colour.name);
test('palette', appearance.colour.palette.length >= 1, appearance.colour.palette.map((p) => `${p.name} ${p.weight}%`).join(', '));
test('materials scored', appearance.materials.length > 0, appearance.materials.slice(0, 2).map((m) => `${m.name} ${(m.score * 100) | 0}%`).join(', '));
test('finish', typeof appearance.finish === 'string', appearance.finish);
test('shape', typeof appearance.shape?.form === 'string', appearance.shape?.form);
const range = attributes.estimateRange({ box, frameWidth: frame.width, frameHeight: frame.height, fovDeg: 62, heightPrior: 0.1 });
test('range from size prior', range?.metres > 0, `${range.metres.toFixed(2)} m (${range.method})`);
const poseRange = attributes.estimateRange({
  box: [100, 20, 200, 230], frameWidth: frame.width, frameHeight: frame.height, fovDeg: 62, heightPrior: 1.75,
  personKpts: [{ name: 'nose', x: 150, y: 40, c: 0.9 }, { name: 'left ankle', x: 140, y: 210, c: 0.8 }, { name: 'right ankle', x: 160, y: 212, c: 0.8 }]
});
test('range from pose', poseRange?.method === 'pose height', `${poseRange?.metres?.toFixed(2)} m`);
const light = attributes.lightingOf(frame);
test('lighting', !!light && light.kelvin > 1000, `${light.key}, ${Math.round(light.kelvin)}K, ${(light.brightness * 100) | 0}%`);
const scene = attributes.inferScene({ objects: [{ label: 'laptop', tier: 2 }, { label: 'office chair', tier: 2 }, { label: 'mug', tier: 2 }], lighting: light, textLines: [] });
test('scene inference', !!scene.label, `${scene.label} (confidence ${scene.confidence.toFixed(2)})`);
const phrase = attributes.appearancePhrase(appearance);
test('appearance phrase', phrase.length > 0, phrase);

/* ---------------- tracker ---------------- */
section('tracker');
const tracker = new TrackerMod.Tracker({ maxAge: 5000 });
const t0 = 1000;
let res = tracker.update([{ box: [100, 100, 200, 200], score: 0.9, cls: 'mug', clsId: 41 }], t0);
test('track born', res.born.length === 1 && res.live.length === 1, `id ${res.born[0]?.id}`);
const id1 = res.born[0].id;
res = tracker.update([{ box: [120, 100, 220, 200], score: 0.88, cls: 'mug', clsId: 41 }], t0 + 100);
test('identity kept across frames', res.live.length === 1 && res.live[0].id === id1);
test('velocity estimated', res.live[0].speed() > 0, `${res.live[0].speed().toFixed(0)} px/s`);
res = tracker.update([], t0 + 400);
test('coasting before expiry', res.live.length === 1 && res.live[0].state === 'coasting');
res = tracker.update([], t0 + 8000);
test('expiry', res.lost.length === 1 && res.live.length === 0);

/* ---------------- memory ---------------- */
section('memory');
const memory = new MemoryMod.Memory({ onLog: () => {} }).load();
memory.beginSession();
const rec = {
  id: 1, label: 'mug', noun: 'mug', category: 'kitchen', tier: 2, confidence: 0.8,
  attributes: { colour: { name: 'red' }, material: { name: 'ceramic', confidence: 0.6 } }, hazard: null
};
const obs1 = memory.observe(rec);
const obs2 = memory.observe(rec);
test('novel then known', obs1.novel === true && obs2.novel === false);
test('history counted', memory.countOf('mug').total >= 2);
memory.watch('dog');
test('watchlist entry', memory.watchlist.length === 1, memory.watchlist[0]?.label);
const hits = memory.checkWatchlist([{ id: 9, label: 'dog', noun: 'dog', category: 'animal', box: [0, 0, 10, 10] }], Date.now());
test('watchlist hit', hits.length === 1);
const hitsAgain = memory.checkWatchlist([{ id: 9, label: 'dog', noun: 'dog', category: 'animal', box: [0, 0, 10, 10] }], Date.now());
test('watchlist debounced', hitsAgain.length === 0);
const taught = memory.learn({ label: 'my inhaler', embedding: new Float32Array([0.1, 0.9, 0.3]), category: 'medical', tags: [], note: '' });
test('teach stored', !!taught && memory.teach.examples.length === 1);
const exported = memory.export();
const memory2 = new MemoryMod.Memory({ onLog: () => {} });
const imported = memory2.import(exported);
test('export → import round trip', imported.taught === 1 && imported.known >= 1, JSON.stringify(imported));
const match = mods['classify.js'].Classifier.matchTaught(new Float32Array([0.1, 0.9, 0.3]), memory.teach, { minScore: 0.9 });
test('taught fingerprint matches', !!match && match.label === 'my inhaler', match ? `${match.score.toFixed(3)}` : 'none');

/* ---------------- agent: parse ---------------- */
section('agent — language');
for (const [utterance, intent, term] of [
  ['what is this', 'identify-this', ''],
  ['describe the scene', 'describe-scene', ''],
  ['what colour is the mug', 'colour', 'mug'],
  ['what is it made of', 'material', ''],
  ['where are my car keys', 'where', 'keys'],
  ['how far is the bus', 'distance', 'bus'],
  ['read that sign', 'read', ''],
  ['how many bottles', 'count', 'bottles'],
  ['watch for dogs', 'watch', 'dogs'],
  ['teach this as my inhaler', 'teach', 'inhaler'],
  ['forget my mug', 'forget', 'mug'],
  ['what have you learned', 'learned', ''],
  ['have you seen a drill before', 'seen-before', 'drill'],
  ['is it dangerous', 'hazard', ''],
  ['lock on to the van', 'lock', 'van'],
  ['capture', 'capture', ''],
  ['mute', 'mute', ''],
  ['status', 'status', ''],
  ['help', 'help', '']
]) {
  const parsed = agent.parse(utterance);
  test(`parse "${utterance}"`, parsed.intent === intent && (!term || parsed.term === term), `→ ${parsed.intent}/${parsed.term}`);
}

/* ---------------- agent: respond ---------------- */
section('agent — answers');
const records = [
  {
    id: 1, label: 'mug', noun: 'mug', category: 'kitchen', tier: 2, confidence: 0.82,
    box: [80, 60, 240, 180], source: 'detector', hits: 5, age: 4000,
    attributes: { colour: { name: 'deep red', hex: '#b02830', palette: [{ name: 'deep red', weight: 70 }, { name: 'charcoal', weight: 20 }] }, material: { name: 'ceramic', confidence: 0.61 }, materials: [{ name: 'ceramic', score: 0.61 }], finish: 'glossy', pattern: { id: 'solid', label: 'solid' } },
    distance: { metres: 0.9, min: 0.6, max: 1.2, bearing: -6, method: 'size prior' },
    text: null, brand: null, hazard: null, pose: null, posture: null, hands: null, gesture: null, activity: null,
    motion: { id: 'stationary', label: 'still', speed: 3 }
  },
  {
    id: 2, label: 'Apple phone', noun: 'phone', category: 'device', tier: 3, confidence: 0.91,
    box: [300, 200, 360, 320], source: 'brand', hits: 9, age: 6000,
    attributes: { colour: { name: 'black', hex: '#101014', palette: [{ name: 'black', weight: 88 }] }, material: { name: 'glass', confidence: 0.55 }, materials: [{ name: 'glass', score: 0.55 }, { name: 'metal', score: 0.4 }], finish: 'glossy', pattern: { id: 'solid', label: 'solid' } },
    distance: { metres: 0.45, min: 0.3, max: 0.6, bearing: 22, method: 'size prior' },
    text: 'iPhone 15 Pro', brand: { name: 'Apple', sector: 'technology', exact: true },
    hazard: null, pose: null, posture: null, hands: null, gesture: null, activity: null,
    motion: { id: 'approaching', label: 'approaching', speed: 120 }
  }
];
const ctx = {
  records, memory, settings: { ...config.DEFAULTS }, scene: { id: 'office', label: 'office desk', confidence: 0.6 }, lighting: light, texts: []
};
const answered = (q, needle) => {
  const reply = agent.respond(q, ctx);
  const text = reply.say || '';
  test(`ask "${q}"`, text.length > 0 && (!needle || new RegExp(needle, 'i').test(text)), text.slice(0, 130));
  return reply;
};
answered('what is this', 'Apple|phone');
answered('what colour is the mug', 'red');
answered('what is the mug made of', 'ceramic');
answered('how far is the phone', 'm|ft');
answered('where are my keys', 'do not have|not');
answered('describe the scene', 'mug|phone');
answered('how many mugs', '1');
answered('is anything dangerous', 'nothing hazardous|caution');
answered('help', 'tap|ring|object');
const lockReply = answered('lock the mug', 'locked');
test('lock action', lockReply.action === 'lock' && lockReply.id === 1, `action=${lockReply.action}`);

/* ---------------- agent: description ---------------- */
section('agent — description');
const described = agent.describeRecord(records[1], config.DEFAULTS);
test('describe includes brand', /Apple/i.test(described), described);
test('describe includes colour', /black/i.test(described));
test('describe includes distance', /0\.4|0\.5/.test(described));

/* ---------------- narrator ---------------- */
section('narrator — proactive speech');
const narrator = new agent.Narrator({});
const narration = narrator.evaluate({ records, scene: ctx.scene, lighting: light }, { settings: { ...config.DEFAULTS }, memory });
test('narrator produced an utterance', narration.length >= 1, narration[0]?.text);
const hazardRecord = { ...records[0], id: 3, label: 'exposed wiring', hazard: { kind: 'electrical', note: 'live conductors exposed' }, tier: 3 };
const narrator2 = new agent.Narrator({});
const hazardLines = narrator2.evaluate({ records: [hazardRecord], scene: null, lighting: light }, { settings: { ...config.DEFAULTS }, memory });
test('hazard takes priority', hazardLines[0]?.tone === 'alert' && /live conductors/i.test(hazardLines[0].text), hazardLines[0]?.text);


/* ---------------- similarity memory ---------------- */
section('memory — appearance similarity');
const memory3 = new MemoryMod.Memory({ onLog: () => {} });
const vec = (seed) => Float32Array.from({ length: 32 }, (_, i) => Math.sin(seed + i * 0.37));
memory3.observe({ label: 'mug', category: 'kitchen', tier: 2, confidence: 0.8, embeddingVec: vec(1), attributes: null, hazard: null });
memory3.observe({ label: 'kettle', category: 'appliance', tier: 2, confidence: 0.7, embeddingVec: vec(40), attributes: null, hazard: null });
memory3.observe({ label: 'mug', category: 'kitchen', tier: 2, confidence: 0.8, embeddingVec: vec(1.05), attributes: null, hazard: null });
const similar = memory3.findSimilar(vec(1.02), { minScore: 0.6 });
test('similarity search finds the remembered object', similar.length >= 1 && similar[0].label === 'mug', similar.map((h) => `${h.label} ${h.score.toFixed(2)}`).join(', '));
test('centroid survives a JSON round trip', (() => {
  const m = new MemoryMod.Memory({ onLog: () => {} });
  m.import(memory3.export());
  return m.findSimilar(vec(1.02), { minScore: 0.6 }).some((h) => h.label === 'mug');
})());

/* ---------------- fusion helpers (no models needed) ---------------- */
section('pipeline — relations and appearance voting');
const PipelineMod = await import('../js/pipeline.js');
const pipeline = Object.create(PipelineMod.Pipeline.prototype);
pipeline.settings = { attributesEvery: 0 };
const sceneObjects = [
  { id: 1, label: 'table', noun: 'table', category: 'furniture', tier: 2, confidence: 0.8, box: [40, 200, 600, 470], attributes: null },
  { id: 2, label: 'mug', noun: 'mug', category: 'kitchen', tier: 2, confidence: 0.8, box: [200, 240, 260, 300], attributes: null },
  { id: 3, label: 'laptop', noun: 'laptop', category: 'device', tier: 3, confidence: 0.9, box: [320, 210, 520, 290], attributes: null },
  { id: 4, label: 'car', noun: 'car', category: 'vehicle', tier: 3, confidence: 0.9, box: [10, 10, 60, 40], attributes: null }
];
pipeline._relations(sceneObjects, { width: 640, height: 480 });
test('containment: mug sits on the table', sceneObjects[1].on === 'table', `on=${sceneObjects[1].on}`);
test('containment: laptop sits on the table', sceneObjects[2].on === 'table', `on=${sceneObjects[2].on}`);
test('containment: car is not on anything', !sceneObjects[3].on);
test('surface lists its contents', sceneObjects[0].supports.includes('mug') && sceneObjects[0].supports.includes('laptop'), sceneObjects[0].supports.join(', '));

const track = { box: [80, 60, 240, 180], label: 'mug', cls: 'cup', attributes: null };
const appearanceFrame = frameOf([190, 40, 45]);
pipeline._attributes(track, appearanceFrame);
test('appearance read on a track', !!track.attributes?.colour?.name, track.attributes?.colour?.name);
const firstColour = track.attributes.colour.name;
pipeline._attributes(track, frameOf([30, 30, 35]));
test('votes smooth a changing read', track.attributes.samples === 2 && track.attributes.colour.name === firstColour, `${track.attributes.colour.name} after ${track.attributes.samples} reads`);

/* ---------------- new intents ---------------- */
section('agent — guided search and relations');
for (const [utterance, intent, term] of [
  ['find my keys', 'find-mode', 'keys'],
  ['look for dogs', 'find-mode', 'dogs'],
  ['what else looks like this', 'similar', ''],
  ['what is on the table', 'on-surface', 'table'],
  ['have you seen this before', 'seen-before', '']
]) {
  const parsed = agent.parse(utterance);
  test(`parse "${utterance}"`, parsed.intent === intent && (!term || parsed.term === term), `→ ${parsed.intent}/${parsed.term}`);
}
const relationCtx = {
  records: [
    { id: 1, label: 'table', noun: 'table', category: 'furniture', tier: 2, confidence: 0.8, box: [40, 200, 600, 470], supports: ['mug', 'laptop'], distance: null, attributes: null, motion: { id: 'stationary' } },
    { id: 2, label: 'mug', noun: 'mug', category: 'kitchen', tier: 2, confidence: 0.8, box: [200, 240, 260, 300], on: 'table', distance: null, attributes: null, motion: { id: 'stationary' } }
  ],
  memory, settings: { ...config.DEFAULTS }, scene: null, lighting: null, texts: [], locked: null
};
const onTable = agent.respond('what is on the table', relationCtx);
test('answers what is on a surface', /mug/i.test(onTable.say), onTable.say);
const findReply = agent.respond('find my keys', relationCtx);
test('find mode starts guided search', findReply.action === 'find' && findReply.term === 'keys', findReply.say);

export default true;
