'use strict';
/*
 * Headless browser tests (requires Playwright: `npm install --no-save playwright`
 * and `npx playwright install chromium`).
 *   1. tests/browser.html — the in-page regression suite with virtual devices
 *   2. Editor → OBS sync over obs_server.py (model, expression, parameters)
 *   3. Real face tracking with a fake webcam (tests/fixtures/face.y4m)
 */
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');

function loadPlaywright() {
  for (const name of ['playwright', '@playwright/test']) {
    try { return require(name); } catch (err) {}
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch (err) {}
  console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'face.y4m');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
async function startServer() {
  const port = await freePort();
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const proc = spawn(python, ['obs_server.py', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/relay-info`); if (r.ok) return { proc, base: `http://127.0.0.1:${port}` }; } catch (err) {}
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('obs_server.py did not start');
}

let failures = 0;
function report(ok, label) { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; }
function watch(page, errors) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/GL Driver|swiftshader|favicon/i.test(m.text())) errors.push(m.text()); });
}
const state = page => page.evaluate(() => window.Anime25D && window.Anime25D.state());

async function suite(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base + '/tests/browser.html');
  await page.click('#run');
  await page.waitForFunction(() => /ALL PASSED|FAIL /.test(document.getElementById('result').textContent), null, { timeout: 240000 });
  const text = await page.textContent('#result');
  console.log(text.split('\n').map(l => '  ' + l).join('\n'));
  report(/ALL PASSED/.test(text), 'in-page regression suite (tests/browser.html)');
  await page.close();
}

