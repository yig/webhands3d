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
| **Stereo, one tab** | Planned (phase 2). Chrome can open two cameras at once; macOS Continuity Camera exposes an iPhone as an ordinary webcam. Run MediaPipe on both, pair frames by `requestVideoFrameCallback` capture time, triangulate. Calibrate from hand keypoints themselves (essential matrix + bundle adjustment, hand size fixes scale) or from a printed ChArUco board. |
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
  calibration/index.ts     hand-scale and focal-length calibration from samples
  backends/monocular.ts    MonocularHandTracker (MediaPipe + solvePose + smoothing)
demo/                      Vite dev page: video + 2D overlay, three.js 3D view, calibration UI
test/                      vitest unit tests (synthetic PnP)
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
  debug?: { landmarks2d, worldLandmarks, center, reprojectionError };
}
interface HandTrackerBackend {
  start(): Promise<void>; stop(): void;
  onFrame(listener: (hands: Hand3D[]) => void): () => void;
}
```

Every backend (monocular, stereo, WebXR) produces `Hand3D` so apps can switch
backends without changes. `debug` is backend-specific.

## Conventions

- **Camera frame**: OpenCV convention, +x right, +y down, +z forward (away from
  the camera), metres, origin at the camera's optical centre. MediaPipe's image
  and world landmarks use the same axis directions. three.js uses (x, −y, −z).
- **Images are not mirrored** when passed to MediaPipe. The demo mirrors the
  display with CSS only.
- **Handedness**: MediaPipe labels hands as if the image were mirrored, so the
  monocular backend swaps the label unless `mirroredInput: true`.
- **Intrinsics**: square pixels, principal point at image centre, no distortion.
  Focal length is stored as `fx / width` per camera (`localStorage`, key
  `webhands:calibration:<deviceId>`), so it survives resolution changes that
  don't crop.

## Monocular pipeline

Per video frame (`requestVideoFrameCallback`; capture time used as timestamp,
forced strictly increasing for MediaPipe):

1. `HandLandmarker.detectForVideo` (VIDEO mode, GPU delegate, up to 2 hands) →
   per hand: image landmarks (normalised → pixels) and world landmarks W (m).
2. Model P = s · W, where s is the per-user hand scale.
3. `solvePose(P, uv, K)`:
   - **Linear init** with R = I: each joint gives
     `tx − x̂·tz = x̂·Pz − Px`, `ty − ŷ·tz = ŷ·Pz − Py` (x̂, ŷ normalised image
     coordinates) → 3×3 normal equations.
   - **Levenberg–Marquardt** on pixel reprojection error over t, plus a
     left-multiplied rotation update ω if `refineRotation` is on.
4. Joints = R · P + t; One Euro filter per handedness (default
   `minCutoff 1.5, beta 5`); filters reset when a hand disappears.

### Why depth needs calibration

depth ≈ f · (hand size) / (hand size in pixels). Two unknowns, f and s, enter as
a product, so one measurement can't separate them:

1. **Hand scale** — user enters wrist-crease → middle-fingertip length;
   s = measured / median(MediaPipe wrist→middle-tip length) over ~1.5 s.
2. **Focal length** — with s fixed, user holds the hand centred at a measured
   distance; f' = f · measured / median(estimated z).

Without calibration: s = 1 (MediaPipe's average hand) and a 60° horizontal FOV.
Lateral position error scales with focal error; depth error scales with both.

## Open questions / to verify empirically

- Are MediaPipe world landmarks really camera-aligned in rotation? If the
  reprojection error with `refineRotation: false` is consistently high while
  `true` lowers it a lot, rotation refinement should become the default. Watch
  for depth jitter when it is on (near-planar hand → PnP ambiguity).
- Handedness swap direction for unmirrored input (check in the demo with a
  known hand).
- Accuracy targets: tape-measure test at 40 / 60 / 100 cm; goal ±10 % depth
  after calibration.
- Whether world-landmark z (finger depth relative to the hand) is good enough
  for pinch detection, or needs a temporal prior.

## Roadmap

1. ✅ Monocular backend, calibration, demo.
2. Stereo in one tab (two `getUserMedia`, capture-time pairing, hand-keypoint
   self-calibration, triangulation; fall back to monocular per view on occlusion).
3. Two-device mode over WebRTC.
4. WebXR backend.
