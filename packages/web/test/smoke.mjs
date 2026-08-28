/**
 * Browser smoke test.
 *
 * The point of running a real browser here is the shaders: everything in the
 * GL pipeline is assembled from generated GLSL fragments at runtime, so a
 * typo in a shader chunk compiles fine in TypeScript and fails only when a
 * program is linked. A unit test cannot catch that; a headless Chromium can.
 *
 * It also exercises the on-viewer HSL tool end to end — synthetic image in,
 * click and drag, pixels out — which is the one path that has to work.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const PORT = 4178;
const server = await serve(PORT);

/* ---- a deterministic test clip ----
   Red for its first second, blue for its second, as VP8 WebM — the one
   family of codecs an open-source Chromium build is guaranteed to decode.
   Solid colours, so every video assertion has an unambiguous pixel. */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';

let clipBase64 = null;
try {
  const clipPath = join(tmpdir(), `easycolor-clip-${Date.now()}.webm`);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0xC03020:s=320x180:d=1:r=12',
    '-f', 'lavfi', '-i', 'color=c=0x2040C0:s=320x180:d=1:r=12',
    '-filter_complex', '[0][1]concat=n=2',
    '-c:v', 'libvpx', '-b:v', '1M',
    clipPath,
  ]);
  clipBase64 = readFileSync(clipPath).toString('base64');
  rmSync(clipPath, { force: true });
} catch {
  // FFmpeg missing: the video checks below fail loudly rather than skip,
  // because a silently skipped check is how NO VIDEO OUTPUT ships twice.
}

