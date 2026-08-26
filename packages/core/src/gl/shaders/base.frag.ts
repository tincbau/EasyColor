/**
 * Pass 1 — camera conversion and primary grade.
 *
 * Two working spaces, and the boundary between them matters:
 *
 *   scene-linear   log decode, gamut, exposure, white balance, tone map
 *   video levels   everything a colourist touches: contrast, wheels, curves,
 *                  saturation, film stock, LUT
 *
 * Wheels and curves belong in gamma-encoded video levels because that is
 * where every grading tool defines them. Run them in linear instead and a
 * "lift" lands almost entirely in the bottom stop, which is not what the
 * control is supposed to feel like.
 */

import { buildCommonGlsl, } from './common.glsl.js';

export function buildBaseFragmentShader(): string {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uSourceSize;
uniform bool uFlipY;

/* --- camera conversion --- */
uniform int   uLogMode;
uniform mat3  uGamut;
uniform bool  uApplyGamut;
uniform int   uDisplayMode;

/* --- primaries --- */
uniform float uExposure;      // stops
uniform float uTemperature;   // -1 cool .. +1 warm
uniform float uTint;          // -1 green .. +1 magenta
uniform float uContrast;
uniform float uPivot;
uniform float uSaturation;
uniform float uVibrance;
uniform float uHighlights;
uniform float uShadows;

/* --- wheels: rgb offsets in xyz, master luma ring in w --- */
uniform vec4 uLift;
uniform vec4 uGamma;
uniform vec4 uGain;
uniform vec4 uOffset;

/* --- curves: RGBA strip, rgb = per channel, a = master --- */
uniform sampler2D uCurves;
uniform bool uCurvesActive;

/* --- film stock --- */
uniform bool  uFilmActive;
uniform mat3  uFilmMatrix;
uniform sampler2D uFilmCurves;
uniform float uFilmIntensity;
uniform float uFilmSaturation;
uniform vec3  uFilmShadowTint;
uniform vec3  uFilmHighlightTint;
uniform float uDensity;       // stock density + user density, combined

/* --- creative LUT --- */
uniform sampler3D uLut;
uniform bool  uLutActive;
uniform float uLutIntensity;
uniform int   uLutStage;      // 0 = before conversion (log), 1 = after (display)
uniform float uLutSize;

/* --- output selection --- */
// 0 = full grade, 1 = camera conversion only (the A/B "corrected" reference),
// 2 = untouched source (the A/B "source" reference).
uniform int uOutputMode;

${buildCommonGlsl()}

/**
 * Tetrahedral 3D LUT interpolation.
 *
 * Hardware trilinear filtering is one texture fetch, but it cuts each cell
 * into eight and blends across the cube diagonal, which bends straight
 * gradients — visible as a faint magenta cast through neutral ramps on
 * strong looks. Tetrahedral splits the cell along the neutral axis instead,
 * so greys stay grey. It is what every LUT box and NLE uses.
 */
vec3 ecSampleLut(vec3 c) {
  float n = uLutSize;
  vec3 pos = clamp(c, 0.0, 1.0) * (n - 1.0);
  vec3 base = floor(pos);
  vec3 f = pos - base;

  // Texel centres, so we read stored nodes rather than blends of them.
  vec3 inv = vec3(1.0 / n);
  vec3 b0 = (base + 0.5) * inv;
  vec3 b1 = (base + 1.5) * inv;

  vec3 c000 = texture(uLut, vec3(b0.x, b0.y, b0.z)).rgb;
  vec3 c111 = texture(uLut, vec3(b1.x, b1.y, b1.z)).rgb;

  vec3 result;
  if (f.r > f.g) {
    if (f.g > f.b) {         // r > g > b
      vec3 c100 = texture(uLut, vec3(b1.x, b0.y, b0.z)).rgb;
      vec3 c110 = texture(uLut, vec3(b1.x, b1.y, b0.z)).rgb;
      result = (1.0 - f.r) * c000 + (f.r - f.g) * c100 + (f.g - f.b) * c110 + f.b * c111;
    } else if (f.r > f.b) {  // r > b > g
      vec3 c100 = texture(uLut, vec3(b1.x, b0.y, b0.z)).rgb;
      vec3 c101 = texture(uLut, vec3(b1.x, b0.y, b1.z)).rgb;
      result = (1.0 - f.r) * c000 + (f.r - f.b) * c100 + (f.b - f.g) * c101 + f.g * c111;
    } else {                 // b > r > g
      vec3 c001 = texture(uLut, vec3(b0.x, b0.y, b1.z)).rgb;
      vec3 c101 = texture(uLut, vec3(b1.x, b0.y, b1.z)).rgb;
      result = (1.0 - f.b) * c000 + (f.b - f.r) * c001 + (f.r - f.g) * c101 + f.g * c111;
    }
  } else {
    if (f.b > f.g) {         // b > g > r
      vec3 c001 = texture(uLut, vec3(b0.x, b0.y, b1.z)).rgb;
      vec3 c011 = texture(uLut, vec3(b0.x, b1.y, b1.z)).rgb;
      result = (1.0 - f.b) * c000 + (f.b - f.g) * c001 + (f.g - f.r) * c011 + f.r * c111;
    } else if (f.b > f.r) {  // g > b > r
      vec3 c010 = texture(uLut, vec3(b0.x, b1.y, b0.z)).rgb;
      vec3 c011 = texture(uLut, vec3(b0.x, b1.y, b1.z)).rgb;
      result = (1.0 - f.g) * c000 + (f.g - f.b) * c010 + (f.b - f.r) * c011 + f.r * c111;
    } else {                 // g > r > b
      vec3 c010 = texture(uLut, vec3(b0.x, b1.y, b0.z)).rgb;
      vec3 c110 = texture(uLut, vec3(b1.x, b1.y, b0.z)).rgb;
      result = (1.0 - f.g) * c000 + (f.g - f.r) * c010 + (f.r - f.b) * c110 + f.b * c111;
    }
  }
  return result;
}

vec3 ecApplyLut(vec3 c, int stage) {
  if (!uLutActive || uLutStage != stage || uLutIntensity <= 0.0) return c;
  return mix(c, ecSampleLut(c), uLutIntensity);
}

/**
 * Lift / Gamma / Gain / Offset, in the order a colourist expects.
 * Each wheel's master luma ring adds equally to all three channels, which is
 * why the ring value is folded in before the per-channel offset is used.
 */
vec3 ecApplyWheels(vec3 c) {
  c += (uOffset.rgb + uOffset.w) * 0.10;

  vec3 lift = (uLift.rgb + uLift.w) * 0.25;
  // Pivoted at white: raising lift opens the blacks and leaves white alone.
  c = c * (1.0 - lift) + lift;

  c *= max(vec3(0.0), 1.0 + (uGain.rgb + uGain.w));

  vec3 g = 1.0 + (uGamma.rgb + uGamma.w);
  c = sign(c) * pow(abs(c) + 1e-6, 1.0 / max(g, vec3(0.05)));

  return c;
}

/** Shadow and highlight recovery with soft, non-overlapping masks. */
vec3 ecRecovery(vec3 c) {
  if (abs(uHighlights) < 1e-5 && abs(uShadows) < 1e-5) return c;
  float y = ecLuma(c);
  float hiMask = smoothstep(0.5, 1.0, y);
  float loMask = 1.0 - smoothstep(0.0, 0.5, y);
  c *= 1.0 + uHighlights * 0.6 * hiMask;
  c += uShadows * 0.25 * loMask;
  return c;
}

/**
 * Subtractive density.
 *
 * Additive saturation pushes colours toward the edge of the cube and they
 * clip to white. Film does the opposite: a saturated colour has more dye in
 * the path, so it gets *darker* as it gets purer. Scaling luminance down
 * with chroma reproduces that, and it is the single biggest reason film
 * emulation reads as film rather than as a saturation boost.
 */
vec3 ecDensity(vec3 c, float amount) {
  if (amount <= 1e-5) return c;
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float chroma = mx - mn;
  float darken = 1.0 - amount * chroma * 0.55;
  return c * darken;
}

vec3 ecFilmStock(vec3 c) {
  if (!uFilmActive || uFilmIntensity <= 0.0) return c;

  vec3 stock = clamp(c, 0.0, 1.0);
  stock = clamp(uFilmMatrix * stock, 0.0, 1.0);
  stock = ecApplyCurves(uFilmCurves, stock);
  stock = ecSaturate(stock, uFilmSaturation);

  // Split tone: shadow tint fades out as the pixel brightens, and vice versa.
  float y = ecLuma(stock);
  stock += uFilmShadowTint * (1.0 - smoothstep(0.0, 0.55, y));
  stock += uFilmHighlightTint * smoothstep(0.45, 1.0, y);

  return mix(c, clamp(stock, 0.0, 1.0), uFilmIntensity);
}

void main() {
  vec2 uv = uFlipY ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec4 texel = texture(uSource, uv);
  vec3 raw = texel.rgb;

  if (uOutputMode == 2) {
    // Untouched source, only decoded far enough to be displayable.
    fragColor = vec4(clamp(raw, 0.0, 1.0), texel.a);
    return;
  }

  /* ---------- scene-linear ---------- */

  vec3 lin;
  if (uLogMode == 0) {
    lin = ecSrgbToLinear(clamp(raw, 0.0, 1.0));
  } else {
    vec3 logged = ecApplyLut(raw, 0);
    lin = ecLogToLinear(logged, uLogMode);
    if (uApplyGamut) lin = uGamut * lin;
  }

  lin *= exp2(uExposure);
  lin = ecWhiteBalance(lin, uTemperature, uTint);
  lin = max(lin, vec3(0.0));

  vec3 video = ecLinearToSrgb(ecDisplayRender(lin, uDisplayMode));

  if (uOutputMode == 1) {
    // Camera conversion only: this is the honest "before" for log footage.
    fragColor = vec4(clamp(video, 0.0, 1.0), texel.a);
    return;
  }

  /* ---------- video levels ---------- */

  video = ecRecovery(video);

  if (abs(uContrast) > 1e-5) {
    float amount = 1.0 + uContrast;
    video = (video - uPivot) * amount + uPivot;
  }

  video = ecApplyWheels(video);
  video = clamp(video, 0.0, 1.0);

  if (uCurvesActive) video = ecApplyCurves(uCurves, video);

  video = ecSaturate(video, uSaturation);
  video = ecVibrance(video, uVibrance);
  video = clamp(video, 0.0, 1.0);

  video = ecFilmStock(video);
  video = ecDensity(video, uDensity);
  video = ecApplyLut(clamp(video, 0.0, 1.0), 1);

  fragColor = vec4(clamp(video, 0.0, 1.0), texel.a);
}
`;
}
