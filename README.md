# ARGUS — a visual agent that runs on the device

ARGUS is an installable web app that turns a phone, tablet or laptop camera into
an always-on visual assistant. It detects and names objects, works out their
colour and material, reads text and brands off them, watches people move, paces
distances, describes the scene, answers spoken questions, and does all of it
locally — no frames, images or audio ever leave the handset.

It is built for a heads-up display: the overlay has a `glasses` style that grows
the type and drops the detail for a screen a few centimetres from the eye, and
every answer is available as speech, because you cannot read a HUD while carrying
a box.

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

The vocabulary is the sum of those layers: **928 curated objects, 1 802 aliases,
1 000 ImageNet classes, 320 brands, 57 materials and 157 named colours — 3 304
recognisable names**, extended at runtime by anything you teach it.

---

## Commands you can say or type

```
what is this · describe the scene · what am I looking at
what colour is the mug · what is it made of
where are my keys · how far is the bus · which way
read that sign · what does it say · how many bottles
who is that · what are they doing · is anything dangerous
teach this as my inhaler · forget my mug · what have you learned
watch for dogs · stop watching for dogs · what are you watching
have you seen a drill before · what have you seen today
lock on to the van · unlock · capture · pause · resume
mute · unmute · detail mode · performance mode · status · modules · help
```

Type them in the query bar, or open the microphone and speak. ARGUS also speaks
first when it matters: hazards and safety signage, watchlist matches, objects
approaching, new objects of interest, and scene changes in chatty mode — and it
stays quiet about the mug that has been on the desk all afternoon.

---

## Teaching it your own things

Public models do not know your inhaler, your keys, or the difference between
your two black mugs. Point ARGUS at the object, tap it, choose **Teach**, and
name it. The 1280-d fingerprint is stored; every later frame is matched against
it by cosine similarity, so the object is recognised from new angles and in
different light. Taught labels outrank every model answer, because you are
ground truth.

Memory records every observation with counts, first and last sighting, colours
and materials seen. It can be exported and imported as JSON, and forgotten
entirely with one button.

---

## Running it

```bash
node tools/serve.mjs          # http://localhost:8080
```

The dev server sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` so the page is cross-origin isolated, which is
what lets onnxruntime-web use SharedArrayBuffer and multiple threads. Without
those headers inference still works, single-threaded.

Then open the address on the phone, allow the camera, and *Add to Home Screen*
(Safari) or *Install app* (Chrome). The service worker caches the whole app and
all seven models (~47 MB) on first run, after which it works fully offline.

No camera? ARGUS falls back to a **demo feed**: the bundled still frame is pushed
through the exact same pipeline, so the whole interface can be exercised
anywhere.

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