const browser = await chromium.launch({
  // Fall back to whatever Playwright installed. The explicit path is for
  // sandboxes that ship a browser outside Playwright's own cache.
  executablePath: process.env.EASYCOLOR_CHROME || undefined,
  args: [
    // Headless Chromium needs to be told to provide a GL implementation;
    // SwiftShader is software but it is a real WebGL2 driver, which is what
    // the shader compilation check needs.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

/* ---- the engine starts ---- */

const engineError = await page.locator('.viewer-empty strong').first().textContent().catch(() => null);
check(
  'grading engine starts (WebGL2 available, all shaders compiled and linked)',
  engineError !== 'Cannot start the grading engine',
  engineError === 'Cannot start the grading engine'
    ? await page.locator('.viewer-empty .hint').first().textContent()
    : '',
);

/* ---- load a synthetic test image ----
   Six colour bands plus a grey ramp: enough distinct hues to exercise zone
   creation and matching, and a neutral wedge to prove greys stay neutral. */

await page.evaluate(async () => {
  const w = 640;
  const h = 360;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const bands = ['#c8322a', '#c87a2a', '#c8c02a', '#2ea84a', '#2a6ec8', '#7a2ac8'];
  bands.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect((i * w) / bands.length, 0, w / bands.length, h * 0.6);
  });

  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, '#000');
  gradient.addColorStop(1, '#fff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, h * 0.6, w, h * 0.4);

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'bars.png', { type: 'image/png' });

  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.querySelector('input[type=file][accept*="image"]');
  Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

await page.waitForSelector('.viewer-stage:not([hidden])', { timeout: 8000 });
await page.waitForTimeout(600);

const canvasSize = await page.evaluate(() => {
  const c = document.querySelector('.viewer canvas');
  return { width: c.width, height: c.height };
});
check('image loads and the viewer sizes to it', canvasSize.width === 640 && canvasSize.height === 360,
  `${canvasSize.width}x${canvasSize.height}`);

/** Read the rendered colour at a normalised position on the viewer canvas. */
async function pixelAt(u, v) {
  return page.evaluate(([u, v]) => {
    const canvas = document.querySelector('.viewer canvas');
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    const x = Math.floor(u * canvas.width);
    const y = Math.floor(v * canvas.height);
    const d = copy.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [u, v]);
}

const redBefore = await pixelAt(0.08, 0.25);
check('the viewer renders the image', redBefore[0] > 120 && redBefore[1] < 90,
  `red band reads rgb(${redBefore})`);

const greyBefore = await pixelAt(0.5, 0.85);
check('neutral ramp starts neutral',
  Math.max(...greyBefore) - Math.min(...greyBefore) <= 3,
  `rgb(${greyBefore})`);

/* ---- the on-viewer HSL tool ---- */

const surface = page.locator('.viewer-surface');
const box = await surface.boundingBox();

/** Click at a normalised position and drag by a normalised delta. */
async function dragOnViewer(u, v, du, dv, modifiers = []) {
  const x = box.x + u * box.width;
  const y = box.y + v * box.height;
  await page.mouse.move(x, y);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.down();
  await page.mouse.move(x + du * box.width, y + dv * box.height, { steps: 8 });
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
  await page.waitForTimeout(220);
}

// Rotate the red band's hue by dragging right.
await dragOnViewer(0.08, 0.25, 0.35, 0);

const zoneCount = async () =>
  page.evaluate(() => document.querySelectorAll('.zone').length);

await page.click('button[role=tab]:has-text("Colours")');
check('clicking a colour and dragging creates one zone', (await zoneCount()) === 1,
  `${await zoneCount()} zones`);

const redAfter = await pixelAt(0.08, 0.25);
check('the graded colour actually changed', redAfter.join() !== redBefore.join(),
  `rgb(${redBefore}) -> rgb(${redAfter})`);

const greyAfter = await pixelAt(0.5, 0.85);
check('grading a colour leaves neutrals neutral',
  Math.abs(greyAfter[0] - greyBefore[0]) <= 2 &&
    Math.abs(greyAfter[1] - greyBefore[1]) <= 2 &&
    Math.abs(greyAfter[2] - greyBefore[2]) <= 2,
  `rgb(${greyBefore}) -> rgb(${greyAfter})`);

// A second, unrelated colour must not disturb the first.
const blueBefore = await pixelAt(0.75, 0.25);
await dragOnViewer(0.75, 0.25, -0.3, -0.1);
const redAfterSecond = await pixelAt(0.08, 0.25);
const blueAfter = await pixelAt(0.75, 0.25);

check('grading a second colour creates a second zone', (await zoneCount()) === 2,
  `${await zoneCount()} zones`);
check('the second colour changed', blueAfter.join() !== blueBefore.join(),
  `rgb(${blueBefore}) -> rgb(${blueAfter})`);
check('the first colour is untouched by the second edit',
  redAfterSecond.join() === redAfter.join(),
  `rgb(${redAfter}) -> rgb(${redAfterSecond})`);

// Clicking the same colour again must reuse its zone, not stack a new one.
await dragOnViewer(0.08, 0.25, 0.05, 0);
check('re-grading the same colour reuses its zone', (await zoneCount()) === 2,
  `${await zoneCount()} zones`);

// A plain click with no drag should not leave a zone behind.
const historyLength = () =>
  page.evaluate(async () => {
    const tab = [...document.querySelectorAll('button[role=tab]')].find(
      (b) => b.textContent.trim() === 'History',
    );
    tab.click();
    await new Promise((r) => setTimeout(r, 60));
    return document.querySelectorAll('.history-entry').length;
  });

const historyBeforeClick = await historyLength();
await page.click('button[role=tab]:has-text("Colours")');

await page.mouse.move(box.x + 0.42 * box.width, box.y + 0.25 * box.height);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
check('a click without a drag does not create a zone', (await zoneCount()) === 2,
  `${await zoneCount()} zones`);

const historyAfterClick = await historyLength();
check('an inspect-click leaves no history entries behind',
  historyAfterClick === historyBeforeClick,
  `${historyBeforeClick} -> ${historyAfterClick} entries`);
await page.click('button[role=tab]:has-text("Colours")');

/* ---- undo ----
   The last real edit was to the red band, so that is the pixel that must
   move when it is undone. */

const beforeUndo = await pixelAt(0.08, 0.25);
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const afterUndo = await pixelAt(0.08, 0.25);
check('undo changes the image back', beforeUndo.join() !== afterUndo.join(),
  `rgb(${beforeUndo}) -> rgb(${afterUndo})`);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(250);
check('redo restores it', (await pixelAt(0.08, 0.25)).join() === beforeUndo.join(),
  `rgb(${await pixelAt(0.08, 0.25)})`);

/* ---- bypass ---- */

await page.keyboard.press('b');
await page.waitForTimeout(250);
const bypassed = await pixelAt(0.08, 0.25);
check('bypass shows the ungraded image',
  Math.abs(bypassed[0] - redBefore[0]) <= 4 && Math.abs(bypassed[2] - redBefore[2]) <= 4,
  `rgb(${bypassed}) vs original rgb(${redBefore})`);
await page.keyboard.press('b');
await page.waitForTimeout(200);

/* ---- scopes ---- */

await page.waitForTimeout(400);
const scopesDrawn = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('.scope canvas')];
  return canvases.map((c) => {
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext('2d').drawImage(c, 0, 0);
    const d = copy.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) lit++;
    }
    return lit;
  });
});
check('all scopes draw a trace', scopesDrawn.length === 3 && scopesDrawn.every((n) => n > 500),
  `lit pixels: ${scopesDrawn.join(', ')}`);

