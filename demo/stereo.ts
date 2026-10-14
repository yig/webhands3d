import {
  MonocularHandTracker,
  StereoHandTracker,
  listCameras,
  openCamera,
  pickCorners,
  type CameraHandle,
  type Hand3D,
} from '../src';
import { cm, createHandScene, drawHandOverlay, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLDivElement>('status');
const readout = $<HTMLDivElement>('readout');
const videos = [$<HTMLVideoElement>('video0'), $<HTMLVideoElement>('video1')] as const;
const overlays = [$<HTMLCanvasElement>('overlay0'), $<HTMLCanvasElement>('overlay1')] as const;
const cameraSelects = [$<HTMLSelectElement>('camera0'), $<HTMLSelectElement>('camera1')] as const;
const fovInputs = [$<HTMLInputElement>('fov0'), $<HTMLInputElement>('fov1')] as const;

// Each camera is a single-camera tracker; the stereo tracker fuses them.
const views = [new MonocularHandTracker({ video: videos[0] }), new MonocularHandTracker({ video: videos[1] })] as const;
const stereo = new StereoHandTracker([views[0], views[1]]);
let cameras: CameraHandle[] = [];

const scene3d = createHandScene($<HTMLDivElement>('scene'));
function updateCameras() {
  const [k0, k1] = [views[0].intrinsics, views[1].intrinsics];
  if (!k0) return;
  const cal = stereo.calibrations[1];
  scene3d.setCameras(
    cal && k1 ? [{ k: k0 }, { k: k1, R: cal.R, t: cal.t, color: 0xc08a5a }] : [{ k: k0 }],
  );
  views.forEach((v, i) => {
    if (v.intrinsics) fovInputs[i].value = v.calibrator.status.focal.hfovDegrees!.toFixed(1);
  });
  $('stereoState').textContent = cal
    ? `Calibrated: baseline ${(Math.hypot(...cal.t) * 100).toFixed(1)} cm, ` +
      `time offset ${cal.timeOffsetMs} ms, epipolar error ${cal.rmsPx.toFixed(1)} px, ` +
      `${(cal.inlierRatio * 100).toFixed(0)} % inliers, scale from ${cal.scaleFrom === 'skeleton' ? 'skeleton' : 'hand size'}`
    : 'Not calibrated (showing camera A only)';
}
views.forEach((v) => v.calibrator.onChange(updateCameras));

// Camera B's own detections, for its overlay.
let latestB: Hand3D[] = [];
views[1].onFrame((hands) => (latestB = hands));

const fps = fpsCounter();
stereo.onFrame((hands) => {
  scene3d.updateHands(hands);
  const [k0, k1] = [views[0].intrinsics, views[1].intrinsics];
  const cal = stereo.calibrations[1];
  if (k0) {
    drawHandOverlay(
      overlays[0],
      k0,
      hands.flatMap((h) => (h.debug?.source !== 'view1' && h.debug?.landmarks2d ? [h.debug.landmarks2d] : [])),
      hands.map((h) => h.joints),
    );
  }
  if (k1) {
    // Project the fused hands into camera B: X1 = R·X0 + t.
    const inB = cal
      ? hands.map((h) => {
          const out = new Float32Array(h.joints.length);
          for (let i = 0; i < out.length; i += 3) {
            const [x, y, z] = [h.joints[i], h.joints[i + 1], h.joints[i + 2]];
            for (let r = 0; r < 3; r++) out[i + r] = cal.R[r * 3] * x + cal.R[r * 3 + 1] * y + cal.R[r * 3 + 2] * z + cal.t[r];
          }
          return out;
        })
      : [];
    drawHandOverlay(overlays[1], k1, latestB.flatMap((h) => (h.debug?.landmarks2d ? [h.debug.landmarks2d] : [])), inB);
  }
  const lines = [`${fps().toFixed(0)} fps`];
  if (!hands.length) lines.push('no hands');
  for (const h of hands) {
    const source = { stereo: 'both cameras', view0: 'camera A only', view1: 'camera B only' }[h.debug?.source ?? 'view0'];
    lines.push(
      `${h.handedness.padEnd(5)} from ${source}`,
      `  wrist   x ${cm(h.joints[0])} y ${cm(h.joints[1])} z ${cm(h.joints[2])}`,
      h.debug?.source === 'stereo' ? `  triangulation error ${h.debug.reprojectionError?.toFixed(1)} px` : '',
    );
  }
  const left = hands.find((h) => h.handedness === 'Left');
  const right = hands.find((h) => h.handedness === 'Right');
  if (left && right) lines.push(`wrist z, left − right: ${cm(left.joints[2] - right.joints[2])}`);
  readout.textContent = lines.filter(Boolean).join('\n');
});

// ---------- controls ----------
async function populateCameras() {
  const cams = await listCameras();
  cameraSelects.forEach((select, i) => {
    const previous = select.value;
    select.replaceChildren(...cams.map((c, j) => new Option(c.label || `Camera ${j + 1}`, c.deviceId)));
    select.value = previous || cams[Math.min(i, cams.length - 1)]?.deviceId || '';
  });
}

async function start() {
  stereo.stop();
  cameras.forEach((c) => c.stop());
  cameras = [];
  if (cameraSelects[0].value && cameraSelects[0].value === cameraSelects[1].value) {
    throw new Error('Pick two different cameras');
  }
  status.textContent = 'Opening cameras…';
  for (let i = 0; i < 2; i++) {
    cameras.push(await openCamera({ video: videos[i], deviceId: cameraSelects[i].value || undefined }));
  }
  status.textContent = 'Loading MediaPipe…';
  await stereo.start();
  status.textContent = `${cameras[0].label} + ${cameras[1].label}`;
  await populateCameras();
  updateCameras();
}

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

const startButton = $<HTMLButtonElement>('start');
startButton.addEventListener('click', () => runStep(startButton, 'Starting…', async () => (await start(), status.textContent ?? '')));
// Labels are only available after permission; list what we can now.
populateCameras().catch(() => {});

fovInputs.forEach((input, i) =>
  input.addEventListener('change', () => {
    const fov = parseFloat(input.value);
    if (fov > 0 && views[i].intrinsics) views[i].calibrator.setFieldOfView(fov);
  }),
);

(['paper0', 'paper1'] as const).forEach((id, i) => {
  const button = $<HTMLButtonElement>(id);
  button.addEventListener('click', () =>
    runStep(button, `Hold A4 paper tilted ~45° in camera ${'AB'[i]}'s view; click its 4 corners (Esc cancels)`, async () => {
      const corners = await pickCorners(videos[i], { mirrored: true });
      const f = views[i].calibrator.addRectangleView(corners, 'a4');
      return `Camera ${'AB'[i]}: focal ${f.toFixed(0)} px. Add more views to average.`;
    }),
  );
});

const handSizeButton = $<HTMLButtonElement>('handSize');
handSizeButton.addEventListener('click', () =>
  runStep(handSizeButton, 'Hold still…', async () => {
    const scale = await views[0].calibrator.handSizeFromObject('card-long');
    return `Hand scale ${scale.toFixed(3)}`;
  }),
);

const calStereoButton = $<HTMLButtonElement>('calStereo');
calStereoButton.addEventListener('click', () =>
  runStep(calStereoButton, 'Move one hand through the shared view…', async () => {
    const result = await stereo.calibrate({
      onProgress: ({ elapsedMs, durationMs, frames }) => {
        status.textContent =
          `Move one hand through the shared view… ${Math.ceil((durationMs - elapsedMs) / 1000)} s ` +
          `(hand seen in ${frames[0]} A / ${frames[1]} B frames)`;
      },
    });
    updateCameras();
    const cal = result.views[1];
    if (!cal || cal instanceof Error) throw cal ?? new Error('Calibration failed');
    return `Camera pair calibrated: baseline ${(Math.hypot(...cal.t) * 100).toFixed(1)} cm`;
  }),
);

$('resetStereo').addEventListener('click', () => {
  stereo.resetCalibration();
  updateCameras();
  status.textContent = 'Camera pair calibration reset';
});
