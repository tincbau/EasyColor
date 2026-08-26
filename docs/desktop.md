# EasyColor for Windows

The desktop build is the same application as the web app, plus the two things
a browser cannot do: open camera formats, and render a master.

---

## Install

Download `EasyColor-1.0.0-x64.exe` and run it. It installs per-user, so it
needs no administrator rights. A portable build is also available if you'd
rather not install anything.

### FFmpeg

EasyColor uses FFmpeg for decoding and encoding, and does not bundle it.

```powershell
winget install Gyan.FFmpeg
```

Then restart EasyColor.

**Why it isn't bundled.** A bundled FFmpeg would add ~80MB to the installer
and, more to the point, would be a *fixed* build. NVENC, Quick Sync and AMF
support depend on your driver stack, and a generic binary regularly ships
without the hardware encoder your machine actually has. Looking for an
installed FFmpeg and reporting exactly which encoders it exposes gives a
better answer on more machines — and a legible failure when it fails.

If FFmpeg lives somewhere unusual, set `EASYCOLOR_FFMPEG` to the full path of
`ffmpeg.exe`.

---

## Opening footage

**Open** in the toolbar goes through FFmpeg, so it reads what your camera
actually wrote:

- Sony XAVC S-I and XAVC-L
- Canon All-Intra and Canon Raw Light
- Panasonic All-Intra
- ProRes, DNxHR, DNxHD
- H.264 and H.265 in any container
- Image sequences and stills, including EXR and DPX

Frames are decoded to 16-bit RGBA with no transfer applied — log stays log,
and EasyColor's own camera conversion does the work. That matters: hand a
10-bit 4:2:2 clip to a browser and it gives you back 8-bit Rec.709, which is
precisely the latitude you were grading for.

### Camera profile detection

When the file's metadata identifies a camera log curve, EasyColor applies it
and says so in a notification. It's a guess from the encoder and make tags,
so change it under **Primary → Source** if it's wrong. A wrong guess is one
dropdown away from right; no guess at all leaves every log clip looking
broken until you know where to look.

### Scrubbing

The transport bar under the viewer seeks and decodes on demand. It is a
scrubber, not a player — each position is a real decode, fast enough to feel
direct but not real-time playback. Grading happens on stills anyway: you find
the frame that matters and work on it.

Arrow keys step one frame; Shift and arrow steps one second.

---

## Rendering a master

**Render** tab.

The master is rendered from the original file at full resolution — not from
the proxy frames the viewer has been showing.

### Encoder

EasyColor probes what your machine can actually do. Being listed in FFmpeg
and being usable are different things — a build can list `hevc_nvenc` on a
machine with no NVIDIA card — so each hardware encoder also gets a one-frame
trial run. Three seconds now beats a failed forty-minute render.

| Encoder | Notes |
|---|---|
| NVIDIA NVENC | 5–20× faster than software; slightly larger for the same quality |
| Intel Quick Sync | Same trade, on Intel iGPUs |
| AMD AMF | Same trade, on Radeon |
| x265 (software) | Slowest, best quality per megabit, identical on every machine |

For a deliverable, use software. For dailies and review copies, use hardware.

### Quality

**Constant quality** is the default and usually the right answer: the encoder
spends bits where the picture needs them. A fixed bitrate wastes them on a
locked-off shot and starves a handheld one.

| Value | Use |
|---|---|
| 10–16 | Near-lossless, for archival |
| 18–22 | Master |
| 23–28 | Delivery |
| 29+ | Preview |

**Target bitrate** runs from 1 to 300 Mbps for when a delivery spec demands a
specific rate. For reference: 50 Mbps is comfortable for 1080p, 100–150 for
4K delivery, 300 approaches intermediate-codec territory.

### Format

10-bit is the default. 8-bit bands a graded gradient — a sky is the usual
casualty — so only drop to it when something downstream cannot read 10-bit.

4:2:0 for delivery, 4:2:2 when the file is going back into a grade or an
edit.

Output is tagged Rec.709 and carries the `hvc1` brand, without which an H.265
MP4 is technically valid and practically unopenable on a Mac.

---

## How faithful is the render?

| | |
|---|---|
| Camera conversion, primaries, wheels, curves, film stock, colour zones, skin | **Exact.** Baked from the live shader into a 65³ LUT and applied tetrahedrally, the same interpolation the viewer uses. |
| Power windows | **Exact.** Each window becomes a second LUT plus a static mask carrying its shape, composited through the mask. |
| Halation | **Close.** A threshold, blur and screen blend. Different blur kernel from the viewer's, so not bit-identical. |
| Grain | **Approximate.** Rendered at a single strength; the viewer weights grain toward the shadows, which the encoder cannot reproduce. Exported grain reads slightly flatter in bright areas. |

The Render panel lists whichever of these apply to your grade before you
start, rather than leaving it to be discovered on a finished master.

---

## Building from source

```bash
npm install
npm run build:core
npm run desktop:dev     # run it
npm run desktop:dist    # build the installer
```

`desktop:dist` produces an NSIS installer and a portable build under
`packages/desktop/release/`.

---

## Troubleshooting

**"FFmpeg was not found."**
Install it, or set `EASYCOLOR_FFMPEG`. Restart EasyColor afterwards — the
probe is cached for the session.

**An encoder shows as unavailable.**
The panel says why underneath. Usually the hardware isn't there, or the
driver is too old for this FFmpeg build.

**"Could not start an encoding session."**
Consumer NVIDIA cards cap concurrent NVENC sessions. Close anything else
that's encoding, or switch to software.

**The encoder rejected the pixel format.**
Not every hardware encoder does 4:2:2. Try 4:2:0, or software.

**The render is much slower than the source is long.**
That's software x265 at `slow` doing its job. Switch to a hardware encoder if
you need speed more than efficiency.
