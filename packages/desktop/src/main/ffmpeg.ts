/**
 * Locating and interrogating FFmpeg.
 *
 * EasyColor does not bundle FFmpeg. That is a deliberate trade: a bundled
 * build would add ~80MB to the installer and, more importantly, would be a
 * *fixed* build — the NVENC, QSV and AMF paths depend on what the user's
 * driver stack supports, and a generic binary regularly ships without the
 * hardware encoder the machine in front of you actually has. Looking for an
 * installed FFmpeg and reporting exactly which encoders it exposes gives a
 * better answer on more machines, and makes the failure legible when it
 * fails.
 */

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import type { EncoderInfo, SystemInfo } from '@easycolor/core';

const execFileAsync = promisify(execFile);

/** Encoders worth offering, in the order the UI should prefer them. */
const CANDIDATE_ENCODERS: Array<Omit<EncoderInfo, 'available' | 'reason'>> = [
  {
    id: 'hevc_nvenc',
    label: 'H.265 · NVIDIA NVENC',
    hardware: true,
    vendor: 'NVIDIA',
  },
  {
    id: 'hevc_qsv',
    label: 'H.265 · Intel Quick Sync',
    hardware: true,
    vendor: 'Intel',
  },
  {
    id: 'hevc_amf',
    label: 'H.265 · AMD AMF',
    hardware: true,
    vendor: 'AMD',
  },
  {
    id: 'hevc_videotoolbox',
    label: 'H.265 · Apple VideoToolbox',
    hardware: true,
    vendor: 'Apple',
  },
  {
    id: 'libx265',
    label: 'H.265 · x265 (software)',
    hardware: false,
    vendor: 'Software',
  },
];

/** Places to look before giving up, beyond whatever is on PATH. */
function candidatePaths(tool: 'ffmpeg' | 'ffprobe'): string[] {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const paths = [exe];

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    paths.push(
      join(programFiles, 'ffmpeg', 'bin', exe),
      join('C:\\', 'ffmpeg', 'bin', exe),
      // winget and Chocolatey both land here often enough to be worth a look.
      join(localAppData, 'Microsoft', 'WinGet', 'Links', exe),
      join('C:\\', 'ProgramData', 'chocolatey', 'bin', exe),
    );
  } else {
    paths.push(
      `/usr/bin/${tool}`,
      `/usr/local/bin/${tool}`,
      `/opt/homebrew/bin/${tool}`,
      `/snap/bin/${tool}`,
    );
  }

  // A binary sitting next to the app wins over anything installed, so a
  // portable build can ship one if a site needs a pinned version.
  const bundled = join(dirname(process.execPath), 'ffmpeg', exe);
  paths.unshift(bundled);

  return paths;
}

async function resolveTool(tool: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  const override = process.env[tool === 'ffmpeg' ? 'EASYCOLOR_FFMPEG' : 'EASYCOLOR_FFPROBE'];
  if (override && existsSync(override)) return override;

  for (const candidate of candidatePaths(tool)) {
    // A bare name has to be tested by running it; an absolute path can be
    // checked on disk first, which is much cheaper.
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (!existsSync(candidate)) continue;
    }
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 6000, windowsHide: true });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

let cached: SystemInfo | null = null;

export async function probeSystem(force = false): Promise<SystemInfo> {
  if (cached && !force) return cached;

  const [ffmpegPath, ffprobePath] = await Promise.all([
    resolveTool('ffmpeg'),
    resolveTool('ffprobe'),
  ]);

  if (!ffmpegPath) {
    cached = {
      ffmpegPath: null,
      ffprobePath,
      ffmpegVersion: null,
      encoders: CANDIDATE_ENCODERS.map((e) => ({
        ...e,
        available: false,
        reason: 'FFmpeg was not found.',
      })),
      problem:
        'FFmpeg was not found on this machine. EasyColor uses it to decode camera formats and ' +
        'to render masters. Install it (winget install Gyan.FFmpeg), or set the EASYCOLOR_FFMPEG ' +
        'environment variable to the full path of ffmpeg.exe, then restart EasyColor.',
    };
    return cached;
  }

  const version = await readVersion(ffmpegPath);
  const encoders = await probeEncoders(ffmpegPath);

  cached = { ffmpegPath, ffprobePath, ffmpegVersion: version, encoders };
  return cached;
}

async function readVersion(ffmpegPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-version'], {
      timeout: 6000,
      windowsHide: true,
    });
    return stdout.split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask FFmpeg which encoders it was built with.
 *
 * Being listed is necessary but not sufficient — a build can list
 * `hevc_nvenc` on a machine with no NVIDIA card, and the failure only
 * surfaces when an export starts. So each hardware encoder is also given a
 * one-frame trial run; three seconds now beats a failed 40-minute render.
 */
async function probeEncoders(ffmpegPath: string): Promise<EncoderInfo[]> {
  let listed = new Set<string>();
  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
      if (match) listed.add(match[1]);
    }
  } catch {
    listed = new Set();
  }

  const results: EncoderInfo[] = [];
  for (const candidate of CANDIDATE_ENCODERS) {
    if (!listed.has(candidate.id)) {
      results.push({
        ...candidate,
        available: false,
        reason: `This FFmpeg build does not include ${candidate.id}.`,
      });
      continue;
    }

    if (!candidate.hardware) {
      results.push({ ...candidate, available: true });
      continue;
    }

    const trial = await trialEncode(ffmpegPath, candidate.id);
    results.push({
      ...candidate,
      available: trial.ok,
      reason: trial.ok ? undefined : trial.reason,
    });
  }

  return results;
}

async function trialEncode(
  ffmpegPath: string,
  encoder: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'color=c=black:s=320x240:d=0.1:r=10',
        '-c:v', encoder,
        '-frames:v', '1',
        '-f', 'null',
        '-',
      ],
      { timeout: 15000, windowsHide: true },
    );
    return { ok: true };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const firstLine = stderr.split('\n').find((l) => l.trim().length > 0)?.trim();
    return {
      ok: false,
      reason: firstLine
        ? `Not usable on this machine: ${firstLine}`
        : 'The encoder is present but failed a test render, so the hardware or driver is missing.',
    };
  }
}

export interface RunOptions {
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** Run FFmpeg and collect stderr. Resolves with the exit code. */
export function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  options: RunOptions = {},
): { promise: Promise<{ code: number; stderr: string[] }>; kill: () => void } {
  const child = spawn(ffmpegPath, args, { windowsHide: true });
  const stderr: string[] = [];

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Keep the tail only: a long render's stderr is mostly progress lines,
    // and holding all of it in memory for an hour serves nobody.
    for (const line of chunk.split(/\r?\n|\r/)) {
      if (line.trim()) stderr.push(line);
    }
    if (stderr.length > 400) stderr.splice(0, stderr.length - 400);
    options.onStderr?.(chunk);
  });

  const promise = new Promise<{ code: number; stderr: string[] }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });

  const kill = () => {
    // 'q' asks FFmpeg to finalise the container before exiting, which leaves
    // a playable partial file instead of a truncated one.
    try {
      child.stdin.write('q');
    } catch {
      /* the process may already be gone */
    }
    setTimeout(() => child.kill('SIGKILL'), 2000);
  };

  options.signal?.addEventListener('abort', kill, { once: true });

  return { promise, kill };
}
