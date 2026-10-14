# webhands — design and architecture

Living document. Update it whenever the design, module layout, conventions or
open questions change.

## Goal

3D hand tracking in a web browser with no special hardware: 21 joints per hand,
in metres, in a known coordinate frame, at camera frame rate.

## Approaches considered

| Approach | Verdict |
|---|---|
| **WebXR Hand Input** | Excellent (25 joints, metric) but only exists on XR headsets (Quest, Vision Pro, Android XR). No desktop browser exposes webcam hands through WebXR. → Later, as an optional backend. |
| **RGBD webcam via getUserMedia** | Not practical. The Media Capture Depth Stream Extensions (RealSense etc.) were abandoned; Safari does not expose iPhone TrueDepth/LiDAR to the web. A native helper streaming depth over WebSocket would work but breaks "no special setup". |
| **Monocular: MediaPipe + PnP** | **Implemented (phase 1).** MediaPipe Hand Landmarker already returns metric `worldLandmarks` (hand shape, origin at the hand's centre) alongside 2D image landmarks. Solving perspective-n-point with known intrinsics places the hand in the camera frame. Needs a calibration of hand size and focal length. Weakest along the viewing axis. |
| **Stereo, one tab** | **Implemented (phase 2).** Chrome opens two cameras at once (verified headless with fake devices); macOS Continuity Camera exposes an iPhone as an ordinary webcam. Two monocular trackers, frames paired by capture time, joints triangulated. Self-calibrated from hand keypoints (essential matrix; hand size / skeleton fixes scale; time offset estimated). See *Stereo pipeline*. |
| **Stereo, two tabs/devices** | Planned (phase 3). Each device runs MediaPipe and sends 2D landmarks (~few hundred bytes/frame) over a WebRTC data channel; signaling via QR code or small broker; needs clock sync. Covers Windows/Android. |
| Monocular depth nets, hand-mesh nets (HaMeR, WiLoR) | Too heavy / not metric enough for real-time browser use right now. Possible later as priors. |

## Module map

```
src/
  index.ts                 public exports
  types.ts                 Hand3D, HandTrackerBackend, joint names, bones
  intrinsics.ts            pinhole intrinsics, FOV defaults, per-camera calibration storage
  camera.ts                listCameras, openCamera, onVideoFrame (rVFC with rAF fallback)
  geometry/solvePose.ts    linear translation + Levenberg–Marquardt PnP, projection helpers
  filter/oneEuro.ts        One Euro filter over a vector
  geometry/numeric.ts      dense linear solve, median, percentile, weighted median
  geometry/bones.ts        skeleton tree, retarget to fixed bone lengths, depth from flattest bones
  geometry/rigid.ts        Kabsch/Horn rotation alignment
  geometry/skeleton.ts     placeSkeleton: rigid palm fit + per-bone ray–sphere (default placement)
  calibration/index.ts     hand-scale and focal-length calibration from hand samples
  calibration/objects.ts   known-size everyday objects; grip scale; focal from a clicked rectangle
  calibration/bones.ts     per-hand skeleton calibration: bone lengths (longest appearance) + palm template
  calibration/calibrator.ts Calibrator: runs steps against a tracker, applies + saves results (headless)
  ui/pickCorners.ts        freeze-frame overlay to click a rectangle's corners (optional UI helper)
  backends/monocular.ts    MonocularHandTracker (MediaPipe + solvePose + smoothing)
  backends/stereo.ts       StereoHandTracker: fuses two StereoSources (e.g. two MonocularHandTrackers)
  geometry/linalg.ts       symmetric eigen (Jacobi), 3×3 SVD, small matrix helpers
  stereo/epipolar.ts       8-point + RANSAC essential matrix, decomposition, LM refinement, triangulation
  stereo/pairing.ts        group samples into frames; interpolate a view's landmarks to a time
  stereo/calibrate.ts      calibrateStereo: time offset + relative pose + metric scale from hand frames
demo/                      Vite dev pages: index.html (one camera), stereo.html (two cameras);
                           shared.ts (three.js scene, 2D overlay), style.css
                           (calibration uses only the public Calibrator / pickCorners API)
test/                      vitest unit tests; test/sim.ts simulates MediaPipe errors (size, flattened z);
                           test/stereoSim.ts simulates two unsynchronised cameras watching a moving hand
```

Dependencies: `@mediapipe/tasks-vision` (runtime; WASM and model fetched from
jsDelivr / Google Storage by default, overridable via `wasmPath` /
`modelAssetPath`). `three` is a demo-only dev dependency. No OpenCV.

## Public API

```ts
interface Hand3D {
  handedness: 'Left' | 'Right';   // the user's actual hand
  joints: Float32Array;           // 21 × 3, metres, camera frame
  confidence: number;
  timestamp: number;              // frame capture time, performance.now() clock
  debug?: { landmarks2d, worldLandmarks, center, reprojectionError, source };
}
interface HandTrackerBackend {
  start(): Promise<void>; stop(): void;
  // timestamp = the frame's capture time, also for frames with no hands
  onFrame(listener: (hands: Hand3D[], timestamp: number) => void): () => void;
}
```

Every backend (monocular, stereo, WebXR) produces `Hand3D` so apps can switch
backends without changes. `debug` is backend-specific.

### Calibration API

Calibration is a library feature, not demo code. `tracker.calibrator` (a
`Calibrator`, headless) runs each step: collects frames from the tracker,
computes, applies the result to the tracker, and saves it per camera.

```ts
const cal = tracker.calibrator;
await cal.handSizeFromObject('card-long');        // or handSizeFromLength(0.185)
cal.addRectangleView(await pickCorners(video, { mirrored: true }), 'a4');  // repeat; median
// or: await cal.focalFromDistance(0.5); cal.setFieldOfView(70);
await cal.skeleton({ onProgress, signal });       // 8 s, both hands
cal.status;       // { handSize, focal: { views, hfovDegrees }, skeleton: { Left, Right }, missing }
cal.onChange(render); cal.reset();
```

- Steps reject with `CalibrationError` and a `code`: `not-started`, `no-hand`,
  `needs-hand-size` (focal-from-distance and skeleton need step 1; opt out with
  `allowDefaultHandSize`), `degenerate-view`, `unknown-object`, `aborted`.
- Collecting steps take `durationMs`, `signal` (AbortSignal) and `onProgress`
  (elapsed time and frames per hand).
- Consistency rules live here: recalibrating hand size rescales saved
  skeletons; rectangle views are per camera and per session (median of views);
  both hands share one overall size.
- `Calibrator` depends only on `CalibratableTracker` (intrinsics, handScale,
  skeletons, cameraId, onFrame), so it is unit-tested with a fake tracker fed
  simulated frames (`test/calibrator.test.ts`), and future backends can reuse it.
- `pickCorners(video, { mirrored })` is the only DOM piece: it overlays the
  frozen frame on the video (assumes `object-fit: contain`), collects clicks,
  and returns image pixels, undoing letterboxing and mirroring. Esc cancels.

## Conventions

- **Camera frame**: OpenCV convention, +x right, +y down, +z forward (away from
  the camera), metres, origin at the camera's optical centre. MediaPipe's image
  and world landmarks use the same axis directions. three.js uses (x, −y, −z).
- **Images are not mirrored** when passed to MediaPipe. The demo mirrors the
  display with CSS only.
- **Handedness**: for unmirrored frames, MediaPipe's label is the user's
  actual hand (verified in the demo). The monocular backend swaps it only when
  `mirroredInput: true`.
- **Intrinsics**: square pixels, principal point at image centre, no distortion.
  Focal length is stored as `fx / width` per camera (`localStorage`, key
  `webhands:calibration:<deviceId>`), so it survives resolution changes that
  don't crop.

## Monocular pipeline

Per video frame (`requestVideoFrameCallback`; capture time used as timestamp,
forced strictly increasing for MediaPipe):

1. `HandLandmarker.detectForVideo` (VIDEO mode, GPU delegate, up to 2 hands) →
   per hand: image landmarks (normalised → pixels) and world landmarks W (m).
2. Place the hand (`depthMethod`):
   - **`'skeleton'`** (default; needs a calibrated skeleton, else falls back to
     `'pnp'`) — `placeSkeleton(W, uv, K, L, palm)`:
     1. *Palm*: the calibrated 5-point palm template (wrist + 4 MCPs), rotated to
        MediaPipe's palm orientation by Kabsch, then a rigid 6-DoF
        Levenberg–Marquardt fit to the 5 palm image points. Tilting a flat shape
        only shortens it across the tilt axis, so the fitted depth is right at
        any tilt. MediaPipe only seeds the rotation, which picks between the
        two mirror-image tilt solutions.
     2. *Every other joint*, parents first: on its camera ray at exactly its bone
        length from its parent (ray–sphere intersection). Of the two
        intersections (bone toward / away from the camera), take the one whose
        direction agrees with MediaPipe's bone; if the ray misses (bone looks
        longer than L, i.e. noise), the ray's closest point.
     So foreshortening comes from the image and calibrated lengths, not from
     MediaPipe's z — which under-reports tilt and pushed tilted hands back.
   For the other two methods the model is P = `retarget(W, L)` (MediaPipe's bone
   directions, calibrated lengths) if calibrated, else P = s · W (s = hand scale):
   - **`'pnp'`** — `solvePose(P, uv, K)`: linear init with R = I (each joint gives
     `tx − x̂·tz = x̂·Pz − Px`, `ty − ŷ·tz = ŷ·Pz − Py`) → Levenberg–Marquardt on
     pixel reprojection error over t, plus a rotation update if `refineRotation`.
   - **`'bones'`** — `translationFromBones(P, uv, K)`: each bone gives a depth
     L·cos(tilt)/a (a = normalised image length, tilt from MediaPipe's bone
     direction). Weighted median, weights 1/((tan(tilt)·σθ)² + (σpx/a_px)²), so
     bones flat to the camera dominate (tilt errors are second-order there).
     Capped by the bound depth ≤ L/a (a bone can only look shorter). x, y by
     least squares given depth.
