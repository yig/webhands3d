import {
  MonocularHandTracker,
  createCalibrationPanel,
  watchCameras,
  openCamera,
  type CameraHandle,
  type DepthMethod,
  type Hand3D,
  type StatusKind,
} from '../src';
import { cm, createHandScene, drawHandOverlay, errorText, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const readout = $<HTMLDivElement>('readout');
const cameraSelect = $<HTMLSelectElement>('camera');
const refineInput = $<HTMLInputElement>('refine');
const depthMethodInput = $<HTMLSelectElement>('depthMethod');

const tracker = new MonocularHandTracker({ video });
let camera: CameraHandle | null = null;

// ---------- views ----------
const scene3d = createHandScene($<HTMLDivElement>('scene'));
function updateFrustum() {
  if (tracker.intrinsics) scene3d.setCameras([{ k: tracker.intrinsics }]);
}
function drawOverlay(hands: Hand3D[]) {
  const k = tracker.intrinsics;
  if (!k) return;
  drawHandOverlay(
    overlay,
    k,
    hands.flatMap((h) => (h.debug?.landmarks2d ? [h.debug.landmarks2d] : [])),
    hands.map((h) => h.joints),
  );
}

// ---------- readout ----------
const fps = fpsCounter();
function updateReadout(hands: Hand3D[]) {
  const lines = [`${fps().toFixed(0)} fps   hand scale ${tracker.handScale.toFixed(3)}`];
  if (!hands.length) lines.push('no hands');
  for (const h of hands) {
    const c = h.debug?.center;
    const wrist = h.joints;
    const w = h.debug?.worldLandmarks;
    lines.push(
      `${h.handedness.padEnd(5)} conf ${h.confidence.toFixed(2)}   skeleton ${tracker.skeletons[h.handedness] ? 'calibrated' : 'MediaPipe'}`,
      c ? `  centre  x ${cm(c[0])} y ${cm(c[1])} z ${cm(c[2])}` : '',
      `  wrist   x ${cm(wrist[0])} y ${cm(wrist[1])} z ${cm(wrist[2])}`,
      `  reproj  ${h.debug?.reprojectionError?.toFixed(1) ?? '?'} px`,
      // Diagnostic for depth drift: MediaPipe's own (unscaled) palm size. If it
      // changes with pose while the hand doesn't, uncalibrated depth drifts.
      w ? `  MP palm ${(palmSize(w) * 1000).toFixed(1)} mm` : '',
    );
  }
  const left = hands.find((h) => h.handedness === 'Left');
  const right = hands.find((h) => h.handedness === 'Right');
  if (left && right) lines.push(`wrist z, left − right: ${cm(left.joints[2] - right.joints[2])}`);
  readout.textContent = lines.join('\n');
}
/** Mean of the wrist–index MCP, wrist–pinky MCP and index–pinky MCP distances. */
function palmSize(w: ArrayLike<number>) {
  const d = (a: number, b: number) =>
    Math.hypot(w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1], w[a * 3 + 2] - w[b * 3 + 2]);
  return (d(0, 5) + d(0, 17) + d(5, 17)) / 3;
}

tracker.onFrame((hands) => {
  scene3d.updateHands(hands);
  drawOverlay(hands);
  updateReadout(hands);
});

// ---------- controls ----------
// All calibration UI comes from the library's panel.
const cal = tracker.calibrator;
const panel = createCalibrationPanel($('calibration'), { tracker, mirrored: () => mirrorInput.checked });
const say = (text: string, kind: StatusKind = 'info') => panel.say(text, kind);
cal.onChange(() => updateFrustum());

async function startCamera(deviceId?: string) {
  tracker.stop();
  camera?.stop();
  say('Opening camera…', 'busy');
  camera = await openCamera({ video, deviceId });
  say('Loading MediaPipe…', 'busy');
  await tracker.start();
  say(`${camera.label} running`, 'ok');
  updateFrustum();
  panel.refresh();
  populateCameras(camera.cameraId);
}

let knownCameras: MediaDeviceInfo[] = [];
function populateCameras(selected = cameraSelect.value) {
  cameraSelect.replaceChildren(
    ...knownCameras.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === selected)),
  );
}
// Ask for camera access up front, so the list shows every camera by name.
watchCameras((cameras) => {
  knownCameras = cameras;
  populateCameras();
}, { requestPermission: true, onError: (e) => say(`Camera access is blocked (${errorText(e)}). Allow the camera in the browser's site settings, then reload.`, 'error') });

$('start').addEventListener('click', () =>
  startCamera().catch((e) => say(errorText(e), 'error')),
);
cameraSelect.addEventListener('change', () =>
  startCamera(cameraSelect.value).catch((e) => say(errorText(e), 'error')),
);
const mirrorInput = $<HTMLInputElement>('mirror');
mirrorInput.addEventListener('change', () => $('videoWrap').classList.toggle('mirror', mirrorInput.checked));
$('videoWrap').classList.add('mirror');
refineInput.addEventListener('change', () => (tracker.refineRotation = refineInput.checked));
depthMethodInput.addEventListener('change', () => {
  tracker.depthMethod = depthMethodInput.value as DepthMethod;
});
