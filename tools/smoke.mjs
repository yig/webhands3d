// Headless end-to-end check of the demo pages with fake cameras (no hands):
// pages load without errors, cameras can be added and removed, a phone page
// connects over WebRTC and leaves. Needs Google Chrome and a running dev
// server (`npm run dev`). Usage: npm run smoke [-- http://localhost:5173]
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=3', '--enable-unsafe-swiftshader'],
});
const errors = [];
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const page = async (path, name) => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text().slice(0, 200)}`));
  await p.goto(base + path);
  return p;
};
const text = (p, sel) => p.textContent(sel);
const options = (p) => p.$$eval('#localCamera option', (os) => os.map((o) => o.textContent));
const tiles = (p) => p.$$eval('.view .label', (s) => s.map((x) => x.textContent));

// One camera.
const mono = await page('/index.html', 'index');
await mono.click('#start');
await mono.waitForTimeout(8000);
check(/fps/.test(await text(mono, '#readout')), 'one-camera page tracks frames');
await mono.close();

// Several cameras.
const host = await page('/cameras.html', 'cameras');
await host.waitForTimeout(1500);
const before0 = await options(host);
check(before0.length === 3 && before0.every((o) => /fake_device/.test(o)), `cameras are listed by name before adding any (${before0.join(', ')})`);
await host.click('#addLocal');
await host.waitForTimeout(6000);
await host.click('#addLocal');
await host.waitForTimeout(6000);
check((await tiles(host)).length === 2, 'two local cameras added');
const before = (await options(host)).length;
await host.click('.view:nth-child(2) .tile-bar button[title="Remove this camera"]');
await host.waitForTimeout(1000);
check((await options(host)).length === before + 1, 'removed local camera is offered again');

// The library calibration panel: screen calibration turns into Stop, shows feedback, Stop cancels.
check((await host.locator('button:has-text("Screen pattern")').count()) === 1, 'calibration panel lists the camera with its lens options');
await host.locator('button:has-text("Screen pattern")').first().click();
await host.waitForTimeout(800);
const running = await host.locator('button.running').first().textContent();
const banner = await host.locator('.banner').getAttribute('data-kind');
const overlays = await host.$$eval('canvas', (cs) => cs.filter((c) => c.style.pointerEvents === 'none').length);
await host.locator('button.running').first().click();
await host.waitForTimeout(500);
check(
  running === 'Stop' && banner === 'busy' && overlays === 1 && /Cancelled/.test(await host.locator('.banner').textContent()),
  'screen calibration shows Stop, a busy banner and on-video feedback; Stop cancels',
);

const room = new URL(await text(host, '#joinUrl')).searchParams.get('room');
const phone = await page(`/remote.html?room=${room}`, 'remote');
await phone.waitForTimeout(500);
// Before the camera runs, the phone's calibration panel says what to do first.
check((await phone.locator('text=Start this camera first').count()) === 1, 'phone: calibration panel says to start the camera first');
const cams = await phone.$$eval('#camera option', (os) => os.map((o) => o.value));
await phone.selectOption('#camera', cams.at(-1));
await phone.click('#start');
// Loading MediaPipe and connecting can take a while on a busy machine.
await phone.locator('.banner:has-text("Connected to the computer")').waitFor({ timeout: 30000 }).catch(() => {});
await host.waitForFunction(() => document.querySelectorAll('.view .label').length === 2, null, { timeout: 10000 }).catch(() => {});
check(/Connected/.test(await phone.locator('.banner').textContent()), 'phone page connects over WebRTC');
check((await tiles(host)).length === 2, 'phone appears as a camera on the host');

// A calibration run (no hands: fails) is recorded and can be downloaded.
await host.locator('button:has-text("Calibrate cameras")').click();
await host.waitForTimeout(13500);
await host.locator('summary:has-text("Debugging")').click();
const download = host.waitForEvent('download');
await host.locator('button:has-text("Download last calibration recording")').click();
const file = await download;
const recording = JSON.parse(await (await import('node:fs/promises')).readFile(await file.path(), 'utf8'));
check(recording.format === 'webhands-recording' && recording.views.length === 2 && recording.views[1].frames.length > 50,
  'calibration recording downloads with both cameras\' frames');

// Remove the reference camera while the phone stays.
await host.click('.view:nth-child(1) .tile-bar button[title="Remove this camera"]');
await host.waitForTimeout(2000);
const left = await tiles(host);
check(left.length === 1 && !/fake_device_0/.test(left[0]), 'reference camera removed; phone remains');
check(/fps/.test(await text(host, '#readout')), 'host keeps producing frames');

await phone.close();
await host.waitForTimeout(7000);
check((await tiles(host)).length === 0, 'phone tile disappears when the phone leaves');

// WebXR page: without a headset it says so instead of failing.
const xr = await page('/xr.html', 'xr');
await xr.waitForTimeout(1500);
check(/no immersive WebXR|Quest/.test(await text(xr, '#status')) || (await xr.isEnabled('#enter')), 'WebXR page loads and explains when there is no headset');
await xr.close();

// ---------- Calibration UI with synthetic video (no camera needed) ----------
const lib = await page('/pattern.html', 'calibration');
const srcUrl = `/@fs${process.cwd().replace(/ /g, '%20')}/src/index.ts`;

// Edge snapping: a white rounded rectangle on grey, clicked a few px off, accepted with Enter.
const truth = [400, 220, 860, 260, 820, 520, 380, 470];
await lib.evaluate(async ({ srcUrl, truth }) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.fillStyle = '#505050';
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#e8e8e8';
    ctx.beginPath();
    ctx.moveTo(truth[0], truth[1]);
    for (let i = 2; i < 8; i += 2) ctx.lineTo(truth[i], truth[i + 1]);
    ctx.closePath();
    ctx.fill();
    requestAnimationFrame(draw);
  };
  draw();
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = canvas.captureStream(30);
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '640px', height: '360px', zIndex: 10 });
  document.body.append(video);
  await video.play();
  await new Promise((r) => setTimeout(r, 500));
  const lib = await import(srcUrl);
  window.__picked = lib.pickRectangle(video);
}, { srcUrl, truth });
for (let i = 0; i < 4; i++) {
  await lib.mouse.click(truth[i * 2] / 2 + [3, -2, 2, -3][i], truth[i * 2 + 1] / 2 + [2, 3, -2, -2][i]);
}
await lib.waitForTimeout(300);
await lib.keyboard.press('Enter');
const picked = await lib.evaluate(async () => {
  const r = await window.__picked;
  return { corners: Array.from(r.corners), snapped: r.snapped };
});
const cornerErr = Math.max(...picked.corners.map((v, i) => Math.abs(v - truth[i])));
check(picked.snapped && cornerErr < 1.5, `rectangle corners snap to the edges (max error ${cornerErr.toFixed(2)} px)`);

// Pattern: what showCalibrationPattern draws is what detectPattern finds.
const shown = await lib.evaluate(async (srcUrl) => {
  const lib = await import(srcUrl);
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '390px', height: '844px' });
  document.body.append(host);
  const handle = lib.showCalibrationPattern({ container: host });
  await new Promise((r) => setTimeout(r, 200));
  const c = host.querySelector('canvas');
  const found = lib.detectPattern(c.getContext('2d').getImageData(0, 0, c.width, c.height));
  handle.close();
  host.remove();
  if (!found) return null;
  const d = (i, j) => Math.hypot(found[i * 2] - found[j * 2], found[i * 2 + 1] - found[j * 2 + 1]);
  return { sides: [d(0, 1), d(1, 2), d(2, 3), d(3, 0)], diagonals: [d(0, 2), d(1, 3)] };
}, srcUrl);
check(
  shown && Math.max(...shown.sides) / Math.min(...shown.sides) < 1.01 && Math.abs(shown.diagonals[0] / shown.diagonals[1] - 1) < 0.01,
  'the displayed pattern is detected as a square',
);

// Pattern calibration from a synthetic camera: the pattern tilting in front of a 64° camera.
const focal = await lib.evaluate(async (srcUrl) => {
  const lib = await import(srcUrl);
  const k = lib.intrinsicsFromFov(1280, 720, 64);
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const start = performance.now();
  const r = 0.09 / 0.82; // disk radius relative to centre spacing
  const draw = () => {
    const s = (performance.now() - start) / 1000;
    const tilt = 0.6, axis = s * 1.3;
    const R = lib.rodrigues(tilt * Math.cos(axis), tilt * Math.sin(axis), 0.2);
    const t = Float64Array.of(0.02 * Math.sin(s), 0, 0.3);
    const P = (x, y) => lib.projectPoints(lib.transformPoints([(x - 0.5) * 0.05, (y - 0.5) * 0.05, 0], { rotation: R, translation: t }), k);
    ctx.fillStyle = '#6e6e6a';
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#080808';
    ctx.beginPath();
    for (const [x, y] of [[-0.35, -0.35], [1.35, -0.35], [1.35, 1.35], [-0.35, 1.35]]) ctx.lineTo(...P(x, y));
    ctx.fill();
    ctx.fillStyle = '#10f010';
    for (const [cx, cy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      ctx.beginPath();
      for (let i = 0; i < 48; i++) ctx.lineTo(...P(cx + r * Math.cos((i / 48) * 2 * Math.PI), cy + r * Math.sin((i / 48) * 2 * Math.PI)));
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };
  draw();
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = canvas.captureStream(30);
  document.body.append(video);
  await video.play();
  const tracker = { intrinsics: lib.defaultIntrinsics(1280, 720), handScale: 1, skeletons: {}, cameraId: 'synthetic', onFrame: () => () => {} };
  const cal = new lib.Calibrator(tracker);
  const f = await lib.calibrateFromPattern(video, cal, () => tracker.intrinsics, { views: 8, timeoutMs: 30000 });
  return { f, truth: k.fx };
}, srcUrl);
check(Math.abs(focal.f / focal.truth - 1) < 0.02, `pattern calibration from video (focal ${focal.f.toFixed(0)} px, true ${focal.truth.toFixed(0)})`);

check(errors.length === 0, `no page errors${errors.length ? ':\n  ' + errors.join('\n  ') : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
