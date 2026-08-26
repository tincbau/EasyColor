/**
 * Tests for the FFmpeg command builder.
 *
 * The command is the whole render: get an argument wrong and a master comes
 * out at the wrong bit depth, untagged, or with the grade silently missing.
 * These check the decisions that are easy to get wrong and impossible to
 * notice until someone plays the file back somewhere else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, parseProgress, explainFailure } from '../dist/main/export.js';

const INFO = { width: 3840, height: 2160, fps: 25, durationSeconds: 10 };

function request(overrides = {}) {
  return {
    inputPath: '/clips/A001.mp4',
    outputPath: '/out/A001_graded.mp4',
    cube: 'LUT_3D_SIZE 2\n',
    windows: [],
    halation: null,
    grain: null,
    encoder: 'libx265',
    bitrateMbps: 80,
    bitDepth: 10,
    chroma: '420',
    useConstantQuality: true,
    quality: 20,
    startSeconds: null,
    durationSeconds: null,
    includeAudio: true,
    ...overrides,
  };
}

const FILES = { baseCube: '/tmp/base.cube', windows: [] };
const argsOf = (r) => buildCommand(r, INFO, FILES).args;
const graphOf = (r, windows = []) =>
  buildCommand(r, INFO, { baseCube: FILES.baseCube, windows }).filterGraph;

test('the base grade is applied as a tetrahedral 3D LUT', () => {
  const graph = graphOf(request());
  assert.match(graph, /lut3d=file=/);
  assert.match(graph, /interp=tetrahedral/);
  // The graph must name the written file, not carry the cube's contents:
  // pasting a megabyte of LUT where a filename belongs fails every render.
  assert.ok(graph.includes('/tmp/base.cube'), 'the base cube path must be referenced');
  assert.ok(!graph.includes('LUT_3D_SIZE'), 'the cube payload must not be inlined');
});

test('grading happens in 10-bit RGB, not in subsampled YUV', () => {
  // Applying a 3D LUT after chroma subsampling quantises colour twice and
  // bands smooth gradients, so the graph must convert up front.
  const graph = graphOf(request());
  const lutIndex = graph.indexOf('lut3d');
  const formatIndex = graph.indexOf('gbrp10le');
  assert.ok(formatIndex >= 0, 'graph should convert to planar RGB');
  assert.ok(formatIndex < lutIndex, 'the conversion must come before the LUT');
});

test('output is tagged so other software reads the colour correctly', () => {
  const args = argsOf(request());
  assert.ok(args.includes('-colorspace') && args.includes('bt709'));
  assert.ok(args.includes('-color_trc'));
  assert.ok(args.includes('-color_primaries'));
  // Without hvc1, an H.265 MP4 will not open in QuickTime or Finder.
  const tagIndex = args.indexOf('-tag:v');
  assert.ok(tagIndex >= 0 && args[tagIndex + 1] === 'hvc1');
  assert.ok(args.includes('+faststart'));
});

test('the hvc1 tag is only applied to H.265, which is the only codec that accepts it', () => {
  for (const encoder of ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf']) {
    assert.ok(argsOf(request({ encoder })).includes('hvc1'), encoder);
  }
  assert.ok(!argsOf(request({ encoder: 'libx264' })).includes('hvc1'));
});

test('the output path is the last argument', () => {
  const args = argsOf(request());
  assert.equal(args[args.length - 1], '/out/A001_graded.mp4');
});

test('bit depth and chroma reach the output pixel format', () => {
  assert.ok(argsOf(request({ bitDepth: 10, chroma: '420' })).includes('yuv420p10le'));
  assert.ok(argsOf(request({ bitDepth: 10, chroma: '422' })).includes('yuv422p10le'));
  assert.ok(argsOf(request({ bitDepth: 8, chroma: '420' })).includes('yuv420p'));
  assert.ok(argsOf(request({ bitDepth: 8, chroma: '422' })).includes('yuv422p'));
});

test('constant quality and target bitrate are mutually exclusive', () => {
  const cq = argsOf(request({ useConstantQuality: true, quality: 18 }));
  assert.ok(cq.includes('-crf'));
  assert.ok(!cq.includes('-b:v'), 'constant quality must not also set a bitrate');

  const cbr = argsOf(request({ useConstantQuality: false, bitrateMbps: 120 }));
  assert.ok(cbr.includes('-b:v'));
  assert.ok(cbr.includes('120000k'), `expected 120 Mbps, got ${cbr.join(' ')}`);
  assert.ok(!cbr.includes('-crf'));
});

test('bitrate is clamped to the documented 1-300 Mbps range', () => {
  assert.ok(argsOf(request({ useConstantQuality: false, bitrateMbps: 5000 })).includes('300000k'));
  assert.ok(argsOf(request({ useConstantQuality: false, bitrateMbps: 0 })).includes('1000k'));
});

test('NVENC gets its own rate control and a 10-bit profile', () => {
  const args = argsOf(request({ encoder: 'hevc_nvenc', useConstantQuality: true, quality: 21 }));
  assert.ok(args.includes('hevc_nvenc'));
  assert.ok(args.includes('-cq') && args.includes('21'));
  assert.ok(args.includes('main10'), '10-bit output needs the main10 profile');
  assert.ok(!args.includes('-crf'), 'crf is an x265 option and NVENC ignores it');
});

test('8-bit output asks for the main profile, not main10', () => {
  const args = argsOf(request({ encoder: 'hevc_nvenc', bitDepth: 8 }));
  assert.ok(args.includes('main'));
  assert.ok(!args.includes('main10'));
});

test('every hardware encoder produces a usable command', () => {
  for (const encoder of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox']) {
    const args = argsOf(request({ encoder, useConstantQuality: false }));
    assert.ok(args.includes('-c:v'), encoder);
    assert.ok(args.includes(encoder), encoder);
    assert.ok(args.includes('-b:v'), `${encoder} should accept a bitrate`);
  }
});

test('trimming passes the seek before the input, where it is fast', () => {
  const args = argsOf(request({ startSeconds: 12.5, durationSeconds: 3 }));
  const ssIndex = args.indexOf('-ss');
  const inputIndex = args.indexOf('-i');
  assert.ok(ssIndex >= 0 && ssIndex < inputIndex, 'a seek after -i decodes from the start');
  assert.ok(args.includes('12.500'));
  const tIndex = args.indexOf('-t');
  assert.ok(tIndex > inputIndex, 'duration must be applied after the input');
});

test('a render with no windows does not ask for -shortest', () => {
  assert.ok(!argsOf(request()).includes('-shortest'));
});

test('audio is copied, or dropped, as asked', () => {
  const withAudio = argsOf(request({ includeAudio: true }));
  assert.ok(withAudio.includes('0:a?'), 'the ? keeps a silent clip from failing');
  assert.ok(withAudio.includes('copy'));
  assert.ok(argsOf(request({ includeAudio: false })).includes('-an'));
});

test('a power window becomes a second LUT composited through its mask', () => {
  const windows = [{ cube: '/tmp/w0.cube', mask: '/tmp/m0.pgm' }];
  const req = request({
    windows: [{ cube: 'x', mask: new Uint8Array(4), maskWidth: 2, maskHeight: 2 }],
  });
  const { args, filterGraph } = buildCommand(req, INFO, { baseCube: FILES.baseCube, windows });

  assert.ok(args.includes('/tmp/m0.pgm'), 'the mask must be an input');
  assert.ok(args.includes('-loop'), 'a still mask must be looped over the clip');
  // A looped still never ends on its own; without -shortest the render runs
  // forever after the footage finishes.
  assert.ok(args.includes('-shortest'), 'a looped mask input needs -shortest');
  assert.match(filterGraph, /maskedmerge/);
  // The looped mask input must be time-bounded, or maskedmerge pulls mask
  // frames forever and the render never finishes.
  const loopIndex = args.indexOf('-loop');
  assert.equal(args[loopIndex + 2], '-t', 'a looped mask needs its own duration');
  assert.ok(Number(args[loopIndex + 3]) >= 10, 'the mask must outlast the footage');
  assert.ok(filterGraph.includes('w0.cube'), 'the window needs its own cube');
  // The mask has to be scaled to the source, not the other way round.
  assert.match(filterGraph, /scale=3840:2160/);
});

test('two windows composite in order', () => {
  const windows = [
    { cube: '/tmp/w0.cube', mask: '/tmp/m0.pgm' },
    { cube: '/tmp/w1.cube', mask: '/tmp/m1.pgm' },
  ];
  const req = request({
    windows: [
      { cube: 'a', mask: new Uint8Array(4), maskWidth: 2, maskHeight: 2 },
      { cube: 'b', mask: new Uint8Array(4), maskWidth: 2, maskHeight: 2 },
    ],
  });
  const graph = buildCommand(req, INFO, { baseCube: FILES.baseCube, windows }).filterGraph;
  assert.ok(graph.includes('masked0') && graph.includes('masked1'));
  assert.ok(graph.indexOf('masked0') < graph.indexOf('[masked1]'));
});

test('highlight isolation is depth-aware, not hardcoded to 8-bit', () => {
  const graph = graphOf(request({
    halation: { threshold: 0.7, radius: 18, strength: 0.4, tint: [1, 0.35, 0.15] },
  }));
  // geq's lum() does not exist on RGB input, and a literal 255 would be
  // wrong for the 10-bit stage this runs in.
  assert.ok(!graph.includes('geq='), 'geq cannot read luma from an RGB stream');
  assert.match(graph, /lutrgb=/);
  assert.match(graph, /maxval/);
});

test('halation scales its radius with the frame', () => {
  const halation = { threshold: 0.7, radius: 18, strength: 0.4, tint: [1, 0.35, 0.15] };
  const hd = graphOf(request({ halation }));
  const uhd = buildCommand(request({ halation }), { ...INFO, height: 1080 }, FILES).filterGraph;

  const sigmaOf = (graph) => Number(/gblur=sigma=([\d.]+)/.exec(graph)[1]);
  // The look is authored at 1080p, so a 2160p render must blur twice as far.
  assert.ok(Math.abs(sigmaOf(hd) / sigmaOf(uhd) - 2) < 0.05,
    `sigma did not scale: ${sigmaOf(uhd)} at 1080p vs ${sigmaOf(hd)} at 2160p`);
  assert.match(hd, /blend=all_mode=screen/);
});

test('grain is animated, or it reads as dirt on the lens', () => {
  const graph = graphOf(request({ grain: { amount: 0.5, size: 1.5, chroma: 0.4 } }));
  assert.match(graph, /noise=/);
  assert.match(graph, /allf=t/);
});

test('no halation or grain means no filters for them', () => {
  const graph = graphOf(request());
  assert.ok(!graph.includes('gblur'));
  assert.ok(!graph.includes('noise='));
});

test('paths with a drive letter are escaped for the filter parser', () => {
  const graph = graphOf(request());
  const windows = [{ cube: 'C:\\Users\\x\\base.cube', mask: 'C:\\Users\\x\\m.pgm' }];
  const req = request({ windows: [{ cube: 'x', mask: new Uint8Array(4), maskWidth: 2, maskHeight: 2 }] });
  const g = buildCommand(req, INFO, { baseCube: 'C:\\Users\\x\\base.cube', windows }).filterGraph;
  // An unescaped ':' ends the filter argument, so C:\ breaks the whole graph.
  assert.ok(g.includes('C\\:/Users/x/base.cube'), `bad escaping: ${g}`);
  assert.ok(!graph.includes('undefined'));
});

/* ---- progress and failures ---- */

test('progress is read from FFmpeg stderr', () => {
  const stats = parseProgress('frame=  240 fps= 48 q=28.0 size=  1024kB time=00:00:09.60 speed=1.92x');
  assert.equal(stats.frame, 240);
  assert.equal(stats.fps, 48);
  assert.equal(stats.speed, 1.92);
  assert.equal(parseProgress('some unrelated line'), null);
});

test('common failures are explained rather than dumped', () => {
  const r = request();
  assert.match(explainFailure(['No space left on device'], r), /out of space/i);
  assert.match(
    explainFailure(['OpenEncodeSessionEx failed: out of memory'], { ...r, encoder: 'hevc_nvenc' }),
    /encoding session/i,
  );
  assert.match(explainFailure(['Unknown encoder hevc_nvenc'], r), /does not have/i);
  assert.match(explainFailure(['Impossible to convert between the formats'], r), /4:2:2/);
  assert.match(explainFailure(['Permission denied'], r), /Could not write/);
  // Anything unrecognised still says something, rather than nothing.
  assert.ok(explainFailure(['weird error happened'], r).length > 0);
  assert.ok(explainFailure([], r).length > 0);
});