3. One Euro filter per handedness (default
   `minCutoff 1.5, beta 5`); filters reset when a hand disappears.

### Calibration

depth ≈ f · (hand size) / (hand size in pixels). The focal length f and the
hand scale s enter as a product, so one measurement can't separate them; there
are two steps. Each offers everyday objects of known size so no ruler is needed
(`KNOWN_LENGTHS`, `KNOWN_RECTANGLES` in `calibration/objects.ts`).

1. **Hand scale s**
   - *Grip an object* end-to-end between thumb tip and index fingertip: credit /
     ID card long or short edge (ISO ID-1, 85.60 × 53.98 mm), AA or AAA battery.
     s = known length / median(MediaPipe thumb-tip↔index-tip distance) over ~1.5 s.
   - *Or* enter a measured wrist-crease → middle-fingertip length;
     s = measured / median(MediaPipe wrist→middle-tip length).
2. **Focal length f**
   - *Click the 4 corners of a known rectangle* (A4, US Letter, credit card,
     US or €5 banknote) in a frozen frame, held tilted ~45°. The homography from
     the rectangle's metric plane gives two constraints linear in 1/f² (r1 ⟂ r2,
     |r1| = |r2|), solved by least squares, assuming square pixels and a centred
     principal point. Clicks may start at any corner in either direction: both
     long/short-edge assignments are tried and the lower-residual one kept.
     Views are accumulated and the median used.
   - *Or* hold the hand (after step 1) centred at a measured distance;
     f' = f · measured / median(estimated z).

