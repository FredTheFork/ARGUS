# ARGUS — a visual agent that runs on the device

ARGUS is an installable web app that turns a phone, tablet or laptop camera into
an always-on visual assistant. It detects and names objects, works out their
colour and material, reads text and brands off them, watches people move, paces
distances, describes the scene, and does all of it locally — no frames, images
or audio ever leave the handset.

**v2.1 — camera-only.** Point it at the world and that is the whole interface:
every object seen is outlined and named on the feed, from the first frame it
appears. The stage carries zero interactive elements — no buttons, no fields,
no sheets — and the only surface the app can raise on its own is a hazard
alert. The language, speech and install modules (`js/agent.js`,
`js/speech.js`, `js/install.js`) remain in the tree, covered by their own
tests, but this build does not use them.

```
        camera ──► detector (tiled) ──► tracker ──► fusion ──► records ─┬─► HUD
                        │                                 │             ├─► speech
        classifier ─────┤                                 │             └─► agent answers
        text/OCR  ──────┼─ background jobs ────────────────┘
        pose/hands ─────┘
```

---

## What it actually recognises

| Layer | What it contributes | Where it lives |
|---|---|---|
| **Detector** | YOLOv8-nano, COCO-80 boxes, run whole-frame plus 2×2 or 3×3 overlapping tiles so small objects (a plug socket, a key, a label) survive | `js/detector.js` |
| **Classifier** | EfficientNet-Lite4 over ImageNet-1k — 1000 classes that COCO does not have: *espresso maker, power drill, hard disc, iPod, plug, switch, projector, test tube, stethoscope…* | `js/classify.js` |
| **Appearance fingerprint** | The classifier's own 1280-d pooled features, used for few-shot learning and for matching what it has seen before | `js/classify.js` |
| **Text + brands** | PP-OCRv4 detection, orientation and recognition (6623 symbols, Latin + CJK), then a 320-brand lexicon: "SAMSUNG" on a phone becomes *Samsung phone*, "FIRE EXIT" becomes a safety call-out | `js/ocr.js` |
| **Colour** | k-means in CIE-Lab over a foreground-masked crop, named against 157 references: *deep red*, *teal*, *charcoal*, plus a weighted palette | `js/attributes.js` |
| **Material** | Cue scoring from specularity, texture entropy, edge density, saturation and warmth, blended with class priors from the knowledge base: *ceramic / glass / brushed aluminium / leather / canvas…* | `js/attributes.js` |
| **Shape, finish, pattern** | Aspect, fill ratio, gloss reading (glossy / satin / matte), autocorrelation for stripes, checks and prints | `js/attributes.js` |
| **People** | 17-keypoint body pose (posture, activity) and optional 21-keypoint hands (pointing, fist, open palm, thumbs up, peace) | `js/pose.js` |
| **Range** | Monocular distance from a per-object real-world height prior, upgraded to pose measurement when a person is in frame | `js/attributes.js` |
| **Scene** | Room and setting inference from the objects present plus lighting statistics (kelvin, key direction, indoor/outdoor) | `js/attributes.js` |
| **Identity** | A tracker keeps objects across frames, so it can say *the mug has moved left*, hold a lock on a target, and tell "new" from "still there" | `js/tracker.js` |
| **Relations** | What is resting on what — "on the table: mug, laptop" — from containment between boxes, no segmentation model needed | `js/pipeline.js` |
| **Appearance memory** | Every observation keeps a quantised 1280-d centroid, so the assistant can answer "have you seen this before" by comparing how the object *looks*, not just what it was called | `js/memory.js` |

The vocabulary is the sum of those layers: **928 curated objects, 1 802 aliases,
1 000 ImageNet classes, 320 brands, 57 materials and 157 named colours — 3 304
recognisable names**, extended at runtime by anything you teach it.

## What the interface does

Nothing to learn. ARGUS runs the detector continuously, and each tracked
object gets corner brackets in its category colour with its name written
alongside — *mug*, *Samsung phone*, *fire exit sign* — the moment it is seen.
The classifier, text and brand reading and pose modules run in the background
and sharpen the names as evidence lands. A hazardous object (live conductors,
a flammable sign, a blade) is named in red and raises the one proactive
surface in the app: a hazard alert. Alerts are debounced per object, so a
kettle in view nags once, not forever.

