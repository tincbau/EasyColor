# Colour science

What EasyColor computes, where the numbers come from, and what is
approximate.

---

## Camera log transforms

Each curve is declared once with its TypeScript implementation and its GLSL
body side by side in the same object, so the CPU and GPU copies cannot
quietly drift.

| Camera | Curve | Native gamut |
|---|---|---|
| Sony | S-Log3 | S-Gamut3.Cine |
| ARRI | LogC3 (EI 800) | ARRI Wide Gamut 3 |
| ARRI | LogC4 | ARRI Wide Gamut 4 |
| Panasonic | V-Log | V-Gamut |
| Canon | Canon Log 3 | Cinema Gamut |
| RED | Log3G10 | REDWideGamutRGB |
| DJI | D-Log | D-Gamut |
| Fujifilm | F-Log | Rec.2020 primaries |

Every curve is regression-tested for two properties: that it maps its
published mid-grey code value to 0.18 ± 0.035 linear, and that it is
monotonically increasing across the full 0–1 range.

That second test earned its keep. Three curves shipped wrong and were caught
by it:

- **LogC3** had a widely-copied shadow segment (`v/0.9661776 - 0.04378604`)
  that does not meet the log segment at the cut point. The curve reversed
  direction there, inverting shadows. The published EI 800 linear leg is
  `(v - 0.092809) / 5.367655`.
- **Canon Log 3** had the wrong offset in its highlight segment. The three
  segments have to meet exactly — at the 0.15277891 cut, both the linear and
  log legs must evaluate to 0.014 — and that constraint fixes the offset at
  0.12240537. It is not a free parameter.
- **F-Log** had `0.555556` where the inner offset should be `0.009468`,
  putting mid-grey at code value 0.73 instead of 0.46.

## Gamut matrices

Derived from published chromaticities at runtime, not transcribed as nine
literals.

Camera gamut matrices are usually copied around as hardcoded numbers, and one
mistyped digit produces a matrix that tints neutral grey — subtly enough to
survive review, badly enough to ruin a grade. A matrix built from primaries
and a white point maps its white to its white *by construction*, so grey
stays grey whatever else is wrong. There is a test asserting exactly that
across every gamut.

The derivation follows SMPTE RP 177. Chromatic adaptation uses Bradford,
though every camera gamut here is D65 so in practice it returns the identity;
it exists so adding an ACES or D60 space later cannot silently shift white.

## Display rendering

Scene-linear has to be mapped to a display. Three options:

| | |
|---|---|
| **Neutral** | Linear with a hard clip. Truest to the maths, least forgiving. |
| **Filmic** | Highlight shoulder with a gentle toe, retuned so 0.18 scene grey lands on 0.18 display linear. The default for log footage. |
| **Soft clip** | Compresses only the top stop, leaving midtones exactly where they were. Useful when you want headroom to grade into. |

---

## The qualifier

All qualification runs in **Oklab**, converted from linear Rec.709.

Oklab over HSV because its hue lines stay perceptually straight: a 20° hue
window is the same perceptual width on orange as on blue, so a zone tuned on
skin behaves predictably when reused elsewhere, and a hue-distance feather
produces a smooth boundary rather than the blocky edges HSV gives.

A zone's weight is the product of three soft windows — hue, chroma and
lightness — each flat-topped with smooth shoulders. The flat top matters: it
lets you select a range without the middle of the selection being weaker than
its edges.

### One subtlety worth knowing

The lower feather of a soft window is clamped at zero. Chroma and lightness
both bottom out there, and letting the feather run negative gives a *neutral*
pixel — which has no hue at all — a partial weight in a hue selection. Every
grey in the frame then picks up the tint you meant for one colour. There is a
test for it.

### Blending

Zone edits accumulate as weighted Oklab deltas with a normalising divisor
applied only when the total weight exceeds one. Non-overlapping zones each
apply in full; overlapping ones blend; and because nothing is written back
over the base, a new zone cannot disturb an earlier one.

---

## Skin tones

Human skin sits on the **123° line** of a vectorscope — every ethnicity,
every lighting condition. Only the distance along the line changes. So
"correct the skin" reduces to "rotate the skin cluster onto the line", which
is a solvable number rather than a matter of taste.

EasyColor measures where the selected skin actually sits, reports the signed
error in degrees, and can solve for the rotation that fixes it.

The rotation is solved **numerically**, not applied as the measured error. An
Oklab hue rotation and a vectorscope angle are related but not equal —
rotating Oklab hue by 5° does not move the vectorscope angle by exactly 5° —
so applying the raw error lands close but not on the line. Bisection gets it
right in a couple of dozen iterations, which is free.

