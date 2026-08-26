/**
 * CPU mirror of the shader's qualifier.
 *
 * Hit-testing a click needs to know which zone already covers a colour, and
 * that answer has to agree with what the GPU is drawing — otherwise clicking
 * a shirt you already graded creates a second, overlapping zone and the two
 * fight. This file and the `ecQualify` function in `zones.frag.ts` are the
 * same maths; change them together.
 */

import type { HslZone, SkinSettings } from '../state/grade.js';
import { linearToOklab, oklabToLch, srgbToLinear, hueDelta } from '../color/space.js';

export interface Lch {
  l: number;
  c: number;
  h: number;
}

/** Display-referred sRGB (0..1) -> Oklab LCh, the space every qualifier uses. */
export function toLch(rgb: [number, number, number]): Lch {
  const lin: [number, number, number] = [
    srgbToLinear(rgb[0]),
    srgbToLinear(rgb[1]),
    srgbToLinear(rgb[2]),
  ];
  const lab = linearToOklab(lin);
  const lch = oklabToLch(lab);
  return { l: lch[0], c: lch[1], h: lch[2] };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function softWindow(v: number, lo: number, hi: number, soft: number): number {
  const s = Math.max(soft, 1e-5);

  // The lower feather is clamped at zero because chroma and lightness both
  // bottom out there. Letting it run negative gives a neutral pixel — which
  // has no hue at all — a partial weight in a hue selection, and every grey
  // in the frame picks up the tint you meant for one colour.
  const lo0 = Math.max(lo - s, 0);
  const rise = lo <= lo0 ? (v >= lo0 ? 1 : 0) : smoothstep(lo0, lo, v);

  return rise * (1 - smoothstep(hi, hi + s, v));
}

export function softBand(distance: number, width: number, soft: number): number {
  const s = Math.max(soft, 1e-5);
  return 1 - smoothstep(width, width + s, distance);
}

export function qualify(
  lch: Lch,
  hue: number,
  hueWidth: number,
  hueSoftness: number,
  chromaLow: number,
  chromaHigh: number,
  chromaSoftness: number,
  lumaLow: number,
  lumaHigh: number,
  lumaSoftness: number,
): number {
  const hw = softBand(Math.abs(hueDelta(lch.h, hue)), hueWidth, hueSoftness);
  if (hw <= 0) return 0;
  const cw = softWindow(lch.c, chromaLow, chromaHigh, chromaSoftness);
  if (cw <= 0) return 0;
  const lw = softWindow(lch.l, lumaLow, lumaHigh, lumaSoftness);
  return hw * cw * lw;
}

export function zoneWeight(zone: HslZone, lch: Lch): number {
  if (!zone.enabled) return 0;
  return (
    qualify(
      lch,
      zone.hue,
      zone.hueWidth,
      zone.hueSoftness,
      zone.chromaLow,
      zone.chromaHigh,
      zone.chromaSoftness,
      zone.lumaLow,
      zone.lumaHigh,
      zone.lumaSoftness,
    ) * zone.strength
  );
}

export function skinWeight(skin: SkinSettings, lch: Lch): number {
  if (!skin.enabled) return 0;
  return (
    qualify(
      lch,
      skin.hue,
      skin.hueWidth,
      skin.hueSoftness,
      skin.chromaLow,
      skin.chromaHigh,
      0.03,
      skin.lumaLow,
      skin.lumaHigh,
      0.18,
    ) * skin.strength
  );
}
