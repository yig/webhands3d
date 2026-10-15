import QRCode from 'qrcode';
import {
  MonocularHandTracker,
  MultiViewHandTracker,
  RemoteCamera,
  acceptRemotes,
  fromCamera0,
  httpSignaling,
  listCameras,
  openCamera,
  pickCorners,
  randomId,
  type CameraHandle,
  type Hand3D,
  type ViewSource,
} from '../src';
import { cm, createHandScene, drawHandOverlay, fpsCounter } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLDivElement>('status');
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
  fov?: HTMLInputElement;
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
  const fov = document.createElement('input');
  fov.type = 'number';
  fov.step = '0.5';
  fov.title = 'Horizontal field of view, degrees';
  const fovLabel = document.createElement('span');
  fovLabel.textContent = 'FOV';
  bar.append(fovLabel, fov);
  view.fov = fov;
  if (view.kind === 'local') {
    const cal = (view.source as MonocularHandTracker).calibrator;
    fov.addEventListener('change', () => {
      const v = parseFloat(fov.value);
      if (v > 0) cal.setFieldOfView(v);
    });
    const paper = document.createElement('button');
    paper.textContent = 'A4';
    paper.title = 'Click the corners of a sheet of A4 held tilted ~45°';
    paper.addEventListener('click', () =>
      runStep(paper, `Click the 4 corners of the A4 sheet in ${view.name} (Esc cancels)`, async () => {
        const f = cal.addRectangleView(await pickCorners(view.video!, { mirrored: true }), 'a4');
        return `${view.name}: focal ${f.toFixed(0)} px. Add more views to average.`;
      }),
    );
    bar.append(paper);
    cal.onChange(render);
  } else {
    fov.disabled = true;
    fov.title = "Set on the phone's own page";
  }
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
  if (view.kind === 'local') populateCameras().catch(() => {});
  render();
}

/** Refresh tile info, FOV fields and 3D camera frustums. */
function render() {
  const st = tracker.status;
  views.forEach((v, i) => {
    const k = v.source.intrinsics;
    const vs = st.views[i];
    const where = i === 0 ? 'reference' : vs?.calibration
      ? `${(vs.baseline! * 100).toFixed(0)} cm away, offset ${vs.calibration.timeOffsetMs} ms`
      : 'not calibrated';
    v.info.textContent = `${i}: ${where} · ${v.rate.toFixed(0)} fps`;
    if (k && v.fov && document.activeElement !== v.fov) v.fov.value = ((360 / Math.PI) * Math.atan(k.width / 2 / k.fx)).toFixed(1);
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
async function populateCameras() {
  const cams = await listCameras();
  const used = new Set(views.flatMap((v) => (v.camera ? [v.camera.cameraId] : [])));
  localSelect.replaceChildren(
    ...cams.filter((c) => !used.has(c.deviceId)).map((c, j) => new Option(c.label || `Camera ${j + 1}`, c.deviceId)),
  );
}
populateCameras().catch(() => {});

const addLocal = $<HTMLButtonElement>('addLocal');
addLocal.addEventListener('click', () =>
  runStep(addLocal, 'Opening camera…', async () => {
    const name = localSelect.selectedOptions[0]?.text || 'Camera';
    const view = await addView('local', name, async (video) => {
      const camera = await openCamera({ video: video!, deviceId: localSelect.value || undefined });
      return { source: new MonocularHandTracker({ video }), camera };
    });
    if (view.camera?.label) view.tile.querySelector('.label')!.textContent = view.camera.label;
    await populateCameras();
    return `Added ${view.camera?.label ?? name}`;
  }),
);

// ---------- phones ----------
const roomKey = 'webhands:room';
let room = '';
try {
  room = localStorage.getItem(roomKey) ?? '';
} catch {}
if (!room) {
  room = randomId();
  try {
    localStorage.setItem(roomKey, room);
  } catch {}
}
const signaling = httpSignaling(location.origin, room);
acceptRemotes(signaling, (link) => {
  const camera = new RemoteCamera(link);
  addView('remote', 'Phone', async () => ({ source: camera }))
    .then((v) => {
      v.tile.querySelector('.label')!.textContent = camera.label || 'Phone';
      status.textContent = `${camera.label || 'A phone'} joined`;
    })
    .catch((e) => (status.textContent = String(e)));
  camera.onClose(() => {
    const v = views.find((x) => x.source === camera);
    if (v) removeView(v);
    status.textContent = `${camera.label || 'A phone'} left`;
  });
});

(async () => {
  // Phones need this page's address on the local network, over HTTPS (camera access needs a secure context).
  let base = location.origin;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try {
      const info = (await (await fetch('/webhands-signal/_info')).json()) as { urls: string[] };
      base = info.urls[0] ?? base;
    } catch {}
  }
  const url = `${base}/remote.html?room=${room}`;
  $('joinUrl').textContent = url;
  await QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, { width: 180, margin: 1 });
  if (!url.startsWith('https:')) {
    $('phoneHint').textContent =
      'Phones need HTTPS: restart the demo with `npm run dev:lan` and open it from the address it prints.';
  }
})();

// ---------- calibration ----------
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

const handSize = $<HTMLButtonElement>('handSize');
handSize.addEventListener('click', () =>
  runStep(handSize, 'Hold still…', async () => {
    const first = views[0]?.source;
    if (!first?.calibrator) throw new Error('Add a camera first');
    return `Hand scale ${(await first.calibrator.handSizeFromObject('card-long')).toFixed(3)}`;
  }),
);

const calibrate = $<HTMLButtonElement>('calibrate');
calibrate.addEventListener('click', () =>
  runStep(calibrate, 'Move one hand through the shared view…', async () => {
    if (views.length < 2) throw new Error('Add at least two cameras');
    const result = await tracker.calibrate({
      onProgress: ({ elapsedMs, durationMs, frames }) => {
        status.textContent =
          `Move one hand through the shared view… ${Math.ceil((durationMs - elapsedMs) / 1000)} s ` +
          `(hand frames per camera: ${frames.join(' / ')})`;
      },
    });
    render();
    const lines = result.views.flatMap((r, i) =>
      i === 0 ? [] : [`camera ${i}: ${r instanceof Error ? r.message : r ? `${(Math.hypot(...r.t) * 100).toFixed(1)} cm, ${r.rmsPx.toFixed(1)} px` : 'skipped'}`],
    );
    const sides = Object.keys(result.skeletons);
    return `${lines.join('; ')}${sides.length ? `; skeleton measured (${sides.join(', ')})` : ''}`;
  }),
);

$('reset').addEventListener('click', () => {
  tracker.resetCalibration();
  render();
  status.textContent = 'Camera positions reset';
});
