/**
 * Colour space primitives.
 *
 * These are the CPU-side conversions used for pixel sampling, palette
 * matching and skin analysis. The shader carries a GLSL mirror of the same
 * formulas in `gl/shaders/common.glsl.ts` — the two are intentional twins
 * and must be changed together.
 */

export type RGB = [number, number, number];

/* ------------------------------------------------------------------ */
/* Transfer functions                                                  */
/* ------------------------------------------------------------------ */

/** sRGB / Rec.709-display EOTF^-1 companding (scene value -> code value). */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

/** sRGB decoding (code value -> linear scene value). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbLinearToSrgb(c: RGB): RGB {
  return [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])];
}

export function rgbSrgbToLinear(c: RGB): RGB {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

/* ------------------------------------------------------------------ */
/* Luminance                                                           */
/* ------------------------------------------------------------------ */

/** Rec.709 luma coefficients — the weighting used everywhere in the app. */
export const LUMA_709: RGB = [0.2126, 0.7152, 0.0722];

export function luma(c: RGB): number {
  return c[0] * LUMA_709[0] + c[1] * LUMA_709[1] + c[2] * LUMA_709[2];
}

/* ------------------------------------------------------------------ */
/* Oklab — the perceptual space all qualifier maths runs in            */
/* ------------------------------------------------------------------ */

/**
 * Oklab (Björn Ottosson, 2020). Chosen over HSL/HSV for the qualifier
 * because its hue lines stay perceptually straight, so a hue-distance
 * feather produces a smooth boundary instead of the blocky edges you get
 * when you feather in HSV.
 *
 * Input is *linear* Rec.709 RGB.
 */
export function linearToOklab(c: RGB): RGB {
  const l = 0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2];
  const m = 0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2];
  const s = 0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2];

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function oklabToLinear(lab: RGB): RGB {
  const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Oklab -> LCh. Hue is returned in degrees, 0..360. */
export function oklabToLch(lab: RGB): RGB {
  const chroma = Math.hypot(lab[1], lab[2]);
  let hue = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return [lab[0], chroma, hue];
}

export function lchToOklab(lch: RGB): RGB {
  const rad = (lch[2] * Math.PI) / 180;
  return [lch[0], lch[1] * Math.cos(rad), lch[1] * Math.sin(rad)];
}

/* ------------------------------------------------------------------ */
/* HSL / HSV — used for the UI readouts and swatches only              */
/* ------------------------------------------------------------------ */

/** Display-referred RGB (0..1) -> HSV, hue in degrees. */
export function rgbToHsv(c: RGB): RGB {
  const max = Math.max(c[0], c[1], c[2]);
  const min = Math.min(c[0], c[1], c[2]);
  const d = max - min;

  let h = 0;
  if (d > 1e-9) {
    if (max === c[0]) h = ((c[1] - c[2]) / d) % 6;
    else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max <= 1e-9 ? 0 : d / max, max];
}

export function hsvToRgb(hsv: RGB): RGB {
  const h = ((hsv[0] % 360) + 360) % 360;
  const c = hsv[2] * hsv[1];
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = hsv[2] - c;

  const seg = Math.floor(h / 60) % 6;
  const table: RGB[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const t = table[seg];
  return [t[0] + m, t[1] + m, t[2] + m];
}

/* ------------------------------------------------------------------ */
/* Vectorscope geometry                                                */
/* ------------------------------------------------------------------ */

/**
 * The skin tone ("I") line sits at 123 degrees on a broadcast vectorscope.
 * Every skin-tone tool in the app aligns to this constant.
 */
export const SKIN_TONE_LINE_DEG = 123;

/**
 * Rec.709 Y'CbCr chroma coordinates, scaled to a unit vectorscope.
 * Returns { x, y } with the same orientation a hardware scope uses:
 * +Cb to the right, +Cr up.
 */
export function rgbToVectorscope(c: RGB): { x: number; y: number } {
  const y = luma(c);
  const cb = (c[2] - y) / 1.8556;
  const cr = (c[0] - y) / 1.5748;
  return { x: cb, y: cr };
}

/**
 * Angle of a colour on the vectorscope, in degrees, measured the way scopes
 * label it: 0 deg along +Cb, increasing counter-clockwise. Skin sits at 123.
 */
export function vectorscopeAngle(c: RGB): number {
  const { x, y } = rgbToVectorscope(c);
  let a = (Math.atan2(y, x) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
}

export function vectorscopeSaturation(c: RGB): number {
  const { x, y } = rgbToVectorscope(c);
  return Math.hypot(x, y);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest signed distance between two hue angles, in degrees (-180..180). */
export function hueDelta(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}
