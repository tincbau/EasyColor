/**
 * Pass 2 — HSL qualifier zones, skin tone suite, and power windows.
 *
 * This is the pass the on-viewer tool drives, and three decisions in it are
 * what make direct grading feel solid rather than fiddly:
 *
 * 1. Qualification runs in Oklab, not HSV. A 20 degree hue window is
 *    perceptually the same width on orange as it is on blue, so a zone you
 *    tuned on skin behaves the same when you reuse it on foliage.
 *
 * 2. Zones are qualified against a *blurred* copy of the image but applied
 *    to the sharp pixel. 4:2:0 footage carries its chroma at half
 *    resolution, so qualifying the sharp pixel reproduces the codec's
 *    2x2 chroma blocks as visible stair-stepping along the edge of a
 *    selection. Blurring only the matte reference removes that without
 *    softening the picture by even one pixel.
 *
 * 3. Zone edits accumulate as weighted deltas with a normalising divisor.
 *    Two zones that overlap blend; two that don't each apply in full; and
 *    grading a new colour can never undo an earlier one, because nothing is
 *    ever written back over the base — only added to it.
 */

import { buildCommonGlsl } from './common.glsl.js';
import { MAX_HSL_ZONES, MAX_POWER_WINDOWS } from '../../state/grade.js';

