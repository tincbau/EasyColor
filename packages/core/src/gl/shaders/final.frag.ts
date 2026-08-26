/**
 * Pass 3 — halation composite, film grain, viewer overlays and A/B compare.
 *
 * Everything spatial or view-only lives here, deliberately downstream of the
 * per-pixel grade. That split is what makes a one-click LUT export possible:
 * the LUT bake replays passes 1 and 2, which are pure functions of colour,
 * and skips this one, which is not.
 */

import { buildCommonGlsl } from './common.glsl.js';

export function buildFinalFragmentShader(): string {
  return /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uGraded;     // rgb = graded image, a = diagnostic matte
uniform sampler2D uReference;  // the A/B "before" image
uniform sampler2D uHalation;   // blurred highlights
uniform vec2  uResolution;

/* --- halation --- */
uniform bool  uHalationActive;
uniform float uHalationStrength;
uniform vec3  uHalationTint;

/* --- grain --- */
uniform bool  uGrainActive;
uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uGrainShadowBias;
uniform float uGrainChroma;
uniform float uGrainSeed;

/* --- compare --- */
uniform int   uCompareMode;   // 0 off, 1 wipe, 2 side by side
uniform float uWipe;
uniform bool  uWipeVertical;
uniform bool  uBypass;

/* --- overlays --- */
uniform int   uOverlay;       // 0 none, 1 false colour, 2 matte diagnostic
uniform float uTime;
uniform bool  uMatteHatch;
uniform vec3  uMatteColor;

${buildCommonGlsl()}

/**
 * ARRI-style false colour. The point of these bands is that they are the
 * ones a cinematographer actually meters against: 18% grey, one stop over
 * for skin, and the two clip points.
 */
vec3 ecFalseColor(vec3 c) {
  float y = ecLuma(c) * 100.0;

  if (y < 2.5)  return vec3(0.42, 0.11, 0.62);   // black clip
  if (y < 4.0)  return vec3(0.13, 0.30, 0.85);   // just above black
  if (y >= 99.0) return vec3(0.92, 0.13, 0.13);  // white clip
  if (y >= 97.0) return vec3(0.95, 0.85, 0.16);  // just below clip
  if (y >= 52.0 && y < 56.0) return vec3(0.95, 0.53, 0.72);  // skin, one over grey
  if (y >= 38.0 && y < 42.0) return vec3(0.24, 0.76, 0.36);  // 18% grey

  // Everything else stays monochrome so the marked bands stand out.
  float g = y / 100.0;
  return vec3(g);
}

/**
 * Film grain.
 *
 * Two properties separate this from video noise: grain lives in the toe of
 * the curve, so shadows are grainier than highlights; and the three dye
 * layers grain semi-independently, so it is not purely monochrome.
 */
vec3 ecGrain(vec3 c, vec2 fragCoord) {
  vec2 p = fragCoord / max(uGrainSize, 0.25);
  vec2 seed = vec2(uGrainSeed, uGrainSeed * 1.618);

  float mono = ecGaussNoise(p + seed);
  float nr = mix(mono, ecGaussNoise(p + seed + 11.7), uGrainChroma);
  float ng = mix(mono, ecGaussNoise(p + seed + 47.3), uGrainChroma);
  float nb = mix(mono, ecGaussNoise(p + seed + 83.9), uGrainChroma);

  float y = ecLuma(c);
  // Peaks just above black and falls away toward white.
  float response = mix(1.0, 1.0 - smoothstep(0.05, 0.85, y), uGrainShadowBias);

  vec3 n = vec3(nr, ng, nb) * uGrainAmount * 0.16 * response;
  return c + n;
}

void main() {
  vec2 uv = vUv;
  vec4 gradedTexel = texture(uGraded, uv);
  vec3 graded = gradedTexel.rgb;
  float matte = gradedTexel.a;
  vec3 reference = texture(uReference, uv).rgb;

  /* ---- halation ---- */
  if (uHalationActive) {
    vec3 bloom = texture(uHalation, uv).rgb;
    // Screen blend: halation adds light, it never darkens, and screen keeps
    // the result inside 0..1 without the flat clip an additive blend gives.
    vec3 tinted = bloom * uHalationTint * uHalationStrength;
    graded = 1.0 - (1.0 - graded) * (1.0 - clamp(tinted, 0.0, 1.0));
  }

  /* ---- grain ---- */
  if (uGrainActive && uGrainAmount > 0.0) {
    graded = ecGrain(graded, uv * uResolution);
  }

  graded = clamp(graded, 0.0, 1.0);

  /* ---- A/B compare ---- */
  vec3 outColor = graded;
  bool onReferenceSide = false;

  if (uBypass) {
    outColor = reference;
  } else if (uCompareMode == 1) {
    float axis = uWipeVertical ? uv.y : uv.x;
    onReferenceSide = axis < uWipe;
    outColor = onReferenceSide ? reference : graded;

    // A one-pixel handle line so the wipe position is always visible.
    float dist = abs(axis - uWipe);
    float lineWidth = (uWipeVertical ? 1.0 / uResolution.y : 1.0 / uResolution.x) * 1.5;
    if (dist < lineWidth) outColor = vec3(1.0);
  } else if (uCompareMode == 2) {
    // Squeeze both images into their own half rather than cropping, so you
    // are comparing the whole frame against the whole frame.
    float axis = uWipeVertical ? uv.y : uv.x;
    vec2 sampleUv = uv;
    if (axis < 0.5) {
      onReferenceSide = true;
      if (uWipeVertical) sampleUv.y = uv.y * 2.0; else sampleUv.x = uv.x * 2.0;
      outColor = texture(uReference, sampleUv).rgb;
    } else {
      if (uWipeVertical) sampleUv.y = (uv.y - 0.5) * 2.0; else sampleUv.x = (uv.x - 0.5) * 2.0;
      outColor = texture(uGraded, sampleUv).rgb;
    }
    float dist = abs(axis - 0.5);
    float lineWidth = (uWipeVertical ? 1.0 / uResolution.y : 1.0 / uResolution.x) * 1.5;
    if (dist < lineWidth) outColor = vec3(1.0);
  }

  /* ---- overlays ---- */

  if (uOverlay == 1 && !onReferenceSide) {
    outColor = ecFalseColor(outColor);
  } else if (uOverlay == 2) {
    /* Matte diagnostic.
       The requirement is to see what is selected without losing sight of the
       picture, so the picture is never dimmed, blurred or covered. Instead
       the matte's *boundary* is drawn as a contour line, which costs four
       texture reads and zero visibility. An optional sparse hatch marks the
       interior for people who prefer it, and even that leaves most pixels
       untouched. */
    vec2 px = 1.0 / uResolution;
    float mR = texture(uGraded, uv + vec2(px.x, 0.0)).a;
    float mL = texture(uGraded, uv - vec2(px.x, 0.0)).a;
    float mU = texture(uGraded, uv + vec2(0.0, px.y)).a;
    float mD = texture(uGraded, uv - vec2(0.0, px.y)).a;

    float edge = max(abs(mR - mL), abs(mU - mD));
    float contour = smoothstep(0.06, 0.22, edge);

    // Marching dashes make the contour readable over a busy background and
    // instantly distinguishable from detail in the image itself.
    float march = step(0.5, fract((uv.x * uResolution.x + uv.y * uResolution.y) * 0.06 - uTime * 1.6));
    outColor = mix(outColor, uMatteColor, contour * mix(0.45, 1.0, march));

    if (uMatteHatch && matte > 0.35) {
      float hatch = step(0.86, fract((uv.x * uResolution.x - uv.y * uResolution.y) * 0.09 + uTime * 0.35));
      outColor = mix(outColor, uMatteColor, hatch * matte * 0.5);
    }
  }

  fragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
`;
}
