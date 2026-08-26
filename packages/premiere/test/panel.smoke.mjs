/**
 * Panel smoke test.
 *
 * Runs the packed CEP extension in headless Chromium with a stubbed
 * `__adobe_cep__`, so the bridge glue, the ExtendScript call encoding and
 * the Premiere panel UI are all exercised without needing Premiere Pro.
 *
 * What this can prove: the panel loads from the packed folder, the bridge
 * is detected, the Premiere tab appears, and the calls it makes carry
 * well-formed ExtendScript with correctly escaped arguments.
 *
 * What it cannot prove: that Premiere itself behaves as the host script
 * expects. That needs Premiere, and the docs say so.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Served with the panel's own folder as the root, matching how CEP loads
// index.html — the bundle's asset paths are relative to it.
const EXTENSION = fileURLToPath(
  new URL('../dist/com.easycolor.premiere/client', import.meta.url),
);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jsx': 'text/plain',
  '.xml': 'text/xml',
};

const PORT = 4181;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://l').pathname;
    const file = join(EXTENSION, normalize(path === '/' ? '/index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    // A favicon request races the page's own; guard against double-sending.
    if (!res.headersSent) res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  // Fall back to whatever Playwright installed. The explicit path is for
  // sandboxes that ship a browser outside Playwright's own cache.
  executablePath: process.env.EASYCOLOR_CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

/**
 * Stand in for Premiere's CEP host.
 *
 * Installed before any page script runs, so the bridge finds it during its
 * own initialisation exactly as it would inside Premiere.
 */
await page.addInitScript(() => {
  window.__evalLog = [];
  window.__adobe_cep__ = {
    evalScript(script, callback) {
      window.__evalLog.push(script);

      if (script.startsWith('EasyColor.hostVersion()')) {
        callback('{"ok":true,"version":"25.1.0"}');
      } else if (script.startsWith('EasyColor.grabFrame()')) {
        callback(
          JSON.stringify({
            ok: true,
            path: 'C:\\Temp\\EasyColor\\frame-1.png',
            // A 2x2 PNG, so the panel has something real to display.
            url:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVQIW2NkYGD4z8DAwMgABXAGNgEAVfoDASHtY4wAAAAASUVORK5CYII=',
            clip: {
              name: 'A001_C003.mxf',
              mediaPath: 'D:\\Footage\\A001_C003.mxf',
              sequenceName: 'Reel 1',
              timecode: '01:00:12:04',
            },
          }),
        );
      } else if (script.startsWith('EasyColor.installLut(')) {
        callback('{"ok":true,"path":"C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\Adobe\\\\Common\\\\LUTs\\\\Technical\\\\Test.cube","folder":"Technical"}');
      } else if (script.startsWith('EasyColor.applyLutToSelection(')) {
        callback('{"ok":false,"partial":true,"error":"Premiere Pro 25.1.0 does not let scripts set a custom LUT."}');
      } else {
        callback('{"ok":true}');
      }
    },
  };
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

check(
  'the panel loads from the packed extension folder',
  (await page.locator('.brand').count()) === 1,
);

check(
  'the Premiere tab appears when the CEP host is present',
  (await page.locator('button[role=tab]:has-text("Premiere")').count()) === 1,
);

check(
  'the desktop-only Render tab stays hidden in the panel',
  (await page.locator('button[role=tab]:has-text("Render")').count()) === 0,
);

await page.click('button[role=tab]:has-text("Premiere")');
await page.waitForTimeout(200);

check(
  'the host version is read on load',
  (await page.locator('.panel').textContent()).includes('25.1.0'),
);

/* ---- grab a frame ---- */

await page.click('button:has-text("Grab the current frame")');
await page.waitForTimeout(700);

const panelText = await page.locator('.panel').textContent();
check('the grabbed clip is named', panelText.includes('A001_C003.mxf'), '');
check('the sequence and timecode are shown', panelText.includes('01:00:12:04'));
check('the frame is displayed', (await page.locator('.reference-thumb').count()) === 1);

/* ---- send a look ---- */

// A log grade should route to the Technical folder, since it carries the
// camera conversion and has to run before Lumetri's own correction.
await page.click('button[role=tab]:has-text("Primary")');
await page.selectOption('.panel select', 'slog3');
await page.waitForTimeout(200);
await page.click('button[role=tab]:has-text("Premiere")');
await page.waitForTimeout(200);

check(
  'a grade with a camera conversion routes to the Input LUT slot',
  (await page.locator('.panel').textContent()).includes('Technical'),
);

await page.fill('.panel input[type=text], .panel input:not([type])', 'Night Look');
await page.click('button:has-text("Send look to Premiere")');
await page.waitForTimeout(2500);

const log = await page.evaluate(() => window.__evalLog);
const installCall = log.find((s) => s.startsWith('EasyColor.installLut('));

check('the look is sent through installLut', Boolean(installCall));

if (installCall) {
  check(
    'the LUT name crosses the boundary as a quoted literal',
    installCall.includes('"Night Look"'),
  );
  check(
    'the cube payload is a properly escaped string, not raw text',
    installCall.includes('\\n') && !installCall.includes('\nLUT_3D_SIZE'),
    'newlines must be escaped or the ExtendScript will not parse',
  );
  check(
    'the baked cube is really in there',
    installCall.includes('LUT_3D_SIZE 33'),
  );
  check('the target folder is passed', installCall.includes('"Technical"'));
}

check(
  'the next step is spelled out after installing',
  (await page.locator('.panel').textContent()).includes('Lumetri Color'),
);

/* ---- the honest failure path ---- */

await page.click('button:has-text("Add Lumetri to the selected clip")');
await page.waitForTimeout(600);

const toastText = await page.locator('.toasts').textContent();
check(
  'a host that refuses the scripted apply is reported, not ignored',
  toastText.includes('does not let scripts set a custom LUT'),
  toastText.trim().slice(0, 80),
);

check('no console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
