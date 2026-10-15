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
| **Remote cameras over WebRTC, N cameras** | **Implemented (phase 3).** Each phone/tab runs MediaPipe and sends 2D + world landmarks, intrinsics and capture times over a WebRTC data channel (~2 KB/frame); joins by QR code; signaling through a mailbox on the dev server; ping/pong clock sync. Generalised to any number of local and remote cameras (`MultiViewHandTracker`). See *Multi-view pipeline* and *Remote cameras*. |
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
  backends/assemble.ts     detections → Hand3D (placement + smoothing), shared by local and remote cameras
  backends/multiview.ts    MultiViewHandTracker: N ViewSources, triangulation, skeleton measurement
  backends/stereo.ts       StereoHandTracker = MultiViewHandTracker (two-camera alias)
  geometry/linalg.ts       symmetric eigen (Jacobi), 3×3 SVD, small matrix helpers
  stereo/epipolar.ts       8-point + RANSAC essential matrix, decomposition, LM refinement, triangulation
  stereo/pairing.ts        group samples into frames; interpolate a view's landmarks to a time
  stereo/calibrate.ts      calibrateStereo: time offset + relative pose + metric scale from hand frames
  remote/link.ts           Link: message pipe (WebRTC data channel, in-memory pair for tests)
  remote/protocol.ts       remote ↔ host messages (hello, intrinsics, frame, ping/pong, calibration)
  remote/clock.ts          ClockSync: NTP-style offset from the lowest-delay round trip
  remote/camera.ts         RemoteCamera (host side, a ViewSource) and RemoteCameraSender (phone side)
  remote/signaling.ts      Signaling interface + httpSignaling client (mailbox protocol)
  remote/webrtc.ts         connectToHost / acceptRemotes: WebRTC setup over Signaling, non-trickle ICE
  debug/recorder.ts        Recorder: per-camera landmarks, timing and calibration as JSON (replay offline)
tools/signaling.ts         Vite plugin serving the signaling mailbox (+ LAN address discovery)
demo/                      Vite dev pages: index.html (one camera), cameras.html (any number of
                           local + phone cameras, QR join), remote.html (phone side);
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

So the demo defaults to paper, asks for a 30–60° tilt, rejects near-frontal views,
and recommends several views. Lower-quality fallback: type in a FOV.

The tilt angle is never used — the homography solves for it — so it needn't
be accurate, only large enough. **Edge-aligned tilts** (the sheet tipped about
one of its own edges, the natural way to hold it) make one of the two
constraints vanish, so both long/short-edge assignments fit exactly; the tie
is broken by the camera's current focal length (`priorFocal`; the default or
earlier views). Without that, such views were off by up to 2.6×.

**Paper isn't rigid** (simulated, perfect clicks, A4 at 60 cm, tilts 30–60° in
all directions; focal error median / worst): a bow along the long side of
1 / 2 / 3 cm → 0.7 / 2.7 / 6 % (worst 1.4 / 6 / 14 %); along the short side
1 / 2 / 3 cm → 1.3 / 5.5 / 11 % (worst 3 / 12 / 30 %); one corner curling
5 mm / 1 cm → 2 / 4 % (worst 5 / 10 %). Bending is a bias (the sheet acts
smaller), so averaging views doesn't remove it: the demo says to lay the
sheet on a book or clipboard.

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

## Multi-view pipeline

`new MultiViewHandTracker([cam0, cam1, …])` (`StereoHandTracker` is the same
class). Each camera is a `ViewSource` (a `CalibratableTracker` with start/stop
and optionally a `calibrator`): a local `MonocularHandTracker` or a
`RemoteCamera`. Cameras can be added and removed while running
(`addSource` / `removeSource`). **Camera 0 is the reference**: output is in its
frame and on its clock, so it is drop-in compatible with monocular output, and
other cameras are calibrated against it. Each camera keeps its own per-camera
calibration (intrinsics, hand size, skeleton).

Camera 0 is *not* needed per frame: any usable camera's frames can drive the
output (below). **Removing camera 0** re-anchors to the first remaining
calibrated camera (`reanchor(k)`, also public): every pose and time offset is
re-expressed relative to camera k (X_j = R_j·R_kᵀ·X_k + (t_j − R_j·R_kᵀ·t_k),
offset_j − offset_k) and saved under the new pair keys; output switches to
camera k's frame. Without another calibrated camera, the next camera simply
becomes camera 0.

