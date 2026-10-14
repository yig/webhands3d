import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  HAND_BONES,
  KNOWN_LENGTHS,
  KNOWN_RECTANGLES,
  MonocularHandTracker,
  NUM_JOINTS,
  listCameras,
  openCamera,
  pickCorners,
  projectPoints,
  type CalibrationStatus,
  type CameraHandle,
  type DepthMethod,
  type Hand3D,
  type Handedness,
} from '../src';

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

// ---------- 3D view ----------
const sceneEl = $<HTMLDivElement>('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
sceneEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);
const view = new THREE.PerspectiveCamera(50, 1, 0.01, 20);
view.position.set(0.9, 0.5, 0.4);
const orbit = new OrbitControls(view, renderer.domElement);
orbit.target.set(0, 0, -0.5);
orbit.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.5));

// Floor grid 30 cm below the camera, 10 cm squares, extending forward.
const grid = new THREE.GridHelper(2, 20, 0x3a4652, 0x26303a);
grid.position.set(0, -0.3, -1);
scene.add(grid);

// Webcam frustum (OpenCV camera frame → three.js: x, -y, -z).
const frustum = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x8899aa }),
);
scene.add(frustum);
function updateFrustum() {
  const k = tracker.intrinsics;
  if (!k) return;
  const d = 0.1;
  const corners = [
    [0, 0], [k.width, 0], [k.width, k.height], [0, k.height],
  ].map(([u, v]) => new THREE.Vector3(((u - k.cx) / k.fx) * d, -((v - k.cy) / k.fy) * d, -d));
  const o = new THREE.Vector3();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pts.push(o, corners[i], corners[i], corners[(i + 1) % 4]);
  frustum.geometry.setFromPoints(pts);
}

const HAND_COLORS: Record<Handedness, number> = { Left: 0x4fa3ff, Right: 0xffa54f };
const handMeshes = new Map<Handedness, { joints: THREE.InstancedMesh; bones: THREE.LineSegments }>();
for (const side of ['Left', 'Right'] as Handedness[]) {
  const material = new THREE.MeshStandardMaterial({ color: HAND_COLORS[side] });
  const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 12, 8), material, NUM_JOINTS);
  const bones = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3),
    ),
    new THREE.LineBasicMaterial({ color: HAND_COLORS[side] }),
  );
  joints.visible = bones.visible = false;
  joints.frustumCulled = bones.frustumCulled = false;
  scene.add(joints, bones);
  handMeshes.set(side, { joints, bones });
}

function updateHands3D(hands: Hand3D[]) {
  const m = new THREE.Matrix4();
  for (const [side, mesh] of handMeshes) {
    const hand = hands.find((h) => h.handedness === side);
    mesh.joints.visible = mesh.bones.visible = !!hand;
    if (!hand) continue;
    const j = hand.joints;
    for (let i = 0; i < NUM_JOINTS; i++) {
      mesh.joints.setMatrixAt(i, m.makeTranslation(j[i * 3], -j[i * 3 + 1], -j[i * 3 + 2]));
    }
    mesh.joints.instanceMatrix.needsUpdate = true;
    const pos = mesh.bones.geometry.getAttribute('position') as THREE.BufferAttribute;
    HAND_BONES.forEach(([a, b], i) => {
      pos.setXYZ(i * 2, j[a * 3], -j[a * 3 + 1], -j[a * 3 + 2]);
      pos.setXYZ(i * 2 + 1, j[b * 3], -j[b * 3 + 1], -j[b * 3 + 2]);
    });
    pos.needsUpdate = true;
  }
}

function resize() {
  const { clientWidth: w, clientHeight: h } = sceneEl;
  renderer.setSize(w, h, false);
  view.aspect = w / Math.max(h, 1);
  view.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(sceneEl);
renderer.setAnimationLoop(() => renderer.render(scene, view));

// ---------- 2D overlay ----------
const ctx = overlay.getContext('2d')!;
function drawOverlay(hands: Hand3D[]) {
  const k = tracker.intrinsics;
  if (!k) return;
  if (overlay.width !== k.width || overlay.height !== k.height) {
    overlay.width = k.width;
    overlay.height = k.height;
  }
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const r = Math.max(2, k.width / 300);
  for (const hand of hands) {
    const detected = hand.debug?.landmarks2d;
    if (detected) drawSkeleton(detected, '#3ccf6e', r);
    drawSkeleton(projectPoints(hand.joints, k), '#ff5a4f', r * 0.7);
  }
}
function drawSkeleton(uv: ArrayLike<number>, color: string, r: number) {
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = r * 0.6;
  ctx.beginPath();
  for (const [a, b] of HAND_BONES) {
    ctx.moveTo(uv[a * 2], uv[a * 2 + 1]);
    ctx.lineTo(uv[b * 2], uv[b * 2 + 1]);
  }
  ctx.stroke();
  for (let i = 0; i < NUM_JOINTS; i++) {
    ctx.beginPath();
    ctx.arc(uv[i * 2], uv[i * 2 + 1], r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- readout ----------
let frames = 0;
let fps = 0;
let fpsStart = performance.now();
function updateReadout(hands: Hand3D[]) {
  frames++;
  const now = performance.now();
  if (now - fpsStart > 1000) {
    fps = (frames * 1000) / (now - fpsStart);
    frames = 0;
    fpsStart = now;
  }
  const lines = [`${fps.toFixed(0)} fps   hand scale ${tracker.handScale.toFixed(3)}`];
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
const cm = (m: number) => (m * 100).toFixed(1).padStart(6) + 'cm';

tracker.onFrame((hands) => {
  updateHands3D(hands);
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
    : 'Hold the object tilted about 45° away from the camera, as large as possible in view. ' +
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
