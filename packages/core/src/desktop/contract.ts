/**
 * The contract between the Electron main process and the renderer.
 *
 * It lives in `core`, not in the desktop package, because three separate
 * places need it: the Electron main process that implements it, the preload
 * script that exposes it, and the web UI that detects and calls it. The web
 * UI also ships to browsers where none of this exists, so it cannot depend
 * on the desktop package — putting the types here is what lets one codebase
 * serve both without declaring the same channel twice and eventually
 * declaring it two different ways.
 */

export const CHANNELS = {
  probeSystem: 'easycolor:probe-system',
  openMediaDialog: 'easycolor:open-media-dialog',
  probeMedia: 'easycolor:probe-media',
  decodeFrame: 'easycolor:decode-frame',
  startExport: 'easycolor:start-export',
  cancelExport: 'easycolor:cancel-export',
  exportProgress: 'easycolor:export-progress',
  saveDialog: 'easycolor:save-dialog',
  writeFile: 'easycolor:write-file',
  readTextFile: 'easycolor:read-text-file',
} as const;

/* ------------------------------------------------------------------ */
/* System capabilities                                                 */
/* ------------------------------------------------------------------ */

export interface EncoderInfo {
  id: string;
  label: string;
  /** Hardware encoders are dramatically faster but slightly less efficient. */
  hardware: boolean;
  /** Vendor the hardware belongs to, for the UI's explanation. */
  vendor: 'NVIDIA' | 'Intel' | 'AMD' | 'Apple' | 'Software';
  available: boolean;
  /** Why it isn't available, when it isn't. */
  reason?: string;
}

export interface SystemInfo {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  encoders: EncoderInfo[];
  /** Present when FFmpeg could not be found at all. */
  problem?: string;
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export interface MediaInfo {
  path: string;
  fileName: string;
  width: number;
  height: number;
  /** Frames per second, as a decimal. */
  fps: number;
  durationSeconds: number;
  frameCount: number;
  codec: string;
  codecLongName: string;
  pixelFormat: string;
  bitDepth: number;
  /** "4:2:0", "4:2:2", "4:4:4" or "unknown". */
  chromaSubsampling: string;
  /** Bitrate in bits per second, when the container reports one. */
  bitrate: number | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  /** True when the stream is intra-only, e.g. XAVC S-I or All-Intra. */
  allIntra: boolean;
  /** A camera log curve guessed from the metadata, for a sensible default. */
  suggestedLogTransform: string | null;
}

export interface DecodedFrame {
  /** RGBA, 16 bits per channel, little endian. */
  data: Uint16Array;
  width: number;
  height: number;
  timeSeconds: number;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface ExportWindowLayer {
  /** .cube text for this window's fully-applied correction. */
  cube: string;
  /** 8-bit greyscale mask, one byte per pixel, row-major from the top. */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

export interface ExportRequest {
  inputPath: string;
  outputPath: string;

  /** .cube text for the base per-pixel grade. */
  cube: string;
  windows: ExportWindowLayer[];

  halation: { threshold: number; radius: number; strength: number; tint: [number, number, number] } | null;
  grain: { amount: number; size: number; chroma: number } | null;

  encoder: string;
  /** Megabits per second, 1 to 300. */
  bitrateMbps: number;
  /** 8 or 10. */
  bitDepth: number;
  /** "420" or "422". */
  chroma: '420' | '422';
  /** Constant-quality instead of a target bitrate. */
  useConstantQuality: boolean;
  quality: number;

  /** Optional trim, in seconds. */
  startSeconds: number | null;
  durationSeconds: number | null;

  /** Copy the source audio through untouched. */
  includeAudio: boolean;
}

export interface ExportProgress {
  jobId: string;
  stage: 'preparing' | 'encoding' | 'done' | 'failed' | 'cancelled';
  /** 0..1, or null when FFmpeg has not reported enough to estimate. */
  progress: number | null;
  framesDone: number;
  totalFrames: number;
  fps: number | null;
  /** Encoding speed relative to real time, e.g. 2.4 means 2.4x. */
  speed: number | null;
  outputPath: string;
  message?: string;
  /** The last lines of FFmpeg output, kept for the failure case. */
  log?: string[];
}

export interface DesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  readonly version: string;

  probeSystem(): Promise<SystemInfo>;
  openMediaDialog(): Promise<string | null>;
  probeMedia(path: string): Promise<MediaInfo>;
  decodeFrame(path: string, timeSeconds: number, maxWidth: number): Promise<DecodedFrame>;

  saveDialog(defaultName: string, filters: Array<{ name: string; extensions: string[] }>): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  readTextFile(path: string): Promise<string>;

  startExport(request: ExportRequest): Promise<string>;
  cancelExport(jobId: string): Promise<void>;
  onExportProgress(listener: (progress: ExportProgress) => void): () => void;
}
