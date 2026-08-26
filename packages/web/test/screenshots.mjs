/**
 * Screenshot harness.
 *
 * Drives the built app through a short grading session and captures the
 * result, so a UI change can be looked at rather than only reasoned about.
 * Set EASYCOLOR_SHOTS to choose the output directory.
 *
 *   npm run build -w @easycolor/web && node packages/web/test/screenshots.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = process.env.EASYCOLOR_SHOTS ?? fileURLToPath(new URL('../shots', import.meta.url));
await mkdir(OUT, { recursive: true });

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://l').pathname;
    const f = join(DIST, normalize(p === '/' ? '/index.html' : p));
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4179, r));

const browser = await chromium.launch({
  executablePath: process.env.EASYCOLOR_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
await page.goto('http://localhost:4179/', { waitUntil: 'networkidle' });

await page.evaluate(async () => {
  const w = 960, h = 540;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  // A synthetic "scene": warm sky gradient, a face-toned oval, foliage, a shadow side.
  const sky = x.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, '#2e5f8f'); sky.addColorStop(1, '#c9a074');
  x.fillStyle = sky; x.fillRect(0, 0, w, h * 0.62);
  x.fillStyle = '#243a22'; x.fillRect(0, h * 0.58, w, h * 0.42);
  x.fillStyle = '#3d5c30';
  for (let i = 0; i < 26; i++) {
    x.beginPath();
    x.ellipse(i * 41 + 20, h * 0.62 + (i % 4) * 22, 46, 26, 0, 0, Math.PI * 2); x.fill();
  }
  x.fillStyle = '#c99070';
  x.beginPath(); x.ellipse(w * 0.34, h * 0.46, 78, 104, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#a46d52';
  x.beginPath(); x.ellipse(w * 0.34, h * 0.5, 78, 104, 0, 0.2, Math.PI * 0.85); x.fill();
  x.fillStyle = '#7c2f2a'; x.fillRect(w * 0.62, h * 0.3, 190, 250);
  x.fillStyle = '#e8e2d2'; x.fillRect(w * 0.05, h * 0.12, 90, 60);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const t = new DataTransfer(); t.items.add(new File([blob], 'scene.png', { type: 'image/png' }));
  const input = document.querySelector('input[type=file][accept*="image"]');
  Object.defineProperty(input, 'files', { value: t.files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForSelector('.viewer-stage:not([hidden])');
await page.waitForTimeout(500);

const box = await page.locator('.viewer-surface').boundingBox();
// Grade the sky cooler, then the foliage.
async function drag(u, v, du, dv) {
  await page.mouse.move(box.x + u * box.width, box.y + v * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + (u + du) * box.width, box.y + (v + dv) * box.height, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}
await drag(0.8, 0.08, -0.06, -0.08);
await drag(0.5, 0.85, 0.05, -0.05);
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'ui-zones.png') });

// Skin panel with the measurement.
await page.click('button[role=tab]:has-text("Skin")');
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, 'ui-skin.png') });

// Wheels + wipe compare.
await page.click('button[role=tab]:has-text("Wheels")');
await page.click('button[title^="Wipe compare"]');
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'ui-wheels.png') });

await browser.close();
server.close();
console.log(`shots written to ${OUT}`);