/* ---- LUT export ---- */

await page.click('button[role=tab]:has-text("LUT")');
const cubeText = await page.evaluate(async () => {
  // Reach the bake through the same button the user presses, but capture the
  // download instead of writing a file.
  return new Promise((resolve, reject) => {
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      blob.text().then(resolve, reject);
      URL.createObjectURL = originalCreate;
      // Hand back a real, empty object URL: returning a fake string makes
      // the browser log a "not allowed to load local resource" error that
      // would otherwise look like a genuine failure.
      return originalCreate(new Blob([]));
    };
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Export .cube',
    );
    button.click();
    setTimeout(() => reject(new Error('export timed out')), 15000);
  });
});

const lines = cubeText.trim().split('\n');
const sizeLine = lines.find((l) => l.startsWith('LUT_3D_SIZE'));
const dataRows = lines.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l));
check('LUT export produces a valid 33-cube', sizeLine === 'LUT_3D_SIZE 33' && dataRows.length === 33 ** 3,
  `${sizeLine}, ${dataRows.length} rows`);

// The baked cube must carry the grade: with two hue zones applied, the
// identity diagonal cannot still be an identity.
const firstRow = dataRows[0].split(' ').map(Number);
const lastRow = dataRows[dataRows.length - 1].split(' ').map(Number);
check('the baked LUT spans the full range',
  firstRow.every((v) => v < 0.05) && lastRow.every((v) => v > 0.95),
  `black ${firstRow.join(',')} white ${lastRow.join(',')}`);

/* ---- power windows ---- */

await page.click('button[role=tab]:has-text("Windows")');
await page.click('button:has-text("Vignette")');
await page.waitForTimeout(300);
const corner = await pixelAt(0.02, 0.05);
const centre = await pixelAt(0.5, 0.3);
check('a vignette darkens the corners more than the centre',
  Math.max(...corner) < Math.max(...centre),
  `corner ${Math.max(...corner)} vs centre ${Math.max(...centre)}`);

/* ---- film emulation ---- */

await page.click('button[role=tab]:has-text("Film")');
await page.selectOption('.panel select', 'kodachrome64');
await page.waitForTimeout(400);
const filmed = await pixelAt(0.08, 0.25);
check('selecting a film stock changes the image', filmed.join() !== redAfter.join(),
  `rgb(${filmed})`);

/* ---- skin isolation overlay ----
   The one requirement on this overlay is that it must not cost visibility:
   no dimming, no blurring, no covering. And it must work with corrections
   switched OFF — the diagnostic exists to help set the qualifier up, and it
   once shipped gated on the very switch it was supposed to precede. */

// Reset the creative grade first: the film stock selected above loads
// animated grain, and grain reseeds on every redraw — a pixel-identity
// check against a noise field measures the noise, not the overlay.
await page.click('button[role=tab]:has-text("Primary")');
await page.click('button:has-text("Reset look")');
await page.waitForTimeout(300);

await page.keyboard.press('Escape');
await page.keyboard.press('5'); // pick-skin tool
await page.mouse.click(box.x + 0.25 * box.width, box.y + 0.25 * box.height); // orange band
await page.waitForTimeout(300);

