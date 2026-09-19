# ARGUS — instant object recognition, on the device

ARGUS is an installable web app that turns a phone, tablet or laptop camera
into a recognition instrument. Point it at something and it is outlined and
named on the feed **on the first frame it appears** — a mug, an espresso
machine, a Bosch drill, a Samsung phone, a fire exit sign, a person sitting
down. Every model runs locally in the browser; no frame, image or audio ever
leaves the handset.

**v3.0 — one job, done well.** The interface is the camera feed and the
overlay drawn on it. Nothing to press, nothing to configure, no modes, no
settings, no conversation. The stage carries zero interactive elements; the
only other chrome is a two-line status readout (what is in view, and that it
all happens on-device).

```
   camera ──► detector (full frame + adaptive tiles)
                  │
                  ▼
               tracker ──► records ──────────────► overlay (name + confidence)
                  ▲
   classifier (1000-class) ──┤  in frame, budgeted
   OCR: text + brands + signs ┘  background, attached by geometry
   pose + hands (people)        ┘  background, posture/gesture word
```

---

## What it recognises

The full model suite runs, so the vocabulary is the union of everything it can
say: **~930 curated objects, ~1 800 aliases, 1 000 ImageNet classes, 320
brands and a 20-entry safety-sign lexicon — more than 3 300 names**, refined
live by OCR (a "phone" with "SAMSUNG" printed on it becomes *Samsung phone*;
"STOP" on a panel becomes *Stop instruction*).

| Model | What it contributes | Size |
|---|---|---|
| `yolov8n.onnx` | object detection, COCO-80 — full frame always, plus 2×2 overlapping tiles on fast devices so small objects survive | 12.1 MB |
| `imagenet-lite4.onnx` | 1 000-class refinement — the vocabulary COCO does not have: *espresso maker, power drill, hard disc, stethoscope…* | 12.9 MB |
| `ppocr-det.onnx` | text-region detection (DBNet) | 4.5 MB |
| `ppocr-rec.onnx` | text recognition (CRNN + CTC, 6 623 symbols, Latin + CJK) | 10.4 MB |
| `ppocr-cls.onnx` | text orientation (0°/180°) | 0.6 MB |
| `yolov8n-pose.onnx` | 17-keypoint body pose → the person tag's posture word (*sitting, crouching, standing*) | 3.6 MB |
| `yolov8n-hand.onnx` | 21-keypoint hands → gesture words folded into the same tag (*pointing, waving*) | 3.5 MB |

`models/manifest.json` lists every file with its byte size and SHA-256, and
the app hashes each model as it loads, so "the fetch returned 200" becomes
"these are the bytes that were tested".

## How a tag gets made

1. **Detect (in frame).** YOLOv8 runs the full frame at an adaptive size
   (320–416 px, kept inside ~110 ms). On a device that stays fast, a 2×2
   tile pass runs on top so small objects keep being found — it never runs
   where it would cost the latency budget.
2. **Track.** Detections become tracks (greedy IoU + proximity + class), so
   the outline is stable and each object keeps its identity and age.
3. **Tag (first frame).** The overlay draws the outline and the chip —
   name, confidence, category dot — the moment the track exists. A 160 ms
   fade-in is all the animation there is.
4. **Refine (background).** The 1 000-class classifier re-reads each object
   (budgeted, ~every 500 ms); OCR reads text, brands and signs; pose and
   hands read people. Results attach to the next frame's records by geometry
   — the tag sharpens (*phone → Samsung phone*, *person → seated*) without
   ever stuttering the feed.

The fusion rule for the label: **safety sign read off the object > brand
text > classifier refinement > detector class.**

## The overlay

One thin rounded outline per object, one crisp chip: name in title case,
confidence as a percentage, a quiet category dot, and — for people — a
posture/gesture word on a second line. Text read by OCR that sits on no
object gets its own small chip. The whole style is one quiet instrument-grade
dark surface: no glow, no scanlines, no radar, no score.

---

## Running it

```bash
node tools/serve.mjs          # http://localhost:8080
npm test                      # headless suites: logic, assets, boot, pwa
npm run verify:models         # run the real models over a real photograph
```

