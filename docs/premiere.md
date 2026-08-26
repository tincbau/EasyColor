# EasyColor for Premiere Pro

A CEP panel that runs the full EasyColor grading UI inside Premiere. Grab the
frame under the playhead, grade it, and send the look back as a LUT that
Lumetri applies.

---

## Install

### Windows

1. Download or build the extension (see [Building](#building) below).
2. **Quit Premiere Pro completely.**
3. Double-click `install/Install-EasyColor.bat`.
4. Start Premiere and open **Window → Extensions → EasyColor**.

### macOS

1. Quit Premiere Pro.
2. In Terminal: `bash install/install-macos.sh`
3. Start Premiere and open **Window → Extensions → EasyColor**.

Neither installer needs administrator rights, and neither writes outside your
own user profile.

### What the installer does, and why

**Copies the panel to your per-user extensions folder.**

- Windows: `%APPDATA%\Adobe\CEP\extensions\com.easycolor.premiere`
- macOS: `~/Library/Application Support/Adobe/CEP/extensions/com.easycolor.premiere`

Per-user rather than the shared folder under Program Files: the shared one
needs admin rights and gets wiped by Creative Cloud updates.

**Enables `PlayerDebugMode`.**

Premiere will not load a CEP extension that Adobe has not signed unless this
is set. It is Adobe's documented mechanism for in-house and self-distributed
panels. The setting is per CEP runtime version, so the installer writes it
across the whole plausible range — otherwise the panel stops appearing the
next time Premiere moves to a newer runtime.

- Windows: `HKCU\Software\Adobe\CSXS.<n>` → `PlayerDebugMode` = `"1"`
  (a *string*; a DWORD is silently ignored and the panel just never shows up)
- macOS: `defaults write com.adobe.CSXS.<n> PlayerDebugMode 1`

**Creates Premiere's user LUT folders** if they don't exist, so the first
"send look" works without a second restart.

- Windows: `%APPDATA%\Adobe\Common\LUTs\{Creative,Technical}`
- macOS: `~/Library/Application Support/Adobe/Common/LUTs/{Creative,Technical}`

### Uninstall

Windows: run `install/Uninstall-EasyColor.ps1`.
macOS: delete the folder listed above.

`PlayerDebugMode` is deliberately left alone — other panels on the machine
may need it, and switching it off would break them silently. LUTs you have
already sent are left too; they're your work.

---

## Workflow

1. Park the playhead on the shot you want to grade.
2. In the panel, **Premiere → Grab the current frame**.
3. Grade it with the normal EasyColor tools — click colours and drag, use the
   wheels, curves, film stocks, whatever the shot needs.
4. Name the look and press **Send look to Premiere**.
5. In Lumetri Color, pick the LUT from the menu the panel names.

### Which Lumetri slot, and why it matters

The panel decides for you from the grade:

| Your grade | Goes to | Lumetri slot |
|---|---|---|
| Includes a camera log conversion | `Technical` | Basic Correction → **Input LUT** |
| Creative look only | `Creative` | Creative → **Look** |

A LUT that carries the camera conversion has to run *before* Lumetri's own
correction. Put it in the Creative slot instead and the image is corrected
twice — which is exactly what a washed-out, green "broken LUT" usually is.

### The first restart

Premiere scans its LUT folders only at launch. A LUT sent for the first time
appears in the menu after you restart Premiere. Re-sending under the same
name takes effect immediately, so the iterate-and-refine loop is fast — it's
only the first one that costs a restart.

---

## What a LUT cannot carry

A 3D LUT maps colour to colour. It cannot know *where* a pixel is in the
frame, so these do not travel:

- Power windows
- Halation
- Grain

The panel warns you when your grade uses any of them. Recreate them in
Premiere, or render the master in the EasyColor desktop app, which applies
them properly.

Everything else — camera conversion, primaries, wheels, curves, film stock,
colour zones and skin corrections — bakes in exactly.

---

## Why you pick the LUT from a menu instead of the panel applying it

Adobe changed the Lumetri parameter API in **Premiere Pro 23.4**. A script
can no longer set a custom LUT by file path: the parameter reports a dropdown
index rather than a path, and setting a path is ignored.

So the panel installs the `.cube` where Lumetri looks for it and asks you to
choose it. One extra click, and it works on every Premiere version rather
than breaking on the next update.

**Add Lumetri to the selected clip** still exists and does what it says — it
adds the effect so the menu is right there. On 23.4 and later it tells you
plainly that it cannot set the LUT itself, rather than reporting a success
that did not happen.

---

## Building

```bash
npm install
npm run build:core
npm run premiere:build     # builds the UI and assembles the extension
npm run premiere:install   # installs it for the current user
```

The assembled extension lands in
`packages/premiere/dist/com.easycolor.premiere/`.

### Testing without Premiere

```bash
npm run test:premiere
```

Runs the packed panel in headless Chromium with a stubbed CEP host. It
verifies the panel loads, the bridge is detected, the ExtendScript calls are
well-formed with correctly escaped arguments, and the honest-failure path
reports rather than swallows a host that refuses.

What it cannot verify is that Premiere itself behaves as the host script
expects — that needs Premiere.

---

## Troubleshooting

**The panel isn't under Window → Extensions.**
Premiere was running when you installed. Quit it completely — check the
system tray and Activity Monitor — and start it again.

**The panel is there but blank or grey.**
CEP's Chromium may have started without GPU access, which the WebGL2 grading
pipeline needs. Check `Help → About` for your Premiere version, and try
restarting the machine; a stale GPU driver state is the usual cause.

**"Premiere did not write the frame."**
There is no clip under the playhead, or the sequence is still rendering. Move
the playhead onto a clip and grab again.

**My LUT isn't in the Lumetri menu.**
It's the first one you sent, so Premiere hasn't scanned for it yet. Restart
Premiere. Press **Show the file** in the panel to confirm it's on disk.

**The scripted apply says it can't set the LUT.**
That's Premiere Pro 23.4+ behaving as documented above. Pick the LUT from the
Lumetri menu; it's already installed and waiting.

---

## Compatibility

| | |
|---|---|
| Premiere Pro | 14.0 (2020) and later |
| Platforms | Windows and macOS |
| Signing | Unsigned; installed via `PlayerDebugMode` |

Not a native C++ effect plugin. A native effect would render inside
Premiere's own pipeline, but the Premiere SDK requires a compiled binary per
platform and per SDK revision, and would still not give you the interactive
grading surface — which is the part of EasyColor worth having. The panel plus
LUT route gives you the full tool and a result Lumetri applies natively.
