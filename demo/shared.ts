import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HAND_BONES, NUM_JOINTS, projectPoints, type Hand3D, type Handedness, type Intrinsics } from '../src';

/** A camera to draw in the 3D view: intrinsics plus pose X_cam = R·X_world + t (identity for camera 0). */
export interface SceneCamera {
  k: Intrinsics;
  R?: ArrayLike<number>;
  t?: ArrayLike<number>;
  color?: number;
}

const HAND_COLORS: Record<Handedness, number> = { Left: 0x4fa3ff, Right: 0xffa54f };

/**
 * three.js view of hands in camera-0 coordinates (OpenCV: +y down, +z forward),
 * drawn as (x, −y, −z), with camera frustums and a floor grid.
 */
export function createHandScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101418);
  const view = new THREE.PerspectiveCamera(50, 1, 0.01, 20);
  view.position.set(0.9, 0.5, 0.4);
  const orbit = new OrbitControls(view, renderer.domElement);
  orbit.target.set(0, 0, -0.5);
  orbit.update();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.5));

  // Floor grid 30 cm below camera 0, 10 cm squares, extending forward.
  const grid = new THREE.GridHelper(2, 20, 0x3a4652, 0x26303a);
  grid.position.set(0, -0.3, -1);
  scene.add(grid);

  const frustums = new THREE.Group();
  scene.add(frustums);

  const handMeshes = new Map<Handedness, { joints: THREE.InstancedMesh; bones: THREE.LineSegments }>();
  for (const side of ['Left', 'Right'] as Handedness[]) {
    const material = new THREE.MeshStandardMaterial({ color: HAND_COLORS[side] });
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 12, 8), material, NUM_JOINTS);
    const bones = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3)),
      new THREE.LineBasicMaterial({ color: HAND_COLORS[side] }),
    );
    joints.visible = bones.visible = false;
    joints.frustumCulled = bones.frustumCulled = false;
    scene.add(joints, bones);
    handMeshes.set(side, { joints, bones });
  }

  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h, false);
    view.aspect = w / Math.max(h, 1);
    view.updateProjectionMatrix();
  }).observe(container);
  renderer.setAnimationLoop(() => renderer.render(scene, view));

  return {
    setCameras(cameras: SceneCamera[]) {
      frustums.clear();
      for (const cam of cameras) {
        const { k } = cam;
        const R = cam.R ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const t = cam.t ?? [0, 0, 0];
        // Camera centre and corner rays in camera-0 coordinates: X = Rᵀ·(X_cam − t).
        const toWorld = (p: number[]) => {
          const q = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
          const x = R[0] * q[0] + R[3] * q[1] + R[6] * q[2];
          const y = R[1] * q[0] + R[4] * q[1] + R[7] * q[2];
          const z = R[2] * q[0] + R[5] * q[1] + R[8] * q[2];
          return new THREE.Vector3(x, -y, -z);
        };
        const d = 0.1;
        const o = toWorld([0, 0, 0]);
        const corners = [[0, 0], [k.width, 0], [k.width, k.height], [0, k.height]].map(([u, v]) =>
          toWorld([((u - k.cx) / k.fx) * d, ((v - k.cy) / k.fy) * d, d]),
        );
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < 4; i++) pts.push(o, corners[i], corners[i], corners[(i + 1) % 4]);
        frustums.add(
          new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({ color: cam.color ?? 0x8899aa }),
          ),
        );
      }
    },

    updateHands(hands: Hand3D[]) {
      const m = new THREE.Matrix4();
      for (const [side, mesh] of handMeshes) {
        const hand = hands.find((h) => h.handedness === side);
        mesh.joints.visible = mesh.bones.visible = !!hand;
        if (!hand) continue;
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
    },
  };
}

/**
 * Draw hands over a video: green = MediaPipe's 2D landmarks (`detected`),
 * red = 3D joints (in this camera's frame) projected back into the image.
 */
export function drawHandOverlay(
  canvas: HTMLCanvasElement,
  k: Intrinsics,
  detected: ArrayLike<number>[],
  joints3d: ArrayLike<number>[],
) {
  if (canvas.width !== k.width || canvas.height !== k.height) {
    canvas.width = k.width;
    canvas.height = k.height;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const r = Math.max(2, k.width / 300);
  for (const uv of detected) drawSkeleton(ctx, uv, '#3ccf6e', r);
  for (const j of joints3d) drawSkeleton(ctx, projectPoints(j, k), '#ff5a4f', r * 0.7);
}

function drawSkeleton(ctx: CanvasRenderingContext2D, uv: ArrayLike<number>, color: string, r: number) {
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

/** Frames per second, updated about once a second. */
export function fpsCounter() {
  let frames = 0, fps = 0, start = performance.now();
  return () => {
    frames++;
    const now = performance.now();
    if (now - start > 1000) {
      fps = (frames * 1000) / (now - start);
      frames = 0;
      start = now;
    }
    return fps;
  };
}

export const cm = (m: number) => (m * 100).toFixed(1).padStart(6) + 'cm';