**Calibration** (`tracker.calibrate()`, 12 s, one hand moving through the shared
view at varied depths). *Note: the pairwise steps below were rebuilt for real
data — see "Robust pair calibration" — after a real recording failed.* Every other camera is calibrated **pairwise against
camera 0** (`calibrateStereo`), so each must share some view with camera 0;
pairs are stored separately (`webhands:stereo:<id0>|<idi>`), so adding a camera
doesn't invalidate the others. Per pair:
0. *Pairing* — **hands are not matched by MediaPipe's left/right labels**,
   which can disagree between cameras (one camera swapping them half the time
   gave a 1 cm baseline instead of 35 cm in simulation). The pose is estimated
   only from frames where each camera sees exactly one hand (paired whatever
   their labels); then frames with two hands in both cameras are added, paired
   by whichever assignment fits that pose's epipolar geometry clearly better
   (2× lower Sampson cost), and the pose is refined on the inliers. With both
   hands in view the whole time, calibration asks for one hand.
   Correspondences are taken at the **slower camera's** frame
   times, with the faster camera interpolated to them (short gaps), and
   interpolation limits scale with the camera's frame interval
   (`pairingLimits`: gaps up to 2.5 intervals, nearest frame within 0.6). A
   phone running MediaPipe may deliver only 10–15 fps; with fixed 30 fps limits
   most of its frames went unpaired and calibration degraded or failed.
1. *Time offset* — coarse: for offsets −200…200 ms (10 ms steps), a RANSAC
   essential matrix refined on its inliers; lowest median Sampson distance
   wins. Fine: ±60 ms around it, the offset that keeps the **triangulated hand
   size most constant** (MAD of log size), among offsets whose epipolar fit is
   within 1.5× (+0.5 px) of the best — elsewhere the pose can degenerate into
   trivially constant sizes. A timing error shifts points along the hand's
   motion; where that is along the epipolar lines the epipolar fit can't see
   it, but it changes triangulated depth, so the hand appears to grow and
   shrink. (This fixed a 20 ms error for a camera on the other side of the
   hand.)
2. *Relative pose* — 8-point essential matrix in RANSAC (samples from distinct
   frames, 4 px) → decomposition with points in front of both cameras →
   Levenberg–Marquardt on Sampson distances.
3. *Metric scale* — triangulated (unit baseline) bone lengths vs. camera 0's
   calibrated skeleton, else hand size × MediaPipe's median.
Then the collected frames are fused exactly as at runtime to **measure the
skeleton** (below).

**Per frame**:
1. Every usable camera (camera 0 + calibrated ones) keeps ~1 s of frames on
   camera 0's clock (capture time + its offset). Output instants are the
   **driving camera's** frame times: camera 0, or — if no frame has arrived
   from it for 300 ms — the first usable camera that is still sending. So a
   frozen or disconnected camera 0 doesn't stop tracking.
2. Each instant waits until every *active* camera (a frame arrived in the last
   500 ms) has a frame at or after it, but at most the slowest active camera's
   typical **arrival delay** (90th percentile of arrival − capture over its
   last 30 frames) **plus its frame interval** (its next frame may be captured
   up to one interval later) + 30 ms, capped at 600 ms. Phones run MediaPipe and then
   send over WiFi, so their frames can arrive 100–200 ms after capture; the
   former fixed 120 ms wait dropped them, so a hand seen only by a phone
   vanished. Latency is therefore about the slowest camera's delay.
3. Each camera's 2D landmarks are interpolated to the instant, with limits
   scaled to that camera's frame interval (`pairingLimits`). Hands are matched by handedness; with two
   hands, each camera's labels are checked against the first camera that sees
   both, and swapped if that fits the epipolar geometry much better.
4. Triangulate each joint from **all cameras that see the hand** (N-view DLT +
   Gauss–Newton on pixel error, `triangulateViews`). Camera 0 need not see it.
5. If the median joint error exceeds 12 px: with 3+ cameras, drop the camera
   that disagrees most and retry; otherwise (or with one camera) use the most
   confident camera's single-view 3D, mapped into camera 0's frame.
   `debug.source` is `stereo` (triangulated) or `view<i>`; `debug.views` lists
   the cameras used.
6. One Euro filter per hand. Before any camera is calibrated, camera 0 passes through.

**Skeleton measurement.** Triangulated hands give each bone's true 3D length
directly, with no foreshortening ambiguity and no reliance on MediaPipe's z.
Frames with median joint error < 3 px and max < 10 px are buffered (last 600
per hand). Each bone's length is the median over the buffer; the palm template
is the Kabsch-aligned median of the 5 palm joints. The result is given to
**every** camera (saved through its calibrator), so any camera's single-view
fallback uses the skeleton placement with measured proportions. Cameras without
a calibrated hand size also get one: the median of triangulated hand size / that
camera's MediaPipe hand size. This happens at calibration and then every 5 s
while running (`refineSkeleton`, default on; `refineIntervalMs`). The overall
size still comes from camera 0's hand size or skeleton; triangulation fixes
proportions, not the metric scale. (A fully independent scale would need a
known baseline or a known-size object seen by two cameras; not implemented.)

