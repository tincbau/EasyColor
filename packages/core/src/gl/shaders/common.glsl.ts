/**
 * GLSL library shared by every pass.
 *
 * The colour-space functions here are the GPU twins of `color/space.ts`.
 * They are duplicated because one runs per-pixel on the GPU and the other
 * runs on sampled pixels in JavaScript; when you change one, change both.
 */

import { buildLogGlsl } from '../../color/log.js';
import { buildDisplayRenderGlsl } from '../../color/gamut.js';

export const GLSL_COLOR = /* glsl */ `
const vec3 EC_LUMA_709 = vec3(0.2126, 0.7152, 0.0722);

float ecLuma(vec3 c) { return dot(c, EC_LUMA_709); }

float ecSrgbToLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
vec3 ecSrgbToLinear(vec3 c) {
  return vec3(ecSrgbToLinear(c.r), ecSrgbToLinear(c.g), ecSrgbToLinear(c.b));
}

float ecLinearToSrgb(float c) {
  c = max(c, 0.0);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 ecLinearToSrgb(vec3 c) {
  return vec3(ecLinearToSrgb(c.r), ecLinearToSrgb(c.g), ecLinearToSrgb(c.b));
}

/* ---- Oklab ------------------------------------------------------- */

vec3 ecLinearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;

  // sign(x)*pow(abs(x),1/3) keeps negative (out of gamut) values usable
  // instead of collapsing them to NaN, which would show up as black holes.
  vec3 lms = vec3(l, m, s);
  vec3 lms_ = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));

  return vec3(
    0.2104542553 * lms_.x + 0.7936177850 * lms_.y - 0.0040720468 * lms_.z,
    1.9779984951 * lms_.x - 2.4285922050 * lms_.y + 0.4505937099 * lms_.z,
    0.0259040371 * lms_.x + 0.7827717662 * lms_.y - 0.8086757660 * lms_.z
  );
}

vec3 ecOklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;

  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;

  return vec3(
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

/** Oklab -> (L, chroma, hue degrees 0..360). */
vec3 ecOklabToLch(vec3 lab) {
  float c = length(lab.yz);
  float h = degrees(atan(lab.z, lab.y));
  if (h < 0.0) h += 360.0;
  return vec3(lab.x, c, h);
}

vec3 ecLchToOklab(vec3 lch) {
  float r = radians(lch.z);
  return vec3(lch.x, lch.y * cos(r), lch.y * sin(r));
}

/** Shortest absolute distance between two hue angles, degrees, 0..180. */
float ecHueDistance(float a, float b) {
  float d = abs(mod(a - b + 540.0, 360.0) - 180.0);
  return d;
}

/* ---- Vectorscope --------------------------------------------------- */

vec2 ecVectorscope(vec3 rgb) {
  float y = ecLuma(rgb);
  return vec2((rgb.b - y) / 1.8556, (rgb.r - y) / 1.5748);
}

/* ---- HSV, for the UI-facing overlays ------------------------------- */

vec3 ecRgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, mx <= 1e-6 ? 0.0 : d / mx, mx);
}
`;

export const GLSL_UTIL = /* glsl */ `
/**
 * A window function with a flat top and smooth shoulders: 1.0 inside
 * [lo, hi], falling to 0 across \`soft\` on each side. This is the shape every
 * qualifier in the app is built from — the flat top is what lets you select
 * a range without the middle of the selection being weaker than its edges.
 */
float ecSoftWindow(float v, float lo, float hi, float soft) {
  soft = max(soft, 1e-5);

  // The lower feather is clamped at zero because chroma and lightness both
  // bottom out there. Letting it run negative gives a neutral pixel — which
  // has no hue at all — a partial weight in a hue selection, and every grey
  // in the frame picks up the tint you meant for one colour.
  float lo0 = max(lo - soft, 0.0);
  float rise = lo <= lo0 ? step(lo0, v) : smoothstep(lo0, lo, v);

  float fall = 1.0 - smoothstep(hi, hi + soft, v);
  return rise * fall;
}

/** Symmetric version for hue, which wraps and is specified as centre +/- width. */
float ecSoftBand(float distance, float width, float soft) {
  soft = max(soft, 1e-5);
  return 1.0 - smoothstep(width, width + soft, distance);
}

/** Hash-based value noise. Deterministic, so a frozen grain stays frozen. */
float ecHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float ecValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = ecHash(i);
  float b = ecHash(i + vec2(1.0, 0.0));
  float c = ecHash(i + vec2(0.0, 1.0));
  float d = ecHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Roughly Gaussian noise in -1..1, from summed hashes. */
float ecGaussNoise(vec2 p) {
  float n = ecHash(p) + ecHash(p + 17.13) + ecHash(p + 91.71) - 1.5;
  return n * 0.9428;
}

/**
 * White balance as channel gains, normalised so overall luminance does not
 * drift. Without the normalisation, warming an image also brightens it and
 * you spend the session chasing exposure back and forth.
 */
vec3 ecWhiteBalance(vec3 c, float temp, float tint) {
  if (abs(temp) < 1e-5 && abs(tint) < 1e-5) return c;
  vec3 gain = vec3(
    1.0 + temp * 0.40 + tint * 0.10,
    1.0 - tint * 0.30,
    1.0 - temp * 0.40 + tint * 0.10
  );
  gain = max(gain, vec3(0.02));
  gain /= dot(gain, EC_LUMA_709);
  return c * gain;
}

/** Curve strip lookup: master curve first, then the per-channel curve. */
vec3 ecApplyCurves(sampler2D tex, vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float mr = texture(tex, vec2(c.r, 0.5)).a;
  float mg = texture(tex, vec2(c.g, 0.5)).a;
  float mb = texture(tex, vec2(c.b, 0.5)).a;
  return vec3(
    texture(tex, vec2(mr, 0.5)).r,
    texture(tex, vec2(mg, 0.5)).g,
    texture(tex, vec2(mb, 0.5)).b
  );
}

vec3 ecSaturate(vec3 c, float amount) {
  float y = ecLuma(c);
  return mix(vec3(y), c, amount);
}

/**
 * Vibrance: saturation weighted by how unsaturated a pixel already is, so
 * skin (already saturated) is protected while a flat background comes up.
 */
vec3 ecVibrance(vec3 c, float amount) {
  if (abs(amount) < 1e-5) return c;
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx - mn;
  float weight = 1.0 - smoothstep(0.0, 0.7, sat);
  return ecSaturate(c, 1.0 + amount * weight);
}
`;

/** The full library, with the generated log and display-render dispatchers. */
export function buildCommonGlsl(): string {
  return [GLSL_COLOR, GLSL_UTIL, buildLogGlsl(), buildDisplayRenderGlsl()].join('\n');
}

/** Shared vertex shader: a full-screen triangle, no attributes needed. */
export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Three vertices covering the viewport. Cheaper than a quad and avoids
  // the diagonal seam artefacts a two-triangle quad can produce.
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;
