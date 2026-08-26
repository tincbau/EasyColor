/**
 * Camera gamut -> Rec.709 matrices, and the scene-linear -> display
 * rendering transforms that finish a log conversion.
 *
 * A log curve alone only fixes the tone response. Without the matching
 * gamut matrix, S-Log3 footage stays visibly under-saturated and green after
 * "conversion" — so every log transform is paired with its native gamut here.
 */

import type { LogTransformId } from './log.js';
import {
  ARRI_WIDE_GAMUT_3,
  ARRI_WIDE_GAMUT_4,
  CANON_CINEMA_GAMUT,
  DJI_D_GAMUT,
  REC709,
  REC2020,
  RED_WIDE_GAMUT,
  S_GAMUT3_CINE,
  V_GAMUT,
  gamutConversion,
} from './colorimetry.js';
import type { Mat3 } from './colorimetry.js';

export type { Mat3 };

export const IDENTITY_MAT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The gamut each camera log curve ships with.
 *
 * Derived from published chromaticities rather than transcribed as nine
 * literals — see `colorimetry.ts` for why. Declared once; both the CPU path
 * and the shader uniform read this table.
 */
export const NATIVE_GAMUT: Record<LogTransformId, Mat3> = {
  none: IDENTITY_MAT,
  slog3: gamutConversion(S_GAMUT3_CINE, REC709),
  logc3: gamutConversion(ARRI_WIDE_GAMUT_3, REC709),
  logc4: gamutConversion(ARRI_WIDE_GAMUT_4, REC709),
  vlog: gamutConversion(V_GAMUT, REC709),
  clog3: gamutConversion(CANON_CINEMA_GAMUT, REC709),
  redlog3g10: gamutConversion(RED_WIDE_GAMUT, REC709),
  djidlog: gamutConversion(DJI_D_GAMUT, REC709),
  // F-Gamut uses Rec.2020 primaries.
  flog: gamutConversion(REC2020, REC709),
};

export function applyMat3(m: Mat3, c: [number, number, number]): [number, number, number] {
  return [
    m[0] * c[0] + m[1] * c[1] + m[2] * c[2],
    m[3] * c[0] + m[4] * c[1] + m[5] * c[2],
    m[6] * c[0] + m[7] * c[1] + m[8] * c[2],
  ];
}

/** Column-major flattening, which is what `uniformMatrix3fv` expects. */
export function mat3ToColumnMajor(m: Mat3): Float32Array {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

/* ------------------------------------------------------------------ */
/* Display rendering transforms                                        */
/* ------------------------------------------------------------------ */

export type DisplayRenderId = 'neutral' | 'filmic' | 'soft';

export interface DisplayRender {
  id: DisplayRenderId;
  label: string;
  hint: string;
  /** scene-linear -> display-linear (still pre-OETF). */
  apply(v: number): number;
  /** GLSL body over `float v`. */
  glsl: string;
}

/** Straight exposure mapping, hard clip at 1.0. Truest to the maths. */
const NEUTRAL: DisplayRender = {
  id: 'neutral',
  label: 'Neutral',
  hint: 'Linear mapping with a hard clip. Most faithful, least forgiving.',
  apply: (v) => Math.min(Math.max(v, 0), 1),
  glsl: `return clamp(v, 0.0, 1.0);`,
};

/**
 * Filmic shoulder in the Hable/Uncharted family, retuned so 0.18 scene grey
 * lands on 0.18 display linear. Rolls highlights instead of clipping them,
 * which is what makes log footage read as "graded" rather than "corrected".
 */
const FILMIC: DisplayRender = {
  id: 'filmic',
  label: 'Filmic',
  hint: 'Highlight shoulder with a gentle toe. The default for log footage.',
  apply: (v) => {
    const f = (x: number) =>
      ((x * (0.15 * x + 0.05 * 0.5) + 0.004 * 0.02) /
        (x * (0.15 * x + 0.5) + 0.004 * 0.3)) -
      0.02 / 0.3;
    const w = f(11.2);
    return Math.min(Math.max(f(v * 2.0) / w, 0), 1);
  },
  glsl: `
    #define EC_HABLE(x) ((((x) * (0.15 * (x) + 0.025) + 0.00008) / ((x) * (0.15 * (x) + 0.5) + 0.0012)) - 0.066666667)
    float w = EC_HABLE(11.2);
    return clamp(EC_HABLE(v * 2.0) / w, 0.0, 1.0);`,
};

/** Reinhard-style shoulder — flatter, useful when you want headroom to grade into. */
const SOFT: DisplayRender = {
  id: 'soft',
  label: 'Soft clip',
  hint: 'Compresses only the top stop. Keeps midtones exactly where they were.',
  apply: (v) => {
    if (v <= 0.8) return Math.max(v, 0);
    const t = v - 0.8;
    return 0.8 + 0.2 * (t / (t + 0.2));
  },
  glsl: `
    if (v <= 0.8) return max(v, 0.0);
    float t = v - 0.8;
    return 0.8 + 0.2 * (t / (t + 0.2));`,
};

export const DISPLAY_RENDERS: DisplayRender[] = [NEUTRAL, FILMIC, SOFT];

export function displayRenderIndex(id: DisplayRenderId): number {
  const i = DISPLAY_RENDERS.findIndex((d) => d.id === id);
  return i < 0 ? 0 : i;
}

export function buildDisplayRenderGlsl(): string {
  const fns = DISPLAY_RENDERS.map(
    (d, i) => `float ec_drt_${i}(float v) {\n${d.glsl.trim()}\n}`,
  ).join('\n');

  const dispatch = DISPLAY_RENDERS.map(
    (_, i) => `  if (mode == ${i}) return ec_drt_${i}(v);`,
  ).join('\n');

  return `${fns}

float ecDisplayRender(float v, int mode) {
${dispatch}
  return clamp(v, 0.0, 1.0);
}

vec3 ecDisplayRender(vec3 c, int mode) {
  return vec3(ecDisplayRender(c.r, mode), ecDisplayRender(c.g, mode), ecDisplayRender(c.b, mode));
}`;
}
