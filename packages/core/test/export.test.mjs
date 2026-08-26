import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportPlan, widenWindow, renderWindowMask } from '../dist/export/plan.js';
import { defaultGrade, createWindow, createZone } from '../dist/state/grade.js';

test('a plain grade needs no window layers', () => {
  const plan = buildExportPlan(defaultGrade());
  assert.equal(plan.windows.length, 0);
  assert.equal(plan.halation, null);
  assert.equal(plan.grain, null);
  assert.equal(plan.base.windows.length, 0);
});

test('the base layer drops windows but keeps everything else', () => {
  const g = defaultGrade();
  g.primaries.exposure = 0.5;
  g.zones = [createZone('z', [1, 0, 0], 30, 0.1, 0.5)];
  g.windows = [createWindow('w', 'ellipse')];

  const plan = buildExportPlan(g);
  assert.equal(plan.base.windows.length, 0, 'windows must not be in the base cube');
  assert.equal(plan.base.primaries.exposure, 0.5);
  assert.equal(plan.base.zones.length, 1, 'zones bake into the base cube');
});

test('each enabled window becomes a layer with its shape widened away', () => {
  const g = defaultGrade();
  const a = { ...createWindow('a', 'ellipse'), exposure: -1 };
  const b = { ...createWindow('b', 'rect'), enabled: false };
  g.windows = [a, b];

  const plan = buildExportPlan(g);
  assert.equal(plan.windows.length, 1, 'a disabled window needs no layer');

  const layer = plan.windows[0];
  assert.equal(layer.window.id, 'a');
  assert.equal(layer.grade.windows.length, 1);

  const widened = layer.grade.windows[0];
  assert.ok(widened.rx >= 10 && widened.ry >= 10, 'the shape must cover the frame');
  assert.equal(widened.invert, false);
  // The correction itself must survive: it is what the cube encodes.
  assert.equal(widened.exposure, -1);
});

test('widenWindow keeps the correction and discards only the shape', () => {
  const w = {
    ...createWindow('w', 'rect'),
    cx: 0.2, cy: 0.8, rx: 0.1, ry: 0.05, rotation: 33,
    softness: 0.9, invert: true, opacity: 0.5,
    exposure: 0.7, saturation: 1.4, temperature: -0.3,
  };
  const wide = widenWindow(w);

  assert.equal(wide.exposure, 0.7);
  assert.equal(wide.saturation, 1.4);
  assert.equal(wide.temperature, -0.3);
  assert.equal(wide.invert, false);
  assert.equal(wide.opacity, 1, 'opacity moves to the mask, not the cube');
  assert.ok(wide.rx >= 10);
});

test('notes name every approximation and nothing else', () => {
  const clean = buildExportPlan(defaultGrade());
  assert.ok(!clean.notes.some((n) => /halation|grain/i.test(n)));

  const g = defaultGrade();
  g.film.halation.enabled = true;
  g.film.halation.strength = 0.5;
  g.film.grain.enabled = true;
  const plan = buildExportPlan(g);
  assert.ok(plan.notes.some((n) => /halation/i.test(n)));
  assert.ok(plan.notes.some((n) => /grain/i.test(n)));
});

/* ---- window masks ---- */

const maskAt = (mask, w, h, u, v) =>
  mask[Math.floor(v * h) * w + Math.floor(u * w)];

test('an ellipse mask is solid at the centre and empty far outside', () => {
  const w = { ...createWindow('w', 'ellipse'), cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, softness: 0.2 };
  const mask = renderWindowMask(w, 200, 200);
  assert.equal(maskAt(mask, 200, 200, 0.5, 0.5), 255);
  assert.equal(maskAt(mask, 200, 200, 0.02, 0.02), 0);
});

test('the mask feathers monotonically outward', () => {
  const w = { ...createWindow('w', 'ellipse'), cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, softness: 0.5 };
  const mask = renderWindowMask(w, 200, 200);
  let prev = 256;
  for (let x = 100; x < 200; x++) {
    const v = mask[100 * 200 + x];
    assert.ok(v <= prev, `mask rose again at x=${x}`);
    prev = v;
  }
});

test('inverting a mask complements it', () => {
  const base = { ...createWindow('w', 'ellipse'), cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, softness: 0.3 };
  const normal = renderWindowMask({ ...base, invert: false }, 128, 128);
  const inverted = renderWindowMask({ ...base, invert: true }, 128, 128);
  for (let i = 0; i < normal.length; i += 97) {
    assert.ok(Math.abs(255 - normal[i] - inverted[i]) <= 1, `mismatch at ${i}`);
  }
});

test('a rectangle mask fills its corners where an ellipse would not', () => {
  const shape = { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.4, softness: 0.02, corner: 0 };
  const rect = renderWindowMask({ ...createWindow('r', 'rect'), ...shape }, 200, 200);
  const ellipse = renderWindowMask({ ...createWindow('e', 'ellipse'), ...shape }, 200, 200);

  // Just inside the corner of the box, on the diagonal.
  const u = 0.5 + 0.4 * 0.85;
  assert.ok(maskAt(rect, 200, 200, u, u) > 200, 'a rectangle should cover its corner');
  assert.equal(maskAt(ellipse, 200, 200, u, u), 0, 'an ellipse should not');
});

test('a rotated window mask follows its rotation', () => {
  const base = { ...createWindow('w', 'ellipse'), cx: 0.5, cy: 0.5, rx: 0.35, ry: 0.08, softness: 0.05 };
  const flat = renderWindowMask({ ...base, rotation: 0 }, 200, 200);
  const upright = renderWindowMask({ ...base, rotation: 90 }, 200, 200);

  // A wide, flat ellipse covers a point to its side but not above it.
  assert.ok(maskAt(flat, 200, 200, 0.78, 0.5) > 100);
  assert.equal(maskAt(flat, 200, 200, 0.5, 0.78), 0);
  // Rotated ninety degrees, exactly the opposite.
  assert.equal(maskAt(upright, 200, 200, 0.78, 0.5), 0);
  assert.ok(maskAt(upright, 200, 200, 0.5, 0.78) > 100);
});

test('window opacity scales the mask', () => {
  const w = { ...createWindow('w', 'ellipse'), cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, opacity: 0.5 };
  const mask = renderWindowMask(w, 100, 100);
  assert.ok(Math.abs(maskAt(mask, 100, 100, 0.5, 0.5) - 128) <= 1);
});

test('masks are isotropic, so equal radii are a circle on any aspect ratio', () => {
  // On a 2:1 frame, a window with equal rx and ry must be circular in pixels.
  // Normalising rx to width instead would make it twice as wide as it is
  // tall — a circle on screen exporting as an oval.
  const w = { ...createWindow('w', 'ellipse'), cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, softness: 0.02 };
  const mask = renderWindowMask(w, 400, 200);

  // Walk out horizontally and vertically from the centre; the covered radius
  // in *pixels* should match.
  let horizontal = 0;
  for (let x = 200; x < 400; x++, horizontal++) if (mask[100 * 400 + x] < 128) break;
  let vertical = 0;
  for (let y = 100; y < 200; y++, vertical++) if (mask[y * 400 + 200] < 128) break;

  assert.ok(
    Math.abs(horizontal - vertical) <= 2,
    `ellipse is not round: ${horizontal}px across vs ${vertical}px down`,
  );
});
