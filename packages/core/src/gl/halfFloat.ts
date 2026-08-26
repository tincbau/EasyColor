/**
 * IEEE 754 half-precision decoding.
 *
 * `readPixels` on an RGBA16F attachment hands back raw 16-bit patterns in a
 * Uint16Array; JavaScript has no Float16Array, so they have to be unpacked
 * by hand to be usable as numbers.
 */

export function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    // Subnormal, including zero.
    return sign * fraction * Math.pow(2, -24);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + fraction / 1024) * Math.pow(2, exponent - 15);
}

export function decodeHalfArray(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = decodeHalf(src[i]);
  return out;
}