async function obsSync(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera'] });
  const errors = [];
  // OBS view with ?model= opens before any editor exists.
  const obs = await context.newPage(); watch(obs, errors);
  await obs.goto(base + '/?obs=1&model=sample2.psd');
  await obs.waitForFunction(() => window.Anime25D && window.Anime25D.state().modelName === 'sample2.psd', null, { timeout: 120000 });
  report(true, 'OBS view loads ?model= when no editor is connected');
  report(await obs.evaluate(() => getComputedStyle(document.getElementById('panel')).display === 'none' && getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)'), 'OBS view hides the UI and is transparent');

  const editor = await context.newPage(); watch(editor, errors);
  await editor.goto(base + '/');
  await editor.waitForFunction(() => window.Anime25D && window.Anime25D.state().obs.relay, null, { timeout: 20000 });
  await editor.click('#drop [data-sample="B"]');
  await editor.waitForFunction(() => window.Anime25D.state().layers > 0, null, { timeout: 120000 });
  await obs.waitForFunction(() => window.Anime25D.state().modelName === 'sample.psd' && window.Anime25D.state().layers > 0, null, { timeout: 120000 });
  report(true, 'a PSD opened in the editor appears in OBS');
  const [e1, o1] = await Promise.all([state(editor), state(obs)]);
  report(e1.modelId === o1.modelId, 'OBS and editor share the same model id');
  await editor.waitForFunction(() => /表示中 1/.test(document.getElementById('obsChip').textContent), null, { timeout: 15000 }).catch(() => {});
  report(/表示中/.test(await editor.textContent('#obsChip')), 'editor shows that OBS is watching');

  await editor.keyboard.press('2');
  await obs.waitForFunction(() => window.Anime25D.state().activePreset === 'smile', null, { timeout: 5000 }).then(() => report(true, 'expression hotkey reaches OBS'), () => report(false, 'expression hotkey reaches OBS'));
  await editor.fill('#pAngleX + input.val', '0.55');
  await editor.dispatchEvent('#pAngleX + input.val', 'change');
  await obs.waitForFunction(() => Math.abs(window.Anime25D.state().params.angleX - 0.55) < 1e-6, null, { timeout: 5000 }).then(() => report(true, 'slider changes reach OBS'), () => report(false, 'slider changes reach OBS'));
  await editor.evaluate(() => document.activeElement && document.activeElement.blur());
  await editor.keyboard.press('e');
  await editor.locator('#overlay .handle[data-key="mouth"]').press('ArrowUp');
  await editor.keyboard.press('Escape');
  await obs.waitForFunction(() => (window.Anime25D.state().anchors.mouth || {}).dy === -1, null, { timeout: 5000 }).then(() => report(true, 'anchor edits reach OBS'), () => report(false, 'anchor edits reach OBS'));
  // Dragging a handle with the mouse follows the whole drag and lands in the history.
  await editor.keyboard.press('e');
  const handle = await editor.locator('#overlay .handle[data-key="neck"] circle').boundingBox();
  const scale = await editor.evaluate(() => { const r = document.getElementById('overlay').getBoundingClientRect(); return document.getElementById('cv').width / r.width; });
  await editor.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await editor.mouse.down();
  for (let i = 1; i <= 10; i++) await editor.mouse.move(handle.x + handle.width / 2 + 6 * i, handle.y + handle.height / 2 + 3 * i);
  await editor.mouse.up();
  const dragged = (await state(editor)).anchors.neck || {};
  report(Math.abs(dragged.dx - 60 * scale) < 3 * scale && Math.abs(dragged.dy - 30 * scale) < 3 * scale, 'mouse drag moves an anchor the full distance (' + JSON.stringify(dragged) + ')');
  await editor.keyboard.press('Escape');
  await editor.keyboard.press('Control+z');
  report(!(await state(editor)).anchors.neck, 'the drag is one undo step');

  // A second OBS source opened later catches up with model and state.
  const late = await context.newPage(); watch(late, errors);
  await late.goto(base + '/?obs=1');
  const want = await state(editor);
  await late.waitForFunction(w => { const s = window.Anime25D && window.Anime25D.state(); return s && s.modelId === w.modelId && s.activePreset === w.activePreset && JSON.stringify(s.params) === JSON.stringify(w.params) && JSON.stringify(s.anchors) === JSON.stringify(w.anchors); }, want, { timeout: 120000 })
    .then(() => report(true, 'a newly opened OBS source restores the current model and expression'), async () => { report(false, 'a newly opened OBS source restores the current model and expression'); console.log(JSON.stringify(await state(late)).slice(0, 600)); });
  await late.close();   // software rendering is slow; keep the CPU for face tracking

  // Real face tracking with a fake webcam, relayed to OBS.
  await editor.click('#tgCam');
  await editor.waitForFunction(() => window.Anime25D.state().camLive, null, { timeout: 90000 })
    .then(() => report(true, 'face tracking detects a face from the (fake) webcam with the bundled MediaPipe'), () => report(false, 'face tracking detects a face from the (fake) webcam with the bundled MediaPipe'));
  const cam = (await state(editor)).cam;
  report(['ax', 'ay', 'az', 'eL', 'eR', 'mo', 'ex', 'ey', 'br', 'mf'].every(k => Number.isFinite(cam[k])) && cam.eL > 0.8, 'tracking values are finite and the eyes read as open');
  await obs.waitForFunction(() => window.Anime25D.state().camLive, null, { timeout: 10000 })
    .then(() => report(true, 'tracking is relayed to OBS'), () => report(false, 'tracking is relayed to OBS'));
  await editor.click('#btnCalibrate');
  await editor.waitForFunction(() => { const s = window.Anime25D.state(); return s.calibrated && Math.abs(s.cam.ax) < 0.2 && Math.abs(s.cam.mf) < 0.3; }, null, { timeout: 15000 })
    .then(() => report(true, 'calibration makes the current face the neutral pose'), async () => report(false, 'calibration makes the current face the neutral pose ' + JSON.stringify((await state(editor)).cam) + ' / ' + await editor.textContent('#appStatus')));
  await editor.click('#tgCam');
  await obs.waitForFunction(() => !window.Anime25D.state().camLive, null, { timeout: 5000 })
    .then(() => report(true, 'turning the camera off returns OBS to idle motion'), () => report(false, 'turning the camera off returns OBS to idle motion'));
  // Sync OFF keeps OBS on the last model; turning it back on sends the current one.
  await editor.uncheck('#prefObsSync');
  await editor.click('.sample-actions [data-sample="A"]');
  await editor.waitForFunction(() => window.Anime25D.state().modelName === 'sample2.psd' && window.Anime25D.state().layers > 0, null, { timeout: 120000 });
  await obs.waitForTimeout(1500);
  report((await state(obs)).modelName === 'sample.psd', 'with sync OFF, OBS keeps the previous model');
  await editor.check('#prefObsSync');
  await obs.waitForFunction(() => window.Anime25D.state().modelName === 'sample2.psd' && window.Anime25D.state().layers > 0, null, { timeout: 120000 })
    .then(() => report(true, 'turning sync back ON sends the model opened meanwhile'), () => report(false, 'turning sync back ON sends the model opened meanwhile'));
  report(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await context.close();
}

(async () => {
  const { proc, base } = await startServer();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + fixture,
    '--autoplay-policy=no-user-gesture-required'] });
  try {
    if (!process.argv.includes('--obs-only')) await suite(browser, base);
    if (!process.argv.includes('--suite-only')) await obsSync(browser, base);
  } catch (err) {
    failures++; console.error(err);
  } finally {
    await browser.close();
    proc.kill();
  }
  console.log(failures ? failures + ' FAILED' : 'ALL BROWSER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
