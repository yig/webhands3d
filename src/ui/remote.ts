import QRCode from 'qrcode';
import { MonocularHandTracker } from '../backends/monocular';
import type { MultiViewHandTracker } from '../backends/multiview';
import { openCamera, watchCameras, type CameraHandle } from '../camera';
import { RemoteCamera, RemoteCameraSender } from '../remote/camera';
import type { Link } from '../remote/link';
import { connectToHost, hostRemoteCameras, randomId, type PeerConnectOptions, type RemoteCameraHost } from '../remote/peer';
import { HAND_BONES, NUM_JOINTS, type Hand3D } from '../types';
import { createCalibrationPanel, type CalibrationPanel, type StatusKind } from './panel';
import { CSS, el } from './style';

// ---------------------------------------------------------------------------
// Host side: QR code for phones to join, adding them to a multi-camera tracker.
// ---------------------------------------------------------------------------

export interface RemoteCameraJoinOptions extends PeerConnectOptions {
  tracker: MultiViewHandTracker;
  /**
   * URL of your page that runs `mountRemoteCamera` (it must be HTTPS for phones
   * to use their camera). The QR code points there, with `?host=<id>` added.
   */
  phonePageUrl: string;
  /** Id to register with (default: one remembered per browser, so the QR code stays the same). */
  id?: string;
  /** Add a camera that joined (default: tracker.addSource). */
  addCamera?: (camera: RemoteCamera) => Promise<unknown>;
  /** Remove a camera that left (default: tracker.removeSource). */
  removeCamera?: (camera: RemoteCamera) => void;
  /** Status messages (e.g. a calibration panel's `say`). */
  onStatus?: (text: string, kind: StatusKind) => void;
  /** QR code size, CSS pixels. Default 180. */
  qrSize?: number;
}

export interface RemoteCameraJoin {
  readonly element: HTMLElement;
  /** The registered id (null until registered). */
  readonly id: string | null;
  readonly cameras: RemoteCamera[];
  destroy(): void;
}

/**
 * "Add a phone" UI for the computer: registers with PeerJS (see remote/peer.ts),
 * shows a QR code and link to your phone page, and adds each phone that
 * connects to `tracker` as a camera (removing it when it leaves).
 */
export function createRemoteCameraJoin(container: HTMLElement, options: RemoteCameraJoinOptions): RemoteCameraJoin {
  const host = document.createElement('div');
  host.className = 'webhands-join';
  container.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}
    .join { display: flex; flex-direction: column; gap: 6px; }
    canvas { background: #fff; border-radius: 6px; align-self: flex-start; }
    .url { font: 11px ui-monospace, monospace; word-break: break-all; }
  </style><div class="join"></div>`;
  const box = root.querySelector<HTMLDivElement>('.join')!;
  const qr = el('canvas') as HTMLCanvasElement;
  const status = el('div', { class: 'hint' }, 'Connecting to PeerJS…');
  const link = el('div', { class: 'url' });
  box.append(el('div', { class: 'hint' }, 'Scan with a phone to add it as a camera (both devices need internet).'), qr, link, status);
  const cameras: RemoteCamera[] = [];
  let registered: RemoteCameraHost | null = null;
  let destroyed = false;
  const say = (text: string, kind: StatusKind = 'info') => options.onStatus?.(text, kind);
  const update = () => {
    status.textContent = registered
      ? `Code ${registered.id} · ${cameras.length ? `${cameras.length} phone${cameras.length > 1 ? 's' : ''} connected` : 'waiting for phones'}`
      : status.textContent;
  };

  const id = options.id ?? rememberedId();
  hostRemoteCameras(
    async (l: Link) => {
      const camera = new RemoteCamera(l);
      cameras.push(camera);
      update();
      camera.onClose(() => {
        const i = cameras.indexOf(camera);
        if (i >= 0) cameras.splice(i, 1);
        (options.removeCamera ?? ((c) => options.tracker.removeSource(c)))(camera);
        say(`${camera.label || 'A phone'} left`);
        update();
      });
      try {
        await (options.addCamera ?? ((c) => options.tracker.addSource(c)))(camera);
        say(`${camera.label || 'A phone'} joined`, 'ok');
      } catch (e) {
        say(e instanceof Error ? e.message : String(e), 'error');
      }
    },
    { ...options, id },
  )
    .then(async (r) => {
      if (destroyed) return r.close();
      registered = r;
      const url = new URL(options.phonePageUrl, location.href);
      url.searchParams.set('host', r.id);
      link.textContent = url.href;
      await QRCode.toCanvas(qr, url.href, { width: options.qrSize ?? 180, margin: 1 });
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
        say('Phones need the phone page over HTTPS to use their camera.', 'error');
      }
      update();
    })
    .catch((e: Error) => {
      status.textContent = `Phones can't join: ${e.message}`;
      say(`Phones can't join: ${e.message}`, 'error');
    });

  return {
    element: host,
    get id() {
      return registered?.id ?? null;
    },
    cameras,
    destroy() {
      destroyed = true;
      registered?.close();
      host.remove();
    },
  };
}