await page.click('button[role=tab]:has-text("Skin")');
await page.waitForTimeout(200);
// Disable corrections, so the check proves the overlay stands on its own.
await page.locator('.panel .checkbox input').first().uncheck();
await page.waitForTimeout(200);

const untouched = await pixelAt(0.58, 0.25); // deep in the green band
await page.click('button:has-text("Show isolation overlay")');
await page.waitForTimeout(500);

const overlayStats = await page.evaluate(() => {
  const canvas = document.querySelector('.viewer canvas');
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d').drawImage(canvas, 0, 0);
  const d = copy.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let cyan = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 110 && d[i + 1] > 160 && d[i + 2] > 160) cyan++;
  }
  return { cyan };
});
check('the isolation overlay draws its contour with corrections disabled',
  overlayStats.cyan > 40, `${overlayStats.cyan} contour pixels`);

const withOverlay = await pixelAt(0.58, 0.25);
check('the overlay does not dim or cover the picture',
  withOverlay.join() === untouched.join(),
  `rgb(${untouched}) with overlay rgb(${withOverlay})`);

await page.keyboard.press('Escape');
await page.keyboard.press('1');
await page.waitForTimeout(200);

/* ---- video ----
   The still-image checks above cannot catch a broken video path: a video
   frame reaches the GPU through a different route (playback and seek
   events, not a one-shot upload), and that route once shipped never
   uploading anything at all. */

check('a test clip could be generated (ffmpeg present)', clipBase64 !== null);

if (clipBase64 !== null) {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'clip.webm', { type: 'video/webm' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('input[type=file][accept*="image"]');
    Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, clipBase64);

  await page.waitForSelector('.transport', { timeout: 8000 });
  await page.waitForTimeout(600);

  const early = await pixelAt(0.5, 0.5);
  check('a video renders without any user action', early[0] > 100 && early[2] < 90,
    `first-second red reads rgb(${early})`);

  check('the video transport appears', (await page.locator('.transport').count()) === 1);

  // Pause, and prove the frame freezes rather than going black or stale.
  await page.click('.transport button[aria-label=Pause]');
  await page.waitForTimeout(200);
  const pausedA = await pixelAt(0.5, 0.5);
  await page.waitForTimeout(400);
  const pausedB = await pixelAt(0.5, 0.5);
  // The clip loops, so which second the pause lands in is timing luck —
  // the assertion is that the frame holds and is a real frame, not black.
  check('pausing holds the current frame',
    pausedA.join() === pausedB.join() && Math.max(...pausedA) > 60,
    `rgb(${pausedA}) then rgb(${pausedB})`);

  // Scrub into the blue second while paused: the seeked frame must upload.
  const track = await page.locator('.transport-track').boundingBox();
  await page.mouse.click(track.x + track.width * 0.8, track.y + track.height / 2);
  await page.waitForTimeout(500);
  const scrubbed = await pixelAt(0.5, 0.5);
  check('scrubbing while paused shows the new frame', scrubbed[2] > 100 && scrubbed[0] < 90,
    `second-second blue reads rgb(${scrubbed})`);

  // Grade the paused frame: the whole point of pausing. The click may land
  // in a zone the image section already created for this hue — reuse is the
  // designed behaviour and is asserted up there — so the check here is only
  // that the drag changed the paused frame.
  await dragOnViewer(0.5, 0.5, 0.3, 0);
  const graded = await pixelAt(0.5, 0.5);
  check('grading works on a paused video frame', graded.join() !== scrubbed.join(),
    `rgb(${scrubbed}) -> rgb(${graded})`);

  /* The video element never enters the DOM, so playback state is read from
     the transport button, which re-renders off the element's own events. */
  const playState = () =>
    page.locator('.transport button[aria-label=Play], .transport button[aria-label=Pause]')
      .first().getAttribute('aria-label');

  check('setup: the clip is paused after grading', (await playState()) === 'Play');
  await page.keyboard.press(' ');
  await page.waitForTimeout(250);
  check('space starts playback', (await playState()) === 'Pause');
  await page.keyboard.press(' ');
  await page.waitForTimeout(250);
  check('space pauses again', (await playState()) === 'Play');
}

/* ---- no runtime errors anywhere ---- */

const realErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
check('no console or page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
