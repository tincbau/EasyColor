import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurveSampler, bakeCurveTexture, CURVE_LUT_SIZE } from '../dist/curves/spline.js';

test('identity curve maps x to x', () => {
  const f = buildCurveSampler([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(f(x) - x) < 1e-9, `f(${x}) = ${f(x)}`);
  }
});

test('curve passes exactly through its control points', () => {
  const pts = [{ x: 0, y: 0.1 }, { x: 0.3, y: 0.2 }, { x: 0.7, y: 0.9 }, { x: 1, y: 0.95 }];
  const f = buildCurveSampler(pts);
  for (const p of pts) {
    assert.ok(Math.abs(f(p.x) - p.y) < 1e-9, `f(${p.x}) = ${f(p.x)}, expected ${p.y}`);
  }
});

test('monotone data produces a monotone curve (no overshoot)', () => {
  // Catmull-Rom overshoots badly on this shape; Fritsch-Carlson must not.
  const f = buildCurveSampler([
    { x: 0, y: 0 },
    { x: 0.4, y: 0.02 },
    { x: 0.45, y: 0.9 },
    { x: 1, y: 1 },
  ]);
  let prev = -Infinity;
  for (let i = 0; i <= 400; i++) {
    const y = f(i / 400);
    assert.ok(y >= prev - 1e-9, `curve reversed at x=${i / 400}: ${y} < ${prev}`);
    assert.ok(y >= -1e-6 && y <= 1 + 1e-6, `curve left 0..1 at x=${i / 400}: ${y}`);
    prev = y;
  }
});

test('duplicate x values do not produce NaN', () => {
  const f = buildCurveSampler([{ x: 0, y: 0 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }]);
  for (let i = 0; i <= 100; i++) {
    assert.ok(Number.isFinite(f(i / 100)), `NaN at x=${i / 100}`);
  }
});

test('baked texture is the right size and identity-neutral', () => {
  const flat = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const tex = bakeCurveTexture({ master: flat, red: flat, green: flat, blue: flat });
  assert.equal(tex.length, CURVE_LUT_SIZE * 4);
  assert.equal(tex[0], 0);
  assert.equal(tex[3], 0);
  assert.equal(tex[(CURVE_LUT_SIZE - 1) * 4], 255);
  const mid = tex[128 * 4 + 3];
  assert.ok(Math.abs(mid - 128) <= 1, `master midpoint drifted: ${mid}`);
});
