import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../dist/state/history.js';
import { defaultGrade, cloneGrade, isNeutralGrade } from '../dist/state/grade.js';
import { serialiseProject, deserialiseProject, ProjectLoadError, encodeBase64, decodeBase64 } from '../dist/state/project.js';
import { LOOK_PRESETS } from '../dist/state/presets.js';

test('a fresh grade is neutral, and any edit makes it non-neutral', () => {
  const g = defaultGrade();
  assert.equal(isNeutralGrade(g), true);
  g.primaries.contrast = 0.1;
  assert.equal(isNeutralGrade(g), false);
});

test('cloneGrade is deep: mutating the clone leaves the original alone', () => {
  const g = defaultGrade();
  g.zones = [{ id: 'a', sampleRgb: [1, 0, 0], hueShift: 0 }];
  const c = cloneGrade(g);
  c.primaries.exposure = 2;
  c.wheels.lift.luma = 0.5;
  c.zones[0].hueShift = 30;
  c.zones[0].sampleRgb[0] = 0;

  assert.equal(g.primaries.exposure, 0);
  assert.equal(g.wheels.lift.luma, 0);
  assert.equal(g.zones[0].hueShift, 0);
  assert.equal(g.zones[0].sampleRgb[0], 1);
});

test('history undo and redo walk the timeline', () => {
  const g = defaultGrade();
  const h = new History(g);
  assert.equal(h.canUndo, false);

  const a = cloneGrade(g); a.primaries.exposure = 1;
  h.push(a, 'Exposure');
  const b = cloneGrade(a); b.primaries.contrast = 0.3;
  h.push(b, 'Contrast');

  assert.equal(h.current.primaries.contrast, 0.3);
  h.undo();
  assert.equal(h.current.primaries.contrast, 0);
  assert.equal(h.current.primaries.exposure, 1);
  h.undo();
  assert.equal(h.current.primaries.exposure, 0);
  assert.equal(h.canUndo, false);

  h.redo();
  assert.equal(h.current.primaries.exposure, 1);
});

test('a continuous drag coalesces into one undo step', () => {
  let now = 1000;
  const g = defaultGrade();
  const h = new History(g, { now: () => now });

  for (let i = 1; i <= 5; i++) {
    const s = cloneGrade(g);
    s.primaries.exposure = i * 0.1;
    now += 40;
    h.push(s, 'Exposure', 'primaries:exposure');
  }

  assert.equal(h.list.length, 2, 'the whole drag should be a single entry after "Open"');
  h.undo();
  assert.equal(h.current.primaries.exposure, 0);
});

test('breakMerge ends a gesture so the next edit is its own step', () => {
  let now = 1000;
  const g = defaultGrade();
  const h = new History(g, { now: () => now });

  const a = cloneGrade(g); a.primaries.exposure = 0.5;
  h.push(a, 'Exposure', 'primaries:exposure');
  h.breakMerge();
  const b = cloneGrade(a); b.primaries.exposure = 0.9;
  now += 10;
  h.push(b, 'Exposure', 'primaries:exposure');

  assert.equal(h.list.length, 3);
});

test('editing after an undo discards the abandoned redo branch', () => {
  const g = defaultGrade();
  const h = new History(g);
  const a = cloneGrade(g); a.primaries.exposure = 1;
  h.push(a, 'A');
  const b = cloneGrade(a); b.primaries.exposure = 2;
  h.push(b, 'B');

  h.undo();
  assert.equal(h.canRedo, true);
  const c = cloneGrade(a); c.primaries.contrast = 0.5;
  h.push(c, 'C');
  assert.equal(h.canRedo, false);
  assert.equal(h.list.at(-1).label, 'C');
});

test('jumpTo moves anywhere on the timeline', () => {
  const g = defaultGrade();
  const h = new History(g);
  for (let i = 1; i <= 4; i++) {
    const s = cloneGrade(g); s.primaries.exposure = i;
    h.push(s, `Step ${i}`);
  }
  h.jumpTo(2);
  assert.equal(h.current.primaries.exposure, 2);
  assert.equal(h.jumpTo(99), null);
});

