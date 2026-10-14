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
calibrate:

1. Measure your hand from wrist crease to middle fingertip, enter it, hold the
   open hand facing the camera, click **Calibrate hand size**.
2. Hold the same hand centred in view at a measured distance, enter it, click
   **Calibrate distance**.

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
