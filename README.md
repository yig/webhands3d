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
2. **Focal length**: easiest and most accurate, open `/pattern.html` on a phone
   or tablet and hold its screen up to the camera, tilting it, after clicking
   **Start**. Or hold a credit card or a sheet of paper (flat, on a book) tilted
   30–60°, click **Freeze & click corners** and click near its 4 corners; they
   snap to the edges. Or hold your hand at a measured distance.
3. **Hand skeleton** (bone lengths and palm shape; fixes distance drifting with
   pose and tilted hands being pushed back): show both hands and slowly turn
   them in every direction for 8 s.

Calibration is saved per camera in `localStorage`.

Several cameras: open `/cameras.html`, add this computer's cameras, and/or join
phones by scanning the QR code (phones need HTTPS: run `npm run dev:lan` and open
the printed `https://` network address; accept the self-signed certificate once).
Then set each camera's field of view, calibrate the hand size, and calibrate the
camera positions by moving one hand through the shared view for 12 s. That also
measures your hand's bone lengths for every camera. Turn off Center Stage.

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

The quickest way: a ready-made, guided calibration UI for any tracker (it is
what the demos use):

```ts
import { createCalibrationPanel } from 'webhands';

createCalibrationPanel(document.querySelector('#calibration'), { tracker });
```

It shows each step's status, live feedback over the video, and a status banner;
it renders in a shadow root and can be themed with `--wh-*` CSS variables.

Or drive the steps yourself. Calibration is part of the library. Each step collects frames, applies the
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

### Several cameras

```ts
import { MonocularHandTracker, MultiViewHandTracker, RemoteCamera, acceptRemotes, httpSignaling } from 'webhands';

const tracker = new MultiViewHandTracker([
  new MonocularHandTracker({ deviceId: laptopCamId }),   // camera 0: the reference frame
  new MonocularHandTracker({ deviceId: secondCamId }),
]);
tracker.onFrame((hands) => { /* joints in camera 0's frame; hand.debug.views = cameras used */ });
await tracker.start();

// Phones join over WebRTC (they run RemoteCameraSender; see demo/remote.ts).
acceptRemotes(httpSignaling(location.origin, room), (link) => tracker.addSource(new RemoteCamera(link)));

await tracker.calibrate({ onProgress }); // move one hand around, 12 s; also measures the skeleton
```

### WebXR (Meta Quest and other headsets)

```ts
import { WebXRHandTracker } from 'webhands';

const tracker = new WebXRHandTracker();            // or { session } to share your renderer's XR session
tracker.onFrame((hands) => { /* same Hand3D format: 21 joints, metres */ });
button.onclick = () => tracker.start();            // needs a user gesture
```

Demo: `/xr.html` in the Quest Browser (over HTTPS, `npm run dev:lan`).

## Scripts

- `npm run dev`: demo dev server
- `npm run dev:lan`: demo over HTTPS on the local network (for phones)
- `npm run smoke [-- <url>]`: headless browser check of the demo pages (needs Chrome and a running dev server)
- `npm run replay -- <recording.json>`: re-run calibration on a debug recording from the cameras demo, with diagnostics
- `npm test`: unit tests
- `npm run build`: library to `dist/`