test('base64 round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 1024]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 255;
    const back = decodeBase64(encodeBase64(bytes));
    assert.equal(back.length, len, `length mismatch at ${len}`);
    for (let i = 0; i < len; i++) assert.equal(back[i], bytes[i], `byte ${i} at length ${len}`);
  }
});

test('a project round-trips, LUT payload included', () => {
  const g = defaultGrade();
  g.name = 'Night exterior';
  g.primaries.exposure = -0.75;
  g.source.logTransform = 'slog3';
  g.zones = [{ id: 'z1', label: 'Sky', enabled: true, solo: false, hue: 250, hueWidth: 20,
    hueSoftness: 25, chromaLow: 0.02, chromaHigh: 0.4, chromaSoftness: 0.05, lumaLow: 0.3,
    lumaHigh: 1, lumaSoftness: 0.2, hueShift: -12, satGain: 1.3, lumGain: 0.1,
    labOffsetA: 0, labOffsetB: 0, strength: 1, sampleRgb: [0.2, 0.4, 0.8] }];

  const size = 3;
  g.lut = { enabled: true, name: 'test.cube', size, intensity: 0.8, stage: 'display',
    data: Float32Array.from({ length: size ** 3 * 3 }, (_, i) => i / 100) };

  const back = deserialiseProject(serialiseProject(g));
  assert.equal(back.name, 'Night exterior');
  assert.equal(back.primaries.exposure, -0.75);
  assert.equal(back.source.logTransform, 'slog3');
  assert.equal(back.zones.length, 1);
  assert.equal(back.zones[0].hueShift, -12);
  assert.equal(back.lut.size, size);
  assert.equal(back.lut.data.length, g.lut.data.length);
  for (let i = 0; i < g.lut.data.length; i++) {
    assert.ok(Math.abs(back.lut.data[i] - g.lut.data[i]) < 1e-6, `LUT value ${i} drifted`);
  }
});

test('a project saved without a newer control still opens', () => {
  const g = defaultGrade();
  const json = JSON.parse(serialiseProject(g));
  delete json.primaries.vibrance;
  delete json.skin;
  const back = deserialiseProject(JSON.stringify(json));
  assert.equal(back.primaries.vibrance, 0);
  assert.equal(back.skin.enabled, false);
});

test('bad project files fail with a readable message', () => {
  assert.throws(() => deserialiseProject('not json'), ProjectLoadError);
  assert.throws(() => deserialiseProject('{"version":99}'), /different version/);
});

test('Reset look clears the film settings a stock auto-loaded', () => {
  const g = defaultGrade();
  g.film.stock = 'cinestill800t';
  g.film.grain = { ...g.film.grain, enabled: true, amount: 0.42 };
  g.film.halation = { ...g.film.halation, enabled: true, strength: 0.85 };

  const reset = LOOK_PRESETS.find((p) => p.id === 'neutral').apply(g);
  assert.equal(reset.film.stock, 'none');
  assert.equal(reset.film.grain.enabled, false, 'grain must not survive a reset');
  assert.equal(reset.film.halation.enabled, false, 'halation must not survive a reset');
});

test('every look preset returns a usable grade and leaves the input alone', () => {
  for (const preset of LOOK_PRESETS) {
    const before = defaultGrade();
    before.primaries.exposure = 0.42;
    before.source.logTransform = 'logc3';
    const snapshot = JSON.stringify(before);

    const after = preset.apply(before);
    assert.equal(JSON.stringify(before), snapshot, `${preset.id} mutated its input`);
    assert.ok(Number.isFinite(after.primaries.exposure), `${preset.id} produced a bad exposure`);
    // Camera conversion must survive a creative look.
    assert.equal(after.source.logTransform, 'logc3', `${preset.id} discarded the camera conversion`);
  }
});