## Robust pair calibration (real MediaPipe data)

A real recording (laptop + iPhone back camera in portrait over WebRTC, Safari)
calibrated badly: 12 % inliers, median epipolar error 11–25 px, answers
varying from 8 to 47 cm. Replaying it (`npm run replay`) and testing hypotheses
against it found:

- **Landmark noise is much larger than simulated.** MediaPipe's 2D landmarks
  for the same hand disagree between two viewpoints by ~5–10 px for a ~300 px
  hand (more for occluded joints), and some frames are garbage. It's not
  timing (error doesn't grow with hand speed) and not coordinate
  rotation/mirroring/aspect issues (tested). The fixed 4 px inlier threshold
  rejected most good points, and 8-point RANSAC on such noisy points rarely
  produced a good model.
- **Fields of view matter and were both the 60° default.** A portrait phone's
  real horizontal FOV is ~40–45°.
- **Focal lengths can't be estimated from the pair.** With both cameras
  converging on the hand, epipolar error and even hand-size constancy only
  determine the *ratio* of the two focal lengths (a valley along the
  diagonal of a FOV grid, in simulation and on the recording); a free fit
  runs to extreme FOVs.

Changes (`src/stereo/robust.ts`, `calibrateStereo`):
- Inlier threshold = 3 % of the median hand length in pixels (≥ 4 px).
- Starting poses from (a) RANSAC and (b) the robust mean rotation between
  the two views' MediaPipe 3D hands (Kabsch per frame, ~25° noise each,
  trimmed mean), with the translation direction from 2-point RANSAC given the
  rotation (a least-squares direction was 78° off with 10 % garbage frames).
- Trimmed Levenberg–Marquardt in pixels (keep residuals < max(3×median,
  threshold), three rounds); best median error wins.
- Time offset: initial pose at offset 0, then median error under that pose
  over −200…200 ms (cheap), refit, finer search, then hand-size constancy.
- Default intrinsics: **66° across the long image side** (`defaultIntrinsics`)
  instead of 60° horizontal, so a portrait phone defaults to ~40°.
- `StereoCalibration.warning` when < 50 % of points are consistent or the
  median error exceeds the threshold (advice: set FOVs with the A4 step).

Results — simulation with 6 px noise, ~20° 3D-hand wobble, 10 % garbage frames,
22 fps portrait phone: rotation < 1.5°, baseline within 5 %, offset within
10 ms with true FOVs; with the default FOVs (66°/40° vs true 70°/45°)
rotation < 4°, baseline within 15 %. The real recording now gives one
consistent geometry (phone to the right, turned ~58° toward the hand; 68–72 %
inliers, 4–6 px) whose baseline depends on the assumed FOVs (33 cm at 60°/60°,
49 cm at the new defaults) — the remaining reason to calibrate FOVs.

## Remote cameras

A phone (or another tab/computer) joins as a camera:

