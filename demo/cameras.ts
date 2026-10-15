import {
  MonocularHandTracker,
  MultiViewHandTracker,
  RemoteCamera,
  createCalibrationPanel,
  createRemoteCameraJoin,
  fromCamera0,
  watchCameras,
  openCamera,
  type CameraHandle,
  type Hand3D,
  type StatusKind,
  type ViewSource,
} from '../src';
import { cm, createHandScene, drawHandOverlay, errorText, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readout = $<HTMLDivElement>('readout');
const tiles = $<HTMLDivElement>('tiles');

/** One camera tile: a local camera with its video, or a remote one drawn from its landmarks. */
interface View {
  source: ViewSource;
  kind: 'local' | 'remote';
  name: string;
  tile: HTMLDivElement;
  overlay: HTMLCanvasElement;
  info: HTMLSpanElement;
  video?: HTMLVideoElement;
  camera?: CameraHandle;
  /** This camera's latest own detections, for its overlay. */
  latest: Hand3D[];
  fps: () => number;
  /** Frames per second this camera delivers. */
  rate: number;
}
const views: View[] = [];
const tracker = new MultiViewHandTracker([]);
tracker.start();
const scene3d = createHandScene($<HTMLDivElement>('scene'));

// All calibration UI comes from the library's panel; the page only shows the cameras.
const panel = createCalibrationPanel($('calibration'), {
  tracker,
  videoFor: (source) => views.find((v) => v.source === source)?.video ?? null,
  nameFor: (source, i) => `${i}: ${views.find((v) => v.source === source)?.name ?? 'camera'}`,
});
const say = (text: string, kind: StatusKind = 'info') => panel.say(text, kind);

// ---------- tiles ----------
function makeTile(name: string, kind: View['kind']) {
  const tile = document.createElement('div');
  tile.className = 'view';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = name;
  const bar = document.createElement('div');
  bar.className = 'tile-bar';
  const info = document.createElement('span');
  const overlay = document.createElement('canvas');
  let video: HTMLVideoElement | undefined;
  if (kind === 'local') {
    const wrap = document.createElement('div');
    wrap.className = 'videoWrap mirror';
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    wrap.append(video, overlay);
    tile.append(wrap);
  } else {
    overlay.className = 'remote-canvas';
    tile.append(overlay);
  }
  tile.append(label, bar);
  bar.append(info);
  tiles.append(tile);
  return { tile, overlay, info, bar, video };
}

function addControls(view: View, bar: HTMLElement) {
  const remove = document.createElement('button');
  remove.textContent = '✕';
  remove.title = 'Remove this camera';
  remove.addEventListener('click', () => removeView(view));
  bar.append(remove);
}

/** Add a camera tile; `create` makes its source (given the tile's video, for local cameras). */
async function addView(
  kind: View['kind'],
  name: string,
  create: (video?: HTMLVideoElement) => Promise<{ source: ViewSource; camera?: CameraHandle }>,
): Promise<View> {
  const { tile, overlay, info, bar, video } = makeTile(name, kind);
  info.textContent = 'starting…';
  let created: { source: ViewSource; camera?: CameraHandle };
  try {
    created = await create(video);
  } catch (e) {
    tile.remove();
    throw e;
  }
  const view: View = { ...created, kind, name, tile, overlay, info, video, latest: [], fps: fpsCounter(), rate: 0 };
  views.push(view);
  addControls(view, bar);
  view.source.onFrame((hands) => {
    view.latest = hands;
    view.rate = view.fps();
  });
  await tracker.addSource(view.source);
  render();
  panel.refresh();
  return view;
}

function removeView(view: View) {
  const i = views.indexOf(view);
  if (i < 0) return;
  views.splice(i, 1);
  // Removing the reference re-anchors the tracker to another calibrated camera,
  // which reorders its cameras; keep the tiles in the same order.
  tracker.removeSource(view.source);
  views.sort((a, b) => tracker.sources.indexOf(a.source) - tracker.sources.indexOf(b.source));
  for (const v of views) tiles.append(v.tile);
  view.camera?.stop();
  if (view.source instanceof RemoteCamera) view.source.close();
  view.tile.remove();
  if (view.kind === 'local') renderCameraList();
  render();
  panel.refresh();
}

/** Refresh tile info and 3D camera frustums. */
function render() {
  const st = tracker.status;
  views.forEach((v, i) => {
    const vs = st.views[i];
    const where = i === 0 ? 'reference' : vs?.calibration
      ? `${(vs.baseline! * 100).toFixed(0)} cm away, offset ${vs.calibration.timeOffsetMs} ms`
      : 'not calibrated';
    v.info.textContent = `${i}: ${where} · ${v.rate.toFixed(0)} fps`;
  });
  scene3d.setCameras(
    views.flatMap((v, i) => {
      const k = v.source.intrinsics;
      const cal = tracker.calibrations[i];
      if (!k || (i > 0 && !cal)) return [];
      return [i === 0 ? { k } : { k, R: cal!.R, t: cal!.t, color: v.kind === 'remote' ? 0x7fc97f : 0xc08a5a }];
    }),
  );
}
setInterval(render, 1000);

// ---------- output ----------
const fps = fpsCounter();
tracker.onFrame((hands) => {
  scene3d.updateHands(hands);
  views.forEach((v, i) => {
    const k = v.source.intrinsics;
    if (!k) return;
    const cal = tracker.calibrations[i];
    const fused = i === 0 ? hands.map((h) => h.joints) : cal ? hands.map((h) => fromCamera0(h.joints, cal)) : [];
    drawHandOverlay(v.overlay, k, v.latest.flatMap((h) => (h.debug?.landmarks2d ? [h.debug.landmarks2d] : [])), fused);
  });
  const lines = [`${fps().toFixed(0)} fps`];
  if (!hands.length) lines.push('no hands');
  for (const h of hands) {
    const from = h.debug?.source === 'stereo' ? `cameras ${h.debug.views?.join(', ')}` : `camera ${h.debug?.views?.[0] ?? 0} only`;
    lines.push(
      `${h.handedness.padEnd(5)} from ${from}`,
      `  wrist   x ${cm(h.joints[0])} y ${cm(h.joints[1])} z ${cm(h.joints[2])}`,
      h.debug?.source === 'stereo' ? `  triangulation error ${h.debug.reprojectionError?.toFixed(1)} px` : '',
    );
  }
  const status = tracker.status;
  lines.push('', 'cameras:');
  for (const v of status.views) {
    const seen = v.hands.length ? v.hands.map((h) => h[0]).join('+') : '–';
    const delay = v.delayMs !== null ? `, ${v.delayMs.toFixed(0)} ms delay` : '';
    lines.push(`  ${v.index}: ${v.fps.toFixed(0)} fps${delay}, sees ${seen}${v.calibrated ? '' : '  NOT CALIBRATED: hands ignored'}`);
  }
  lines.push(`skeleton samples: left ${status.skeletonSamples.Left}, right ${status.skeletonSamples.Right}`);
  readout.textContent = lines.filter(Boolean).join('\n');
});

// ---------- local cameras ----------
const localSelect = $<HTMLSelectElement>('localCamera');
let knownCameras: MediaDeviceInfo[] = [];
function renderCameraList() {
  const used = new Set(views.flatMap((v) => (v.camera ? [v.camera.cameraId] : [])));
  localSelect.replaceChildren(
    ...knownCameras.filter((c) => !used.has(c.deviceId)).map((c, j) => new Option(c.label || `Camera ${j + 1}`, c.deviceId)),
  );
}
// Ask for camera access up front, so the list shows every camera by name.
watchCameras((cameras) => {
  knownCameras = cameras;
  renderCameraList();
}, { requestPermission: true, onError: (e) => say(`Camera access is blocked (${errorText(e)}). Allow the camera in the browser's site settings, then reload.`, 'error') });

const addLocal = $<HTMLButtonElement>('addLocal');
addLocal.addEventListener('click', () =>
  runStep(addLocal, 'Opening camera…', async () => {
    const name = localSelect.selectedOptions[0]?.text || 'Camera';
    const view = await addView('local', name, async (video) => {
      const camera = await openCamera({ video: video!, deviceId: localSelect.value || undefined });
      return { source: new MonocularHandTracker({ video }), camera };
    });
    if (view.camera?.label) {
      view.name = view.camera.label;
      view.tile.querySelector('.label')!.textContent = view.camera.label;
    }
    renderCameraList();
    panel.refresh();
    return `Added ${view.camera?.label ?? name}`;
  }),
);

// ---------- phones ----------
// The library's join component registers with PeerJS and shows the QR code; phones
// that connect get a tile here (addCamera) and leave with it (removeCamera).
(async () => {
  // Phones need this page's address on the local network (over HTTPS for their camera).
  let base = new URL('.', location.href).href;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try {
      const info = (await (await fetch('/webhands-info')).json()) as { urls: string[] };
      if (info.urls[0]) base = `${info.urls[0]}/`;
    } catch {}
  }
  createRemoteCameraJoin($('join'), {
    tracker,
    phonePageUrl: new URL('remote.html', base).href,
    onStatus: say,
    addCamera: async (camera) => {
      const v = await addView('remote', 'Phone', async () => ({ source: camera }));
      v.name = camera.label || 'Phone';
      v.tile.querySelector('.label')!.textContent = v.name;
      panel.refresh();
    },
    removeCamera: (camera) => {
      const v = views.find((x) => x.source === camera);
      if (v) removeView(v);
    },
  });
})();

// ---------- page actions ----------
async function runStep(button: HTMLButtonElement, hint: string, step: () => Promise<string>) {
  button.disabled = true;
  say(hint, 'busy');
  try {
    say(await step(), 'ok');
  } catch (e) {
    say(errorText(e), 'error');
  } finally {
    button.disabled = false;
  }
}
