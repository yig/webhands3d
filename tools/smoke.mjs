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
await host.waitForTimeout(500);
await host.click('#addLocal');
await host.waitForTimeout(6000);
await host.click('#addLocal');
await host.waitForTimeout(6000);
check((await tiles(host)).length === 2, 'two local cameras added');
const before = (await options(host)).length;
await host.click('.view:nth-child(2) .tile-bar button[title="Remove this camera"]');
await host.waitForTimeout(1000);
check((await options(host)).length === before + 1, 'removed local camera is offered again');

const room = new URL(await text(host, '#joinUrl')).searchParams.get('room');
const phone = await page(`/remote.html?room=${room}`, 'remote');
await phone.waitForTimeout(500);
const cams = await phone.$$eval('#camera option', (os) => os.map((o) => o.value));
await phone.selectOption('#camera', cams.at(-1));
await phone.click('#start');
await phone.waitForTimeout(10000);
check(/Connected/.test(await text(phone, '#status')), 'phone page connects over WebRTC');
check((await tiles(host)).length === 2, 'phone appears as a camera on the host');

// Remove the reference camera while the phone stays.
await host.click('.view:nth-child(1) .tile-bar button[title="Remove this camera"]');
await host.waitForTimeout(2000);
const left = await tiles(host);
check(left.length === 1 && !/fake_device_0/.test(left[0]), 'reference camera removed; phone remains');
check(/fps/.test(await text(host, '#readout')), 'host keeps producing frames');

await phone.close();
await host.waitForTimeout(7000);
check((await tiles(host)).length === 0, 'phone tile disappears when the phone leaves');

check(errors.length === 0, `no page errors${errors.length ? ':\n  ' + errors.join('\n  ') : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
