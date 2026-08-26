/** Straight copy, used to downscale into the scope and thumbnail buffers. */
export const BLIT_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform bool uFlipY;
void main() {
  vec2 uv = uFlipY ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  fragColor = texture(uTex, uv);
}
`;