Bisection rather than Newton: the objective is cheap, the bracket is known
(nothing sane needs more than ±60°), and bisection cannot diverge on the
near-neutral samples where the angle gets noisy. When the root isn't
bracketed — the cluster is too weak or too wide to align meaningfully — it
returns zero and leaves the image alone rather than lurching.

Mean angles are computed by averaging vector *positions*, not angles. The
mean of 350° and 10° is 0°, not 180°.

---

## Film emulation

Each stock is a parameter bundle rather than a baked LUT: a channel-mix
matrix for dye cross-talk, per-channel characteristic curves, a split tone,
density, and the grain and halation the stock is known for. Describing them
this way keeps each a few hundred bytes, lets them blend continuously, and
means a stock still responds to the grade underneath it instead of flattening
it.

**These are stylistic interpretations, not colorimetric scans of the
emulsions.** They aim to land where a colourist would expect the stock to
sit, not to be measurement-accurate.

### Subtractive density

Additive saturation pushes colours toward the edge of the cube until they
clip to white. Film does the opposite: a saturated colour has more dye in the
light path, so it gets *darker* as it gets purer. Scaling luminance down with
chroma reproduces that, and it is the single biggest reason a film emulation
reads as film rather than as a saturation boost.

### Halation

Light passes through the emulsion, scatters off the film base, and exposes
the layers a second time from behind. Only bright areas carry enough energy,
hence the threshold; the red layer sits furthest from the base, hence the
red-orange halo.

The threshold has a soft knee, because a hard one makes the bloom pop in as a
highlight crosses it — which reads as a flickering edge on moving footage.
The radius is authored at 1080p and scales with the frame, so a look holds
when applied to a 4K master.

CineStill 800T's extreme default is not a bug: it is Vision3 500T with the
anti-halation remjet layer removed, and that bloom is the whole point of the
stock.

### Grain

Two properties separate film grain from video noise. Grain lives in the toe
of the curve, so shadows are grainier than highlights — at zero shadow bias
this looks like sensor noise instead. And the three dye layers grain
semi-independently, so it is not purely monochrome.

Animated by default. Frozen grain sticks to the screen on moving footage
instead of sitting in the image; freeze it only when matching a still.

---

## Scopes

Computed from a downscaled frame read back from the GPU, throttled rather
than run every frame — reading back a 4K frame sixty times a second stalls
the pipeline hard enough to halve the viewer's frame rate.

**Waveform and parade** use a square-root response, not linear. A waveform's
counts are extremely skewed: a flat sky puts thousands of pixels on one level
and a face puts three on another, and a linear mapping renders everything but
the sky invisible.

**Histogram** scaling ignores the 0 and 255 bins. They pile up on any
letterboxed or clipped frame and would flatten everything else.

**Vectorscope** uses Rec.709 Y'CbCr chroma coordinates with the same
orientation a hardware scope uses — +Cb right, +Cr up — so the skin tone line
sits at 123° and colour bar targets land where a colourist expects them.
Near-neutral pixels are excluded from the mean, since their angle is
essentially random.

Luma binning rounds rather than truncates. The Rec.709 coefficients sum to 1
only in exact arithmetic, so truncation puts pure white at level 254 and the
waveform never quite reaches 100 IRE on a legitimately clipped frame.

---

## LUT export

The bake pushes an identity Hald image through the same base and zones
shader programs the viewer just used. What comes out is not an approximation
of the look — it is the look, sampled on a lattice.

Sampling uses **tetrahedral** interpolation, both in the viewer and in the
FFmpeg render. Hardware trilinear filtering is one texture fetch but blends
across the cube diagonal, bending straight gradients — visible as a faint
magenta cast through neutral ramps on strong looks. Tetrahedral splits each
cell along the neutral axis instead, so greys stay grey. It is what every LUT
box and NLE uses.

Spatial effects are excluded by construction: halation, grain and power
windows depend on *where* a pixel is, and a 3D LUT only knows what colour it
is. The UI says so before you export.

---

## What has not been verified

Stated plainly rather than left implicit:

- **Film stock accuracy.** Interpretations, as above. Not measured against
  real emulsions.
- **Log curves** are tested against published mid-grey values and for
  monotonicity, not against real camera footage from each manufacturer.
- **Hardware encoders** (NVENC, Quick Sync, AMF) are implemented and their
  command construction is tested, but no machine with that hardware was
  available to run them.
- **Real camera media.** The decode path is built against FFmpeg's documented
  behaviour; no XAVC S-I or Canon All-Intra clip was available to test with.
- **Premiere Pro itself.** The panel is tested against a stubbed CEP host.
  Whether Premiere behaves as the ExtendScript expects — particularly around
  `exportFramePNG`, which is an undocumented QE DOM call — needs Premiere.
