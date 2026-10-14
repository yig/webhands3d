import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  HAND_BONES,
  MonocularHandTracker,
  NUM_JOINTS,
  collectSamples,
  focalFromDistance,
  fovFromIntrinsics,
  handScaleFromLength,
  intrinsicsFromFov,
  listCameras,
  loadCalibration,
  openCamera,
  projectPoints,
  saveCalibration,
  type CameraHandle,
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
    lines.push(
      `${h.handedness.padEnd(5)} conf ${h.confidence.toFixed(2)}`,
      c ? `  centre  x ${cm(c[0])} y ${cm(c[1])} z ${cm(c[2])}` : '',
      `  wrist   x ${cm(wrist[0])} y ${cm(wrist[1])} z ${cm(wrist[2])}`,
      `  reproj  ${h.debug?.reprojectionError?.toFixed(1) ?? '?'} px`,
    );
  }
  readout.textContent = lines.join('\n');
}
const cm = (m: number) => (m * 100).toFixed(1).padStart(6) + 'cm';

tracker.onFrame((hands) => {
  updateHands3D(hands);
  drawOverlay(hands);
  updateReadout(hands);
});

// ---------- controls ----------
async function startCamera(deviceId?: string) {
  tracker.stop();
  camera?.stop();
  status.textContent = 'Opening camera…';
  camera = await openCamera({ video, deviceId });
  status.textContent = 'Loading MediaPipe…';
  await tracker.start();
  status.textContent = camera.label;
  fovInput.value = fovFromIntrinsics(tracker.intrinsics!).toFixed(1);
  updateFrustum();
  await populateCameras(camera.cameraId);
}

async function populateCameras(selected: string) {
  const cams = await listCameras();
  cameraSelect.replaceChildren(
    ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === selected)),
  );
}

function persist(patch: { focalOverWidth?: number; handScale?: number }) {
  const id = tracker.cameraId;
  saveCalibration(id, { ...loadCalibration(id), ...patch });
}

$('start').addEventListener('click', () =>
  startCamera().catch((e) => (status.textContent = String(e))),
);
cameraSelect.addEventListener('change', () =>
  startCamera(cameraSelect.value).catch((e) => (status.textContent = String(e))),
);
$('mirror').addEventListener('change', (e) =>
  $('videoWrap').classList.toggle('mirror', (e.target as HTMLInputElement).checked),
);
$('videoWrap').classList.add('mirror');
refineInput.addEventListener('change', () => (tracker.refineRotation = refineInput.checked));

fovInput.addEventListener('change', () => {
  const k = tracker.intrinsics;
  const fov = parseFloat(fovInput.value);
  if (!k || !(fov > 0)) return;
  tracker.intrinsics = intrinsicsFromFov(k.width, k.height, fov);
  persist({ focalOverWidth: tracker.intrinsics.fx / k.width });
  updateFrustum();
});

async function calibrate(button: string, run: (samples: Hand3D[]) => string) {
  const el = $<HTMLButtonElement>(button);
  el.disabled = true;
  status.textContent = 'Hold still…';
  try {
    status.textContent = run(await collectSamples((l) => tracker.onFrame(l)));
  } catch (e) {
    status.textContent = String(e instanceof Error ? e.message : e);
  } finally {
    el.disabled = false;
  }
}

$('calScale').addEventListener('click', () =>
  calibrate('calScale', (samples) => {
    const length = parseFloat($<HTMLInputElement>('handLength').value) / 100;
    const scale = handScaleFromLength(length, samples);
    if (!Number.isFinite(scale)) throw new Error('Calibration failed');
    tracker.handScale = scale;
    persist({ handScale: scale });
    return `Hand scale ${scale.toFixed(3)} from ${samples.length} frames`;
  }),
);

$('calFocal').addEventListener('click', () =>
  calibrate('calFocal', (samples) => {
    const k = tracker.intrinsics!;
    const distance = parseFloat($<HTMLInputElement>('distance').value) / 100;
    const f = focalFromDistance(k.fx, distance, samples);
    if (!Number.isFinite(f)) throw new Error('Calibration failed');
    tracker.intrinsics = { ...k, fx: f, fy: f };
    persist({ focalOverWidth: f / k.width });
    fovInput.value = fovFromIntrinsics(tracker.intrinsics).toFixed(1);
    updateFrustum();
    return `Focal ${f.toFixed(0)} px (FOV ${fovInput.value}°) from ${samples.length} frames`;
  }),
);

$('calReset').addEventListener('click', () => {
  const k = tracker.intrinsics;
  if (!k) return;
  saveCalibration(tracker.cameraId, {});
  tracker.handScale = 1;
  tracker.intrinsics = intrinsicsFromFov(k.width, k.height);
  fovInput.value = fovFromIntrinsics(tracker.intrinsics).toFixed(1);
  updateFrustum();
  status.textContent = 'Calibration reset';
});
