/**
 * Skin tone analysis.
 *
 * The 123 degree line on a vectorscope is where human skin sits — every
 * ethnicity, every lighting condition. Only the distance along the line
 * changes. So "correct the skin" reduces to "rotate the skin cluster onto
 * the line", and that is a solvable number rather than a matter of taste.
 *
 * The rotation is solved numerically rather than guessed. An Oklab hue
 * rotation and a vectorscope angle are related but not equal — rotating
 * Oklab hue by 5 degrees does not move the vectorscope angle by exactly 5 —
 * so applying the raw angular error as a hue shift lands close but not on
 * the line. Bisection gets it right in a dozen iterations, which is free.
 */

import type { SkinSettings } from '../state/grade.js';
import type { FramePixels } from '../scopes/compute.js';
import {
  SKIN_TONE_LINE_DEG,
  hueDelta,
  lchToOklab,
  linearToOklab,
  linearToSrgb,
  oklabToLch,
  oklabToLinear,
  srgbToLinear,
  vectorscopeAngle,
  vectorscopeSaturation,
} from '../color/space.js';
import { skinWeight, toLch } from '../interaction/qualifier.js';

export interface SkinSample {
  rgb: [number, number, number];
  /** Qualifier weight, used to weight the mean toward confident pixels. */
  weight: number;
}

export interface SkinAnalysis {
  samples: SkinSample[];
  /** Fraction of the frame the qualifier selected, 0..1. */
  coverage: number;
  /** Current weighted mean vectorscope angle, degrees. */
  meanAngle: number;
  meanSaturation: number;
  /** Signed error against the 123 degree line, degrees. */
  angleError: number;
}

/**
 * Collect skin pixels from a graded frame.
 *
 * `stride` skips pixels — at 480x270 a stride of 2 still yields thousands of
 * samples, which is far more than the mean needs, and keeps the analysis
 * comfortably inside a frame budget.
 */
export function analyzeSkin(
  frame: FramePixels,
  skin: SkinSettings,
  stride = 2,
): SkinAnalysis {
  const samples: SkinSample[] = [];
  const { data, width, height } = frame;

  // Qualify with the panel's settings even when the panel is switched off,
  // so the diagnostic works before you commit to enabling it.
  const probe: SkinSettings = { ...skin, enabled: true, strength: 1 };

  let considered = 0;
  let selected = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      considered++;
      const i = (y * width + x) * 4;
      const rgb: [number, number, number] = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];

      const w = skinWeight(probe, toLch(rgb));
      if (w <= 0.05) continue;

      selected++;
      samples.push({ rgb, weight: w });
    }
  }

  const { angle, saturation } = weightedMeanVectorscope(samples);

  return {
    samples,
    coverage: considered === 0 ? 0 : selected / considered,
    meanAngle: angle,
    meanSaturation: saturation,
    angleError: hueDelta(angle, SKIN_TONE_LINE_DEG),
  };
}

/**
 * Weighted mean position of samples on the vectorscope, returned as an angle.
 *
 * Averaging the angles directly would be wrong — the mean of 350 and 10
 * degrees is 0, not 180 — so the vector positions are averaged instead and
 * the angle is taken at the end.
 */
export function weightedMeanVectorscope(
  samples: SkinSample[],
): { angle: number; saturation: number } {
  let sx = 0;
  let sy = 0;
  let sw = 0;

  for (const s of samples) {
    const angle = (vectorscopeAngle(s.rgb) * Math.PI) / 180;
    const sat = vectorscopeSaturation(s.rgb);
    sx += Math.cos(angle) * sat * s.weight;
    sy += Math.sin(angle) * sat * s.weight;
    sw += s.weight;
  }

  if (sw === 0 || (sx === 0 && sy === 0)) {
    return { angle: SKIN_TONE_LINE_DEG, saturation: 0 };
  }

  let angle = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { angle, saturation: Math.hypot(sx, sy) / sw };
}

/** Apply an Oklab hue rotation to a display-referred colour. */
export function rotateHue(
  rgb: [number, number, number],
  degrees: number,
): [number, number, number] {
  const lin: [number, number, number] = [
    srgbToLinear(rgb[0]),
    srgbToLinear(rgb[1]),
    srgbToLinear(rgb[2]),
  ];
  const lch = oklabToLch(linearToOklab(lin));
  lch[2] = (lch[2] + degrees + 360) % 360;
  const out = oklabToLinear(lchToOklab(lch));
  return [linearToSrgb(out[0]), linearToSrgb(out[1]), linearToSrgb(out[2])];
}

/**
 * Solve for the Oklab hue shift that puts the skin cluster on the 123 line.
 *
 * Bisection rather than Newton: the objective is cheap, the bracket is known
 * (nothing sane needs more than +/-60 degrees), and bisection cannot diverge
 * on the near-neutral samples where the angle gets noisy.
 */
export function solveSkinHueShift(
  samples: SkinSample[],
  targetAngle = SKIN_TONE_LINE_DEG,
  bracket = 60,
  iterations = 24,
): number {
  if (samples.length === 0) return 0;

  const error = (shift: number): number => {
    const rotated = samples.map((s) => ({ rgb: rotateHue(s.rgb, shift), weight: s.weight }));
    return hueDelta(weightedMeanVectorscope(rotated).angle, targetAngle);
  };

  let lo = -bracket;
  let hi = bracket;
  let eLo = error(lo);
  let eHi = error(hi);

  // If the root isn't bracketed the cluster is too weak or too wide to align
  // meaningfully; returning 0 leaves the image alone rather than lurching.
  if (eLo === 0) return lo;
  if (eHi === 0) return hi;
  if (Math.sign(eLo) === Math.sign(eHi)) return 0;

  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const eMid = error(mid);
    if (eMid === 0) return mid;
    if (Math.sign(eMid) === Math.sign(eLo)) {
      lo = mid;
      eLo = eMid;
    } else {
      hi = mid;
      eHi = eMid;
    }
  }

  return (lo + hi) / 2;
}

/**
 * Build a skin qualifier from a clicked pixel.
 *
 * Widths are deliberately generous: skin across a lit face spans a good
 * range of both lightness and chroma, and a tight qualifier picked from one
 * pixel of a cheek would drop the shadow side of the same face.
 */
export function qualifierFromSample(
  rgb: [number, number, number],
  current: SkinSettings,
): SkinSettings {
  const lch = toLch(rgb);
  return {
    ...current,
    hue: lch.h,
    hueWidth: 16,
    hueSoftness: 20,
    chromaLow: Math.max(0.006, lch.c * 0.2),
    chromaHigh: Math.max(0.12, lch.c * 2.4),
    lumaLow: Math.max(0, lch.l - 0.4),
    lumaHigh: Math.min(1.3, lch.l + 0.4),
  };
}

/** A short, honest read on how usable the current selection is. */
export function describeSelection(analysis: SkinAnalysis): string {
  if (analysis.samples.length < 40) {
    return 'Not enough skin selected to measure. Click a face to set the qualifier.';
  }
  if (analysis.coverage > 0.6) {
    return `Selecting ${Math.round(analysis.coverage * 100)}% of the frame — that is more than skin. Narrow the hue or chroma range.`;
  }
  const err = analysis.angleError;
  if (Math.abs(err) < 1.5) return 'Skin is on the 123° line.';
  return `Skin sits ${Math.abs(err).toFixed(1)}° ${err > 0 ? 'counter-clockwise of' : 'clockwise of'} the line.`;
}
