import {
  KNOWN_LENGTHS,
  KNOWN_RECTANGLES,
  MonocularHandTracker,
  listCameras,
  openCamera,
  pickCorners,
  type CalibrationStatus,
  type CameraHandle,
  type DepthMethod,
  type Hand3D,
} from '../src';
import { cm, createHandScene, drawHandOverlay, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const status = $<HTMLDivElement>('status');
const readout = $<HTMLDivElement>('readout');
const cameraSelect = $<HTMLSelectElement>('camera');
const fovInput = $<HTMLInputElement>('fov');
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
// Everything below uses only the public calibration API (tracker.calibrator, pickCorners).
const cal = tracker.calibrator;

async function startCamera(deviceId?: string) {
  tracker.stop();
  camera?.stop();
  status.textContent = 'Opening camera…';
  camera = await openCamera({ video, deviceId });
  status.textContent = 'Loading MediaPipe…';
  await tracker.start();
  status.textContent = camera.label;
  renderCalibration(cal.status);
  await populateCameras(camera.cameraId);
}

async function populateCameras(selected: string) {
  const cams = await listCameras();
  cameraSelect.replaceChildren(
    ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === selected)),
  );
}

$('start').addEventListener('click', () =>
  startCamera().catch((e) => (status.textContent = String(e))),
);
cameraSelect.addEventListener('change', () =>
  startCamera(cameraSelect.value).catch((e) => (status.textContent = String(e))),
);
const mirrorInput = $<HTMLInputElement>('mirror');
mirrorInput.addEventListener('change', () => $('videoWrap').classList.toggle('mirror', mirrorInput.checked));
$('videoWrap').classList.add('mirror');
refineInput.addEventListener('change', () => (tracker.refineRotation = refineInput.checked));
depthMethodInput.addEventListener('change', () => {
  tracker.depthMethod = depthMethodInput.value as DepthMethod;
});

/** Reflect calibration state in the panel and the 3D view. */
function renderCalibration(s: CalibrationStatus) {
  if (s.focal.hfovDegrees !== null) fovInput.value = s.focal.hfovDegrees.toFixed(1);
  const views = s.focal.views;
  $('focalViews').textContent = views.length
    ? `${views.length} view(s): ${views.map((v) => v.toFixed(0)).join(', ')} px`
    : '';
  const sides = (['Left', 'Right'] as const).filter((side) => s.skeleton[side]);
  $('bonesState').textContent = sides.length ? `Calibrated: ${sides.join(', ')}` : 'Not calibrated';
  updateFrustum();
}
cal.onChange(renderCalibration);

/** Run a calibration step with its button disabled, reporting the outcome in the status line. */
async function runStep(button: HTMLButtonElement, hint: string, step: () => Promise<string>) {
  button.disabled = true;
  status.textContent = hint;
  try {
    status.textContent = await step();
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    button.disabled = false;
  }
}

fovInput.addEventListener('change', () => {
  const fov = parseFloat(fovInput.value);
  if (fov > 0) cal.setFieldOfView(fov);
});

// --- Step 1: hand size, from a gripped object of known length or a measured hand ---
const scaleRef = $<HTMLSelectElement>('scaleRef');
scaleRef.append(
  ...KNOWN_LENGTHS.map((o) => new Option(o.label, o.id)),
  new Option('My measured hand length', 'hand'),
);
function updateScaleUi() {
  const hand = scaleRef.value === 'hand';
  $('handLengthRow').hidden = !hand;
  $('scaleHint').textContent = hand
    ? 'Hold one open hand, fingers together, facing the camera.'
    : 'Hold the object by its two ends between thumb tip and index fingertip, facing the camera.';
}
scaleRef.addEventListener('change', updateScaleUi);
updateScaleUi();

const calScale = $<HTMLButtonElement>('calScale');
calScale.addEventListener('click', () =>
  runStep(calScale, 'Hold still…', async () => {
    const scale =
      scaleRef.value === 'hand'
        ? await cal.handSizeFromLength(parseFloat($<HTMLInputElement>('handLength').value) / 100)
        : await cal.handSizeFromObject(scaleRef.value);
    return `Hand scale ${scale.toFixed(3)}`;
  }),
);

// --- Step 2: focal length, from clicking a known rectangle's corners, or hand distance ---
const focalRef = $<HTMLSelectElement>('focalRef');
focalRef.append(
  ...KNOWN_RECTANGLES.map((o) => new Option(o.label, o.id)),
  new Option('Hand at a measured distance', 'distance'),
);
focalRef.value = 'a4';
const calFocal = $<HTMLButtonElement>('calFocal');
function updateFocalUi() {
  const distance = focalRef.value === 'distance';
  $('distanceRow').hidden = !distance;
  $('focalHint').textContent = distance
    ? 'Needs step 1 first. Hold the hand centred in view at the measured distance.'
    : 'Hold the object tilted 30–60° away from the camera (any direction), flat (paper on a book or ' +
      'clipboard), as large as possible in view. ' +
      'Freeze, then click its 4 corners in order around the edge (Esc cancels). Paper is much ' +
      'more accurate than a card; add several views.';
  calFocal.textContent = distance ? 'Calibrate distance' : 'Freeze & click corners';
  cal.clearRectangleViews();
}
focalRef.addEventListener('change', updateFocalUi);
updateFocalUi();

calFocal.addEventListener('click', () => {
  if (focalRef.value === 'distance') {
    runStep(calFocal, 'Hold still…', async () => {
      const f = await cal.focalFromDistance(parseFloat($<HTMLInputElement>('distance').value) / 100);
      return `Focal ${f.toFixed(0)} px (FOV ${fovInput.value}°)`;
    });
    return;
  }
  runStep(calFocal, 'Click the 4 corners in order around the edge', async () => {
    const corners = await pickCorners(video, { mirrored: mirrorInput.checked });
    const f = cal.addRectangleView(corners, focalRef.value);
    return `Focal ${f.toFixed(0)} px (FOV ${fovInput.value}°). Add more views to average.`;
  });
});

// --- Step 3: hand skeleton ---
const calBones = $<HTMLButtonElement>('calBones');
calBones.addEventListener('click', () =>
  runStep(calBones, 'Turn both hands slowly in every direction…', async () => {
    const result = await cal.skeleton({
      onProgress: ({ elapsedMs, durationMs, frames }) => {
        status.textContent =
          `Turn both hands slowly in every direction… ${Math.ceil((durationMs - elapsedMs) / 1000)} s ` +
          `(left ${frames.Left}, right ${frames.Right} frames)`;
      },
    });
    const totals = (['Left', 'Right'] as const)
      .filter((side) => result[side])
      .map((side) => `${side} ${(result[side]!.lengths.reduce((a, b) => a + b, 0) * 1000).toFixed(0)} mm`);
    return `Skeleton calibrated (bone totals: ${totals.join(', ')})`;
  }),
);

$('calReset').addEventListener('click', () => {
  cal.reset();
  status.textContent = 'Calibration reset';
});
