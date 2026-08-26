/**
 * Cross-platform local install, for development.
 *
 * The shipped installers are the PowerShell and shell scripts under
 * `install/`, which people can run without Node. This one exists so that
 * `npm run install:local` does the same thing during development.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const BUNDLE_ID = 'com.easycolor.premiere';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'dist', BUNDLE_ID);

if (!existsSync(join(source, 'CSXS', 'manifest.xml'))) {
  console.error('The extension has not been built. Run:  npm run build -w @easycolor/premiere');
  process.exit(1);
}

function extensionsRoot() {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Adobe', 'CEP', 'extensions');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
  }
  // Premiere Pro does not run on Linux; this branch exists so the script
  // fails with an explanation rather than an ENOENT.
  return null;
}

const target = extensionsRoot();
if (!target) {
  console.error('Premiere Pro only runs on Windows and macOS, so there is nowhere to install to.');
  process.exit(1);
}

/**
 * Premiere refuses to load an extension Adobe has not signed unless
 * PlayerDebugMode is set — per CEP runtime version, so the whole plausible
 * range gets written.
 */
async function enableUnsignedExtensions() {
  const versions = Array.from({ length: 22 }, (_, i) => i + 4);

  if (platform() === 'win32') {
    for (const version of versions) {
      await execFileAsync('reg', [
        'add', `HKCU\\Software\\Adobe\\CSXS.${version}`,
        '/v', 'PlayerDebugMode',
        // A string "1", not a DWORD. A DWORD is silently ignored and the
        // panel simply never appears.
        '/t', 'REG_SZ', '/d', '1', '/f',
      ]).catch(() => {});
    }
  } else {
    for (const version of versions) {
      await execFileAsync('defaults', [
        'write', `com.adobe.CSXS.${version}`, 'PlayerDebugMode', '1',
      ]).catch(() => {});
    }
  }
}

await enableUnsignedExtensions();

const destination = join(target, BUNDLE_ID);
await mkdir(target, { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });

// Premiere only scans the LUT folders it already has, at launch.
const lutRoot =
  platform() === 'win32'
    ? join(process.env.APPDATA ?? '', 'Adobe', 'Common', 'LUTs')
    : join(homedir(), 'Library', 'Application Support', 'Adobe', 'Common', 'LUTs');

for (const kind of ['Creative', 'Technical']) {
  await mkdir(join(lutRoot, kind), { recursive: true });
}

console.log(`Installed to ${destination}`);
console.log('');
console.log('Restart Premiere Pro, then open  Window > Extensions > EasyColor.');
