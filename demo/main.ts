import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  HAND_BONES,
  KNOWN_LENGTHS,
  KNOWN_RECTANGLES,
  MonocularHandTracker,
  NUM_JOINTS,
  calibrateHandsBoneLengths,
  collectHands,
  collectSamples,
  focalFromDistance,
  fovFromIntrinsics,
  focalFromRectangle,
  handScaleFromGrip,
  handScaleFromLength,
  intrinsicsFromFov,
  listCameras,
  loadCalibration,
  openCamera,
  projectPoints,
  saveCalibration,
  type StoredCalibration,
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
  if (!k || freeze) return;
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
async function startCamera(deviceId?: string) {
  tracker.stop();
  camera?.stop();
  status.textContent = 'Opening camera…';
  camera = await openCamera({ video, deviceId });
  status.textContent = 'Loading MediaPipe…';
  await tracker.start();
  status.textContent = camera.label;
  updateBonesState();
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

function persist(patch: Partial<StoredCalibration>) {
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
depthMethodInput.addEventListener('change', () => {
  tracker.depthMethod = depthMethodInput.value as DepthMethod;
});

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

function setFocal(f: number) {
  const k = tracker.intrinsics!;
  tracker.intrinsics = { ...k, fx: f, fy: f };
  persist({ focalOverWidth: f / k.width });
  fovInput.value = fovFromIntrinsics(tracker.intrinsics).toFixed(1);
  updateFrustum();
}

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

$('calScale').addEventListener('click', () =>
  calibrate('calScale', (samples) => {
    const known = KNOWN_LENGTHS.find((o) => o.id === scaleRef.value);
    const scale = known
      ? handScaleFromGrip(known.length, samples)
      : handScaleFromLength(parseFloat($<HTMLInputElement>('handLength').value) / 100, samples);
    if (!Number.isFinite(scale)) throw new Error('Calibration failed');
    // Bone lengths carry the overall size too; rescale them to match.
    const ratio = scale / tracker.handScale;
    const stored: StoredCalibration['skeletons'] = {};
    for (const side of ['Left', 'Right'] as const) {
      const skeleton = tracker.skeletons[side];
      if (!skeleton) continue;
      stored[side] = {
        lengths: Array.from(skeleton.lengths, (l) => l * ratio),
        palm: Array.from(skeleton.palm, (v) => v * ratio),
      };
      tracker.skeletons[side] = stored[side];
    }
    tracker.handScale = scale;
    persist({ handScale: scale, skeletons: stored });
    return `Hand scale ${scale.toFixed(3)} from ${samples.length} frames`;
  }),
);

// --- Step 2: focal length, from clicking a known rectangle's corners, or hand distance ---
const focalRef = $<HTMLSelectElement>('focalRef');
focalRef.append(
  ...KNOWN_RECTANGLES.map((o) => new Option(o.label, o.id)),
  new Option('Hand at a measured distance', 'distance'),
);
focalRef.value = 'a4';
const calFocalButton = $<HTMLButtonElement>('calFocal');
const cancelFreezeButton = $<HTMLButtonElement>('cancelFreeze');
let focalViews: number[] = [];
function updateFocalUi() {
  const distance = focalRef.value === 'distance';
  $('distanceRow').hidden = !distance;
  $('focalHint').textContent = distance
    ? 'Needs step 1 first. Hold the hand centred in view at the measured distance.'
    : 'Hold the object tilted about 45° away from the camera, as large as possible in view. ' +
      'Freeze, then click its 4 corners in order around the edge. Paper is much more ' +
      'accurate than a card; add several views.';
  calFocalButton.textContent = distance ? 'Calibrate distance' : 'Freeze & click corners';
  focalViews = [];
  $('focalViews').textContent = '';
}
focalRef.addEventListener('change', updateFocalUi);
updateFocalUi();

/** Frozen frame being annotated, with the corners clicked so far (image pixels). */
let freeze: { clicks: number[] } | null = null;

function drawFreeze() {
  if (!freeze) return;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  ctx.drawImage(frozenFrame, 0, 0);
  const c = freeze.clicks;
  const r = Math.max(3, overlay.width / 200);
  ctx.strokeStyle = ctx.fillStyle = '#ffd23f';
  ctx.lineWidth = r / 2;
  ctx.beginPath();
  for (let i = 0; i < c.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, c[i], c[i + 1]);
  ctx.stroke();
  for (let i = 0; i < c.length; i += 2) {
    ctx.beginPath();
    ctx.arc(c[i], c[i + 1], r, 0, Math.PI * 2);
    ctx.fill();
  }
}
const frozenFrame = document.createElement('canvas');

function endFreeze() {
  freeze = null;
  $('videoWrap').classList.remove('frozen');
  calFocalButton.disabled = false;
  cancelFreezeButton.hidden = true;
}

calFocalButton.addEventListener('click', () => {
  if (focalRef.value === 'distance') {
    calibrate('calFocal', (samples) => {
      const distance = parseFloat($<HTMLInputElement>('distance').value) / 100;
      const f = focalFromDistance(tracker.intrinsics!.fx, distance, samples);
      if (!Number.isFinite(f)) throw new Error('Calibration failed');
      setFocal(f);
      return `Focal ${f.toFixed(0)} px (FOV ${fovInput.value}°) from ${samples.length} frames`;
    });
    return;
  }
  if (!video.videoWidth) return;
  frozenFrame.width = video.videoWidth;
  frozenFrame.height = video.videoHeight;
  frozenFrame.getContext('2d')!.drawImage(video, 0, 0);
  freeze = { clicks: [] };
  $('videoWrap').classList.add('frozen');
  calFocalButton.disabled = true;
  cancelFreezeButton.hidden = false;
  status.textContent = 'Click the 4 corners in order around the edge';
  drawFreeze();
});
cancelFreezeButton.addEventListener('click', () => {
  endFreeze();
  status.textContent = 'Cancelled';
});

overlay.addEventListener('click', (e) => {
  if (!freeze) return;
  // Map the click to image pixels: undo object-fit: contain and the CSS mirror.
  const rect = overlay.getBoundingClientRect();
  const scale = Math.min(rect.width / overlay.width, rect.height / overlay.height);
  let x = e.clientX - rect.left;
  if ($('videoWrap').classList.contains('mirror')) x = rect.width - x;
  const u = (x - (rect.width - overlay.width * scale) / 2) / scale;
  const v = (e.clientY - rect.top - (rect.height - overlay.height * scale) / 2) / scale;
  freeze.clicks.push(u, v);
  drawFreeze();
  if (freeze.clicks.length < 8) return;

  const object = KNOWN_RECTANGLES.find((o) => o.id === focalRef.value)!;
  const k = tracker.intrinsics!;
  const f = focalFromRectangle(freeze.clicks, object, k.cx, k.cy);
  endFreeze();
  if (f === null) {
    status.textContent = 'Could not use that view — tilt the object more and try again';
    return;
  }
  focalViews.push(f);
  const sorted = [...focalViews].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  setFocal(median);
  $('focalViews').textContent =
    `${focalViews.length} view(s): ${focalViews.map((v) => v.toFixed(0)).join(', ')} px`;
  status.textContent = `Focal ${median.toFixed(0)} px (FOV ${fovInput.value}°). Add more views to average.`;
});

// --- Step 3: bone lengths ---
function updateBonesState() {
  const sides = (['Left', 'Right'] as const).filter((s) => tracker.skeletons[s]);
  $('bonesState').textContent = sides.length ? `Calibrated: ${sides.join(', ')}` : 'Not calibrated';
}

$('calBones').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('calBones');
  const k = tracker.intrinsics;
  if (!k) return;
  button.disabled = true;
  status.textContent = 'Turn both hands slowly in every direction…';
  try {
    const samples = await collectHands((l) => tracker.onFrame(l), 8000);
    const result = calibrateHandsBoneLengths(samples, k, tracker.handScale);
    const sides = (['Left', 'Right'] as const).filter((s) => result[s]);
    if (!sides.length) throw new Error('Not enough frames of either hand; try again');
    const stored: StoredCalibration['skeletons'] = { ...loadCalibration(tracker.cameraId).skeletons };
    for (const side of sides) {
      const { lengths, palm } = result[side]!;
      stored[side] = { lengths: Array.from(lengths), palm: Array.from(palm) };
      tracker.skeletons[side] = stored[side];
    }
    persist({ skeletons: stored });
    const mm = sides.map((s) => `${s} ${(result[s]!.lengths.reduce((a, b) => a + b, 0) * 1000).toFixed(0)} mm`);
    status.textContent = `Bone lengths calibrated (total: ${mm.join(', ')})`;
  } catch (e) {
    status.textContent = String(e instanceof Error ? e.message : e);
  } finally {
    button.disabled = false;
    updateBonesState();
  }
});

$('calReset').addEventListener('click', () => {
  const k = tracker.intrinsics;
  if (!k) return;
  saveCalibration(tracker.cameraId, {});
  tracker.handScale = 1;
  tracker.skeletons = {};
  updateBonesState();
  tracker.intrinsics = intrinsicsFromFov(k.width, k.height);
  fovInput.value = fovFromIntrinsics(tracker.intrinsics).toFixed(1);
  focalViews = [];
  $('focalViews').textContent = '';
  updateFrustum();
  status.textContent = 'Calibration reset';
});
