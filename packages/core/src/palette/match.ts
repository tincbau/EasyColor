/**
 * Reference palette matching.
 *
 * Given a reference still and the current frame, generate a grade that moves
 * the current frame toward the reference's colour character.
 *
 * The approach is two-stage, and the split matters:
 *
 * 1. **Global statistics first.** Match the mean and spread of lightness and
 *    of the two Oklab chroma axes. This is the classic Reinhard colour
 *    transfer, and it does most of the work: exposure, contrast and overall
 *    cast all fall out of it, expressed as controls the user can then adjust
 *    by hand rather than as an opaque LUT.
 *
 * 2. **Per-cluster hue nudges second.** Pair each source swatch with the
 *    reference swatch nearest it in hue, and emit an HSL zone for the pairs
 *    that actually differ. This is what carries a specific look — teal
 *    shadows, warm skin — that a global transfer alone flattens out.
 *
 * The result is a normal, editable grade. Nothing about it is locked, which
 * is the whole point: an auto-match is a starting point, not a verdict.
 */

import type { GradeState, HslZone } from '../state/grade.js';
import { MAX_HSL_ZONES, cloneGrade, createZone, describeHue } from '../state/grade.js';
import type { Swatch } from './kmeans.js';
import { extractPalette } from './kmeans.js';
import type { FramePixels } from '../scopes/compute.js';
import { hueDelta, oklabToLch } from '../color/space.js';

export interface PaletteStats {
  meanL: number;
  meanA: number;
  meanB: number;
  stdL: number;
  stdA: number;
  stdB: number;
}

export function paletteStats(swatches: Swatch[]): PaletteStats {
  if (swatches.length === 0) {
    return { meanL: 0.5, meanA: 0, meanB: 0, stdL: 0.2, stdA: 0.05, stdB: 0.05 };
  }

  let wSum = 0;
  let mL = 0;
  let mA = 0;
  let mB = 0;
  for (const s of swatches) {
    mL += s.lab[0] * s.weight;
    mA += s.lab[1] * s.weight;
    mB += s.lab[2] * s.weight;
    wSum += s.weight;
  }
  mL /= wSum;
  mA /= wSum;
  mB /= wSum;

  let vL = 0;
  let vA = 0;
  let vB = 0;
  for (const s of swatches) {
    vL += (s.lab[0] - mL) ** 2 * s.weight;
    vA += (s.lab[1] - mA) ** 2 * s.weight;
    vB += (s.lab[2] - mB) ** 2 * s.weight;
  }

  return {
    meanL: mL,
    meanA: mA,
    meanB: mB,
    // A floor on the deviations stops a flat, single-colour reference from
    // producing a divide-by-almost-zero and a wildly over-contrasted match.
    stdL: Math.max(Math.sqrt(vL / wSum), 0.02),
    stdA: Math.max(Math.sqrt(vA / wSum), 0.004),
    stdB: Math.max(Math.sqrt(vB / wSum), 0.004),
  };
}

export interface MatchOptions {
  /** 0..1 blend of the generated match against the current grade. */
  strength?: number;
  /** Emit HSL zones for per-colour differences, not just the global match. */
  perColor?: boolean;
  /** Maximum zones the match is allowed to create. */
  maxZones?: number;
  /** Hue differences smaller than this are left alone, in degrees. */
  hueThreshold?: number;
}

export interface MatchResult {
  grade: GradeState;
  sourcePalette: Swatch[];
  referencePalette: Swatch[];
  /** Plain-language summary of what the match did, for the UI. */
  notes: string[];
}

/**
 * Generate a match from a reference frame.
 *
 * `source` should be the *graded* frame, so repeated matching converges
 * rather than fighting the grade already applied.
 */
