import {
  MonocularHandTracker,
  RemoteCameraSender,
  connectToHost,
  fovFromIntrinsics,
  httpSignaling,
  listCameras,
  openCamera,
  pickRectangle,
  calibrateFromPattern,
  showCalibrationPattern,
  randomId,
  type CameraHandle,
  type Link,
} from '../src';
import { drawHandOverlay, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const status = $<HTMLDivElement>('status');
const cameraSelect = $<HTMLSelectElement>('camera');
const roomInput = $<HTMLInputElement>('room');
const fovInput = $<HTMLInputElement>('fov');
const mirrorInput = $<HTMLInputElement>('mirror');

roomInput.value = new URLSearchParams(location.search).get('room') ?? '';

/** Stable id for this device, so the host can remember this camera's calibration. */
function deviceToken(): string {
  try {
    let token = localStorage.getItem('webhands:device');
    if (!token) localStorage.setItem('webhands:device', (token = randomId()));
    return token;
  } catch {
    return randomId();
  }
}

const tracker = new MonocularHandTracker({ video });
let camera: CameraHandle | null = null;
let link: Link | null = null;
let sender: RemoteCameraSender | null = null;
const fps = fpsCounter();

tracker.onFrame((hands) => {
  const k = tracker.intrinsics;
  if (!k) return;
  drawHandOverlay(overlay, k, hands.flatMap((h) => (h.debug?.landmarks2d ? [h.debug.landmarks2d] : [])), []);
  const rate = fps();
  if (link?.open) status.textContent = `Connected · ${rate.toFixed(0)} fps · ${hands.length} hand(s) · ${sender?.framesSent ?? 0} frames sent`;
});
tracker.calibrator.onChange((s) => {
  if (s.focal.hfovDegrees !== null && document.activeElement !== fovInput) fovInput.value = s.focal.hfovDegrees.toFixed(1);
});

async function populateCameras() {
  const cams = await listCameras();
  const previous = cameraSelect.value;
  cameraSelect.replaceChildren(...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  // Prefer the back camera on phones.
  const back = cams.find((c) => /back|rear|environment/i.test(c.label));
  cameraSelect.value = previous || back?.deviceId || cams[0]?.deviceId || '';
}
populateCameras().catch(() => {});

async function start() {
  const room = roomInput.value.trim();
  if (!room) throw new Error('Enter the room shown on the computer');
  sender?.stop();
  link?.close();
  tracker.stop();
  camera?.stop();

  status.textContent = 'Opening camera…';
  camera = await openCamera({ video, deviceId: cameraSelect.value || undefined });
  mirrorInput.checked = !/back|rear|environment/i.test(camera.label);
  $('videoWrap').classList.toggle('mirror', mirrorInput.checked);
  status.textContent = 'Loading MediaPipe…';
  await tracker.start();
  fovInput.value = fovFromIntrinsics(tracker.intrinsics!).toFixed(1);
  await populateCameras();

  status.textContent = 'Connecting to the computer…';
  link = await connectToHost(httpSignaling(location.origin, room));
  sender = new RemoteCameraSender(tracker, link, {
    cameraId: `${deviceToken()}:${tracker.cameraId}`,
    label: camera.label || 'Phone',
  });
  sender.start();
  link.onClose(() => (status.textContent = 'Disconnected. Tap "Start & connect" to reconnect.'));
  // Keep the screen on while streaming.
  try {
    await (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock?.request('screen');
  } catch {}
}

// Tell the computer right away when this page goes away.
addEventListener('pagehide', () => link?.close());

const startButton = $<HTMLButtonElement>('start');
startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  try {
    await start();
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    startButton.disabled = false;
  }
});

fovInput.addEventListener('change', () => {
  const fov = parseFloat(fovInput.value);
  if (fov > 0 && tracker.intrinsics) tracker.calibrator.setFieldOfView(fov);
});
mirrorInput.addEventListener('change', () => $('videoWrap').classList.toggle('mirror', mirrorInput.checked));

const fromScreen = $<HTMLButtonElement>('fromScreen');
fromScreen.addEventListener('click', async () => {
  if (!tracker.intrinsics) {
    status.textContent = 'Start the camera first';
    return;
  }
  fromScreen.disabled = true;
  try {
    const f = await calibrateFromPattern(video, tracker.calibrator, () => tracker.intrinsics, {
      onProgress: ({ views, needed, seen }) => {
        status.textContent = `${seen ? 'Pattern seen' : 'Looking for the pattern'}; ${views} of ${needed} views. Tilt the phone.`;
      },
    });
    status.textContent = `Focal ${f.toFixed(0)} px from the screen pattern`;
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    fromScreen.disabled = false;
  }
});
$('showPattern').addEventListener('click', () =>
  showCalibrationPattern({ message: 'Hold this up to the computer camera, tilting it · tap to close' }),
);

const paper = $<HTMLButtonElement>('paper');
paper.addEventListener('click', async () => {
  if (!tracker.intrinsics) return;
  paper.disabled = true;
  status.textContent = 'Tap near the 4 corners in order around the edge';
  try {
    const { corners, snapped } = await pickRectangle(video, { mirrored: mirrorInput.checked });
    const f = tracker.calibrator.addRectangleView(corners, $<HTMLSelectElement>('object').value);
    status.textContent = `Focal ${f.toFixed(0)} px${snapped ? '' : ' (edges not found; used taps)'}. Add more views to average.`;
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    paper.disabled = false;
  }
});
