# webhands3d

3D hand tracking in the browser with no special hardware: 21 joints per hand, in
metres. All inputs produce the same output:

- **one webcam**: MediaPipe, plus a calibrated hand skeleton for distance;
- **several cameras**: this computer's cameras and **phones** that join by
  scanning a QR code; joints are triangulated from every camera that sees them;
- **WebXR headsets** with hand tracking (e.g. Meta Quest).

It includes guided, drop-in **calibration UI**. You calibrate each camera's lens
with a pattern shown on another screen, or with a credit card or sheet of paper.
You calibrate hand size with a credit card, and camera positions by moving one
hand around.

**Live demo:** https://yig.github.io/webhands3d/ (one camera ·
[several cameras](https://yig.github.io/webhands3d/cameras.html) ·
[WebXR](https://yig.github.io/webhands3d/xr.html))

## Install

```sh
npm install @ygingold/webhands3d
```

The ES module includes TypeScript types. MediaPipe's model and WebAssembly files
load from a CDN by default (`wasmPath` / `modelAssetPath` to self-host). Phones
connect through [PeerJS](https://peerjs.com).

## One camera

```ts
import { MonocularHandTracker, createCalibrationPanel } from '@ygingold/webhands3d';

const tracker = new MonocularHandTracker();          // opens the default camera
tracker.onFrame((hands) => {
  for (const hand of hands) {
    // hand.handedness: 'Left' | 'Right'
    // hand.joints: Float32Array of 21 × (x, y, z) metres in MediaPipe's joint order,
    //   camera frame: +x right, +y down, +z away from the camera
  }
});
await tracker.start();

// Guided calibration UI (lens, hand size, bone lengths) with a status banner:
createCalibrationPanel(document.querySelector('#calibration'), { tracker });
```

## Several cameras, including phones

```ts
import {
  MonocularHandTracker, MultiViewHandTracker,
  createCalibrationPanel, createRemoteCameraJoin,
} from '@ygingold/webhands3d';

const tracker = new MultiViewHandTracker([new MonocularHandTracker()]); // camera 0 = reference frame
tracker.onFrame((hands) => { /* joints in camera 0's frame; hand.debug.views = cameras used */ });
await tracker.start();

// QR code + link for phones; each phone that connects becomes a camera.
createRemoteCameraJoin(document.querySelector('#join'), {
  tracker,
  phonePageUrl: 'https://example.com/phone.html',  // your HTTPS page running mountRemoteCamera
});

// Lens per camera, hand size, camera positions (move one hand through the shared view for 12 s):
createCalibrationPanel(document.querySelector('#calibration'), { tracker });
```

The phone page is one call:

```ts
import { mountRemoteCamera } from '@ygingold/webhands3d';
mountRemoteCamera(document.querySelector('#remote'));   // reads ?host=… from the QR link
```

Phones need the page over **HTTPS** to use their camera, and both devices need
internet access. PeerJS's free public server only helps the two browsers find
each other; hand data then flows directly between them. That server sees the
peer ids and connection-setup messages, including the devices' network
addresses, but no hand data. To use your own
[PeerServer](https://github.com/peers/peerjs-server), pass `peerOptions`. Pass
`config.iceServers` there for your own STUN/TURN.

## WebXR (Meta Quest and other headsets)

```ts
import { WebXRHandTracker } from '@ygingold/webhands3d';

const tracker = new WebXRHandTracker();          // or { session } to share your renderer's XR session
tracker.onFrame((hands) => { /* same Hand3D format: 21 joints, metres */ });
button.onclick = () => tracker.start();          // needs a user gesture
```

## Calibration without the panel

Every step is also an API. Steps collect frames, apply the result and save it per
camera. They reject with a `CalibrationError` whose `code` says what to fix:

```ts
import { calibrateFromPattern, pickRectangle } from '@ygingold/webhands3d';

const cal = tracker.calibrator;
await calibrateFromPattern(video, cal, () => tracker.intrinsics);   // pattern shown on another screen
cal.addRectangleView((await pickRectangle(video)).corners, 'card'); // or a credit card / A4 / Letter
await cal.handSizeFromObject('card-long');                          // card held between thumb and index
await cal.skeleton();                                               // one camera: bone lengths (8 s)
console.log(cal.status.missing);                                    // [] when fully calibrated
```

How it works, the design decisions, and the measured accuracy are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```sh
npm install
npm run dev        # demo pages at http://localhost:5173 (one camera, cameras, xr)
npm run dev:lan    # the same over HTTPS on your local network, for phones (accept the certificate once)
```

- `npm test`: unit tests. `npm run typecheck`: TypeScript.
- `npm run build`: the library, to `dist/`. `npm run build:demo`: the demo as a static site, to `dist-demo/`.
- `npm run smoke [-- <url>]`: headless Chrome check of the demo pages. Needs Chrome, a running dev server and internet (PeerJS).
- `npm run replay -- <recording.json>`: re-run calibration and tracking on a debug recording from the cameras demo.

Turn off Center Stage (macOS Video Effects) on cameras you track with: it crops
and zooms, which changes the camera's geometry.

## Releasing

1. **GitHub**: create the empty repository `yig/webhands3d`, then
   `git remote add origin git@github.com:yig/webhands3d.git` and
   `git push -u origin main`.
2. **Demo**: in the repository's Settings → Pages, set Source to "GitHub
   Actions". The `Demo on GitHub Pages` workflow then publishes the demo on
   every push to `main`.
3. **npm**: `npm login`, then `npm publish`. `prepublishOnly` runs the tests and
   the build; `publishConfig` makes the scoped package public. For later
   releases: `npm version patch|minor|major`, `git push --follow-tags`,
   `npm publish`.

## License

[CC0 1.0](LICENSE): public domain dedication. CC0 does not grant patent rights.
