/**
 * End-to-end render test against a real FFmpeg.
 *
 * The unit tests check that the command *says* the right thing. This one
 * checks that FFmpeg accepts it and that the pixels come out changed in the
 * direction the grade asked for — which is the only way to catch a filter
 * graph that is syntactically fine and semantically wrong.
 *
 * Skips itself when FFmpeg is missing or lacks the filters it needs, so it
 * does not fail a machine that simply cannot run it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommand } from '../dist/main/export.js';
import { writeCube } from '../../core/dist/lut/cube.js';
import { renderWindowMask } from '../../core/dist/export/plan.js';
import { createWindow } from '../../core/dist/state/grade.js';

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.EASYCOLOR_FFMPEG ?? 'ffmpeg';

const REQUIRED_FILTERS = ['lut3d', 'maskedmerge', 'gblur', 'noise', 'blend', 'geq'];

function capabilities() {
  try {
    const filters = execFileSync(FFMPEG, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      maxBuffer: 8 << 20,
    });
    const missing = REQUIRED_FILTERS.filter((f) => !new RegExp(`\\b${f}\\b`).test(filters));

    const encoders = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      maxBuffer: 8 << 20,
    });
    return { ok: missing.length === 0, missing, hasX265: /\blibx265\b/.test(encoders) };
  } catch {
    return { ok: false, missing: ['ffmpeg itself'], hasX265: false };
  }
}

const caps = capabilities();
const skip = caps.ok ? false : `FFmpeg is missing: ${caps.missing.join(', ')}`;

/** A cube that swaps the red and blue channels — unmistakable in the output. */
function swapCube(size = 5) {
  const values = [];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        values.push(b / (size - 1), g / (size - 1), r / (size - 1));
  return writeCube(size, values, { title: 'swap' });
}

/** A cube that crushes everything to black. */
function blackCube(size = 5) {
  return writeCube(size, new Array(size ** 3 * 3).fill(0), { title: 'black' });
}

async function averageColor(path, at = '0.2') {
  // signalstats reports per-frame averages; one frame is enough.
  const { stderr } = await execFileAsync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'info',
      '-ss', at, '-i', path, '-frames:v', '1',
      '-vf', 'format=rgb24,signalstats,metadata=mode=print:file=-',
      '-f', 'null', '-',
    ],
    { maxBuffer: 8 << 20 },
  ).catch((e) => ({ stderr: e.stderr ?? '' }));

  // Fall back to decoding one raw pixel if signalstats is unavailable.
  const { stdout } = await execFileAsync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-ss', at, '-i', path, '-frames:v', '1',
      '-vf', 'scale=1:1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
    ],
    { encoding: 'buffer', maxBuffer: 1 << 20 },
  );
  void stderr;
  return [stdout[0], stdout[1], stdout[2]];
}

async function pixelAt(path, u, v, size = 64) {
  const { stdout } = await execFileAsync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', path, '-frames:v', '1',
      '-vf', `scale=${size}:${size}`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
    ],
    { encoding: 'buffer', maxBuffer: 4 << 20 },
  );
  const x = Math.floor(u * size);
  const y = Math.floor(v * size);
  const i = (y * size + x) * 3;
  return [stdout[i], stdout[i + 1], stdout[i + 2]];
}

let work;
let sourcePath;

test('set up a source clip', { skip }, async () => {
  work = await mkdtemp(join(tmpdir(), 'easycolor-render-'));
  sourcePath = join(work, 'source.mp4');

  // A flat, strongly red clip: any channel change is obvious.
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0xC03020:s=320x180:d=1:r=25',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    sourcePath,
  ]);

  const rgb = await averageColor(sourcePath);
  assert.ok(rgb[0] > 150 && rgb[2] < 90, `source should be red, got rgb(${rgb})`);
});

function baseRequest(overrides = {}) {
  return {
    inputPath: sourcePath,
    outputPath: join(work, `out-${Math.random().toString(36).slice(2)}.mp4`),
    cube: swapCube(),
    windows: [],
    halation: null,
    grain: null,
    encoder: 'libx264', // x264 renders this test clip in a second; the graph is what is under test
    bitrateMbps: 20,
    bitDepth: 8,
    chroma: '420',
    useConstantQuality: true,
    quality: 20,
    startSeconds: null,
    durationSeconds: null,
    includeAudio: false,
    ...overrides,
  };
}