There is nothing to tap, drag or type. Boot is the only other screen: it
reports honest progress, and on failure says what failed with a working Retry,
or the bundled demo feed.

---

## Teaching and memory (modules retained, surfaces removed in v2.1)

The appearance-memory and few-shot teaching layers are unchanged internally:
every observation still keeps a quantised 1280-d centroid, and taught labels
still outrank every model answer. What v2.1 removes is the furniture — the
teach sheet, the memory sheet, the query bar. Objects taught in an earlier
version and imported into the device's storage are still recognised and named.

---

## Running it

```bash
node tools/serve.mjs          # http://localhost:8080
npm test                      # 244 headless checks, no browser required
npm run verify:models         # run the real models over a real photograph
```

`npm install` also brings in the model verifier: `npm run verify:models` loads
the shipped ONNX graphs on the same runtime the browser uses, checks their
digests against `models/manifest.json`, pushes `tools/sample-bus.jpg` through
detector, tracker, colour and material analysis, classifier, OCR, pose, fusion
and the language layer, and prints what ARGUS saw field by field. That is how
the following were caught — none of them are visible to a unit test:

* the INT8 pose and hand graphs use `ConvInteger`, which the WASM execution
  provider only implements from ONNX Runtime 1.21 onwards (the vendored runtime
  is 1.30.0, and `models/manifest.json` records its digests)
* the quantised pose graph is exported at a fixed 640 × 640, so feeding it 320
  made every pose pass fail — the input size is now read from the graph
* fitting the long side of a frame to the pose model's size produced a tensor
  whose length did not match its declared shape; letterboxing is square now
* the colour read called a beige coat black and a blue bus gunmetal, because
  shadow, glass and highlight were counted as pigment; the colour now comes
  from the mid-tones with a hue-preserving illuminant correction
* material scoring called a person "foliage" and a bus "denim"; materials that
  only make sense on certain subjects are now gated, and a weak cue match falls
  back to what the knowledge base says the object is made of

`verify:models` exits non-zero if any check fails, so it can gate a release.

The dev server sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` so the page is cross-origin isolated, which is
what lets onnxruntime-web use SharedArrayBuffer and multiple threads.
`netlify.toml` and `vercel.json` ship the same headers for production; hosts
that cannot set response headers (GitHub Pages) simply fall back to
single-threaded inference, which still works.

`npm test` runs four suites: **logic** (knowledge base, colour and material
analysis, tracker, memory, language, fusion relations), **assets** (every import
resolves to a real export, every shipped file exists, model digests match
`models/manifest.json`, version strings stay in sync), **boot** (the real
`app.js` start-up under a DOM that refuses the camera and blocks the runtime —
proving failures are reported instead of thrown, that a successful boot
really does dismiss the loading screen, and the v2.1 contract: a stage with
zero interactive elements, outlines on the first frame, hazards as the only
proactive channel, and agent/speech/install shipped but unused) and **pwa**
(the service worker evaluated against a fake Cache API over the real repository
files — precache, verified payloads, cache-first vs stale-while-revalidate,
range requests, offline navigation, background model fill and purge — plus the
inline boot watchdog in `index.html`).

At runtime the same manifest is checked in the other direction: each model is
hashed as it loads and compared with `models/manifest.json`, so "the fetch
returned 200" becomes "these are the bytes that were tested".

Then open the address on the phone, allow the camera, and *Add to Home Screen*
(Safari) or *Install app* (Chrome). On first launch the service worker caches
the application shell while the loader fetches the models; once the first boot
succeeds it fills the remaining payloads in the background, so every later
launch is fully offline. Camera and models start **in parallel**, the camera
step gives up politely (25 s watchdog) if a webview hides the permission
prompt, and a classic-script watchdog in `index.html` reports a broken module
graph with a working Retry even when the app scripts never load at all.

No camera? ARGUS falls back to a **demo feed**: the bundled still frame is pushed
through the exact same pipeline, so the whole interface can be exercised
anywhere — there is a *Run demo feed* button on every boot error, or open the
app with `?demo=1` to skip the camera outright.

---

## The model suite

| File | Task | Size |
|---|---|---|
| `yolov8n.onnx` | object detection, COCO-80, tiled | 12.1 MB |
| `imagenet-lite4.onnx` | ImageNet-1k classification + 1280-d embedding | 12.9 MB |
| `ppocr-det.onnx` | text detection (DBNet) | 4.5 MB |
| `ppocr-rec.onnx` | text recognition (CRNN + CTC, 6623 symbols) | 10.4 MB |
| `ppocr-cls.onnx` | text orientation (0°/180°) | 0.6 MB |
| `yolov8n-pose.onnx` | 17-keypoint body pose | 3.6 MB |
| `yolov8n-hand.onnx` | 21-keypoint hands | 3.5 MB |

`models/manifest.json` lists every file with its byte size and SHA-256.
Quantised graphs (classifier, pose, hands) are deliberately pinned to the WASM
execution provider even on a WebGPU device, because the quantised ops are faster
there and the fallback would otherwise copy tensors back and forth.

**Licences.** YOLOv8n and the pose/hand exports derive from Ultralytics YOLOv8
(AGPL-3.0); the EfficientNet-Lite4 graph is Google (Apache-2.0); the PP-OCRv4
models are PaddleOCR (Apache-2.0). Check these against your own distribution
plans — AGPL in particular has obligations if you ship this as a service.

---

## Where things live

```
index.html            interface shell — boot screen, HUD, sheets
css/app.css           HUD, sheets, four display styles
sw.js                 offline cache; verifies every payload before storing it
js/app.js             boot, camera, the two-clock frame loop, glue
js/core.js            onnxruntime boot (WebGPU → WASM), verified fetch, tensor
                      and image maths, Lab colour science, k-means, NMS
