# How EasyColor works

One engine, three shells. This document covers the shape of the thing and the
decisions that aren't obvious from the code.

---

## Packages

```
packages/core        colour science, GL pipeline, LUT I/O, scopes,
                     interaction model. No React, no Electron, no DOM
                     beyond a GL context.
packages/web         React UI. Ships to browsers, and is also the renderer
                     for the other two shells.
packages/desktop     Electron main process: FFmpeg decode and encode.
packages/premiere    CEP extension: manifest, ExtendScript host, installers.
```

The web app is the UI everywhere. The desktop and Premiere shells add
capabilities by exposing a bridge on `window`; the UI detects it and renders
those features only when present. That's why there is no dead Electron code
in the browser bundle and no feature that half-exists.

Both bridge contracts live in `core` rather than in their own packages,
because three places need each one — the process that implements it, the
preload or glue that exposes it, and the UI that calls it — and the UI cannot
depend on a package that only exists in one shell.

---

## The render pipeline

```
1   base       camera conversion + primary grade         pure per-pixel
1b  reference  the A/B "before" image                    only when comparing
2   qualBlur   blurred copy for matte qualification      spatial
3   zones      HSL zones, skin, power windows            pure per-pixel*
4   halation   threshold + bloom                         spatial
5   final      grain, overlays, compare, output          spatial + view-only
```

\* Power windows are positional, so the LUT baker skips them; everything else
in pass 3 is a function of colour alone.

That split between "pure per-pixel" and "spatial" is not incidental — it is
what makes the one-click `.CUBE` export exact rather than approximate. The
baker replays passes 1 and 3 over an identity Hald image and gets, by
construction, the same numbers the viewer showed. No separate implementation
to keep in sync, and no drift.

### Two working spaces

```
scene-linear    log decode, gamut matrix, exposure, white balance, tone map
video levels    contrast, wheels, curves, saturation, film stock, LUT
```

Exposure and white balance belong in linear because that's where they're
physically meaningful. Wheels and curves belong in gamma-encoded video levels
because that's where every grading tool defines them — run a "lift" in linear
and it lands almost entirely in the bottom stop, which is not what the
control is supposed to feel like.

### Why Oklab for the qualifier

A fixed hue window is perceptually the same width everywhere on the wheel, so
a zone tuned on skin behaves the same when reused on foliage, and a
hue-distance feather produces a smooth boundary instead of the blocky edges
HSV gives you.

### Why mattes are built from a blurred copy

4:2:0 footage carries its chroma at half resolution. Qualify the sharp pixel
and you faithfully reproduce the codec's 2×2 chroma blocks as stair-stepping
along the edge of every selection. Blurring only the *matte reference* —
never the image — removes that without softening the picture by a pixel.

### Why zone edits accumulate as deltas

Each zone computes a weight and a delta in Oklab. Deltas are summed, and
divided by the total weight only when that total exceeds one. Consequences:

- Non-overlapping zones each apply in full.
- Overlapping zones blend rather than compound.
- Nothing is ever written back over the base, so grading a new colour cannot
  undo an earlier one.

---

## The interaction model

Three verbs: click to pick what you mean, drag to change it, release.

**Sampling averages a patch, not a pixel.** One pixel on grainy footage
answers differently every time you click the same face.

**Clicks match against the pre-grade colour.** A zone's identity is where the
subject started. Match on the graded colour and a zone walks out from under
its own selection as soon as you rotate its hue.

**Drags are absolute, not incremental.** Every update is computed from a
baseline captured at pointer-down, so a slow drag and a fast drag ending in
the same place give the same result, and nothing accumulates drift over a
long gesture.

**Axes are locked, not blended.** Horizontal is hue, vertical is saturation,
and a modifier collapses both onto one property. Diagonal drags that quietly
change two things at once are how people lose control of a grade.

---

## State and history

A grade is one serialisable object. The history stack snapshots it; the
project file *is* it; the shader uniforms are derived from it. Nothing about
a look lives anywhere else.

Snapshots are cheap because a grade is a few kilobytes of plain numbers — the
only large payload, a loaded 3D LUT, is shared by reference rather than
copied.

Continuous edits coalesce by merge key, so a drag is one undo step. Viewer
state — wipe position, bypass, overlays — deliberately never enters history:
undoing back through six viewer toggles to reach an actual colour change is
nobody's idea of an undo stack.

---

## Rendering a master

FFmpeg cannot run a fragment shader, so the grade is translated into things
it can apply. `core/export/plan.ts` does that translation once, so the
desktop exporter and the Premiere bridge cannot interpret a look differently.

- **Per-pixel grade** → one 65³ cube baked from the real shader. Tetrahedral
  interpolation on both sides; the match is exact to well under a code value
  at 10-bit.
- **Power windows** → one extra cube per window, baked with the shape widened
  to cover the frame, plus a static mask image carrying the real shape.
  Compositing the two through the mask reproduces a window exactly, which
  beats the usual answer of dropping windows from a LUT-based export.
- **Halation and grain** → filter-chain approximations, because they are
  spatial and stochastic. What differs is stated in the UI.

### Things the FFmpeg graph gets wrong if you're not careful

All four of these were found by an end-to-end render test and are now
regression-tested:

- A filter argument that takes a *filename* will happily accept a megabyte of
  LUT text and fail cryptically.
- `-loop 1` on a mask image never ends. `maskedmerge` has no framesync
  options to stop it, so the mask input needs its own `-t`; `-shortest` alone
  governs muxing, not the graph upstream of it.
- `geq`'s `lum()` only exists on YUV input. On an RGB stage you need
  `lutrgb`, which also knows its own bit depth through `maxval` instead of a
  hardcoded 255.
- `-tag:v hvc1` is rejected by the muxer on anything that isn't HEVC.

---

## Testing

| Suite | What it can prove |
|---|---|
| `npm test` — 107 unit tests | Curve solver, `.CUBE` parsing, colour transforms, the qualifier, history coalescing, project round-trips, scopes, palette matching, the skin solver, export planning, FFmpeg command construction. |
| `npm run test:browser` — 37 checks | That the shaders compile and link at all, and that click-and-drag grading, zone independence, undo, bypass, scopes, LUT export, windows and film stocks work end to end. |
| `npm run test:render` — 7 checks | That FFmpeg accepts the graph and the pixels come out changed in the direction the grade asked for. |
| `npm run test:premiere` — 16 checks | That the packed panel loads, the CEP bridge is detected, and ExtendScript calls are well-formed. |

The browser tests exist because the GL pipeline is assembled from generated
GLSL at runtime: a typo in a shader chunk typechecks fine and fails only when
a program links. The render tests exist because a filter graph can be
syntactically perfect and semantically wrong. Between them they caught seven
bugs that unit tests could not.

What is **not** covered: real camera media (no XAVC S-I clip to test with),
hardware encoders (no NVIDIA/Intel/AMD GPU available), and Premiere Pro
itself. Those paths are built and reasoned about but have not been run
against the real thing.
