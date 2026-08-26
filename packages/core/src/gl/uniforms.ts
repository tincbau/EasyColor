/**
 * Packing of the grade document into shader uniform arrays.
 *
 * Kept apart from the pipeline so the LUT baker and the live renderer feed
 * their programs from exactly the same code — a divergence here would mean
 * an exported LUT that doesn't match what the viewer showed, which is the
 * one bug in a colour tool nobody forgives.
 */

import type { GradeState, HslZone, PowerWindow, SkinSettings } from '../state/grade.js';
import { MAX_HSL_ZONES, MAX_POWER_WINDOWS } from '../state/grade.js';
import { getStock } from '../film/stocks.js';
import { NATIVE_GAMUT, IDENTITY_MAT, mat3ToColumnMajor, displayRenderIndex } from '../color/gamut.js';
import { logTransformIndex } from '../color/log.js';
import { bakeCurveTexture } from '../curves/spline.js';
import { isDefaultCurve } from '../curves/spline.js';

export interface PackedZones {
  count: number;
  z0: Float32Array;
  z1: Float32Array;
  z2: Float32Array;
  z3: Float32Array;
  flags: Int32Array;
  anySolo: boolean;
  /** Index of the zone whose matte the overlay should show, or -1. */
  matteIndex: number;
}

export function packZones(zones: HslZone[], matteZoneId: string | null): PackedZones {
  const count = Math.min(zones.length, MAX_HSL_ZONES);
  const z0 = new Float32Array(MAX_HSL_ZONES * 4);
  const z1 = new Float32Array(MAX_HSL_ZONES * 4);
  const z2 = new Float32Array(MAX_HSL_ZONES * 4);
  const z3 = new Float32Array(MAX_HSL_ZONES * 4);
  const flags = new Int32Array(MAX_HSL_ZONES);

  let anySolo = false;
  let matteIndex = -1;

  for (let i = 0; i < count; i++) {
    const z = zones[i];
    const o = i * 4;

    z0[o + 0] = z.hue;
    z0[o + 1] = z.hueWidth;
    z0[o + 2] = z.hueSoftness;
    z0[o + 3] = z.strength;

    z1[o + 0] = z.chromaLow;
    z1[o + 1] = z.chromaHigh;
    z1[o + 2] = z.chromaSoftness;
    z1[o + 3] = 0;

    z2[o + 0] = z.lumaLow;
    z2[o + 1] = z.lumaHigh;
    z2[o + 2] = z.lumaSoftness;
    z2[o + 3] = z.hueShift;

    z3[o + 0] = z.satGain;
    z3[o + 1] = z.lumGain;
    z3[o + 2] = z.labOffsetA;
    z3[o + 3] = z.labOffsetB;

    flags[i] = (z.enabled ? 1 : 0) | (z.solo ? 2 : 0);
    if (z.solo) anySolo = true;
    if (z.id === matteZoneId) matteIndex = i;
  }

  return { count, z0, z1, z2, z3, flags, anySolo, matteIndex };
}

export interface PackedWindows {
  count: number;
  w0: Float32Array;
  w1: Float32Array;
  w2: Float32Array;
  w3: Float32Array;
  flags: Int32Array;
  matteIndex: number;
}

const SHAPE_CODE: Record<PowerWindow['shape'], number> = {
  ellipse: 0,
  rect: 1,
  vignette: 2,
};

export function packWindows(windows: PowerWindow[], matteWindowId: string | null): PackedWindows {
  const count = Math.min(windows.length, MAX_POWER_WINDOWS);
  const w0 = new Float32Array(MAX_POWER_WINDOWS * 4);
  const w1 = new Float32Array(MAX_POWER_WINDOWS * 4);
  const w2 = new Float32Array(MAX_POWER_WINDOWS * 4);
  const w3 = new Float32Array(MAX_POWER_WINDOWS * 4);
  const flags = new Int32Array(MAX_POWER_WINDOWS);
  let matteIndex = -1;

  for (let i = 0; i < count; i++) {
    const w = windows[i];
    const o = i * 4;

    w0[o + 0] = w.cx;
    w0[o + 1] = w.cy;
    w0[o + 2] = w.rx;
    w0[o + 3] = w.ry;

    w1[o + 0] = w.rotation;
    w1[o + 1] = w.softness;
    w1[o + 2] = w.corner;
    w1[o + 3] = w.opacity;

    w2[o + 0] = w.exposure;
    w2[o + 1] = w.contrast;
    w2[o + 2] = w.saturation;
    w2[o + 3] = 0;

    w3[o + 0] = w.temperature;
    w3[o + 1] = w.tint;

    flags[i] = (w.enabled ? 1 : 0) | (w.invert ? 2 : 0) | (SHAPE_CODE[w.shape] << 2);
    if (w.id === matteWindowId) matteIndex = i;
  }

  return { count, w0, w1, w2, w3, flags, matteIndex };
}

export interface PackedSkin {
  active: boolean;
  s0: [number, number, number, number];
  s1: [number, number, number, number];
  s2: [number, number, number, number];
}

export function packSkin(skin: SkinSettings): PackedSkin {
  return {
    active: skin.enabled,
    s0: [skin.hue, skin.hueWidth, skin.hueSoftness, skin.strength],
    s1: [skin.chromaLow, skin.chromaHigh, skin.lumaLow, skin.lumaHigh],
    s2: [skin.hueShift, skin.satGain, skin.lumGain, skin.smoothing],
  };
}

export interface PackedSource {
  logMode: number;
  gamut: Float32Array;
  applyGamut: boolean;
  displayMode: number;
}

export function packSource(g: GradeState): PackedSource {
  const mat = g.source.applyGamut ? NATIVE_GAMUT[g.source.logTransform] : IDENTITY_MAT;
  return {
    logMode: logTransformIndex(g.source.logTransform),
    gamut: mat3ToColumnMajor(mat),
    // The identity matrix costs a matrix multiply for nothing, so skip it.
    applyGamut: g.source.applyGamut && g.source.logTransform !== 'none',
    displayMode: displayRenderIndex(g.source.displayRender),
  };
}

export interface PackedFilm {
  active: boolean;
  matrix: Float32Array;
  curves: Uint8Array;
  intensity: number;
  saturation: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** Stock density scaled by intensity, plus the user's own density. */
  density: number;
}

export function packFilm(g: GradeState): PackedFilm {
  const stock = getStock(g.film.stock);
  const active = g.film.stock !== 'none' && g.film.stockIntensity > 0;
  const intensity = active ? g.film.stockIntensity : 0;

  return {
    active,
    matrix: mat3ToColumnMajor(stock.matrix),
    curves: bakeCurveTexture(stock.curves),
    intensity,
    saturation: stock.saturation,
    shadowTint: stock.shadowTint,
    highlightTint: stock.highlightTint,
    density: Math.min(1.5, g.film.density + stock.density * intensity),
  };
}

export function curvesAreActive(g: GradeState): boolean {
  return !(
    isDefaultCurve(g.curves.master) &&
    isDefaultCurve(g.curves.red) &&
    isDefaultCurve(g.curves.green) &&
    isDefaultCurve(g.curves.blue)
  );
}

export function packCurves(g: GradeState): Uint8Array {
  return bakeCurveTexture(g.curves);
}

/** Which matte the overlay pass should draw, matching the shader's enum. */
export function matteMode(g: GradeState): number {
  switch (g.viewer.overlay) {
    case 'skinIsolation':
      return 1;
    case 'zoneMatte':
      return g.viewer.overlayZoneId ? 2 : 4;
    case 'windowMatte':
      return 3;
    default:
      return 0;
  }
}
