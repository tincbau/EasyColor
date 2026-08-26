/**
 * Scope computation from a downscaled RGBA8 frame.
 *
 * All four scopes are built in a single pass over the pixels where possible,
 * because at 480x270 the per-pixel loop is the whole cost and iterating four
 * times would show up as a dropped frame on every scope refresh.
 *
 * Counts are returned raw. Display gain belongs to the renderer, so the same
 * data can be drawn logarithmically in one panel and linearly in another.
 */

import { LUMA_709, SKIN_TONE_LINE_DEG } from '../color/space.js';

export interface WaveformResult {
  /** width * levels counts, column-major: index = x * levels + level. */
  data: Uint32Array;
  width: number;
  levels: number;
  peak: number;
}

export interface ParadeResult {
  red: WaveformResult;
  green: WaveformResult;
  blue: WaveformResult;
}

export interface HistogramResult {
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  luma: Uint32Array;
  bins: number;
  peak: number;
}

export interface VectorscopeResult {
  /** size * size accumulation grid, row-major, origin at the centre. */
  data: Uint32Array;
  size: number;
  peak: number;
  /** Mean angle of pixels with meaningful chroma, in vectorscope degrees. */
  meanAngle: number;
  meanSaturation: number;
}

export interface FramePixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

const LEVELS = 256;

/** Luma waveform. `outWidth` is usually the panel width in CSS pixels. */
export function computeWaveform(frame: FramePixels, outWidth = 256): WaveformResult {
  const { data, width, height } = frame;
  const w = Math.max(1, Math.min(outWidth, width));
  const out = new Uint32Array(w * LEVELS);
  let peak = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * 4;
      const luma =
        data[i] * LUMA_709[0] + data[i + 1] * LUMA_709[1] + data[i + 2] * LUMA_709[2];
      // Rounded, not truncated. The Rec.709 coefficients sum to 1 only in
      // exact arithmetic, so truncation puts pure white at level 254 and the
      // waveform never quite reaches 100 IRE on a legitimately clipped frame.
      const level = luma < 0 ? 0 : luma >= 255 ? 255 : Math.round(luma);
      const col = ((x * w) / width) | 0;
      const idx = col * LEVELS + level;
      const v = ++out[idx];
      if (v > peak) peak = v;
    }
  }

  return { data: out, width: w, levels: LEVELS, peak };
}

/** RGB parade: three waveforms, one per channel. */
export function computeParade(frame: FramePixels, outWidth = 256): ParadeResult {
  const { data, width, height } = frame;
  const w = Math.max(1, Math.min(outWidth, width));

  const red = new Uint32Array(w * LEVELS);
  const green = new Uint32Array(w * LEVELS);
  const blue = new Uint32Array(w * LEVELS);
  let peakR = 0;
  let peakG = 0;
  let peakB = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * 4;
      const col = ((x * w) / width) | 0;
      const base = col * LEVELS;

      const vr = ++red[base + data[i]];
      const vg = ++green[base + data[i + 1]];
      const vb = ++blue[base + data[i + 2]];
      if (vr > peakR) peakR = vr;
      if (vg > peakG) peakG = vg;
      if (vb > peakB) peakB = vb;
    }
  }

  return {
    red: { data: red, width: w, levels: LEVELS, peak: peakR },
    green: { data: green, width: w, levels: LEVELS, peak: peakG },
    blue: { data: blue, width: w, levels: LEVELS, peak: peakB },
  };
}

export function computeHistogram(frame: FramePixels): HistogramResult {
  const { data, width, height } = frame;
  const red = new Uint32Array(LEVELS);
  const green = new Uint32Array(LEVELS);
  const blue = new Uint32Array(LEVELS);
  const luma = new Uint32Array(LEVELS);

  const n = width * height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    red[r]++;
    green[g]++;
    blue[b]++;
    const y = r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2];
    luma[y < 0 ? 0 : y >= 255 ? 255 : Math.round(y)]++;
  }

  let peak = 0;
  for (let i = 0; i < LEVELS; i++) {
    // The 0 and 255 bins pile up on any letterboxed or clipped frame and
    // would flatten everything else if they set the scale.
    if (i === 0 || i === LEVELS - 1) continue;
    if (red[i] > peak) peak = red[i];
    if (green[i] > peak) peak = green[i];
    if (blue[i] > peak) peak = blue[i];
  }

  return { red, green, blue, luma, bins: LEVELS, peak: Math.max(peak, 1) };
}

/**
 * Vectorscope.
 *
 * Coordinates match a hardware scope: +Cb right, +Cr up, so the skin tone
 * line sits at 123 degrees and the colour bar targets land where a
 * colourist expects them.
 */
export function computeVectorscope(frame: FramePixels, size = 256): VectorscopeResult {
  const { data, width, height } = frame;
  const out = new Uint32Array(size * size);
  const half = size / 2;
  let peak = 0;

  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;

  const n = width * height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const y = r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2];
    const cb = (b - y) / 1.8556;
    const cr = (r - y) / 1.5748;

    // Scale so 100% colour bars land near the outer graticule ring.
    const px = half + cb * size * 0.9;
    const py = half - cr * size * 0.9;

    const xi = px | 0;
    const yi = py | 0;
    if (xi >= 0 && xi < size && yi >= 0 && yi < size) {
      const v = ++out[yi * size + xi];
      if (v > peak) peak = v;
    }

    // Near-neutral pixels have an essentially random angle, so letting them
    // into the mean would drag it toward whatever noise happens to dominate.
    const sat = Math.hypot(cb, cr);
    if (sat > 0.02) {
      sumX += cb;
      sumY += cr;
      sumWeight += sat;
    }
  }

  let meanAngle = SKIN_TONE_LINE_DEG;
  let meanSaturation = 0;
  if (sumWeight > 0) {
    meanAngle = (Math.atan2(sumY, sumX) * 180) / Math.PI;
    if (meanAngle < 0) meanAngle += 360;
    meanSaturation = Math.hypot(sumX, sumY) / Math.max(1, sumWeight);
  }

  return { data: out, size, peak: Math.max(peak, 1), meanAngle, meanSaturation };
}

/**
 * Everything the scopes panel needs, from one frame grab.
 * Skipping a scope that isn't on screen is the caller's job — pass only the
 * ones being drawn.
 */
export interface ScopeRequest {
  waveform?: number;
  parade?: number;
  histogram?: boolean;
  vectorscope?: number;
}

export interface ScopeBundle {
  waveform?: WaveformResult;
  parade?: ParadeResult;
  histogram?: HistogramResult;
  vectorscope?: VectorscopeResult;
}

export function computeScopes(frame: FramePixels, request: ScopeRequest): ScopeBundle {
  const out: ScopeBundle = {};
  if (request.waveform) out.waveform = computeWaveform(frame, request.waveform);
  if (request.parade) out.parade = computeParade(frame, request.parade);
  if (request.histogram) out.histogram = computeHistogram(frame);
  if (request.vectorscope) out.vectorscope = computeVectorscope(frame, request.vectorscope);
  return out;
}

/**
 * Percentile of the luma distribution, 0..1. Used by auto-exposure and by
 * the "drag the waveform" tool to work out which tonal range was grabbed.
 */
export function lumaPercentile(hist: HistogramResult, percentile: number): number {
  let total = 0;
  for (let i = 0; i < hist.bins; i++) total += hist.luma[i];
  if (total === 0) return 0;

  const target = total * Math.min(Math.max(percentile, 0), 1);
  let run = 0;
  for (let i = 0; i < hist.bins; i++) {
    run += hist.luma[i];
    if (run >= target) return i / (hist.bins - 1);
  }
  return 1;
}
