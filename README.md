# webhands

3D hand tracking in the browser with no special hardware.

Currently: a **monocular** backend. MediaPipe Hand Landmarker gives each hand's
metric shape and 2D landmarks, and a perspective-n-point solve places it in the
camera frame (metres). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
design, the alternatives considered, and the roadmap (stereo, WebXR).

## Demo

```sh
npm install
npm run dev
```

Open the printed URL in Chrome and click **Start camera**. For accurate depth,
calibrate using objects you probably have (no ruler needed):

1. **Hand size**: pick an object (credit card, AA battery, …), hold it by its
   two ends between thumb tip and index fingertip, click **Calibrate hand size**.
   Or enter your measured hand length.
2. **Focal length**: pick a rectangle (A4 / Letter paper is most accurate),
   hold it tilted ~45° away from the camera, click **Freeze & click corners**
   and click its 4 corners. Repeat for a few views. Or hold your hand at a
   measured distance.
3. **Hand skeleton** (bone lengths and palm shape; fixes distance drifting with
   pose and tilted hands being pushed back): show both hands and slowly turn
   them in every direction for 8 s.

Calibration is saved per camera in `localStorage`.

Two cameras (e.g. laptop + iPhone via Continuity Camera): open `/stereo.html`
from the demo, pick both cameras, then calibrate each camera's field of view,
the hand size, and the camera pair (move one hand through the shared view for
12 s). Turn off Center Stage.

## Library

```ts
import { MonocularHandTracker } from 'webhands';

const tracker = new MonocularHandTracker();   // opens the default camera
tracker.onFrame((hands) => {
  for (const hand of hands) {
    // hand.joints: Float32Array of 21 × (x, y, z) metres,
    // camera frame: +x right, +y down, +z away from the camera
  }
});
await tracker.start();
```

### Calibration

Calibration is part of the library. Each step collects frames, applies the
result to the tracker and saves it per camera; steps reject with a
`CalibrationError` whose `code` explains what to fix.

```ts
import { pickCorners } from 'webhands';

const cal = tracker.calibrator;

// 1. Hand size: hold a credit card by its long edge between thumb and index tips.
await cal.handSizeFromObject('card-long');

// 2. Focal length: hold a sheet of A4 tilted ~45°, click its corners; repeat a few times.
cal.addRectangleView(await pickCorners(video, { mirrored: true }), 'a4');

// 3. Skeleton: turn both hands in every direction for 8 s.
await cal.skeleton({ onProgress: ({ elapsedMs, frames }) => console.log(elapsedMs, frames) });

console.log(cal.status.missing); // [] when fully calibrated
```

Objects: `KNOWN_LENGTHS` (card edges, AA/AAA batteries) and `KNOWN_RECTANGLES`
(A4, US Letter, card, US/€5 banknotes), or pass your own sizes.

### Two cameras

```ts
import { MonocularHandTracker, StereoHandTracker } from 'webhands';

const a = new MonocularHandTracker({ deviceId: laptopCamId });
const b = new MonocularHandTracker({ deviceId: phoneCamId });
const stereo = new StereoHandTracker([a, b]);
stereo.onFrame((hands) => { /* joints in camera A's frame; hand.debug.source = 'stereo' | 'view0' | 'view1' */ });
await stereo.start();
if (!stereo.status.calibrated) await stereo.calibrate({ onProgress }); // move one hand around, 12 s
```

## Scripts

- `npm run dev`: demo dev server
- `npm test`: unit tests
- `npm run build`: library to `dist/`
