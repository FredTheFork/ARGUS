/**
 * tests/logic.mjs — headless logic tests.
 *
 * No browser, no camera, no GPU: the suites below drive the knowledge base,
 * naming rules, tracking and pose interpretation with synthetic data and
 * check the answers they produce. Run with `npm test`.
 */

import { test, section } from './harness.mjs';

/* ---------------- imports ---------------- */
section('module imports (syntax + top-level safety)');
const mods = {};
for (const path of [
  '../js/core.js', '../js/config.js', '../js/kb.js',
  '../js/detector.js', '../js/classify.js', '../js/ocr.js',
  '../js/pose.js', '../js/tracker.js', '../js/pipeline.js',
  '../js/ui.js', '../js/app.js'
]) {
  const name = path.split('/').pop();
  try { mods[name] = await import(path); test(`import ${name}`, true); }
  catch (err) { test(`import ${name}`, false, err.message.split('\n')[0]); }
}

const kb = mods['kb.js'];
const config = mods['config.js'];
const TrackerMod = mods['tracker.js'];
const pose = mods['pose.js'];
const classify = mods['classify.js'];

/* ---------------- knowledge base ---------------- */
section('knowledge base');
const stats = kb.stats();
test('vocabulary size', stats.vocabulary > 2000, `${stats.vocabulary} names`);
test('curated objects', stats.objects > 800, `${stats.objects}`);
test('brands', stats.brands > 200, `${stats.brands}`);
test('imagenet classes mapped', stats.imagenet === 1000, `${stats.imagenet}`);

for (const [query, expectName] of [
  ['plug socket', 'wall socket'], ['socket', 'plug'], ['iphone', 'phone'], ['keys', 'key'],
  ['power drill', 'power drill'], ['kettle', 'kettle'], ['fridge', 'fridge'], ['tv', 'television']
]) {
  const hit = kb.lookup(query, { fuzzy: true });
  test(`lookup "${query}"`, !!hit && hit.name === expectName, hit ? `→ ${hit.name} (${hit.category})` : 'no hit');
}

const brand = kb.matchBrand('APPLE IPHONE 15 PRO');
test('brand from OCR text', !!brand && /apple/i.test(brand.name), brand ? brand.name : 'none');
const brand2 = kb.matchBrand('SAMSUNG GALAXY S24');
test('brand with product text', !!brand2 && /samsung/i.test(brand2.name), brand2 ? brand2.name : 'none');
const noBrand = kb.matchBrand('THE QUICK BROWN FOX');
test('no brand on plain text', noBrand === null, noBrand ? noBrand.name : 'null');

const sign = kb.matchSign('FIRE EXIT');
test('sign lexicon', !!sign && sign.kind === 'exit', sign ? `${sign.kind} (${sign.say})` : 'none');
const sign2 = kb.matchSign('WET FLOOR — MIND THE STEP');
test('sign lexicon (wet)', !!sign2 && sign2.kind === 'wet', sign2 ? sign2.kind : 'none');

test('categoryOf drill', kb.categoryOf('power drill') !== 'misc', kb.categoryOf('power drill'));
test('categoryOf from index', kb.categoryOf('espresso machine') === 'appliance' || kb.categoryOf('espresso machine') === 'kitchen', kb.categoryOf('espresso machine'));
test('tierOf', typeof kb.tierOf('keys') === 'number', `keys tier ${kb.tierOf('keys')}`);

/* ---------------- naming ---------------- */
section('naming');
test('nameFor detector only', kb.nameFor({ cls: 'cell phone' }) === 'phone', kb.nameFor({ cls: 'cell phone' }));
test('nameFor refined', kb.nameFor({ cls: 'cell phone', refined: 'iPod' }) === 'iPod', kb.nameFor({ cls: 'cell phone', refined: 'iPod' }));
test('nameFor brand-qualified', (() => {
  const b = kb.matchBrand('SAMSUNG');
  return kb.nameFor({ cls: 'cell phone', brand: b }) === 'Samsung phone';
})(), kb.nameFor({ cls: 'cell phone', brand: kb.matchBrand('SAMSUNG') }));