async function render(request) {
  // Write the base cube to disk, the way the exporter does, then reference
  // it by path — the graph names files, it does not carry their contents.
  const baseCube = join(work, `base-${Math.random().toString(36).slice(2)}.cube`);
  await writeFile(baseCube, request.cube, 'utf8');

  const { args } = buildCommand(
    request,
    { width: 320, height: 180, fps: 25 },
    { baseCube, windows: request._files ?? [] },
  );
  try {
    await execFileAsync(FFMPEG, args, { maxBuffer: 16 << 20 });
  } catch (error) {
    const stderr = String(error.stderr ?? '').split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed\n\n${args.join(' ')}\n\n${stderr}`);
  }
  return request.outputPath;
}

test('the base LUT is actually applied to the render', { skip }, async () => {
  const request = baseRequest();
  const out = await render(request);
  const rgb = await averageColor(out);
  // Red and blue swapped: the frame must now be blue.
  assert.ok(rgb[2] > 130, `expected blue after the swap LUT, got rgb(${rgb})`);
  assert.ok(rgb[0] < 90, `red should have dropped, got rgb(${rgb})`);
});

test('10-bit 4:2:2 output is produced and correctly tagged', { skip }, async () => {
  // x264 handles 10-bit 4:2:2 in any standard build.
  const out = await render(baseRequest({ bitDepth: 10, chroma: '422', encoder: 'libx264' }));

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt,color_primaries,color_transfer',
    '-of', 'json', out,
  ]);
  const stream = JSON.parse(stdout).streams[0];
  assert.equal(stream.pix_fmt, 'yuv422p10le');
  assert.equal(stream.color_primaries, 'bt709');
  assert.equal(stream.color_transfer, 'bt709');
});

test('a power window only affects the area inside its mask', { skip }, async () => {
  // A small ellipse in the centre, crushing to black.
  const window = {
    ...createWindow('w', 'ellipse'),
    cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, softness: 0.05,
  };
  const maskWidth = 320;
  const maskHeight = 180;
  const mask = renderWindowMask(window, maskWidth, maskHeight);

  const cubePath = join(work, 'win.cube');
  const maskPath = join(work, 'win.pgm');
  await writeFile(cubePath, blackCube(), 'utf8');
  await writeFile(
    maskPath,
    Buffer.concat([
      Buffer.from(`P5\n${maskWidth} ${maskHeight}\n255\n`, 'ascii'),
      Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength),
    ]),
  );

  const request = baseRequest({
    // Identity base, so only the window changes anything.
    cube: writeCube(2, [0,0,0, 1,0,0, 0,1,0, 1,1,0, 0,0,1, 1,0,1, 0,1,1, 1,1,1], { title: 'id' }),
    windows: [{ cube: 'x', mask, maskWidth, maskHeight }],
    _files: [{ cube: cubePath, mask: maskPath }],
  });

  const out = await render(request);

  const centre = await pixelAt(out, 0.5, 0.5);
  const corner = await pixelAt(out, 0.06, 0.06);

  assert.ok(Math.max(...centre) < 40, `inside the window should be crushed, got rgb(${centre})`);
  assert.ok(corner[0] > 130, `outside the window should be untouched red, got rgb(${corner})`);
});

test('halation and grain render without breaking the graph', { skip }, async () => {
  const out = await render(
    baseRequest({
      halation: { threshold: 0.4, radius: 12, strength: 0.5, tint: [1, 0.35, 0.15] },
      grain: { amount: 0.4, size: 1.5, chroma: 0.4 },
    }),
  );
  const rgb = await averageColor(out);
  assert.ok(rgb.some((v) => v > 10), `expected a real image, got rgb(${rgb})`);
});

test('trimming produces a shorter file', { skip }, async () => {
  const out = await render(baseRequest({ startSeconds: 0.2, durationSeconds: 0.4 }));
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out,
  ]);
  const duration = Number(stdout.trim());
  assert.ok(duration > 0.2 && duration < 0.7, `expected ~0.4s, got ${duration}s`);
});

test('clean up', { skip }, async () => {
  await rm(work, { recursive: true, force: true });
});
