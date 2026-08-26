/**
 * Assemble the CEP extension folder.
 *
 * Copies the built web app in as the panel's UI and injects the Premiere
 * bridge ahead of it, so the panel and the browser build stay the same
 * bundle rather than two that drift.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const webDist = join(root, '..', 'web', 'dist');
const out = join(root, 'dist', 'com.easycolor.premiere');

if (!existsSync(join(webDist, 'index.html'))) {
  console.error(
    'The web app has not been built.\n' +
      'Run:  EASYCOLOR_BASE=./ npm run build -w @easycolor/web',
  );
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'client'), { recursive: true });

await cp(join(root, 'CSXS'), join(out, 'CSXS'), { recursive: true });
await cp(join(root, 'host'), join(out, 'host'), { recursive: true });
await cp(webDist, join(out, 'client'), { recursive: true });
await cp(join(root, 'client', 'premiere-bridge.js'), join(out, 'client', 'premiere-bridge.js'));

// Inject the bridge before the app's own module script, so the UI can see it
// during its first render rather than having to poll for it.
const indexPath = join(out, 'client', 'index.html');
let html = await readFile(indexPath, 'utf8');

if (!html.includes('premiere-bridge.js')) {
  html = html.replace(
    /<script type="module"/,
    '<script src="./premiere-bridge.js"></script>\n    <script type="module"',
  );
  await writeFile(indexPath, html, 'utf8');
}

console.log(`Extension assembled at ${out}`);
console.log('Install it with:  node packages/premiere/scripts/install.mjs');