const refined1 = classify.refineFromClassifier('cup', [{ name: 'espresso machine', category: 'kitchen', prob: 0.71, tier: 2 }]);
test('classifier refines within category', refined1.refined === 'espresso machine', refined1.refined);
const refined2 = classify.refineFromClassifier('person', [{ name: 'tench', category: 'animal', prob: 0.3, tier: 1 }]);
test('unrelated classifier vote rejected', refined2.refined === null, refined2.refined || 'null');

/* ---------------- config ---------------- */
section('config');
test('config has a detector floor', config.CONFIG.minConfidence > 0 && config.CONFIG.scanSize >= 256, `conf ${config.CONFIG.minConfidence}, scan ${config.CONFIG.scanSize}`);
test('every category has a colour', Object.values(config.CATEGORIES).every((c) => /^#[0-9a-f]{6}$/i.test(c.colour)));
test('titleCase', config.titleCase('espresso machine') === 'Espresso Machine');
test('CLASSES is COCO-80', config.CLASSES.length === 80);
test('every COCO class has meta', config.CLASSES.every((c) => config.COCO_META[c]));

/* ---------------- geometry ---------------- */
section('geometry + nms');
const core = mods['core.js'];
const a = [0, 0, 10, 10];
const b = [5, 5, 15, 15];
test('iou overlap', Math.abs(core.iou(a, b) - (25 / 175)) < 1e-9, core.iou(a, b).toFixed(4));
const dets = [
  { box: [0, 0, 10, 10], score: 0.9, cls: 'mug' },
  { box: [1, 1, 11, 11], score: 0.8, cls: 'mug' },
  { box: [50, 50, 60, 60], score: 0.7, cls: 'mug' },
  { box: [1, 1, 11, 11], score: 0.85, cls: 'cup' }
];
const kept = core.nms(dets, 0.5, 'class');
test('nms keeps one per overlapping class', kept.length === 3, kept.map((d) => `${d.cls} ${d.score}`).join(', '));

/* ---------------- tracker ---------------- */
section('tracker');
const tracker = new TrackerMod.Tracker({ maxAge: 5000 });
const t0 = 1000;
let res = tracker.update([{ box: [100, 100, 200, 200], score: 0.9, cls: 'mug', clsId: 41, label: 'mug' }], t0);
test('track born', res.born.length === 1 && res.live.length === 1, `id ${res.born[0]?.id}`);
const id1 = res.born[0].id;
res = tracker.update([{ box: [120, 100, 220, 200], score: 0.88, cls: 'mug', clsId: 41, label: 'mug' }], t0 + 100);
test('identity kept across frames', res.live.length === 1 && res.live[0].id === id1);
test('box smoothing', res.live[0].box[0] > 100 && res.live[0].box[0] < 120, `x ${res.live[0].box[0].toFixed(1)}`);
res = tracker.update([], t0 + 400);
test('coasting before expiry', res.live.length === 1 && res.live[0].state === 'coasting');
res = tracker.update([], t0 + 8000);
test('expiry', res.lost.length === 1 && res.live.length === 0);

/* ---------------- pose interpretation ---------------- */
section('pose — posture and gesture');
const K = (name, x, y, c = 0.9) => ({ name, x, y, c });
const standing = [
  K('nose', 100, 20), K('left shoulder', 80, 60), K('right shoulder', 120, 60),
  K('left hip', 82, 120), K('right hip', 118, 120),
  K('left knee', 80, 170), K('right knee', 120, 170),
  K('left ankle', 78, 220), K('right ankle', 122, 220)
];
test('posture standing', pose.postureOf(standing, [60, 10, 140, 230]) === 'standing', pose.postureOf(standing, [60, 10, 140, 230]));
const sitting = [
  K('nose', 100, 40), K('left shoulder', 80, 70), K('right shoulder', 120, 70),
  K('left hip', 78, 120), K('right hip', 122, 120),
  K('left knee', 120, 118), K('right knee', 150, 120),
  K('left ankle', 122, 185), K('right ankle', 152, 187)
];
test('posture sitting', pose.postureOf(sitting, [60, 30, 160, 200]) === 'sitting', pose.postureOf(sitting, [60, 30, 160, 200]));

// A synthetic 21-landmark hand: wrist at the origin, each finger four joints
// along its own direction. Extended = tip out at radius 40; bent = tip folded
// back to radius 15, inside the pip.
const hand = (extended = false) => {
  const P = [];
  P[0] = { x: 0, y: 0, c: 0.95 };                                        // wrist
  const fingers = [
    { base: 1, angle: -60 },   // thumb
    { base: 5, angle: 0 },     // index
    { base: 9, angle: 30 },    // middle
    { base: 13, angle: 60 },   // ring
    { base: 17, angle: 90 }    // pinky
  ];
  for (const f of fingers) {
    const rad = f.angle * Math.PI / 180;
    const cos = Math.cos(rad); const sin = Math.sin(rad);
    const radii = [10, 20, 25, extended ? 40 : 15];
    for (let j = 0; j < 4; j++) {
      P[f.base + j] = { x: cos * radii[j], y: sin * radii[j], c: 0.95 };
    }
  }
  return P;
};
const open = pose.gestureOf(hand(true));
test('gesture open palm', /open/i.test(open.name), `${open.name} (${open.confidence})`);
const fist = pose.gestureOf(hand(false));
test('gesture fist', fist.name === 'fist', `${fist.name} (${fist.confidence})`);

const activity = pose.activityOf({ kpts: sitting, posture: 'sitting' }, []);
test('activity from posture', activity.id === 'sitting', activity.label);

/* ---------------- fusion naming (no models needed) ---------------- */
section('pipeline — record resolution');
const PipelineMod = mods['pipeline.js'];
const pipeline = Object.create(PipelineMod.Pipeline.prototype);
pipeline.settings = config.CONFIG;

const mkTrack = (over = {}) => ({
  id: 1, cls: 'cell phone', label: 'phone', category: 'device', tier: 3,
  box: [100, 100, 200, 260], smoothScore: 0.86, text: 'Samsung', textAt: 1000,
  brand: kb.matchBrand('Samsung'), sign: null, signRatio: 1,
  refined: null, refineConfidence: 0, firstSeen: 0,
  posture: null, gesture: null, activity: null,
  ...over
});

const rec1 = pipeline._record(mkTrack({ firstSeen: 0 }), 0);
test('brand-qualified label', rec1.label === 'Samsung phone' && rec1.source === 'brand', `${rec1.label} (${rec1.source})`);

const rec2 = pipeline._record(mkTrack({ text: null, brand: null, refined: 'iPod', refineConfidence: 0.6, category: 'device' }), 0);
test('refined label wins over detector', rec2.label === 'iPod' && rec2.source === 'classifier', `${rec2.label} (${rec2.source})`);

const rec3 = pipeline._record(mkTrack({ text: 'FIRE EXIT', brand: null, sign: { kind: 'exit', say: 'Exit sign', tier: 3 }, signRatio: 0.05 }), 0);
test('safety sign labels the object', rec3.label === 'Exit sign' && rec3.source === 'sign', `${rec3.label} (${rec3.source})`);

const rec4 = pipeline._record(mkTrack({ text: 'FIRE EXIT', brand: null, sign: { kind: 'exit', say: 'Exit sign', tier: 3 }, signRatio: 0.8, category: 'vehicle' }), 0);
test('sign on a big non-sign object does not rename it', !/exit/i.test(rec4.label), rec4.label);

const personRec = pipeline._record(mkTrack({
  id: 7, cls: 'person', label: 'person', category: 'person', text: null, brand: null,
  posture: 'sitting', activity: { id: 'sitting', label: 'seated', confidence: 0.6 }
}), 0);
test('person keeps posture + activity for the overlay', personRec.posture === 'sitting' && personRec.activity?.label === 'seated', JSON.stringify(personRec.activity));
