/**
 * The master re-renderer.
 *
 * Builds an FFmpeg filter graph that reproduces the grade, then encodes to
 * H.265 in an MP4. The graph is assembled in one place and logged with the
 * job, so when a render looks wrong the exact command that produced it is
 * recoverable rather than a matter of reconstruction.
 *
 * The grade reaches FFmpeg as 3D LUTs baked from the real shader, so the
 * per-pixel result is exact. Power windows come through as a widened-window
 * LUT plus a static mask image, which reproduces them exactly too. Only
 * halation and grain are approximations, and the UI says so.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExportProgress, ExportRequest } from '@easycolor/core';
import { probeSystem, runFfmpeg } from './ffmpeg.js';
import { probeMedia } from './decode.js';

export type ProgressListener = (progress: ExportProgress) => void;

interface Job {
  id: string;
  cancel: () => void;
  workDir: string;
}

const jobs = new Map<string, Job>();

export async function startExport(
  request: ExportRequest,
  onProgress: ProgressListener,
): Promise<string> {
  const jobId = randomUUID();
  const system = await probeSystem();
  if (!system.ffmpegPath) {
    throw new Error(system.problem ?? 'FFmpeg was not found.');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'easycolor-'));
  const controller = new AbortController();

  const emit = (patch: Partial<ExportProgress>) => {
    onProgress({
      jobId,
      stage: 'encoding',
      progress: null,
      framesDone: 0,
      totalFrames: 0,
      fps: null,
      speed: null,
      outputPath: request.outputPath,
      ...patch,
    });
  };

  emit({ stage: 'preparing', message: 'Reading the source file…' });

  void (async () => {
    try {
      const info = await probeMedia(request.inputPath);

      const totalFrames = request.durationSeconds
        ? Math.round(request.durationSeconds * info.fps)
        : info.frameCount;

      emit({ stage: 'preparing', message: 'Writing look-up tables…', totalFrames });

      /* ---- write the LUTs and masks the graph refers to ---- */

      const basePath = join(workDir, 'base.cube');
      await writeFile(basePath, request.cube, 'utf8');

      const windowFiles: Array<{ cube: string; mask: string }> = [];
      for (let i = 0; i < request.windows.length; i++) {
        const layer = request.windows[i];
        const cubePath = join(workDir, `window-${i}.cube`);
        const maskPath = join(workDir, `mask-${i}.pgm`);
        await writeFile(cubePath, layer.cube, 'utf8');
        await writeFile(maskPath, encodePgm(layer.mask, layer.maskWidth, layer.maskHeight));
        windowFiles.push({ cube: cubePath, mask: maskPath });
      }

      const plan = buildCommand(
        request,
        { width: info.width, height: info.height, fps: info.fps, durationSeconds: info.durationSeconds },
        { baseCube: basePath, windows: windowFiles },
      );

      emit({
        stage: 'encoding',
        message: `Encoding with ${request.encoder}…`,
        totalFrames,
        log: [`ffmpeg ${plan.args.join(' ')}`],
      });

      const { promise, kill } = runFfmpeg(system.ffmpegPath!, plan.args, {
        signal: controller.signal,
        onStderr: (chunk) => {
          const stats = parseProgress(chunk);
          if (!stats) return;
          emit({
            stage: 'encoding',
            framesDone: stats.frame ?? 0,
            totalFrames,
            fps: stats.fps,
            speed: stats.speed,
            progress: totalFrames > 0 && stats.frame ? Math.min(1, stats.frame / totalFrames) : null,
          });
        },
      });

      jobs.set(jobId, { id: jobId, cancel: kill, workDir });

      const { code, stderr } = await promise;

      if (controller.signal.aborted) {
        emit({ stage: 'cancelled', message: 'Export cancelled.', totalFrames });
      } else if (code === 0) {
        emit({
          stage: 'done',
          progress: 1,
          framesDone: totalFrames,
          totalFrames,
          message: `Wrote ${request.outputPath}`,
        });
      } else {
        emit({
          stage: 'failed',
          totalFrames,
          message: explainFailure(stderr, request),
          log: stderr.slice(-25),
        });
      }
    } catch (error) {
      emit({
        stage: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      jobs.delete(jobId);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return jobId;
}

export function cancelExport(jobId: string): void {
  jobs.get(jobId)?.cancel();
}

/* ------------------------------------------------------------------ */
/* Filter graph                                                        */
/* ------------------------------------------------------------------ */

interface CommandPlan {
  args: string[];
  filterGraph: string;
}

/**
 * Paths to the temporary files the graph refers to.
 *
 * Passed separately from the request, which carries the cube *contents*.
 * Conflating the two is easy to do and produces a filter graph with a
 * multi-megabyte LUT pasted where a filename should be — so they are
 * different types, in different arguments.
 */
export interface ResolvedFiles {
  baseCube: string;
  windows: Array<{ cube: string; mask: string }>;
}

export function buildCommand(
  request: ExportRequest,
  info: { width: number; height: number; fps: number; durationSeconds?: number },
  files: ResolvedFiles,
): CommandPlan {
  const args: string[] = ['-hide_banner', '-loglevel', 'info', '-y'];

  if (request.startSeconds !== null) {
    args.push('-ss', request.startSeconds.toFixed(3));
  }
  args.push('-i', request.inputPath);
  if (request.durationSeconds !== null) {
    args.push('-t', request.durationSeconds.toFixed(3));
  }

  // Mask images are stills, looped to cover the clip.
  //
  // The loop has to be bounded. maskedmerge does not expose framesync
  // options, so it cannot be told to stop when the footage ends, and an
  // unbounded '-loop 1' makes it pull mask frames forever — the render never
  // finishes and quietly fills the disk. Giving the mask input its own '-t'
  // ends the stream on its own terms; '-shortest' then trims the output back
  // to the length of the actual footage.
  const maskSeconds = (request.durationSeconds ?? info.durationSeconds ?? 0) + 2;
  for (const window of files.windows) {
    args.push('-loop', '1', '-t', maskSeconds.toFixed(3), '-i', window.mask);
  }

  const graph = buildFilterGraph(request, info, files);
  args.push('-filter_complex', graph, '-map', '[out]');

  if (request.includeAudio) {
    // '?' makes the mapping optional, so a clip with no audio track does not
    // fail the whole render.
    args.push('-map', '0:a?', '-c:a', 'copy');
  } else {
    args.push('-an');
  }

  if (files.windows.length > 0) {
    // Power window masks are still images fed through '-loop 1', which never
    // ends. Without this the render never terminates: the footage finishes
    // and FFmpeg keeps encoding the looping mask until the disk fills.
    args.push('-shortest');
  }

  args.push(...encoderArgs(request));

  args.push(
    '-pix_fmt', outputPixelFormat(request),
    // Tag the output properly. An untagged 10-bit file is played back by
    // most software as if it were Rec.709 8-bit, which shifts everything.
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-movflags', '+faststart',
  );

  if (isHevc(request.encoder)) {
    // The hvc1 tag is what makes an H.265 MP4 play in QuickTime and Finder;
    // without it the file is technically valid and practically unopenable on
    // a Mac. It is specific to HEVC, though — muxing it onto anything else
    // is rejected outright, so it is applied only where it belongs.
    args.push('-tag:v', 'hvc1');
  }

  args.push(request.outputPath);

  return { args, filterGraph: graph };
}

function buildFilterGraph(
  request: ExportRequest,
  info: { width: number; height: number },
  files: ResolvedFiles,
): string {
  const parts: string[] = [];
  // Work in 10-bit planar RGB throughout: applying a 3D LUT in a subsampled
  // YUV space quantises the chroma twice and bands smooth gradients.
  let current = 'v0';

  parts.push(`[0:v]format=gbrp10le,setsar=1[${current}]`);

  /* --- the base grade --- */
  parts.push(`[${current}]lut3d=file='${escapePath(files.baseCube)}':interp=tetrahedral[graded]`);
  current = 'graded';

  /* --- power windows --- */
  files.windows.forEach((window, index) => {
    const inputIndex = index + 1;
    const windowed = `win${index}`;
    const masked = `masked${index}`;
    const mask = `mk${index}`;

    // The window's own cube, applied to the whole frame...
    parts.push(
      `[${current}]split=2[${current}a][${current}b]`,
      `[${current}b]lut3d=file='${escapePath(window.cube)}':interp=tetrahedral[${windowed}]`,
      // ...then blended back through the mask, which carries the shape.
      `[${inputIndex}:v]format=gbrp10le,scale=${info.width}:${info.height}[${mask}]`,
      `[${current}a][${windowed}][${mask}]maskedmerge[${masked}]`,
    );
    current = masked;
  });

  /* --- halation --- */
  if (request.halation) {
    const h = request.halation;
    const sigma = Math.max(0.5, (h.radius * info.height) / 1080);
    // Threshold in luma, blur, tint, then screen-blend back over the image.
    // Highlights are isolated with lutrgb rather than geq: geq's lum() only
    // exists on YUV input and this stage is RGB, and lutrgb is a lookup
    // table that knows its own bit depth through maxval rather than a
    // per-pixel expression with a hardcoded 255 in it.
    const keep = `if(gt(val,${h.threshold.toFixed(4)}*maxval),val,0)`;
    parts.push(
      `[${current}]split=2[hbase][hsrc]`,
      `[hsrc]lutrgb=r='${keep}':g='${keep}':b='${keep}',` +
        `gblur=sigma=${sigma.toFixed(2)},` +
        `colorchannelmixer=` +
        `rr=${(h.tint[0] * h.strength).toFixed(4)}:gg=${(h.tint[1] * h.strength).toFixed(4)}:` +
        `bb=${(h.tint[2] * h.strength).toFixed(4)}[halo]`,
      `[hbase][halo]blend=all_mode=screen:shortest=1[haloed]`,
    );
    current = 'haloed';
  }

  /* --- grain --- */
  if (request.grain) {
    const strength = Math.round(Math.min(100, Math.max(1, request.grain.amount * 60)));
    // 't' makes the pattern move frame to frame; without it the grain sticks
    // to the screen instead of sitting in the image.
    const flags = request.grain.chroma > 0.15 ? 't+u' : 't+u+a';
    parts.push(`[${current}]noise=alls=${strength}:allf=${flags}[grained]`);
    current = 'grained';
  }

  parts.push(`[${current}]format=${outputPixelFormat(request)}[out]`);

  return parts.join(';');
}

function encoderArgs(request: ExportRequest): string[] {
  const bitrate = `${Math.round(Math.min(300, Math.max(1, request.bitrateMbps)) * 1000)}k`;
  const args = ['-c:v', request.encoder];

  switch (request.encoder) {
    case 'hevc_nvenc':
      args.push(
        '-preset', 'p6',
        // Higher quality tuning; 'hq' costs a little speed for a real gain
        // in a masters-only workflow.
        '-tune', 'hq',
        '-rc', request.useConstantQuality ? 'vbr' : 'cbr',
        '-profile:v', request.bitDepth === 10 ? 'main10' : 'main',
      );
      if (request.useConstantQuality) {
        args.push('-cq', String(request.quality), '-b:v', '0');
      } else {
        args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', `${parseInt(bitrate) * 2}k`);
      }
      break;

    case 'hevc_qsv':
      args.push('-preset', 'slower', '-profile:v', request.bitDepth === 10 ? 'main10' : 'main');
      if (request.useConstantQuality) args.push('-global_quality', String(request.quality));
      else args.push('-b:v', bitrate, '-maxrate', bitrate);
      break;

    case 'hevc_amf':
      args.push('-quality', 'quality', '-profile:v', request.bitDepth === 10 ? 'main10' : 'main');
      if (request.useConstantQuality) args.push('-qp_i', String(request.quality), '-qp_p', String(request.quality));
      else args.push('-b:v', bitrate, '-maxrate', bitrate);
      break;

    case 'hevc_videotoolbox':
      args.push('-profile:v', request.bitDepth === 10 ? 'main10' : 'main');
      if (request.useConstantQuality) args.push('-q:v', String(request.quality));
      else args.push('-b:v', bitrate);
      break;

    default:
      // libx265, and anything else, gets the software path.
      args.push('-preset', 'slow');
      if (request.useConstantQuality) args.push('-crf', String(request.quality));
      else args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', `${parseInt(bitrate) * 2}k`);
      if (request.encoder === 'libx265') {
        // x265 writes a wall of statistics to stderr by default, which buries
        // the progress lines the UI parses.
        args.push('-x265-params', 'log-level=error');
      }
      break;
  }

  return args;
}

function isHevc(encoder: string): boolean {
  return encoder.startsWith('hevc') || encoder === 'libx265';
}

function outputPixelFormat(request: ExportRequest): string {
  if (request.bitDepth === 10) {
    return request.chroma === '422' ? 'yuv422p10le' : 'yuv420p10le';
  }
  return request.chroma === '422' ? 'yuv422p' : 'yuv420p';
}

/** FFmpeg filter arguments treat ':' and '\' specially. */
function escapePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/** Portable greymap: the simplest format FFmpeg reads for a single-channel mask. */
function encodePgm(mask: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  return Buffer.concat([header, Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength)]);
}

interface ProgressStats {
  frame: number | null;
  fps: number | null;
  speed: number | null;
}

export function parseProgress(chunk: string): ProgressStats | null {
  if (!chunk.includes('frame=')) return null;
  const frame = /frame=\s*(\d+)/.exec(chunk);
  const fps = /fps=\s*([\d.]+)/.exec(chunk);
  const speed = /speed=\s*([\d.]+)x/.exec(chunk);
  if (!frame && !fps) return null;
  return {
    frame: frame ? Number(frame[1]) : null,
    fps: fps ? Number(fps[1]) : null,
    speed: speed ? Number(speed[1]) : null,
  };
}

/**
 * Turn FFmpeg's failure into something actionable.
 *
 * The raw stderr is kept alongside, but the common failures have known
 * causes and telling someone "your GPU has no free encode session" beats
 * handing them forty lines of libavcodec output.
 */
export function explainFailure(stderr: string[], request: ExportRequest): string {
  const text = stderr.join('\n');

  if (/No space left on device/i.test(text)) {
    return 'The drive ran out of space partway through the render.';
  }
  if (/OpenEncodeSessionEx failed|out of memory|no free encoding sessions/i.test(text)) {
    return (
      `${request.encoder} could not start an encoding session. Consumer NVIDIA cards allow a ` +
      'limited number at once — close other apps that are encoding, or switch to the software ' +
      'encoder.'
    );
  }
  if (/Permission denied|Error opening output/i.test(text)) {
    return `Could not write to ${request.outputPath}. Check the folder exists and is writable.`;
  }
  if (/Unknown encoder|Encoder .* not found/i.test(text)) {
    return `This FFmpeg build does not have ${request.encoder}. Pick a different encoder.`;
  }
  if (/Invalid data found|could not find codec parameters/i.test(text)) {
    return 'FFmpeg could not read the source file. It may be corrupt or an unsupported variant.';
  }
  if (/Impossible to convert between/i.test(text)) {
    return (
      'The encoder rejected the pixel format. 4:2:2 needs an encoder that supports it — ' +
      'try 4:2:0, or the software encoder.'
    );
  }

  const lastError = stderr.filter((l) => /error|failed|invalid/i.test(l)).slice(-1)[0];
  return lastError ? `Render failed: ${lastError}` : 'The render failed. See the log below.';
}