3. **Hand skeleton (per hand): bone lengths L + palm template** — fixes depth drift. MediaPipe re-estimates
   each hand's size every frame and the estimate changes with pose, so depth
   (≈ f · size / pixel size) drifts with pose, and differently for the two
   hands. True bone lengths are constant and foreshortening only shortens, so
   while the user turns their hands for ~8 s, alternate:
   - per frame: place the skeleton with the current L (`placeSkeleton`, so frame
     depth comes from the rigid palm, not MediaPipe's tilt);
   - per bone: L = 90th percentile over frames of (bone depth × normalised image
     length). Not the max: 2D noise only adds length.
   The palm template is MediaPipe's median palm shape (Kabsch-aligned) from
   frames where the palm faces the camera within 35° (where MediaPipe's weak z
   matters least), scaled to the wrist→MCP lengths. The finger bones are then
   measured relative to the palm.
   Depth and L share one overall scale, set to `handScale` × MediaPipe's median
   hand size averaged over both hands — i.e. **left and right hands are assumed
   the same size**, so their distances agree. Recalibrating hand size (step 1)
   rescales the stored skeletons. Stored under `skeletons` in the calibration
   (an earlier `boneLengths` key is ignored; recalibrate).

**Object size matters for the rectangle method** (simulated, 1.5 px uniform
click noise, single view, median / 90th-percentile focal error):

| Object, distance | 20° tilt | 34° tilt | 51° tilt |
|---|---|---|---|
| Card, 30 cm | 9 % / 22 % | 5 % / 12 % | 4 % / 9 % |
| Card, 40 cm | 15 % / 46 % | 9 % / 21 % | 7 % / 18 % |
| US banknote, 40 cm | 7 % / 17 % | 4 % / 10 % | 3 % / 7 % |
| A4 / Letter, 60 cm | 3 % / 7 % | 1.6 % / 4 % | 1.2 % / 3 % |

So the demo defaults to paper, asks for a ~45° tilt, rejects near-frontal views,
and recommends several views. Lower-quality fallback: type in a FOV.

**Drift simulation** (`test/bones.test.ts` setup: random poses 45–80 cm,
MediaPipe size error ±15 % per frame, joint noise 2 mm xy / 6 mm z, 1.5 px 2D
noise; wrist depth RMS error, and correlation with the size error):

| MediaPipe relative depth | PnP, MediaPipe size | PnP, calibrated L | Bones, calibrated L |
|---|---|---|---|
| accurate (z × 1) | 9.0 % (corr 0.99) | **2.7 %** (corr 0.17) | 4.6 % (corr 0.03) |
| flattened (z × 0.7) | 9.2 % | 5.9 % | **5.7 %** |
| flattened (z × 0.5) | 9.6 % | 10.4 % | **6.8 %** |

| … | **Skeleton (palm + rays)** | joint RMS, skeleton vs. PnP-calibrated-L |
|---|---|---|
| z × 1 | **1.7 %**, bias −0.2 % | 15 mm vs. 18 mm |
| z × 0.5 | **1.7 %**, bias −0.2 % | 15 mm vs. 73 mm |

Calibrated bone lengths remove the size-driven drift for every method, but the
PnP and bones methods still take each bone's tilt from MediaPipe, so when
MediaPipe flattens depth a tilted hand is pushed back (PnP bias +5.5 % at
z × 0.5). This matched the observed failure ("one hand foreshortened, the whole
hand moves back"), and is why `'skeleton'` is now the default: its error doesn't
depend on MediaPipe's z at all. Its remaining joint error is mostly overall
placement from 2D noise (~10 mm at 45–80 cm). Skeleton calibration recovers bone
lengths to < 6 % RMS even with z × 0.5.

Without calibration: s = 1 (MediaPipe's average hand) and a 60° horizontal FOV.
Lateral position error scales with focal error; depth error scales with both.

## Stereo pipeline

`new StereoHandTracker([trackerA, trackerB])`. Each source is a `StereoSource`
(a `CalibratableTracker` with start/stop) — normally a `MonocularHandTracker`,
later a remote (WebRTC) view. Sources keep their own per-camera calibration
(intrinsics, hand size, skeleton) via their `calibrator`. Output is in camera
A's (camera 0's) frame, so it is drop-in compatible with the monocular output.

**Calibration** (`stereo.calibrate()`, 12 s, one hand moving through the shared
view at varied depths; `calibrateStereo` does the math):
1. *Time offset* — the two cameras' capture clocks can differ (Continuity
   Camera adds latency). For offsets −200…200 ms (10 ms, then 2 ms steps),
   camera B's landmarks are interpolated to camera A's frame times and a
   RANSAC essential matrix is fit; the offset with the lowest median Sampson
   distance wins. (A moving hand makes the offset observable.)
2. *Relative pose* — at that offset: 8-point essential matrix in RANSAC
   (samples drawn from distinct frames, 4 px threshold) → the decomposition
   with points in front of both cameras → Levenberg–Marquardt on Sampson
   distances (rotation + translation direction).
3. *Metric scale* — triangulate with unit baseline; scale = median of
   (true bone length / triangulated bone length), with true lengths from camera
   A's calibrated skeleton, else hand size × MediaPipe's median.
   Stored per camera pair (`webhands:stereo:<idA>|<idB>`).

**Per frame**:
1. Camera A frames wait (≤ 120 ms) until camera B has a frame at or after the
   same instant; camera B's 2D landmarks are linearly interpolated to camera
   A's capture time (on A's clock, via the offset). Latency ≤ ~1 frame.
