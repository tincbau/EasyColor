# EasyColor

A point-and-click cinematic colour grading studio. Grade by clicking the
image and dragging, not by hunting for the right slider.

Runs three ways from one codebase:

| | What it adds |
|---|---|
| **Web app** | Everything below, in a browser. Deploys to GitHub Pages. |
| **Windows desktop app** | Native 10-bit 4:2:2 camera decoding, and H.265 mastering from 1 to 300 Mbps with NVENC/QSV/AMF or software encoding. |
| **Premiere Pro panel** | Grade the frame under the playhead, send the look back as a LUT Lumetri can apply. |

---

## The idea

Most grading tools ask you to decide *which control* to reach for before you
can express *what you want*. EasyColor inverts that: point at the thing you
want to change, drag, and it works out which control that is.

Click a jacket and drag sideways — its hue rotates. Drag a shadow up — Lift
rises. Grab a waveform and pull — exposure follows. The panels on the right
are still there, showing exactly what your gesture set, so a look you made by
feel is still a look you can read, adjust and hand to someone else.

---

## Direct on-viewer grading

The centrepiece. Pick the **Colour** tool and click any colour in the image.

| Gesture | Effect |
|---|---|
| Drag left / right | Rotate that colour's hue |
| Drag up / down | Raise or lower its saturation |
| **Shift** + drag | Saturation only |
| **Ctrl** or **Alt** + drag | Luminance only |
| Click without dragging | Just look — nothing is created |

Four decisions make this feel solid rather than fiddly:

**A click resolves against colours you've already graded.** Clicking a jacket
you pushed toward teal finds that zone and keeps working on it. It does not
stack a second zone on top, so repeated passes converge instead of
compounding.

**Matching uses the colour *before* your grade.** A zone's identity is where
the subject started, not where you've moved it to. Match on the graded colour
instead and a zone walks out from under its own selection the moment you
rotate its hue.

**Colours are independent.** Zone edits accumulate as weighted deltas in
Oklab with a normalising divisor. Two zones that overlap blend; two that
don't each apply in full; and grading the sky after grading the skin leaves
the skin exactly as it was. Nothing is ever written back over the base — only
added to it.

**Edges stay clean.** Qualification runs in Oklab, where a fixed hue window
is perceptually the same width everywhere on the wheel, so feathering is
smooth rather than blocky. And mattes are built from a *blurred* copy of the
image while the edit applies to the sharp pixel — compressed footage carries
its colour at half resolution, so qualifying the raw pixels reproduces the
codec's 2×2 chroma blocks as stair-stepping along every selection edge. A
couple of pixels of **Matte softness** removes that without softening the
picture at all.

### The other direct tools

- **Tonal** — drag on a shadow, midtone or highlight and EasyColor picks
  Lift, Gamma or Gain for you. Vertical is luminance, horizontal is warm/cool.
- **Scopes** — drag a waveform, parade or histogram to set exposure. Hold
  Shift to move only the wheel for the tonal range you grabbed.
- **Window** — drag the on-screen handles of a power window.
- **Pick skin** — click a face to set the skin qualifier.

---

## Features

### Colour and film

- **Primaries** — exposure, temperature, tint, contrast with adjustable
  pivot, highlight and shadow recovery, saturation and vibrance.
- **Three-way wheels** — Lift, Gamma, Gain and Offset, each with a master
  luma ring. The disc is pure chroma: its three channel offsets always sum to
  zero, so balance moves without exposure drifting.
- **Curves** — master plus R, G and B, on a monotone spline that cannot
  overshoot, so a drag can never invert your shadows.
- **Camera log** — S-Log3, LogC3, LogC4, V-Log, Canon Log 3, Log3G10, D-Log
  and F-Log, each with its native gamut matrix and a choice of display
  rendering. Gamut matrices are derived from published chromaticities rather
  than transcribed, which makes a matrix that tints neutral grey impossible
  by construction.
