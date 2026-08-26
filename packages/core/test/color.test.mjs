import test from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToLinear, linearToSrgb, linearToOklab, oklabToLinear, oklabToLch, lchToOklab,
  vectorscopeAngle, hueDelta, SKIN_TONE_LINE_DEG,
} from '../dist/color/space.js';
import { LOG_TRANSFORMS, logToLinear } from '../dist/color/log.js';
import { NATIVE_GAMUT, applyMat3, DISPLAY_RENDERS } from '../dist/color/gamut.js';

test('sRGB transfer round-trips', () => {
  for (let i = 0; i <= 100; i++) {
    const v = i / 100;
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-6, `failed at ${v}`);
  }
});

test('Oklab round-trips linear RGB', () => {
  const samples = [[0.18, 0.18, 0.18], [0.8, 0.2, 0.1], [0.02, 0.35, 0.6], [1, 1, 1], [0, 0, 0]];
  for (const c of samples) {
    const back = oklabToLinear(linearToOklab(c));
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - c[i]) < 1e-5, `${c} -> ${back}`);
    }
  }
});

test('LCh round-trips Oklab', () => {
  const lab = linearToOklab([0.6, 0.25, 0.1]);
  const back = lchToOklab(oklabToLch(lab));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - lab[i]) < 1e-9);
});

test('neutral grey has zero chroma in Oklab', () => {
  const lch = oklabToLch(linearToOklab([0.18, 0.18, 0.18]));
  assert.ok(lch[1] < 1e-4, `grey should have no chroma, got ${lch[1]}`);
});

test('a typical skin tone lands near the 123 degree vectorscope line', () => {
  // A mid Caucasian skin patch and a deeper skin patch, display-referred.
  for (const rgb of [[0.78, 0.57, 0.47], [0.42, 0.27, 0.20], [0.94, 0.76, 0.66]]) {
    const angle = vectorscopeAngle(rgb);
    const err = Math.abs(hueDelta(angle, SKIN_TONE_LINE_DEG));
    assert.ok(err < 22, `skin at ${rgb} sat ${angle.toFixed(1)}deg, ${err.toFixed(1)} off the line`);
  }
});

test('hueDelta takes the short way round', () => {
  assert.equal(hueDelta(10, 350), 20);
  assert.equal(hueDelta(350, 10), -20);
  assert.equal(hueDelta(0, 0), 0);
});

test('every log transform maps its mid-grey code value near 0.18 linear', () => {
  // Each curve is checked at the code value the manufacturer publishes for
  // 18% grey. A transform that misses this is visibly wrong on real footage.
  const midGrey = {
    slog3: 0.4105, logc3: 0.3910, logc4: 0.2784, vlog: 0.4230,
    clog3: 0.3309, redlog3g10: 0.3333, djidlog: 0.3988, flog: 0.4644,
  };
  for (const t of LOG_TRANSFORMS) {
    if (t.id === 'none') continue;
    const code = midGrey[t.id];
    assert.ok(code !== undefined, `no reference mid-grey for ${t.id}`);
    const lin = t.toLinear(code);
    assert.ok(
      Math.abs(lin - 0.18) < 0.035,
      `${t.label} maps ${code} to ${lin.toFixed(4)}, expected ~0.18`,
    );
  }
});

test('log transforms are monotonically increasing', () => {
  for (const t of LOG_TRANSFORMS) {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = t.toLinear(i / 200);
      assert.ok(Number.isFinite(v), `${t.label} produced ${v} at ${i / 200}`);
      assert.ok(v >= prev - 1e-9, `${t.label} reversed at ${i / 200}`);
      prev = v;
    }
  }
});

test('gamut matrices keep neutral grey neutral', () => {
  for (const [id, mat] of Object.entries(NATIVE_GAMUT)) {
    const out = applyMat3(mat, [0.18, 0.18, 0.18]);
    const spread = Math.max(...out) - Math.min(...out);
    assert.ok(spread < 0.006, `${id} tints grey by ${spread.toFixed(4)}`);
  }
});

test('display renders are monotonic and land inside 0..1', () => {
  for (const d of DISPLAY_RENDERS) {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = d.apply(i / 20); // 0..10, well past clipping
      assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `${d.label} produced ${v}`);
      assert.ok(v >= prev - 1e-6, `${d.label} reversed`);
      prev = v;
    }
  }
});

test('logToLinear dispatches to the same curve as the table entry', () => {
  const [r] = logToLinear([0.41, 0.41, 0.41], 'slog3');
  const direct = LOG_TRANSFORMS.find((t) => t.id === 'slog3').toLinear(0.41);
  assert.equal(r, direct);
});