2. Hands matched by handedness; with two hands in both views, the swapped
   labelling is used if it fits the epipolar geometry much better.
3. Each joint: linear triangulation + Gauss–Newton on pixel reprojection error
   in both views.
4. If the median joint error exceeds 12 px (views disagree, e.g. occlusion or a
   MediaPipe failure in one view), or the hand is in one view only, the hand
   comes from that view's single-camera 3D (camera B's mapped into camera A's
   frame). `debug.source` says which: `stereo`, `view0`, `view1`.
5. One Euro filter per hand. Before calibration, camera A passes through.

**Simulation** (`test/stereoSim.ts`: 1280×720 60° + 1920×1080 70° cameras,
35 cm apart and turned inward, hand on a smooth path 40–80 cm away, 1.5 px
noise, camera B clock 60 ms behind):

| Quantity | Recovered | True |
|---|---|---|
| Time offset | 64 ms | 60 ms |
| Rotation | 0.3° error | — |
| Baseline (skeleton scale) | 35.2 cm | 35.5 cm |
| Baseline (hand-size scale) | within 8 % | — |
| Joint error, triangulated (1 px noise) | 0.5 mm median | — |

vs. ~15 mm for the monocular skeleton method. Calibration takes < 1 s to compute.

**Practical notes**: turn off Center Stage (macOS Video Effects) on both
cameras — it crops/zooms continuously, changing the intrinsics. Each camera's
focal length matters (use the paper step per camera, or enter FOVs); errors
there bias depth. Two `getUserMedia` calls are made sequentially.