export function matchToReference(
  grade: GradeState,
  source: FramePixels,
  reference: FramePixels,
  options: MatchOptions = {},
): MatchResult {
  const strength = clamp(options.strength ?? 1, 0, 1);
  const perColor = options.perColor ?? true;
  const maxZones = options.maxZones ?? 4;
  const hueThreshold = options.hueThreshold ?? 6;

  const sourcePalette = extractPalette(source, { count: 6 });
  const referencePalette = extractPalette(reference, { count: 6 });

  const next = cloneGrade(grade);
  const notes: string[] = [];

  if (sourcePalette.length === 0 || referencePalette.length === 0) {
    notes.push('Could not read a palette from one of the images.');
    return { grade: next, sourcePalette, referencePalette, notes };
  }

  /* ---- 1. global statistics ---- */

  const src = paletteStats(sourcePalette);
  const ref = paletteStats(referencePalette);

  // Lightness mean difference reads as exposure; the ratio of spreads reads
  // as contrast. Both are expressed in the units the user's controls use.
  const exposure = clamp(Math.log2(Math.max(ref.meanL, 0.02) / Math.max(src.meanL, 0.02)), -2, 2);
  const contrast = clamp(ref.stdL / src.stdL - 1, -0.6, 0.9);

  // Oklab b is the blue-yellow axis, which is what a temperature control
  // moves; a is green-magenta, which is tint.
  const temperature = clamp((ref.meanB - src.meanB) * 6, -1, 1);
  const tint = clamp((ref.meanA - src.meanA) * 6, -1, 1);

  // Chroma spread against chroma spread gives overall saturation.
  const chromaSrc = Math.hypot(src.stdA, src.stdB);
  const chromaRef = Math.hypot(ref.stdA, ref.stdB);
  const saturation = clamp(chromaRef / Math.max(chromaSrc, 0.004), 0.4, 2.2);

  next.primaries = {
    ...next.primaries,
    exposure: lerp(next.primaries.exposure, next.primaries.exposure + exposure, strength),
    contrast: clamp(lerp(next.primaries.contrast, next.primaries.contrast + contrast, strength), -1, 1),
    temperature: clamp(lerp(next.primaries.temperature, next.primaries.temperature + temperature, strength), -1, 1),
    tint: clamp(lerp(next.primaries.tint, next.primaries.tint + tint, strength), -1, 1),
    saturation: clamp(lerp(next.primaries.saturation, next.primaries.saturation * saturation, strength), 0, 3),
  };

  notes.push(
    `Global match: ${signed(exposure * strength, 2)} stops, ` +
      `contrast ${signed(contrast * strength, 2)}, ` +
      `temperature ${signed(temperature * strength, 2)}, ` +
      `saturation x${(1 + (saturation - 1) * strength).toFixed(2)}.`,
  );

  /* ---- 2. per-colour zones ---- */

  if (perColor) {
    const pairs = pairSwatches(sourcePalette, referencePalette);
    let added = 0;

    for (const pair of pairs) {
      if (added >= maxZones) break;
      if (next.zones.length >= MAX_HSL_ZONES) break;

      const srcLch = oklabToLch(pair.source.lab);
      const refLch = oklabToLch(pair.reference.lab);
      const dHue = hueDelta(refLch[2], srcLch[2]);

      const dSat = refLch[1] / Math.max(srcLch[1], 0.004);
      const significant = Math.abs(dHue) > hueThreshold || Math.abs(dSat - 1) > 0.18;
      if (!significant) continue;

      // Skip a swatch an existing zone already claims, so re-running the
      // match refines the grade instead of piling zones on top of each other.
      if (next.zones.some((z) => Math.abs(hueDelta(z.hue, srcLch[2])) < z.hueWidth)) continue;

      const zone: HslZone = {
        ...createZone(
          `match-${added}-${Date.now().toString(36)}`,
          pair.source.rgb,
          srcLch[2],
          srcLch[1],
          srcLch[0],
        ),
        label: `Match ${describeHue(srcLch[2])}`,
        hueShift: clamp(dHue * strength, -60, 60),
        satGain: clamp(1 + (dSat - 1) * strength, 0.2, 2.5),
        // Generous feathering: a matched zone should read as a shift in the
        // look, not as a stencil someone cut out of the image.
        hueSoftness: 30,
        strength: 0.85,
      };

      next.zones = [...next.zones, zone];
      added++;
    }

    if (added > 0) {
      notes.push(`Added ${added} colour zone${added === 1 ? '' : 's'} for per-hue differences.`);
    } else {
      notes.push('Per-colour differences were small; the global match covers them.');
    }
  }

  return { grade: next, sourcePalette, referencePalette, notes };
}

interface SwatchPair {
  source: Swatch;
  reference: Swatch;
  distance: number;
}

/**
 * Pair source swatches with reference swatches.
 *
 * Greedy nearest-hue matching, heaviest swatches first, each reference used
 * at most once. Optimal assignment would be prettier but the palettes are
 * five or six entries and the greedy answer is the same one in practice.
 */
function pairSwatches(source: Swatch[], reference: Swatch[]): SwatchPair[] {
  const used = new Set<number>();
  const pairs: SwatchPair[] = [];

  for (const s of source) {
    const sLch = oklabToLch(s.lab);
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < reference.length; i++) {
      if (used.has(i)) continue;
      const rLch = oklabToLch(reference[i].lab);
      // Hue dominates, lightness breaks ties: pairing a highlight with a
      // shadow of the same hue would produce a nonsense correction.
      const d = Math.abs(hueDelta(sLch[2], rLch[2])) + Math.abs(sLch[0] - rLch[0]) * 90;
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      used.add(bestIndex);
      pairs.push({ source: s, reference: reference[bestIndex], distance: bestDistance });
    }
  }

  return pairs;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function signed(v: number, digits: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}
