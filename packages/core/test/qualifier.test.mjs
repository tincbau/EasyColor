import test from 'node:test';
import assert from 'node:assert/strict';
import { toLch, zoneWeight, softWindow, softBand } from '../dist/interaction/qualifier.js';
import { defaultGrade, createZone, MAX_HSL_ZONES } from '../dist/state/grade.js';
import {
  beginHslGrade, updateHslGrade, findZoneFor, axisFor, resetZoneIds, dragWasNoOp,
  beginTonalGrade, updateTonalGrade, tonalRangeFor, beginScopeDrag, updateScopeDrag,
} from '../dist/interaction/onViewer.js';

const NONE = { shift: false, ctrl: false, alt: false, meta: false };
const sample = (rgb) => ({ base: rgb, graded: rgb });

test('soft window is flat-topped and reaches zero outside the feather', () => {
  assert.equal(softWindow(0.5, 0.3, 0.7, 0.1), 1);
  assert.equal(softWindow(0.1, 0.3, 0.7, 0.1), 0);
  assert.equal(softWindow(0.95, 0.3, 0.7, 0.1), 0);
  const edge = softWindow(0.25, 0.3, 0.7, 0.1);
  assert.ok(edge > 0 && edge < 1, `expected a partial weight in the feather, got ${edge}`);
});

test('soft band feathers monotonically away from the centre', () => {
  let prev = 1.1;
  for (let d = 0; d <= 60; d += 2) {
    const w = softBand(d, 20, 20);
    assert.ok(w <= prev + 1e-9, `band rose again at ${d} degrees`);
    prev = w;
  }
  assert.equal(softBand(0, 20, 20), 1);
  assert.equal(softBand(45, 20, 20), 0);
});

test('modifier keys select the documented axis lock', () => {
  assert.equal(axisFor(NONE), 'both');
  assert.equal(axisFor({ ...NONE, shift: true }), 'saturation');
  assert.equal(axisFor({ ...NONE, ctrl: true }), 'luminance');
  assert.equal(axisFor({ ...NONE, alt: true }), 'luminance');
  // Shift wins so an ambiguous chord still does exactly one thing.
  assert.equal(axisFor({ ...NONE, shift: true, ctrl: true }), 'saturation');
});

test('clicking a colour creates one zone; clicking it again reuses that zone', () => {
  resetZoneIds();
  let grade = defaultGrade();

  const red = sample([0.75, 0.2, 0.18]);
  const first = beginHslGrade(grade, red);
  grade = first.grade;
  assert.equal(grade.zones.length, 1);
  assert.ok(first.drag);
  assert.equal(first.drag.created, true);

  const second = beginHslGrade(grade, red);
  assert.equal(second.grade.zones.length, 1, 'a second click must not stack a zone');
  assert.equal(second.drag.created, false);
  assert.equal(second.drag.zoneId, first.drag.zoneId);
});

test('grading a second colour leaves the first colour untouched', () => {
  resetZoneIds();
  let grade = defaultGrade();

  const red = sample([0.75, 0.2, 0.18]);
  const blue = sample([0.18, 0.28, 0.8]);

  const a = beginHslGrade(grade, red);
  grade = updateHslGrade(a.grade, a.drag, 0.4, -0.2, NONE);
  const redZone = { ...grade.zones.find((z) => z.id === a.drag.zoneId) };

  const b = beginHslGrade(grade, blue);
  grade = updateHslGrade(b.grade, b.drag, -0.3, 0.25, NONE);

  assert.equal(grade.zones.length, 2);
  const redAfter = grade.zones.find((z) => z.id === a.drag.zoneId);
  assert.deepEqual(
    { h: redAfter.hueShift, s: redAfter.satGain, l: redAfter.lumGain },
    { h: redZone.hueShift, s: redZone.satGain, l: redZone.lumGain },
    'the first zone must not move when a second colour is graded',
  );
});

test('a zone keeps matching its subject after its hue has been rotated', () => {
  resetZoneIds();
  let grade = defaultGrade();
  const teal = sample([0.15, 0.55, 0.6]);

  const a = beginHslGrade(grade, teal);
  grade = updateHslGrade(a.grade, a.drag, 0.9, 0, NONE); // large hue rotation
  const zone = grade.zones[0];
  assert.ok(Math.abs(zone.hueShift) > 20, 'test needs a real rotation to be meaningful');

  // Matching is against the pre-grade colour, so the same click still lands.
  const found = findZoneFor(grade, toLch(teal.base));
  assert.ok(found, 'zone should still be found after its hue was rotated');
  assert.equal(found.id, a.drag.zoneId);
});

