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
  PATTERN_ADVICE,
  showCalibrationPattern,
  randomId,
  type CameraHandle,
  type Link,
} from '../src';
import { drawHandOverlay, errorText, fpsCounter, say, stoppableButton } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
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
  // Live numbers in their own line, so the banner keeps event messages.
  $('connection').textContent = link?.open
    ? `Connected · ${rate.toFixed(0)} fps · ${hands.length} hand(s) · ${sender?.framesSent ?? 0} frames sent`
    : `Not connected · camera ${rate.toFixed(0)} fps`;
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

  say('Opening camera…', 'busy');
  camera = await openCamera({ video, deviceId: cameraSelect.value || undefined });
  mirrorInput.checked = !/back|rear|environment/i.test(camera.label);
  $('videoWrap').classList.toggle('mirror', mirrorInput.checked);
  say('Loading MediaPipe…', 'busy');
  await tracker.start();
  fovInput.value = fovFromIntrinsics(tracker.intrinsics!).toFixed(1);
  await populateCameras();

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

fovInput.addEventListener('change', () => {
  const fov = parseFloat(fovInput.value);
  if (fov > 0 && tracker.intrinsics) tracker.calibrator.setFieldOfView(fov);
});
mirrorInput.addEventListener('change', () => $('videoWrap').classList.toggle('mirror', mirrorInput.checked));

stoppableButton($<HTMLButtonElement>('fromScreen'), 'Point the camera at the green dots on the computer…', async (signal) => {
  if (!tracker.intrinsics) throw new Error('Tap "Start & connect" first: the camera is not running');
  const f = await calibrateFromPattern(video, tracker.calibrator, () => tracker.intrinsics, {
    signal,
    feedback: { mirrored: mirrorInput.checked },
    onProgress: ({ views, needed, state }) => say(`${PATTERN_ADVICE[state]} · ${views} of ${needed} views`, 'busy'),
  });
  return `Focal ${f.toFixed(0)} px from the screen pattern`;
});
$('showPattern').addEventListener('click', () =>
  showCalibrationPattern({ message: 'Hold this up to the computer camera, tilting it · tap to close' }),
);

const paper = $<HTMLButtonElement>('paper');
paper.addEventListener('click', async () => {
  if (!tracker.intrinsics) {
    say('Tap "Start & connect" first: the camera is not running', 'error');
    return;
  }
  paper.disabled = true;
  say('Tap near the 4 corners in order around the edge', 'busy');
  try {
    const { corners, snapped } = await pickRectangle(video, { mirrored: mirrorInput.checked });
    const f = tracker.calibrator.addRectangleView(corners, $<HTMLSelectElement>('object').value);
    say(`Focal ${f.toFixed(0)} px${snapped ? '' : ' (edges not found; used taps)'}. Add more views to average.`, 'ok');
  } catch (e) {
    say(errorText(e), 'error');
  } finally {
    paper.disabled = false;
  }
});
