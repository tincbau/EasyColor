/**
 * Separable Gaussian blur, used twice in the pipeline:
 *   - to build the qualifier reference, so mattes don't inherit chroma
 *     subsampling blocks from the codec;
 *   - to spread the halation bloom.
 *
 * Taps are placed between texel centres so hardware bilinear filtering
 * fetches two samples per read. That halves the texture reads for the same
 * kernel, which is the difference between a 4K viewer running at 60fps and
 * at 25fps on integrated graphics.
 */

export const MAX_BLUR_TAPS = 32;

export function buildBlurFragmentShader(): string {
  return /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2  uTexel;      // 1 / resolution
uniform vec2  uDirection;  // (1,0) horizontal, (0,1) vertical
uniform float uSigma;
uniform int   uTaps;       // one side, excluding the centre

void main() {
  if (uSigma <= 0.01 || uTaps <= 0) {
    fragColor = texture(uTex, vUv);
    return;
  }

  float twoSigmaSq = 2.0 * uSigma * uSigma;

  vec4 sum = texture(uTex, vUv);
  float weightSum = 1.0;

  for (int i = 1; i <= ${MAX_BLUR_TAPS}; i++) {
    if (i > uTaps) break;

    // Pair up taps 2i-1 and 2i and sample once between them.
    float o1 = float(i * 2 - 1);
    float o2 = float(i * 2);
    float w1 = exp(-(o1 * o1) / twoSigmaSq);
    float w2 = exp(-(o2 * o2) / twoSigmaSq);
    float w = w1 + w2;
    float offset = (o1 * w1 + o2 * w2) / w;

    vec2 step = uDirection * uTexel * offset;
    sum += texture(uTex, vUv + step) * w;
    sum += texture(uTex, vUv - step) * w;
    weightSum += 2.0 * w;
  }

  fragColor = sum / weightSum;
}
`;
}

/**
 * Threshold pass that isolates the highlights halation blooms from.
 *
 * Real halation is light passing through the emulsion, scattering off the
 * film base and exposing the layers a second time from behind. Only bright
 * areas carry enough energy to do it, hence the threshold; and the red
 * layer sits furthest from the base, which is why the halo is red-orange.
 */
export function buildHalationThresholdShader(): string {
  return /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;

const vec3 EC_LUMA_709 = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float y = dot(c, EC_LUMA_709);

  // Soft knee: a hard threshold makes the bloom pop in as a highlight
  // crosses it, which reads as a flickering edge on moving footage.
  float w = smoothstep(uThreshold - uKnee, uThreshold + uKnee, y);

  fragColor = vec4(c * w, 1.0);
}
`;
}