export function buildZonesFragmentShader(): string {
  return /* glsl */ `#version 300 es
precision highp float;

#define MAX_ZONES ${MAX_HSL_ZONES}
#define MAX_WINDOWS ${MAX_POWER_WINDOWS}

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBase;      // sharp, fully primary-graded
uniform sampler2D uQualRef;   // blurred copy, used only to build mattes
uniform vec2  uResolution;
uniform float uAspect;

/* --- zones ---
   z0 = (hue, hueWidth, hueSoftness, strength)
   z1 = (chromaLow, chromaHigh, chromaSoftness, unused)
   z2 = (lumaLow, lumaHigh, lumaSoftness, hueShift)
   z3 = (satGain, lumGain, labOffsetA, labOffsetB)   */
uniform int  uZoneCount;
uniform vec4 uZone0[MAX_ZONES];
uniform vec4 uZone1[MAX_ZONES];
uniform vec4 uZone2[MAX_ZONES];
uniform vec4 uZone3[MAX_ZONES];
/** Bit 0 = enabled, bit 1 = solo. */
uniform int  uZoneFlags[MAX_ZONES];
uniform bool uAnySolo;

/* --- skin tone suite --- */
uniform bool  uSkinActive;
uniform vec4  uSkin0;   // hue, hueWidth, hueSoftness, strength
uniform vec4  uSkin1;   // chromaLow, chromaHigh, lumaLow, lumaHigh
uniform vec4  uSkin2;   // hueShift, satGain, lumGain, smoothing

/* --- power windows ---
   w0 = (cx, cy, rx, ry)
   w1 = (rotationDeg, softness, corner, opacity)
   w2 = (exposure, contrast, saturation, unused)
   w3 = (temperature, tint, unused, unused)  */
uniform int  uWindowCount;
uniform vec4 uWin0[MAX_WINDOWS];
uniform vec4 uWin1[MAX_WINDOWS];
uniform vec4 uWin2[MAX_WINDOWS];
uniform vec4 uWin3[MAX_WINDOWS];
/** Bit 0 = enabled, bit 1 = invert, bits 2-3 = shape (0 ellipse, 1 rect, 2 vignette). */
uniform int  uWinFlags[MAX_WINDOWS];

/* --- diagnostic matte output ---
   0 none, 1 skin, 2 a specific zone, 3 a specific window, 4 all zones. */
uniform int uMatteMode;
uniform int uMatteIndex;

uniform float uPivot;

${buildCommonGlsl()}

/**
 * The qualifier. One function, used by zones and by the skin panel, so the
 * skin tools cannot drift from the behaviour of a hand-made zone.
 */
float ecQualify(
  vec3 lch,
  float hue, float hueWidth, float hueSoftness,
  float chromaLow, float chromaHigh, float chromaSoftness,
  float lumaLow, float lumaHigh, float lumaSoftness
) {
  float hueW = ecSoftBand(ecHueDistance(lch.z, hue), hueWidth, hueSoftness);
  if (hueW <= 0.0) return 0.0;

  float chromaW = ecSoftWindow(lch.y, chromaLow, chromaHigh, chromaSoftness);
  if (chromaW <= 0.0) return 0.0;

  float lumaW = ecSoftWindow(lch.x, lumaLow, lumaHigh, lumaSoftness);
  return hueW * chromaW * lumaW;
}

float ecZoneWeight(int i, vec3 refLch) {
  if ((uZoneFlags[i] & 1) == 0) return 0.0;
  if (uAnySolo && (uZoneFlags[i] & 2) == 0) return 0.0;

  vec4 z0 = uZone0[i];
  vec4 z1 = uZone1[i];
  vec4 z2 = uZone2[i];

  return ecQualify(
    refLch,
    z0.x, z0.y, z0.z,
    z1.x, z1.y, z1.z,
    z2.x, z2.y, z2.z
  ) * z0.w;
}

/** Apply one zone's edit to a colour, in Oklab. Returns the *delta*. */
vec3 ecZoneDelta(int i, vec3 lab) {
  vec4 z2 = uZone2[i];
  vec4 z3 = uZone3[i];

  vec3 lch = ecOklabToLch(lab);
  lch.z = mod(lch.z + z2.w, 360.0);
  lch.y = max(lch.y * z3.x, 0.0);
  lch.x = max(lch.x * exp2(z3.y), 0.0);

  vec3 edited = ecLchToOklab(lch);
  edited.y += z3.z;
  edited.z += z3.w;
  return edited - lab;
}

float ecWindowMask(int i, vec2 uv) {
  int flags = uWinFlags[i];
  if ((flags & 1) == 0) return 0.0;

  vec4 w0 = uWin0[i];
  vec4 w1 = uWin1[i];
  int shape = (flags >> 2) & 3;

  // Work in aspect-corrected space, measured in units of frame height, so
  // the shape is isotropic: equal radii really are a circle on any aspect
  // ratio, the feather is the same width on every edge, and rotation moves
  // the shape the way the on-screen gizmo shows it. Normalising the two
  // radii to different axes — x to width, y to height — is the obvious
  // alternative and it silently turns every circle into an oval.
  vec2 p = uv - w0.xy;
  p.x *= uAspect;

  float rot = radians(w1.x);
  float cs = cos(rot);
  float sn = sin(rot);
  p = vec2(p.x * cs + p.y * sn, -p.x * sn + p.y * cs);

  vec2 rr = max(w0.zw, vec2(1e-4));
  vec2 q = abs(p) / rr;

  float d;
  if (shape == 1) {
    // Superellipse: exponent 2 is an ellipse, high exponents approach a
    // hard rectangle. One expression covers every corner rounding.
    float n = mix(16.0, 2.0, clamp(w1.z, 0.0, 1.0));
    d = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
  } else {
    d = length(q);
  }

  float soft = clamp(w1.y, 0.0015, 1.0);
  float mask = 1.0 - smoothstep(1.0 - soft, 1.0, d);

  if ((flags & 2) != 0) mask = 1.0 - mask;
  return mask;
}

vec3 ecApplyWindow(int i, vec3 c, float mask) {
  if (mask <= 0.0) return c;
  vec4 w1 = uWin1[i];
  vec4 w2 = uWin2[i];
  vec4 w3 = uWin3[i];

  vec3 wc = c * exp2(w2.x);
  wc = (wc - uPivot) * (1.0 + w2.y) + uPivot;
  wc = ecSaturate(wc, w2.z);
  wc = ecWhiteBalance(wc, w3.x, w3.y);

  return mix(c, clamp(wc, 0.0, 1.0), clamp(mask * w1.w, 0.0, 1.0));
}

float ecSkinMatte(vec3 refLch) {
  return ecQualify(
    refLch,
    uSkin0.x, uSkin0.y, uSkin0.z,
    uSkin1.x, uSkin1.y, 0.03,
    uSkin1.z, uSkin1.w, 0.18
  );
}

void main() {
  vec3 base = texture(uBase, vUv).rgb;
  vec3 refc = texture(uQualRef, vUv).rgb;

  vec3 refLab = ecLinearToOklab(ecSrgbToLinear(refc));
  vec3 refLch = ecOklabToLch(refLab);

  vec3 lab = ecLinearToOklab(ecSrgbToLinear(base));

  /* ---- HSL zones ---- */

  vec3 delta = vec3(0.0);
  float totalWeight = 0.0;
  float matteAll = 0.0;
  float matteSelected = 0.0;

  for (int i = 0; i < MAX_ZONES; i++) {
    if (i >= uZoneCount) break;
    float w = ecZoneWeight(i, refLch);
    if (w <= 0.0) continue;

    delta += w * ecZoneDelta(i, lab);
    totalWeight += w;
    matteAll = max(matteAll, w);
    if (i == uMatteIndex) matteSelected = w;
  }

  /* ---- skin ---- */

  // The qualifier is evaluated whether or not corrections are enabled: the
  // isolation overlay exists to help set the qualifier up, and a diagnostic
  // that only works after you have committed to the correction is useless in
  // the one moment it is for. Only the *edit* is gated on enabled — and the
  // diagnostic ignores strength too, so turning the correction down does not
  // also blind the view of what is selected.
  float skinSelect = ecSkinMatte(refLch);
  float skinW = uSkinActive ? skinSelect * uSkin0.w : 0.0;
  if (skinW > 0.0) {
    vec3 lch = ecOklabToLch(lab);
    lch.z = mod(lch.z + uSkin2.x, 360.0);
    lch.y = max(lch.y * uSkin2.y, 0.0);
    lch.x = max(lch.x * exp2(uSkin2.z), 0.0);
    delta += skinW * (ecLchToOklab(lch) - lab);
    totalWeight += skinW;
  }

  // Normalise only when the weights actually exceed one. Below that, every
  // zone applies at exactly the strength it was given — which is what keeps
  // a second, unrelated colour edit from diluting the first.
  if (totalWeight > 1.0) delta /= totalWeight;

  vec3 graded = clamp(ecLinearToSrgb(ecOklabToLinear(lab + delta)), 0.0, 1.0);

  /* ---- skin smoothing ----
     A small local average, applied only where the skin matte is strong.
     Sampled from the qualifier reference, which is already blurred, so this
     costs nothing extra. */
  if (skinW > 0.0 && uSkin2.w > 0.0) {
    float amount = skinW * uSkin2.w;
    // Preserve luminance detail, soften only chroma: that removes blotchy
    // colour without turning a face into plastic.
    vec3 softLab = ecLinearToOklab(ecSrgbToLinear(refc));
    vec3 gLab = ecLinearToOklab(ecSrgbToLinear(graded));
    gLab.yz = mix(gLab.yz, softLab.yz, amount);
    graded = clamp(ecLinearToSrgb(ecOklabToLinear(gLab)), 0.0, 1.0);
  }

  /* ---- power windows ---- */

  float matteWindow = 0.0;
  for (int i = 0; i < MAX_WINDOWS; i++) {
    if (i >= uWindowCount) break;
    float mask = ecWindowMask(i, vUv);
    graded = ecApplyWindow(i, graded, mask);
    if (i == uMatteIndex) matteWindow = mask;
  }

  /* ---- diagnostic matte, carried in alpha ----
     The overlay pass reads this. Keeping it in alpha avoids a second render
     target, which some integrated GPUs handle badly at 4K. */
  float matte = 0.0;
  if (uMatteMode == 1) matte = skinSelect;
  else if (uMatteMode == 2) matte = matteSelected;
  else if (uMatteMode == 3) matte = matteWindow;
  else if (uMatteMode == 4) matte = matteAll;

  fragColor = vec4(graded, matte);
}
`;
}