- **Film stocks** — Kodachrome 64, Portra 400 and 800, Ektar 100, Vision3
  250D and 500T, Eterna, Velvia 50, Pro 400H, CineStill 800T and 50D, Agfa
  Vista, HP5 and Tri-X. Each is a parameter bundle — dye cross-talk matrix,
  characteristic curves, split tone, density — so a stock blends continuously
  and still responds to the grade underneath it.
- **Halation** — adjustable threshold, bloom radius and strength, with a
  tintable halo. The radius is authored at 1080p and scales with the frame,
  so a look holds on a 4K master.
- **Subtractive density** — colours darken as they saturate, the way light
  losing energy through dye layers does. It is the opposite of a saturation
  control, and the single biggest reason an emulation reads as film.
- **Grain** — amount, size, colour, and a shadow bias, because real negative
  grains up in the toe. At zero bias it looks like sensor noise instead.

### Selective

- **Colour zones** — up to eight independent hue/chroma/luma qualifiers with
  full feathering control, created by clicking the image.
- **Skin tone suite** — measures where skin actually sits on the vectorscope,
  states the error in degrees, and solves for the rotation that puts it on the
  123° line. The alignment is solved numerically, not applied as the raw
  measured error: an Oklab hue rotation and a vectorscope angle are related
  but not equal, so the naive version lands close and stops.
- **Skin isolation overlay** — outlines the selection in place. It does not
  dim, blur or cover the picture, so you are still judging the actual image
  while you tune the qualifier.
- **Power windows** — ellipse, rectangle and vignette, with interactive
  handles for position, size, rotation and softness. The gizmo draws both the
  hard edge and the feather extent, because edge softness is otherwise
  invisible until the correction is too strong to judge.

### Scopes and comparison

- Waveform, RGB parade, histogram, and a vectorscope with the 123° skin tone
  line marked and the frame's own mean angle drawn against it.
- A/B compare as a draggable wipe or side by side, with **B** to toggle
  bypass and **\\** to hold it.
- False colour exposure overlay, with the bands a cinematographer actually
  meters against.

### LUTs and matching

- Drag and drop `.cube` files in, with intensity blending and a choice of
  applying before or after the camera conversion.
- One-click `.cube` export at 17³ to 65³. The bake replays the actual grading
  shader over an identity lattice, so the cube *is* the look rather than an
  approximation of it.
- Reference palette matching — extract palettes from a reference still and
  generate an auto-match. The result is an ordinary, editable grade, not an
  opaque transform.

### Everything else

- Non-destructive history with a timeline you can jump around. A continuous
  drag is one step.
- Projects save and load as `.ecgrade`.
- Look presets: teal & orange, bleach bypass, day for night, faded print and
  more, applied on top of the work you have already done.

---

## Getting started

```bash
npm install
npm run build:core
npm run dev            # http://localhost:5173
```

Drop a still or a clip on the viewer and start clicking colours.

### Build

```bash
npm run build          # engine + web app
npm test               # 98 unit tests
npm run test:browser   # 22 checks in headless Chromium
```

---

## Deploying the web app

`.github/workflows/pages.yml` builds and publishes on every push to `main`.
Enable it once under **Settings → Pages → Source → GitHub Actions**.

To build it yourself:

```bash
EASYCOLOR_BASE=/your-repo-name/ npm run build:web
```

The base path matters: GitHub Pages serves a project site from a subpath, and
a bundle built for `/` 404s every asset there.

### Browser requirements

WebGL2, which means any current Chrome, Edge, Firefox or Safari. Browsers
decode a narrow set of codecs — H.264 and VP9 — so camera formats like XAVC
S-I need the desktop app.

---

## Documentation

- [Desktop app](docs/desktop.md) — install, camera decoding, mastering
- [Premiere Pro panel](docs/premiere.md) — install and workflow
- [How it works](docs/architecture.md) — the pipeline, and why it is shaped
  the way it is
- [Colour science](docs/colour-science.md) — transforms, qualifier maths, and
  what is approximate

---

## Licence

MIT.

Film stock emulations are stylistic interpretations, not colorimetric scans
of the emulsions. They aim to land where a colourist would expect the stock
to sit, not to be measurement-accurate.
