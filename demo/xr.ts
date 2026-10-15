import * as THREE from 'three';
import { HAND_BONES, NUM_JOINTS, WebXRHandTracker, type Hand3D, type Handedness } from '../src';
import { cm, errorText, fpsCounter, say } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readout = $<HTMLDivElement>('readout');

// three.js renders in the headset; the tracker reads hands from the same session.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local'); // the tracker's default space, so its joints line up
$('scene').append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 20);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.5));

const COLORS: Record<Handedness, number> = { Left: 0x4fa3ff, Right: 0xffa54f };
const meshes = new Map<Handedness, { joints: THREE.InstancedMesh; bones: THREE.LineSegments }>();
for (const side of ['Left', 'Right'] as Handedness[]) {
  const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 10, 6), new THREE.MeshStandardMaterial({ color: COLORS[side] }), NUM_JOINTS);
  const bones = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3)),
    new THREE.LineBasicMaterial({ color: COLORS[side] }),
  );
  joints.frustumCulled = bones.frustumCulled = false;
  joints.visible = bones.visible = false;
  scene.add(joints, bones);
  meshes.set(side, { joints, bones });
}

function show(hands: Hand3D[]) {
  const m = new THREE.Matrix4();
  for (const [side, mesh] of meshes) {
    const hand = hands.find((h) => h.handedness === side);
    mesh.joints.visible = mesh.bones.visible = !!hand;
    if (!hand) continue;
    // Library axes (y down, z forward) back to WebXR/three.js axes (y up, −z forward).
    const j = hand.joints;
    for (let i = 0; i < NUM_JOINTS; i++) mesh.joints.setMatrixAt(i, m.makeTranslation(j[i * 3], -j[i * 3 + 1], -j[i * 3 + 2]));
    mesh.joints.instanceMatrix.needsUpdate = true;
    const pos = mesh.bones.geometry.getAttribute('position') as THREE.BufferAttribute;
    HAND_BONES.forEach(([a, b], i) => {
      pos.setXYZ(i * 2, j[a * 3], -j[a * 3 + 1], -j[a * 3 + 2]);
      pos.setXYZ(i * 2 + 1, j[b * 3], -j[b * 3 + 1], -j[b * 3 + 2]);
    });
    pos.needsUpdate = true;
  }
}

const fps = fpsCounter();
renderer.setAnimationLoop(() => renderer.render(scene, camera));

(async () => {
  if (!(await WebXRHandTracker.isSupported())) {
    say('This browser has no immersive WebXR. Open the page in the Meta Quest Browser (over HTTPS).', 'error');
    $<HTMLButtonElement>('enter').disabled = true;
  }
})();

$('enter').addEventListener('click', async () => {
  try {
    const xr = navigator.xr!;
    const mode = (await xr.isSessionSupported('immersive-ar').catch(() => false)) ? 'immersive-ar' : 'immersive-vr';
    const session = await xr.requestSession(mode, { requiredFeatures: ['hand-tracking'], optionalFeatures: ['local-floor'] });
    await renderer.xr.setSession(session);
    const tracker = new WebXRHandTracker({ session });
    tracker.onFrame((hands) => {
      show(hands);
      const lines = [`${fps().toFixed(0)} fps`];
      for (const h of hands) lines.push(`${h.handedness.padEnd(5)} wrist x ${cm(h.joints[0])} y ${cm(h.joints[1])} z ${cm(h.joints[2])}`);
      if (!hands.length) lines.push('no hands (put the controllers down)');
      readout.textContent = lines.join('\n');
    });
    await tracker.start();
    session.addEventListener('end', () => say('Left XR', 'info'));
    say(`In XR (${mode}). Hands are tracked by the headset.`, 'ok');
  } catch (e) {
    say(`Couldn't start XR with hand tracking: ${errorText(e)}`, 'error');
  }
});
