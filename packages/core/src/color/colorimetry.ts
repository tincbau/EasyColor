/**
 * Deriving RGB working-space matrices from primaries.
 *
 * Camera gamut matrices are usually copied around as nine hardcoded numbers,
 * and a single mistyped digit produces a matrix that tints neutral grey —
 * subtly enough to survive review and badly enough to ruin a grade. Deriving
 * them from published chromaticities instead makes that failure impossible:
 * a matrix built this way maps its white point to its white point by
 * construction, so grey stays grey whatever else is wrong.
 *
 * Reference: SMPTE RP 177, "Derivation of Basic Television Colour Equations".
 */

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** CIE xy chromaticity. */
export interface Chromaticity {
  x: number;
  y: number;
}

export interface RgbPrimaries {
  red: Chromaticity;
  green: Chromaticity;
  blue: Chromaticity;
  white: Chromaticity;
}

export const D65: Chromaticity = { x: 0.3127, y: 0.329 };
export const D60: Chromaticity = { x: 0.32168, y: 0.33767 };

/** xyY -> XYZ at Y = 1. */
function toXyz(c: Chromaticity): [number, number, number] {
  return [c.x / c.y, 1, (1 - c.x - c.y) / c.y];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as number[];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as Mat3;
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;

  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;

  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    throw new Error('Matrix is singular — check the primaries it was built from.');
  }

  const inv = 1 / det;
  return [
    A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
  ];
}

export function apply(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Linear RGB -> CIE XYZ for a set of primaries.
 *
 * The primaries give the *direction* of each channel in XYZ; the white point
 * gives the scaling that makes RGB(1,1,1) land exactly on it.
 */
export function rgbToXyz(p: RgbPrimaries): Mat3 {
  const r = toXyz(p.red);
  const g = toXyz(p.green);
  const b = toXyz(p.blue);

  const base: Mat3 = [
    r[0], g[0], b[0],
    r[1], g[1], b[1],
    r[2], g[2], b[2],
  ];

  const white = toXyz(p.white);
  const scale = apply(invert(base), white);

  return [
    r[0] * scale[0], g[0] * scale[1], b[0] * scale[2],
    r[1] * scale[0], g[1] * scale[1], b[1] * scale[2],
    r[2] * scale[0], g[2] * scale[1], b[2] * scale[2],
  ];
}

export function xyzToRgb(p: RgbPrimaries): Mat3 {
  return invert(rgbToXyz(p));
}

/** Bradford cone response, the standard basis for chromatic adaptation. */
const BRADFORD: Mat3 = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
];

/**
 * Von Kries adaptation in the Bradford basis.
 *
 * Only needed when two spaces disagree about white — every camera gamut here
 * is D65, so in practice this returns the identity. It exists so adding an
 * ACES or D60 space later doesn't silently shift white.
 */
export function adaptation(from: Chromaticity, to: Chromaticity): Mat3 {
  if (Math.abs(from.x - to.x) < 1e-9 && Math.abs(from.y - to.y) < 1e-9) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  const src = apply(BRADFORD, toXyz(from));
  const dst = apply(BRADFORD, toXyz(to));

  const scale: Mat3 = [
    dst[0] / src[0], 0, 0,
    0, dst[1] / src[1], 0,
    0, 0, dst[2] / src[2],
  ];

  return multiply(invert(BRADFORD), multiply(scale, BRADFORD));
}

/** Linear RGB in `from` primaries -> linear RGB in `to` primaries. */
export function gamutConversion(from: RgbPrimaries, to: RgbPrimaries): Mat3 {
  const toXyzMat = rgbToXyz(from);
  const adapt = adaptation(from.white, to.white);
  const fromXyzMat = xyzToRgb(to);
  return multiply(fromXyzMat, multiply(adapt, toXyzMat));
}

/* ------------------------------------------------------------------ */
/* Published camera primaries                                          */
/* ------------------------------------------------------------------ */

export const REC709: RgbPrimaries = {
  red: { x: 0.64, y: 0.33 },
  green: { x: 0.3, y: 0.6 },
  blue: { x: 0.15, y: 0.06 },
  white: D65,
};

export const REC2020: RgbPrimaries = {
  red: { x: 0.708, y: 0.292 },
  green: { x: 0.17, y: 0.797 },
  blue: { x: 0.131, y: 0.046 },
  white: D65,
};

export const S_GAMUT3_CINE: RgbPrimaries = {
  red: { x: 0.766, y: 0.275 },
  green: { x: 0.225, y: 0.8 },
  blue: { x: 0.089, y: -0.087 },
  white: D65,
};

export const ARRI_WIDE_GAMUT_3: RgbPrimaries = {
  red: { x: 0.684, y: 0.313 },
  green: { x: 0.221, y: 0.848 },
  blue: { x: 0.0861, y: -0.102 },
  white: D65,
};

export const ARRI_WIDE_GAMUT_4: RgbPrimaries = {
  red: { x: 0.7347, y: 0.2653 },
  green: { x: 0.1424, y: 0.8576 },
  blue: { x: 0.0991, y: -0.0308 },
  white: D65,
};

export const V_GAMUT: RgbPrimaries = {
  red: { x: 0.73, y: 0.28 },
  green: { x: 0.165, y: 0.84 },
  blue: { x: 0.1, y: -0.03 },
  white: D65,
};

export const CANON_CINEMA_GAMUT: RgbPrimaries = {
  red: { x: 0.74, y: 0.27 },
  green: { x: 0.17, y: 1.14 },
  blue: { x: 0.08, y: -0.1 },
  white: D65,
};

export const RED_WIDE_GAMUT: RgbPrimaries = {
  red: { x: 0.780308, y: 0.304253 },
  green: { x: 0.121595, y: 1.493994 },
  blue: { x: 0.095612, y: -0.084589 },
  white: D65,
};

export const DJI_D_GAMUT: RgbPrimaries = {
  red: { x: 0.71, y: 0.31 },
  green: { x: 0.21, y: 0.88 },
  blue: { x: 0.09, y: -0.08 },
  white: D65,
};