- **Phone side** (`demo/remote.html`): a `MonocularHandTracker` on its camera
  plus a `RemoteCameraSender`, which sends `hello` (stable camera id = random
  device token + local camera id, and a label), `intrinsics` (again when they
  change, e.g. after the phone's own FOV / A4 calibration), and per frame its
  capture time (phone clock), and each hand's handedness, confidence, 2D
  landmarks (0.1 px) and world landmarks (0.01 mm). JSON, ~2 KB/frame. It
  answers clock pings and applies calibration the host measured (hand size,
  skeleton) to its own tracker.
- **Host side**: `RemoteCamera` is a `ViewSource`. It converts capture times to
  the host clock with `ClockSync` (pings every 300 ms ×10, then every 1 s;
  offset from the lowest-delay round trip of the last 20), and places hands
  in 3D **on the host** with the same `HandAssembler` as a local camera, using
  hand size / skeleton stored on the host under `remote:<id>`. Closes after 5 s
  of silence. The pair time-offset search still runs on top of clock sync and
  absorbs the remaining pipeline latency difference.
- **Connection**: `connectToHost` (phone, offerer) / `acceptRemotes` (host).
  Non-trickle ICE, so signaling is one offer and one answer through a
  `Signaling` mailbox. `httpSignaling` speaks a tiny HTTP long-poll protocol
  served by `tools/signaling.ts` (a Vite plugin; any server implementing it
  works). No ICE servers by default: works on one local network; pass
  `iceServers` (STUN/TURN) otherwise.
- **Joining**: the host page shows a QR code for
  `https://<LAN address>/remote.html?room=<room>` (room id remembered per host
  browser). Phones need HTTPS for camera access: `npm run dev:lan` serves the
  demo over HTTPS with a self-signed certificate on all interfaces (phones show
  a certificate warning to accept once).
- Verified headless (`npm run smoke`, Chrome with fake cameras, no hands):
  pages load without errors; local cameras are added and removed (and offered
  again); a phone page connects over WebRTC, streams at camera rate, and
  appears / disappears on the host; removing the reference camera keeps the
  phone running.

**Simulation** (`test/stereoSim.ts`, `test/multiview.test.ts`: 1280×720 60°,
1920×1080 70° and 1280×720 65° cameras, 30–35 cm either side of camera 0 and
turned inward, hand on a smooth path 40–80 cm away, 1–1.5 px noise, clocks
+60 ms and −30 ms off):

| Quantity | Recovered | True |
|---|---|---|
| Time offsets | 59 / 61 / −29 ms | 60 / 60 / −30 ms |
| Rotation | < 0.1° error | — |
| Baseline (skeleton scale) | 35.5 cm | 35.5 cm |
| Baseline (hand-size scale) | within 8 % | — |
| Joint error, triangulated | 0.5 mm median | — |
| Joint error, cameras 1+2 only (camera 0 lost the hand) | < 5 mm median | — |
| Second hand seen only by cameras 1+2, their frames arriving 150 ms late | tracked in every frame, < 5 mm median | — |
| Camera 0 stops sending | cameras 1+2 keep driving the output | — |
| Phones at 10 / 12 fps arriving 150 / 180 ms late: calibration, then a hand only they see | both calibrated < 1°; hand tracked (triangulated) in ≥ 90 % of frames | — |
| Pair calibration with a 10 fps camera, offset 120 ms | offset 119 ms, < 1°, baseline within 3 % | — |
| Skeleton measured by triangulation | < 3 % per bone (median) | — |

vs. ~15 mm joint error for the monocular skeleton method. Calibration takes
< 1 s to compute per camera.

**Diagnostics**: `tracker.status.views[i]` reports each camera's fps, arrival
delay, the hands in its latest frame, and whether it is `used` (camera 0 or
calibrated, and sending). The demo readout lists these per camera and flags an
uncalibrated camera whose hands are being ignored.

**Practical notes**: turn off Center Stage (macOS Video Effects) on all
cameras — it crops/zooms continuously, changing the intrinsics. Each camera's
focal length matters (use the paper step per camera, or enter FOVs); errors
there bias depth. Two `getUserMedia` calls are made sequentially.

## Debug recordings

`Recorder` (`src/debug/recorder.ts`) subscribes to every camera of a
multi-camera tracker and records, per frame: capture time, arrival time, and
each hand's label, confidence, 2D landmarks (0.1 px) and MediaPipe world
landmarks — plus each camera's id, label, intrinsics, hand scale and skeleton,
and the camera poses before and after. No images. ~0.5 MB per 10 s for two
cameras. The cameras demo records every calibration run automatically
("Download last calibration recording") and has "Record 10 s" for tracking
problems.

`npm run replay -- <file>` (`test/replay.test.ts`) prints per-camera stats
(fps, arrival delay, frames with 0/1/2 hands, label counts, intrinsics), the
browser's result, and re-runs `calibrateStereo` on each pair with its
`onDiagnostics` hook: the coarse time-offset curve, the fine search (hand-size
spread and Sampson error per offset), paired hand-frames (single-hand vs.
total), inlier counts, and the bone-length scale ratios. It then replays
**tracking**: the recorded frames, in arrival order, through
`MultiViewHandTracker` with the camera poses the session had, reporting where
each output hand came from (triangulated vs. one camera), the triangulation
errors (also with no error cutoff), and how often the cameras' left/right
labels agree. Recordings go in `recordings/` (git-ignored).

Reading the readout: "from camera N only" means the hand wasn't triangulated —
usually because the stored camera pose doesn't match what the cameras see
(triangulation error above 12 px); single-camera 3D is shown instead, so it can
look fine. Recalibrating the cameras fixes it.

## Open questions / to verify empirically

- Stereo on real cameras: does hand self-calibration converge with real
  MediaPipe noise and a ~30 fps unsynchronised, rolling-shutter pair? Does the
  Continuity Camera time offset stay constant, or drift (would need online
  re-estimation)? Is the iPhone's focal length stable (lens switching)?
- Remote cameras: real WiFi latency/jitter and phone thermal throttling; does
  the clock offset stay put (pings follow drift; the pair time offset doesn't)?
  Should the per-pair time offset be re-estimated online?
- Cameras that don't overlap camera 0 can't be calibrated yet; chaining via
  other cameras (or a joint bundle adjustment over all cameras and frames)
  would remove that restriction and refine every pose together.
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
2b. ✅ Skeleton measured by triangulation (at calibration and continuously),
   given to every camera for single-view fallback.
3. ✅ Remote cameras over WebRTC, generalised to N cameras (local and remote).
4. WebXR backend.