function rememberedId(): string {
  try {
    let id = localStorage.getItem('webhands:host-id');
    if (!id) localStorage.setItem('webhands:host-id', (id = `webhands3d-${randomId()}`));
    return id;
  } catch {
    return `webhands3d-${randomId()}`;
  }
}

// ---------------------------------------------------------------------------
// Phone side: the whole remote-camera page.
// ---------------------------------------------------------------------------

export interface RemoteCameraPageOptions extends PeerConnectOptions {
  /** The computer's id. Default: `?host=` in the page URL. */
  hostId?: string;
  /** Label for this camera on the computer. Default: the camera's name. */
  label?: string;
}

export interface RemoteCameraPage {
  readonly element: HTMLElement;
  /** This device's tracker (MediaPipe on this camera). */
  readonly tracker: MonocularHandTracker;
  readonly panel: CalibrationPanel;
  destroy(): void;
}

/**
 * The complete page for a phone (or any device) joining as a remote camera:
 * camera choice, connect, connection status, the camera view with detected
 * hands, and this camera's lens calibration. Put it on an HTTPS page and give
 * its URL to `createRemoteCameraJoin`.
 */
export function mountRemoteCamera(container: HTMLElement, options: RemoteCameraPageOptions = {}): RemoteCameraPage {
  const host = document.createElement('div');
  host.className = 'webhands-remote';
  container.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}
    .page { display: flex; flex-direction: column; gap: 10px; }
    .stage { position: relative; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 3 / 4; max-height: 60vh; }
    .stage video, .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .stage.mirror video, .stage.mirror canvas { transform: scaleX(-1); }
    label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    input[type='text'] { width: 12em; }
  </style><div class="page"></div>`;
  const page = root.querySelector<HTMLDivElement>('.page')!;
  const video = el('video', { muted: '', playsinline: '' }) as HTMLVideoElement;
  video.muted = true;
  video.playsInline = true;
  const overlay = el('canvas') as HTMLCanvasElement;
  const stage = el('div', { class: 'stage' }, video, overlay);
  const cameraSelect = el('select') as HTMLSelectElement;
  const code = el('input', { type: 'text', placeholder: 'from the computer' }) as HTMLInputElement;
  code.value = options.hostId ?? new URLSearchParams(location.search).get('host') ?? '';
  const mirror = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const connectButton = el('button', { class: 'primary' }, 'Start & connect') as HTMLButtonElement;
  const connection = el('div', { class: 'hint' }, 'Not connected');
  const calibration = el('div');
  page.append(
    stage,
    el('section', {},
      el('h3', {}, 'Camera'),
      el('p', { class: 'hint' }, 'Prop this device up so it sees where your hands will be, and keep this page open.'),
      el('label', {}, 'Camera', cameraSelect),
      el('label', {}, "Computer's code", code),
      el('label', {}, 'Mirror view', mirror),
      el('div', { class: 'actions' }, connectButton),
      connection,
    ),
    calibration,
  );
  mirror.addEventListener('change', () => stage.classList.toggle('mirror', mirror.checked));

  const tracker = new MonocularHandTracker({ video });
  const panel = createCalibrationPanel(calibration, {
    tracker,
    steps: ['lens'],
    nameFor: () => 'This camera',
    videoFor: () => video,
    mirrored: () => mirror.checked,
  });
  const say = panel.say;

  let camera: CameraHandle | null = null;
  let link: Link | null = null;
  let sender: RemoteCameraSender | null = null;
  let frames = 0, start = performance.now(), rate = 0;
  tracker.onFrame((hands) => {
    frames++;
    const now = performance.now();
    if (now - start > 1000) {
      rate = (frames * 1000) / (now - start);
      frames = 0;
      start = now;
    }
    drawLandmarks(overlay, tracker, hands);
    connection.textContent = link?.open
      ? `Connected · ${rate.toFixed(0)} fps · ${hands.length} hand(s) · ${sender?.framesSent ?? 0} frames sent`
      : `Not connected · camera ${rate.toFixed(0)} fps`;
  });

  let cameras: MediaDeviceInfo[] = [];
  const listCameras = () => {
    const previous = cameraSelect.value;
    cameraSelect.replaceChildren(...cameras.map((c, i) => el('option', { value: c.deviceId }, c.label || `Camera ${i + 1}`)));
    // Prefer the main back camera on phones (not ultra-wide / telephoto / dual, whose lens can switch).
    const back =
      cameras.find((c) => /back|rear|environment/i.test(c.label) && !/ultra|tele|dual|triple/i.test(c.label)) ??
      cameras.find((c) => /back|rear|environment/i.test(c.label));
    cameraSelect.value = previous || back?.deviceId || cameras[0]?.deviceId || '';
  };
  const unwatch = watchCameras((list) => {
    cameras = list;
    listCameras();
  }, {
    requestPermission: true,
    onError: (e) => say(`Camera access is blocked (${e instanceof Error ? e.message : e}). Allow the camera in the browser's site settings, then reload.`, 'error'),
  });

  const connect = async () => {
    const hostId = code.value.trim();
    if (!hostId) throw new Error("Enter the computer's code (shown under its QR code)");
    sender?.stop();
    link?.close();
    tracker.stop();
    camera?.stop();
    say('Opening camera…', 'busy');
    camera = await openCamera({ video, deviceId: cameraSelect.value || undefined });
    mirror.checked = !/back|rear|environment/i.test(camera.label);
    stage.classList.toggle('mirror', mirror.checked);
    say('Loading MediaPipe…', 'busy');
    await tracker.start();
    panel.refresh();
    say('Connecting to the computer…', 'busy');
    link = await connectToHost(hostId, options);
    sender = new RemoteCameraSender(tracker, link, {
      cameraId: `${deviceToken()}:${tracker.cameraId}`,
      label: options.label ?? camera.label ?? 'Phone',
    });
    sender.start();
    link.onClose(() => say('Disconnected. Tap "Start & connect" to reconnect.', 'error'));
    say('Connected to the computer', 'ok');
    try {
      await (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock?.request('screen');
    } catch {}
  };
  connectButton.addEventListener('click', async () => {
    connectButton.disabled = true;
    try {
      await connect();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      connectButton.disabled = false;
    }
  });
  // Tell the computer right away when this page goes away.
  const onHide = () => link?.close();
  addEventListener('pagehide', onHide);

  return {
    element: host,
    tracker,
    panel,
    destroy() {
      removeEventListener('pagehide', onHide);
      unwatch();
      sender?.stop();
      link?.close();
      tracker.dispose();
      camera?.stop();
      panel.destroy();
      host.remove();
    },
  };
}

/** Stable id for this device, so the computer can remember this camera's calibration. */
function deviceToken(): string {
  try {
    let token = localStorage.getItem('webhands:device');
    if (!token) localStorage.setItem('webhands:device', (token = randomId()));
    return token;
  } catch {
    return randomId();
  }
}

/** MediaPipe's 2D landmarks over the camera view. */
function drawLandmarks(canvas: HTMLCanvasElement, tracker: MonocularHandTracker, hands: Hand3D[]) {
  const k = tracker.intrinsics;
  if (!k) return;
  if (canvas.width !== k.width || canvas.height !== k.height) {
    canvas.width = k.width;
    canvas.height = k.height;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const r = Math.max(2, k.width / 300);
  ctx.strokeStyle = ctx.fillStyle = '#3ccf6e';
  ctx.lineWidth = r * 0.6;
  for (const hand of hands) {
    const uv = hand.debug?.landmarks2d;
    if (!uv) continue;
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
}
