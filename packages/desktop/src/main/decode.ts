/**
 * Native camera decoding.
 *
 * This is the reason the desktop app exists. A browser will decode H.264 and
 * VP9 and nothing else, at 8 bits, after its own colour management has
 * already been applied. Sony XAVC S-I, Canon All-Intra, ProRes and the rest
 * are simply not openable, and the 10-bit 4:2:2 signal they carry is exactly
 * the extra latitude a colourist is grading for.
 *
 * Frames come back as RGBA at 16 bits per channel with no transfer applied,
 * so log stays log and the pipeline's own camera conversion does the work.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { DecodedFrame, MediaInfo } from '@easycolor/core';
import { probeSystem } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  bit_rate?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  has_b_frames?: number;
  tags?: Record<string, string>;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> };
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const system = await probeSystem();
  if (!system.ffprobePath) {
    throw new Error(
      system.problem ??
        'ffprobe was not found, so EasyColor cannot read this file’s format.',
    );
  }

  const { stdout } = await execFileAsync(
    system.ffprobePath,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      path,
    ],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );

  const parsed = JSON.parse(stdout) as FfprobeResult;
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('That file has no video stream.');

  const fps = parseRational(video.r_frame_rate) || parseRational(video.avg_frame_rate) || 25;
  const duration =
    Number(video.duration ?? parsed.format?.duration ?? 0) || 0;

  const pixelFormat = video.pix_fmt ?? 'unknown';
  const bitDepth = Number(video.bits_per_raw_sample) || bitDepthFromPixelFormat(pixelFormat);

  return {
    path,
    fileName: basename(path),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    durationSeconds: duration,
    frameCount: Number(video.nb_frames) || Math.round(duration * fps),
    codec: video.codec_name ?? 'unknown',
    codecLongName: video.codec_long_name ?? '',
    pixelFormat,
    bitDepth,
    chromaSubsampling: chromaFromPixelFormat(pixelFormat),
    bitrate: Number(video.bit_rate ?? parsed.format?.bit_rate) || null,
    colorSpace: video.color_space ?? null,
    colorTransfer: video.color_transfer ?? null,
    colorPrimaries: video.color_primaries ?? null,
    // No B-frames at all is the tell for an intra-only stream: XAVC S-I,
    // Canon All-Intra, ProRes, DNxHR.
    allIntra: (video.has_b_frames ?? 0) === 0 && isIntraCodec(video.codec_name ?? ''),
    suggestedLogTransform: guessLogTransform(video, parsed.format?.tags),
  };
}

function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return Number(value) || 0;
  return num / den;
}

function bitDepthFromPixelFormat(pixelFormat: string): number {
  const match = pixelFormat.match(/(\d+)(le|be)$/);
  if (match) return Number(match[1]);
  if (/p10/.test(pixelFormat)) return 10;
  if (/p12/.test(pixelFormat)) return 12;
  return 8;
}

function chromaFromPixelFormat(pixelFormat: string): string {
  if (/444/.test(pixelFormat)) return '4:4:4';
  if (/422/.test(pixelFormat)) return '4:2:2';
  if (/420/.test(pixelFormat)) return '4:2:0';
  if (/^gray/.test(pixelFormat)) return 'monochrome';
  return 'unknown';
}

function isIntraCodec(codec: string): boolean {
  return ['prores', 'dnxhd', 'cfhd', 'jpeg2000', 'mjpeg', 'rawvideo', 'v210'].includes(codec);
}

/**
 * Guess the camera's log curve.
 *
 * Cameras rarely tag it outright, so this leans on what they do tag: the
 * transfer characteristic, and the encoder or make strings in the container.
 * A guess that is wrong is easy to change in one dropdown; no guess at all
 * means every log clip opens looking broken until the user knows to go
 * looking, which is worse.
 */
function guessLogTransform(
  video: FfprobeStream,
  formatTags: Record<string, string> | undefined,
): string | null {
  const haystack = [
    video.tags?.encoder,
    video.tags?.handler_name,
    formatTags?.encoder,
    formatTags?.make,
    formatTags?.model,
    formatTags?.['com.android.manufacturer'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/s-log3|slog3/.test(haystack)) return 'slog3';
  if (/logc4/.test(haystack)) return 'logc4';
  if (/logc|arri/.test(haystack)) return 'logc3';
  if (/v-log|vlog/.test(haystack)) return 'vlog';
  if (/c-?log ?3|canon log 3/.test(haystack)) return 'clog3';
  if (/d-?log|dji/.test(haystack)) return 'djidlog';
  if (/f-?log|fujifilm/.test(haystack)) return 'flog';
  if (/log3g10|red/.test(haystack)) return 'redlog3g10';

  // Sony's XAVC S-I is overwhelmingly shot in S-Log3 when it is being
  // graded at all, which is the situation someone opening EasyColor is in.
  if (video.codec_name === 'hevc' && /sony/.test(haystack)) return 'slog3';

  // Anything tagged as an HDR transfer is definitely not plain Rec.709.
  if (video.color_transfer === 'arib-std-b67') return 'none';

  return null;
}

/**
 * Decode a single frame to 16-bit RGBA.
 *
 * `-ss` before `-i` makes FFmpeg seek by keyframe first, which is orders of
 * magnitude faster than decoding from the start of the file. On intra-only
 * camera formats every frame is a keyframe, so the seek is also exact — and
 * intra-only is precisely what this path exists for.
 */
export async function decodeFrame(
  path: string,
  timeSeconds: number,
  maxWidth: number,
): Promise<DecodedFrame> {
  const system = await probeSystem();
  if (!system.ffmpegPath) {
    throw new Error(system.problem ?? 'FFmpeg was not found.');
  }

  const info = await probeMedia(path);
  const scale = Math.min(1, maxWidth / Math.max(1, info.width));
  // Even dimensions keep the scaler on its fast path and avoid a chroma
  // siting shift on subsampled sources.
  const width = Math.max(2, Math.round((info.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((info.height * scale) / 2) * 2);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', Math.max(0, timeSeconds).toFixed(3),
    '-i', path,
    '-frames:v', '1',
    // Scale in full-range RGB at 16 bits. Doing the conversion here rather
    // than after subsampling keeps the extra chroma resolution of a 4:2:2
    // source, which is the whole point of decoding it natively.
    '-vf', `scale=${width}:${height}:flags=lanczos:in_range=tv:out_range=full`,
    '-pix_fmt', 'rgba64le',
    '-f', 'rawvideo',
    '-',
  ];

  const expectedBytes = width * height * 8;

  return new Promise<DecodedFrame>((resolve, reject) => {
    const child = spawn(system.ffmpegPath!, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let received = 0;
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && received < expectedBytes) {
        reject(
          new Error(
            `FFmpeg could not decode a frame from ${info.fileName}.` +
              (stderr.trim() ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''),
          ),
        );
        return;
      }

      const buffer = Buffer.concat(chunks, Math.max(received, expectedBytes));
      // Copy into a fresh ArrayBuffer: Node pools small Buffers, so handing
      // the underlying buffer straight to the renderer can expose unrelated
      // memory through structured clone.
      const data = new Uint16Array(width * height * 4);
      for (let i = 0; i < data.length; i++) data[i] = buffer.readUInt16LE(i * 2);

      resolve({ data, width, height, timeSeconds });
    });
  });
}