`npm run verify:models` loads the shipped ONNX graphs on the same runtime the
browser uses, checks their digests against `models/manifest.json`, pushes
`tools/sample-bus.jpg` through detector, tracker, classifier, OCR, pose and
the fusion naming, and prints what ARGUS saw field by field. It exits non-zero
if any check fails, so it can gate a release.

The dev server sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` so the page is cross-origin isolated, which is
what lets onnxruntime-web use SharedArrayBuffer and multiple threads.
`netlify.toml` and `vercel.json` ship the same headers for production; hosts
that cannot set response headers simply fall back to single-threaded
inference, which still works.

`npm test` runs four suites: **logic** (knowledge base, naming rules,
tracker, pose interpretation, NMS/geometry), **assets** (every import
resolves to a real export, every shipped file exists, model and runtime
digests match the manifest, versions stay in sync), **boot** (the real
`app.js` start-up under a DOM that refuses the camera and blocks the runtime
— failures are reported, a successful boot dismisses the loading screen, the
stage carries zero interactive elements, and a first-seen object is outlined,
named and given its confidence on that very frame) and **pwa** (the service
worker evaluated against a fake Cache API over the real repository files —
precache, verified payloads, cache-first vs stale-while-revalidate, range
requests, offline navigation, background model fill and purge — plus the
inline boot watchdog in `index.html`).

At runtime the same manifest is checked in the other direction: each model is
hashed as it loads and compared with `models/manifest.json`.

Then open the address on the phone, allow the camera, and **Add to Home
Screen** (Safari) or **Install app** (Chrome). On first launch the service
worker caches the application shell while the loader fetches the models; once
the first boot succeeds it fills the remaining payloads in the background, so
every later launch is fully offline. Camera and models start **in
parallel**, the camera step gives up politely (25 s watchdog) if a webview
hides the permission prompt, and a classic-script watchdog in `index.html`
reports a broken module graph with a working Retry even when the app scripts
never load at all.

No camera? ARGUS falls back to a **demo feed**: the bundled still frame is
pushed through the exact same pipeline, so the whole interface can be
exercised anywhere — open the app with `?demo=1` to skip the camera
outright.

## Where things live

```
index.html            shell — boot card, stage (video + overlay + status)
css/app.css           the one quiet surface
sw.js                 offline cache; verifies every payload before storing it
js/app.js             boot, camera, the two-clock frame loop, status line
js/core.js            onnxruntime boot (WebGPU → WASM), verified fetch, tensor
                      and image maths, NMS
js/kb.js              the knowledge base: ~3 300 names, aliases, brands,
                      signs, ImageNet mapping, naming rules
js/detector.js        tiled YOLOv8 detection with cross-tile merge
js/classify.js        ImageNet-Lite4 refinement
js/ocr.js             DBNet + orientation + CRNN/CTC text pipeline
js/pose.js            body and hand keypoints, posture and gesture words
js/tracker.js         identity and box smoothing across frames
js/pipeline.js        the fusion engine: one frame → named records
js/ui.js              the overlay: outlines, chips, boot console
js/data/*             the knowledge files (objects, brands, ImageNet labels,
                      OCR charset)
tools/serve.mjs       zero-dependency dev server
tools/verify-models.mjs  model verifier
```

## Honest limits

* The detector is COCO-80. Everything finer than that comes from the
  classifier, the text reading, or the knowledge base — a wall socket with no
  label is named by the classifier chain, not by the detector.
* OCR reads what is in frame; very small or glancing text can be missed
  between passes (1.6 s cadence), and chips persist ~4 s after last seen.
* Posture and gesture are keypoint heuristics over the pose model's output:
  a person mostly out of frame gets no word, and ambiguous postures stay
  silent rather than guess.
* Distances, materials, colour analysis and scene description are not in
  this build by design — the camera recognises and tags, and that is all it
  does.

## Licences

YOLOv8n and the pose/hand exports derive from Ultralytics YOLOv8 (AGPL-3.0);
the EfficientNet-Lite4 graph is Google (Apache-2.0); the PP-OCRv4 models are
PaddleOCR (Apache-2.0). Check these against your own distribution plans —
AGPL in particular has obligations if you ship this as a service.
