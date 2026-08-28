import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFace, FaceTracker, applyTrackToWindow } from '../dist/track/faceTrack.js';
import { renderWindowMask } from '../dist/export/plan.js';
import { defaultGrade, createWindow } from '../dist/state/grade.js';

const SKIN = defaultGrade().skin;
/** A colour the default qualifier selects strongly (checked by the first test). */
const FACE = [200, 138, 112];
const BG = [64, 64, 70];

/** Draw a frame: neutral background plus filled ellipses of a given colour. */
function frame(width, height, blobs) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rgb = BG;
      for (const b of blobs) {
        const a = ((b.angle ?? 0) * Math.PI) / 180;
        const dx = x - b.cx;
        const dy = y - b.cy;
        const lx = dx * Math.cos(a) + dy * Math.sin(a);
        const ly = -dx * Math.sin(a) + dy * Math.cos(a);
        if ((lx / b.rx) ** 2 + (ly / b.ry) ** 2 <= 1) rgb = b.color ?? FACE;
      }
      const i = (y * width + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test('the default qualifier accepts the test face colour and rejects the background', () => {
  const f = frame(64, 64, [{ cx: 32, cy: 32, rx: 16, ry: 16 }]);
  const found = detectFace(f, SKIN, { minMass: 20 });
  assert.ok(found, 'the face blob should be detected');
  const empty = detectFace(frame(64, 64, []), SKIN, { minMass: 20 });
  assert.equal(empty, null, 'a frame with no skin has no face');
});

test('the detected centre lands on the blob', () => {
  const f = frame(320, 180, [{ cx: 224, cy: 63, rx: 30, ry: 40 }]);
  const face = detectFace(f, SKIN);
  assert.ok(face);
  assert.ok(Math.abs(face.cx - 224 / 320) < 0.03, `cx ${face.cx}`);
  assert.ok(Math.abs(face.cy - 63 / 180) < 0.03, `cy ${face.cy}`);
});

test('the fitted ellipse actually covers the blob when rendered as a window mask', () => {
  // The strongest possible check: apply the fit to a real power window, run
  // it through the same mask renderer the export uses, and demand the mask
  // covers the blob. Convention mistakes — axis units, rotation sign, y
  // direction — all fail this no matter how self-consistent they are.
  const w = 320;
  const h = 180;
  const blob = { cx: 200, cy: 90, rx: 26, ry: 44, angle: 30 };
  const face = detectFace(frame(w, h, [blob]), SKIN);
  assert.ok(face);

  const window = applyTrackToWindow(
    { ...createWindow('t', 'ellipse'), softness: 0.02 },
    face,
  );
  const mask = renderWindowMask(window, w, h);

  let inside = 0;
  let covered = 0;
  let maskArea = 0;
  const a = (blob.angle * Math.PI) / 180;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - blob.cx;
      const dy = y - blob.cy;
      const lx = dx * Math.cos(a) + dy * Math.sin(a);
      const ly = -dx * Math.sin(a) + dy * Math.cos(a);
      const inBlob = (lx / blob.rx) ** 2 + (ly / blob.ry) ** 2 <= 1;
      const inMask = mask[y * w + x] > 128;
      if (inBlob) { inside++; if (inMask) covered++; }
      if (inMask) maskArea++;
    }
  }

  const coverage = covered / inside;
  assert.ok(coverage > 0.95, `mask covers only ${(coverage * 100).toFixed(1)}% of the blob`);
  // Padding means the mask is larger than the blob, but not absurdly so.
  assert.ok(maskArea < inside * 4, `mask is ${(maskArea / inside).toFixed(1)}x the blob`);
});

test('an elongated tilted blob yields a matching orientation', () => {
  const face = detectFace(frame(320, 180, [{ cx: 160, cy: 90, rx: 18, ry: 55, angle: 25 }]), SKIN);
  assert.ok(face);
  assert.ok(face.rx > face.ry, 'major axis first');
  // The blob's long axis is its local y rotated by 25°; the fit's major axis
  // should sit 90° from the blob's x-angle, mod 180.
  const expected = 25 + 90;
  const delta = Math.abs((((face.rotation - expected) % 180) + 270) % 180 - 90);
  assert.ok(delta < 8, `rotation ${face.rotation.toFixed(1)}, expected ~${expected} mod 180`);
});

test('component choice: a larger far blob does not steal an established track', () => {
  const f = frame(320, 180, [
    { cx: 80, cy: 90, rx: 22, ry: 30 },              // the face being tracked
    { cx: 260, cy: 90, rx: 34, ry: 44 },             // a bigger blob elsewhere
  ]);

  const cold = detectFace(f, SKIN);
  assert.ok(Math.abs(cold.cx - 260 / 320) < 0.05, 'with no history the bigger blob wins');

  const warm = detectFace(f, SKIN, { near: { cx: 80 / 320, cy: 0.5 } });
  assert.ok(Math.abs(warm.cx - 80 / 320) < 0.05,
    `continuity should hold the smaller blob, got cx ${warm.cx.toFixed(3)}`);
});

test('the tracker follows a moving blob and smooths the path', () => {
  const tracker = new FaceTracker();
  let last = null;
  const centres = [];
  for (let step = 0; step < 12; step++) {
    const cx = 60 + step * 16;
    const result = tracker.update(frame(320, 180, [{ cx, cy: 90, rx: 24, ry: 32 }]), SKIN);
    assert.equal(result.state, 'tracking');
    centres.push(result.ellipse.cx * 320);
    last = result.ellipse;
  }
  // It follows, minus the EMA's steady-state lag: an exponential filter at
  // follow factor a tracking constant velocity v settles v(1-a)/a behind —
  // here 16·0.6/0.4 = 24px. Ending within that lag plus slack IS correct
  // behaviour; ending closer would mean the smoothing isn't smoothing.
  const lag = 16 * (1 - 0.4) / 0.4;
  assert.ok(Math.abs(centres.at(-1) - (60 + 11 * 16 - lag)) < 12, `ended at ${centres.at(-1)}`);
  // ...and it smooths: the first tracked step moves less than the raw jump.
  assert.ok(centres[1] - centres[0] < 16, 'smoothing should lag the raw motion');
  assert.ok(last.confidence > 0.5);
});