test('drags are absolute: the same endpoint gives the same result', () => {
  resetZoneIds();
  const grade = defaultGrade();
  const a = beginHslGrade(grade, sample([0.7, 0.4, 0.2]));

  const direct = updateHslGrade(a.grade, a.drag, 0.3, -0.15, NONE);

  let stepwise = a.grade;
  for (const [du, dv] of [[0.1, -0.05], [0.2, -0.1], [0.3, -0.15]]) {
    stepwise = updateHslGrade(stepwise, a.drag, du, dv, NONE);
  }

  const z1 = direct.zones[0];
  const z2 = stepwise.zones[0];
  assert.equal(z1.hueShift, z2.hueShift);
  assert.equal(z1.satGain, z2.satGain);
});

test('Shift locks to saturation and Ctrl locks to luminance', () => {
  resetZoneIds();
  const grade = defaultGrade();
  const a = beginHslGrade(grade, sample([0.7, 0.4, 0.2]));
  const start = a.grade.zones[0];

  const sat = updateHslGrade(a.grade, a.drag, 0.5, -0.3, { ...NONE, shift: true }).zones[0];
  assert.equal(sat.hueShift, start.hueShift, 'Shift must not change hue');
  assert.equal(sat.lumGain, start.lumGain, 'Shift must not change luminance');
  assert.ok(sat.satGain > start.satGain);

  const lum = updateHslGrade(a.grade, a.drag, 0.5, -0.3, { ...NONE, ctrl: true }).zones[0];
  assert.equal(lum.hueShift, start.hueShift, 'Ctrl must not change hue');
  assert.equal(lum.satGain, start.satGain, 'Ctrl must not change saturation');
  assert.ok(lum.lumGain > start.lumGain);
});

test('a click with no movement is reported as a no-op', () => {
  resetZoneIds();
  const grade = defaultGrade();
  const a = beginHslGrade(grade, sample([0.3, 0.6, 0.35]));
  assert.equal(dragWasNoOp(a.grade, a.drag), true);
  const moved = updateHslGrade(a.grade, a.drag, 0.2, 0, NONE);
  assert.equal(dragWasNoOp(moved, a.drag), false);
});

test('the zone budget is reported rather than silently exceeded', () => {
  let grade = defaultGrade();
  // Fill every slot with well-separated, tight hues.
  grade.zones = Array.from({ length: MAX_HSL_ZONES }, (_, i) => ({
    ...createZone(`z${i}`, [0.5, 0.5, 0.5], i * (360 / MAX_HSL_ZONES), 0.1, 0.5),
    hueWidth: 2,
    hueSoftness: 2,
    chromaLow: 0.09,
    chromaHigh: 0.11,
  }));

  const result = beginHslGrade(grade, sample([0.99, 0.99, 0.99]));
  assert.equal(result.drag, null);
  assert.match(result.problem, /zones are in use/);
});

test('tonal ranges map brightness to the expected wheel', () => {
  assert.equal(tonalRangeFor(0.1), 'shadows');
  assert.equal(tonalRangeFor(0.5), 'midtones');
  assert.equal(tonalRangeFor(0.9), 'highlights');
});

test('dragging up on a shadow raises Lift, not Gain', () => {
  const grade = defaultGrade();
  const drag = beginTonalGrade(grade, sample([0.08, 0.08, 0.09]));
  assert.equal(drag.wheel, 'lift');

  const next = updateTonalGrade(grade, drag, 0, -0.4, NONE);
  assert.ok(next.wheels.lift.luma > 0);
  assert.equal(next.wheels.gain.luma, 0);
  assert.equal(next.wheels.gamma.luma, 0);
});

test('dragging a scope adjusts exposure, and with Shift the matching wheel', () => {
  const grade = defaultGrade();

  const plain = beginScopeDrag(grade, 0.9);
  const exposed = updateScopeDrag(grade, plain, -0.2, NONE);
  assert.ok(exposed.primaries.exposure > 0);
  assert.equal(exposed.wheels.gain.luma, 0);

  const shifted = updateScopeDrag(grade, plain, -0.2, { ...NONE, shift: true });
  assert.equal(shifted.primaries.exposure, 0);
  assert.ok(shifted.wheels.gain.luma > 0, 'grabbing the top of the scope should move Gain');
});

test('zone weight falls to zero well outside the qualifier', () => {
  const zone = createZone('z', [0.8, 0.3, 0.2], 30, 0.12, 0.6);
  assert.ok(zoneWeight(zone, { l: 0.6, c: 0.12, h: 30 }) > 0.9);
  assert.equal(zoneWeight(zone, { l: 0.6, c: 0.12, h: 210 }), 0);
  assert.equal(zoneWeight(zone, { l: 0.6, c: 0.0, h: 30 }), 0, 'a neutral pixel is not in a hue zone');
});
