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

Calibration is saved per camera in `localStorage`.

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

## Scripts

- `npm run dev`: demo dev server
- `npm test`: unit tests
- `npm run build`: library to `dist/`
