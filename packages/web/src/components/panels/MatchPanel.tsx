import { useRef, useState } from 'react';
import { extractPalette, matchToReference } from '@easycolor/core';
import type { Swatch } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import type { RendererApi } from '../../hooks/useRenderer.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, fmt } from '../ui/controls.js';

/**
 * Reference palette matching.
 *
 * The output is an ordinary, fully editable grade — exposure, contrast,
 * temperature and a few colour zones — not an opaque transform. That is the
 * point: an auto-match should give you a starting position you can argue
 * with, not a black box you either accept or discard.
 */

interface Props {
  renderer: RendererApi;
  hasMedia: boolean;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

interface ReferenceState {
  name: string;
  url: string;
  frame: { data: Uint8Array; width: number; height: number };
  palette: Swatch[];
}

export function MatchPanel({ renderer, hasMedia, onNotify }: Props) {
  const store = useStore();
  const grade = useGrade();
  const inputRef = useRef<HTMLInputElement>(null);

  const [reference, setReference] = useState<ReferenceState | null>(null);
  const [sourcePalette, setSourcePalette] = useState<Swatch[] | null>(null);
  const [strength, setStrength] = useState(0.85);
  const [perColor, setPerColor] = useState(true);
  const [notes, setNotes] = useState<string[]>([]);

  const loadReference = async (file: File) => {
    try {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.src = url;
      await image.decode();

      // Downscale into a canvas: the palette only needs a few thousand
      // samples, and a 6000px still would otherwise be read pixel by pixel.
      const scale = Math.min(1, 400 / Math.max(image.naturalWidth, image.naturalHeight));
      const w = Math.max(1, Math.round(image.naturalWidth * scale));
      const h = Math.max(1, Math.round(image.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not read the reference image.');
      ctx.drawImage(image, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const frame = { data: new Uint8Array(imageData.data.buffer.slice(0)), width: w, height: h };

      if (reference) URL.revokeObjectURL(reference.url);
      setReference({ name: file.name, url, frame, palette: extractPalette(frame, { count: 6 }) });
      setNotes([]);
    } catch (e) {
      onNotify(e instanceof Error ? e.message : 'Could not read that reference image.', 'error');
    }
  };

  const readSource = () => {
    const frame = renderer.grabFrame(400);
    if (!frame) {
      onNotify('Open a still or a clip first.', 'error');
      return null;
    }
    setSourcePalette(extractPalette(frame, { count: 6 }));
    return frame;
  };

  const applyMatch = () => {
    if (!reference) {
      onNotify('Load a reference image first.', 'error');
      return;
    }
    const source = readSource();
    if (!source) return;

    const result = matchToReference(grade, source, reference.frame, { strength, perColor });
    store.update(result.grade, `Match to ${reference.name}`);
    store.commit();
    setNotes(result.notes);
    onNotify('Reference match applied. Every control it set is editable.', 'success');
  };

  return (
    <div className="panel">
      <Section title="Reference image">
        {reference ? (
          <>
            <img className="reference-thumb" src={reference.url} alt={reference.name} />
            <p className="hint" style={{ color: 'var(--text)' }}>
              {reference.name}
            </p>
            <PaletteStrip palette={reference.palette} />
            <div className="row" style={{ marginTop: 8 }}>
              <Button small variant="ghost" onClick={() => inputRef.current?.click()}>
                Replace
              </Button>
              <Button
                small
                variant="ghost"
                onClick={() => {
                  URL.revokeObjectURL(reference.url);
                  setReference(null);
                  setNotes([]);
                }}
              >
                Clear
              </Button>
            </div>
          </>
        ) : (
          <div className="empty">
            No reference loaded.
            <br />
            <Button small onClick={() => inputRef.current?.click()}>
              Choose a reference still
            </Button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadReference(file);
            e.target.value = '';
          }}
        />
      </Section>

      <Section title="Current frame">
        {sourcePalette ? (
          <PaletteStrip palette={sourcePalette} />
        ) : (
          <p className="hint">Not read yet.</p>
        )}
        <Button small variant="ghost" onClick={readSource} disabled={!hasMedia}>
          Read palette from viewer
        </Button>
      </Section>

      <Section title="Match">
        <Slider
          label="Strength"
          value={strength}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.85}
          format={fmt.percent}
          onChange={(v) => setStrength(v)}
        />
        <Checkbox
          label="Match individual colours too"
          checked={perColor}
          onChange={setPerColor}
        />
        <p className="hint">
          With this off you get the global match only — exposure, contrast, temperature and
          saturation. With it on, EasyColor also pairs up the two palettes and adds colour zones
          for hues that differ, which is what carries a specific look rather than an overall cast.
        </p>

        <Button onClick={applyMatch} disabled={!reference || !hasMedia}>
          Apply match
        </Button>

        {notes.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {notes.map((note, i) => (
              <p key={i} className="hint">
                {note}
              </p>
            ))}
            <p className="hint">
              These landed in the normal controls. Adjust or undo any of them.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

function PaletteStrip({ palette }: { palette: Swatch[] }) {
  if (palette.length === 0) return <p className="hint">No colours found.</p>;
  return (
    <div className="palette" title="Swatch widths show how much of the frame each colour covers">
      {palette.map((s, i) => (
        <div
          key={i}
          className="palette-swatch"
          style={{
            // Width by cluster weight, so the strip reads as the image's
            // actual colour balance rather than a flat set of chips.
            flex: Math.max(0.08, s.weight),
            background: `rgb(${s.rgb.map((v) => Math.round(v * 255)).join(',')})`,
          }}
        />
      ))}
    </div>
  );
}
