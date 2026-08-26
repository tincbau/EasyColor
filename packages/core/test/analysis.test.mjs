import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWaveform, computeHistogram, computeVectorscope, computeParade, lumaPercentile } from '../dist/scopes/compute.js';
import { extractPalette } from '../dist/palette/kmeans.js';
import { matchToReference } from '../dist/palette/match.js';
import { analyzeSkin, solveSkinHueShift, rotateHue, weightedMeanVectorscope } from '../dist/skin/analyze.js';
import { defaultGrade } from '../dist/state/grade.js';
import { SKIN_TONE_LINE_DEG, hueDelta, vectorscopeAngle } from '../dist/color/space.js';

/** Build a test frame from a function of (x, y) returning [r,g,b] in 0..1. */
function frame(width, height, fn) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const solid = (rgb) => frame(64, 64, () => rgb);

test('a flat grey frame produces a single waveform level', () => {
  const wf = computeWaveform(solid([0.5, 0.5, 0.5]), 64);
  let nonZeroLevels = 0;
  for (let level = 0; level < wf.levels; level++) {
    let total = 0;
    for (let x = 0; x < wf.width; x++) total += wf.data[x * wf.levels + level];
    if (total > 0) nonZeroLevels++;
  }
  assert.equal(nonZeroLevels, 1, 'a flat frame should occupy exactly one level');
});

test('a horizontal ramp fills the waveform diagonally', () => {
  const wf = computeWaveform(frame(256, 16, (x) => [x / 255, x / 255, x / 255]), 256);
  // Column 0 should be black, the last column white.
  assert.ok(wf.data[0 * wf.levels + 0] > 0, 'left edge should be at level 0');
  assert.ok(wf.data[255 * wf.levels + 255] > 0, 'right edge should be at level 255');
  assert.equal(wf.data[0 * wf.levels + 255], 0, 'left edge must not reach white');
});

test('the parade separates channels', () => {
  const p = computeParade(solid([1, 0, 0]), 32);
  assert.ok(p.red.data[0 * 256 + 255] > 0, 'red channel should be at full');
  assert.ok(p.green.data[0 * 256 + 0] > 0, 'green channel should be at zero');
  assert.ok(p.blue.data[0 * 256 + 0] > 0, 'blue channel should be at zero');
});

test('histogram counts every pixel and ignores clipping bins when scaling', () => {
  const f = frame(100, 10, (x) => (x < 50 ? [0, 0, 0] : [0.5, 0.5, 0.5]));
  const h = computeHistogram(f);
  let total = 0;
  for (let i = 0; i < h.bins; i++) total += h.luma[i];
  assert.equal(total, 1000);
  assert.equal(h.luma[0], 500);
  // The 500 pure-black pixels must not set the peak, or the mid-grey spike
  // would be invisible in the drawn histogram.
  assert.ok(h.peak <= 500);
});

test('luma percentile finds the median', () => {
  const h = computeHistogram(frame(100, 10, (x) => {
    const v = x / 99;
    return [v, v, v];
  }));
  const median = lumaPercentile(h, 0.5);
  assert.ok(Math.abs(median - 0.5) < 0.06, `median was ${median}`);
});

test('a neutral frame sits at the centre of the vectorscope', () => {
  const v = computeVectorscope(solid([0.5, 0.5, 0.5]), 128);
  const centre = v.data[64 * 128 + 64];
  assert.ok(centre > 0, 'neutral pixels belong at the centre');
  assert.equal(v.meanSaturation, 0, 'neutral has no saturation to average');
});

test('a skin-toned frame reads near 123 degrees on the vectorscope', () => {
  const v = computeVectorscope(solid([0.78, 0.57, 0.47]), 128);
  const err = Math.abs(hueDelta(v.meanAngle, SKIN_TONE_LINE_DEG));
  assert.ok(err < 20, `mean angle ${v.meanAngle.toFixed(1)} is ${err.toFixed(1)} off the line`);
});