## Open questions / to verify empirically

- Stereo on real cameras: does hand self-calibration converge with real
  MediaPipe noise and a ~30 fps unsynchronised, rolling-shutter pair? Does the
  Continuity Camera time offset stay constant, or drift (would need online
  re-estimation)? Is the iPhone's focal length stable (lens switching)?
- Stereo intrinsics: refine both focal lengths during stereo calibration
  (observable with enough depth variation) instead of relying on per-camera steps?

- Does `'skeleton'` fix the foreshortening push-back on real hands?
- Toward/away flips: when a finger bone lies nearly in a plane through the camera
  ray, the two ray–sphere solutions are close and MediaPipe's z picks; if its
  sign is wrong the bone flips. May need temporal hysteresis.
- Palm rigidity: cupping the hand bends the MCP arch; the 5-point palm fit then
  absorbs some error into the palm pose.
- Does bone-length calibration remove the observed left/right depth drift on
  real hands, and which `depthMethod` is better? Demo readout shows MediaPipe's
  raw palm size per hand (confirms the cause if it varies with pose) and the
  left − right wrist depth.
- Are left and right hands really equal in size for the shared scale? If not,
  hands will have a constant (non-drifting) depth offset.

- Are MediaPipe world landmarks really camera-aligned in rotation? If the
  reprojection error with `refineRotation: false` is consistently high while
  `true` lowers it a lot, rotation refinement should become the default. Watch
  for depth jitter when it is on (near-planar hand → PnP ambiguity).
- Accuracy targets: tape-measure test at 40 / 60 / 100 cm; goal ±10 % depth
  after calibration.
- Whether world-landmark z (finger depth relative to the hand) is good enough
  for pinch detection, or needs a temporal prior.
- Grip calibration assumes the thumb and index landmarks sit at the object's
  ends; finger-pad thickness may bias s by a few mm over 50–86 mm. Compare
  against the measured-hand-length method.
- Real webcams' principal point may be off-centre by tens of pixels; if
  rectangle-based f is inconsistent across views, also estimate (cx, cy) from
  several views (Zhang's method).

## Roadmap

1. ✅ Monocular backend, calibration with everyday objects, demo.
1b. ✅ Bone-length calibration and bone-based depth (pose-dependent drift).
1c. ✅ Skeleton placement: rigid palm + ray–sphere fingers (foreshortening push-back).
2. ✅ Stereo in one tab (two `getUserMedia`, capture-time pairing, hand-keypoint
   self-calibration incl. time offset, triangulation; monocular fallback per view).
3. Two-device mode over WebRTC: a remote `StereoSource` that receives the
   phone's landmarks, intrinsics and capture times; clock sync replaces the
   time-offset search (or seeds it).
4. WebXR backend.