test('a brief occlusion coasts; a long one is lost', () => {
  const tracker = new FaceTracker({ graceFrames: 3 });
  tracker.update(frame(320, 180, [{ cx: 160, cy: 90, rx: 24, ry: 32 }]), SKIN);

  const empty = frame(320, 180, []);
  for (let i = 0; i < 3; i++) {
    const r = tracker.update(empty, SKIN);
    assert.equal(r.state, 'coasting', `frame ${i} should coast`);
    assert.ok(r.ellipse, 'coasting keeps the last fit');
  }
  const gone = tracker.update(empty, SKIN);
  assert.equal(gone.state, 'lost');
  assert.equal(gone.ellipse, null);

  // And it can re-acquire from scratch afterwards.
  const back = tracker.update(frame(320, 180, [{ cx: 100, cy: 60, rx: 24, ry: 32 }]), SKIN);
  assert.equal(back.state, 'tracking');
});

/* ---- plausibility: the difference between tracking and smearing ---- */

test('a frame filled with skin tone yields no face, not a frame-sized window', () => {
  // The shipped failure: on real footage the qualifier accepted a warm
  // wall, the fit wrapped the whole frame, and the window became a
  // gradient smeared across the image. The only right answer to "everything
  // is skin-coloured" is "then I cannot see a face".
  const wall = frame(320, 180, [{ cx: 160, cy: 90, rx: 400, ry: 400 }]);
  assert.equal(detectFace(wall, SKIN), null);
});

test('a large warm background loses to the face on plausibility', () => {
  // A skin-toned band across the lower 60% of frame (sand, wood panelling)
  // and a face on the neutral part above it. The band has far more mass —
  // it must be rejected by the gates, not chosen and smeared.
  const f = frame(320, 180, [
    { cx: 160, cy: 160, rx: 380, ry: 75 },           // the "sand"
    { cx: 200, cy: 40, rx: 20, ry: 26 },             // the face
  ]);
  const face = detectFace(f, SKIN);
  assert.ok(face, 'the face should be found despite the background');
  assert.ok(Math.abs(face.cx - 200 / 320) < 0.05, `cx ${face.cx.toFixed(3)}`);
  assert.ok(Math.abs(face.cy - 40 / 180) < 0.06, `cy ${face.cy.toFixed(3)}`);
  assert.ok(face.ry < 0.5, `implausibly large: ry ${face.ry.toFixed(2)}`);
});

test('warm speckle is eroded away rather than fitted', () => {
  const blobs = [{ cx: 100, cy: 90, rx: 22, ry: 30 }];
  // A field of single-cell warm dots — noise, foliage highlights, bokeh.
  for (let i = 0; i < 300; i++) {
    blobs.push({ cx: (i * 37) % 320, cy: 20 + ((i * 53) % 140), rx: 1, ry: 1 });
  }
  const face = detectFace(frame(320, 180, blobs), SKIN);
  assert.ok(face, 'the face should survive the clutter');
  assert.ok(Math.abs(face.cx - 100 / 320) < 0.05, `cx ${face.cx.toFixed(3)}`);
});

test('an arm-like stripe is skipped for the face even when it has more mass', () => {
  const f = frame(320, 180, [
    { cx: 160, cy: 150, rx: 150, ry: 7 },            // the arm
    { cx: 80, cy: 60, rx: 20, ry: 27 },              // the face
  ]);
  const face = detectFace(f, SKIN);
  assert.ok(face);
  assert.ok(Math.abs(face.cx - 80 / 320) < 0.05,
    `should pick the face, landed at cx ${face.cx.toFixed(3)}`);
});

test('the tracker reports lost on an all-skin frame instead of tracking a smear', () => {
  const tracker = new FaceTracker({ graceFrames: 2 });
  const wall = frame(320, 180, [{ cx: 160, cy: 90, rx: 400, ry: 400 }]);
  let last = null;
  for (let i = 0; i < 4; i++) last = tracker.update(wall, SKIN);
  assert.equal(last.state, 'lost');
  assert.equal(last.ellipse, null);
});

test('a tracked fit can never exceed the window size ceiling', () => {
  const moved = applyTrackToWindow(createWindow('w', 'ellipse'), {
    cx: 0.5, cy: 0.5, rx: 2.4, ry: 1.9, rotation: 0, confidence: 1,
  });
  assert.ok(moved.rx <= 0.8 && moved.ry <= 0.8, `rx ${moved.rx} ry ${moved.ry}`);
});

test('applyTrackToWindow moves only geometry, never the correction', () => {
  const window = { ...createWindow('w', 'ellipse'), exposure: 0.8, saturation: 1.3, label: 'Face' };
  const moved = applyTrackToWindow(window, {
    cx: 0.3, cy: 0.4, rx: 0.2, ry: 0.25, rotation: 15, confidence: 0.9,
  });
  assert.equal(moved.exposure, 0.8);
  assert.equal(moved.saturation, 1.3);
  assert.equal(moved.label, 'Face');
  assert.equal(moved.cx, 0.3);
  assert.equal(moved.rotation, 15);
});