js/kb.js              the knowledge base: 3 304 names, aliases, brands,
                      materials, colours, signs, tiers, size priors, safety
js/detector.js        tiled YOLOv8 detection with cross-tile merge
js/classify.js        ImageNet classifier, embeddings, few-shot store
js/ocr.js             DBNet + CRNN + CTC text pipeline, oriented boxes
js/pose.js            body and hand keypoints, posture/gesture/activity
js/attributes.js      colour, material, pattern, shape, range, light, scene
js/tracker.js         identity, motion, appearance memory across frames
js/pipeline.js        the fusion engine: one frame → object records
js/memory.js          taught examples, watchlist, history, timeline
js/agent.js           language understanding, answers, proactive narration
js/ui.js              canvas overlay, object list, sheets, settings
js/speech.js          speech output queue and speech input
js/install.js         install prompts, platform guidance, storage accounting
js/data/*             the knowledge files (objects, materials, colours, brands,
                      ImageNet labels, OCR charset)
tools/serve.mjs       zero-dependency dev server
```

## Adding to the knowledge base

The data files are plain text, one row per line, `|` separated — no code to
change:

```
# js/data/kb-objects.js
name | aliases | category | materials | colours | height_m | tier | tags | note

laser level | laser spirit level, cross line laser | tool | plastic,metal,glass | green,black | 0.12 | 2 | tool,fragile | Self-levelling; do not stare into the beam.
```

`tier` decides how loudly ARGUS speaks about it (3 call-out, 2 mention, 1 quiet),
`height_m` is what makes distance estimation possible (`0` = no size prior), and
`tags` carry the safety semantics (`electrical`, `hot`, `sharp`, `fragile`,
`valuable`, `medical`, `flammable`, `gas`, `security`).

## Honest limits

* The detector is COCO-80. Everything finer than that comes from the classifier,
  the text, your teaching, or the knowledge base — a wall socket with no label
  is named by the classifier chain, not by the detector.
* Distances are monocular estimates. They are useful (bus-sized objects land
  within ~15 %, a mug within ~40 %) and they are explicitly reported as a range.
* Material recognition is cue-based inference from appearance, not spectrometry.
  It reports a ranked composition with percentages rather than a single verdict.
* Barcodes and QR codes are not decoded; there is no depth sensor and no
  inertial fusion (no WebXR on phones), so range never uses motion parallax.
* Everything degrades gracefully: if a module fails to load, the rest of the
  assistant keeps working, and the log says exactly what failed.