test('palette extraction finds the planted colours', () => {
  // Three distinct bands.
  const colors = [[0.85, 0.15, 0.15], [0.15, 0.65, 0.25], [0.2, 0.3, 0.85]];
  const f = frame(90, 30, (x) => colors[Math.floor(x / 30)]);

  const palette = extractPalette(f, { count: 3, stride: 1 });
  assert.equal(palette.length, 3);

  for (const target of colors) {
    const found = palette.some(
      (s) => Math.hypot(s.rgb[0] - target[0], s.rgb[1] - target[1], s.rgb[2] - target[2]) < 0.12,
    );
    assert.ok(found, `palette missed ${target}: got ${palette.map((s) => s.rgb.map((v) => v.toFixed(2)))}`);
  }
  const totalWeight = palette.reduce((a, s) => a + s.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-6, 'weights should sum to 1');
});

test('palette extraction is deterministic', () => {
  const f = frame(60, 60, (x, y) => [(x / 60), (y / 60), 0.4]);
  const a = extractPalette(f, { count: 4 });
  const b = extractPalette(f, { count: 4 });
  assert.deepEqual(a.map((s) => s.rgb), b.map((s) => s.rgb));
});

test('matching a frame to itself is close to a no-op', () => {
  const f = frame(60, 60, (x, y) => [0.2 + x / 200, 0.4, 0.7 - y / 300]);
  const result = matchToReference(defaultGrade(), f, f);
  assert.ok(Math.abs(result.grade.primaries.exposure) < 0.08, `exposure drifted to ${result.grade.primaries.exposure}`);
  assert.ok(Math.abs(result.grade.primaries.saturation - 1) < 0.15);
  assert.ok(Math.abs(result.grade.primaries.temperature) < 0.12);
});

test('matching a dark frame to a bright reference raises exposure', () => {
  const dark = solid([0.12, 0.12, 0.13]);
  const bright = solid([0.62, 0.6, 0.58]);
  const result = matchToReference(defaultGrade(), dark, bright);
  assert.ok(result.grade.primaries.exposure > 0.5, `expected a positive push, got ${result.grade.primaries.exposure}`);
  assert.ok(result.notes.length > 0);
});

test('matching a warm frame to a cool reference cools it', () => {
  const warm = solid([0.7, 0.5, 0.35]);
  const cool = solid([0.4, 0.5, 0.7]);
  const result = matchToReference(defaultGrade(), warm, cool, { perColor: false });
  assert.ok(result.grade.primaries.temperature < 0, `expected cooling, got ${result.grade.primaries.temperature}`);
});

test('rotating hue moves the vectorscope angle in the same direction', () => {
  const rgb = [0.7, 0.45, 0.35];
  const before = vectorscopeAngle(rgb);
  const after = vectorscopeAngle(rotateHue(rgb, 20));
  assert.ok(hueDelta(after, before) > 5, `expected a counter-clockwise move, got ${hueDelta(after, before)}`);
});

test('the skin solver lands the cluster on the 123 line', () => {
  // A face-like patch pushed well off the line to start with.
  const off = frame(48, 48, () => [0.82, 0.52, 0.38]);
  const skin = { ...defaultGrade().skin, enabled: true };

  // Widen the qualifier so the synthetic patch is definitely selected.
  const analysis = analyzeSkin(off, { ...skin, hueWidth: 60, hueSoftness: 40, chromaLow: 0, chromaHigh: 0.5, lumaLow: 0, lumaHigh: 1.4 }, 1);
  assert.ok(analysis.samples.length > 100, `only ${analysis.samples.length} samples selected`);

  const shift = solveSkinHueShift(analysis.samples);
  const corrected = analysis.samples.map((s) => ({ rgb: rotateHue(s.rgb, shift), weight: s.weight }));
  const angle = weightedMeanVectorscope(corrected).angle;

  assert.ok(
    Math.abs(hueDelta(angle, SKIN_TONE_LINE_DEG)) < 0.5,
    `after a ${shift.toFixed(2)} degree shift the cluster sits at ${angle.toFixed(2)}`,
  );
});

test('the skin solver declines rather than lurching when there is nothing to align', () => {
  assert.equal(solveSkinHueShift([]), 0);
  // A pure neutral patch has no meaningful angle to correct.
  const neutral = [{ rgb: [0.5, 0.5, 0.5], weight: 1 }];
  assert.equal(Number.isFinite(solveSkinHueShift(neutral)), true);
});
