import {
  MonocularHandTracker,
  RemoteCameraSender,
  connectToHost,
  httpSignaling,
  watchCameras,
  openCamera,
  randomId,
  createCalibrationPanel,
  type CameraHandle,
  type StatusKind,
  type Link,
} from '../src';
import { drawHandOverlay, errorText, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const cameraSelect = $<HTMLSelectElement>('camera');
const roomInput = $<HTMLInputElement>('room');
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
  // Live numbers in their own line, so the banner keeps event messages.
  $('connection').textContent = link?.open
    ? `Connected · ${rate.toFixed(0)} fps · ${hands.length} hand(s) · ${sender?.framesSent ?? 0} frames sent`
    : `Not connected · camera ${rate.toFixed(0)} fps`;
});
// The library's calibration panel: lens step for this camera, plus "Show pattern" for the computer's camera.
const panel = createCalibrationPanel($('calibration'), {
  tracker,
  steps: ['lens'],
  nameFor: () => 'This camera',
  mirrored: () => mirrorInput.checked,
});
const say = (text: string, kind: StatusKind = 'info') => panel.say(text, kind);

let knownCameras: MediaDeviceInfo[] = [];
async function populateCameras() {
  const cams = knownCameras;
  const previous = cameraSelect.value;
  cameraSelect.replaceChildren(...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  // Prefer the back camera on phones.
  const back = cams.find((c) => /back|rear|environment/i.test(c.label));
  cameraSelect.value = previous || back?.deviceId || cams[0]?.deviceId || '';
}
// Ask for camera access up front, so the list shows every camera by name.
watchCameras((cameras) => {
  knownCameras = cameras;
  populateCameras();
}, { requestPermission: true, onError: (e) => say(`Camera access is blocked (${errorText(e)}). Allow the camera in the browser's site settings, then reload.`, 'error') });

async function start() {
  const room = roomInput.value.trim();
  if (!room) throw new Error('Enter the room shown on the computer');
  sender?.stop();
  link?.close();
  tracker.stop();
  camera?.stop();

  say('Opening camera…', 'busy');
  camera = await openCamera({ video, deviceId: cameraSelect.value || undefined });
  mirrorInput.checked = !/back|rear|environment/i.test(camera.label);
  $('videoWrap').classList.toggle('mirror', mirrorInput.checked);
  say('Loading MediaPipe…', 'busy');
  await tracker.start();
  await populateCameras();
  panel.refresh();

  say('Connecting to the computer…', 'busy');
  link = await connectToHost(httpSignaling(location.origin, room));
  sender = new RemoteCameraSender(tracker, link, {
    cameraId: `${deviceToken()}:${tracker.cameraId}`,
    label: camera.label || 'Phone',
  });
  sender.start();
  say('Connected to the computer', 'ok');
  link.onClose(() => say('Disconnected. Tap "Start & connect" to reconnect.', 'error'));
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
    say(errorText(e), 'error');
  } finally {
    startButton.disabled = false;
  }
});

mirrorInput.addEventListener('change', () => $('videoWrap').classList.toggle('mirror', mirrorInput.checked));
