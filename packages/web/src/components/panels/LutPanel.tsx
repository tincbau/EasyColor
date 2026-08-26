import { useRef, useState } from 'react';
import { parseCube, toLut3D, writeCube } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import type { RendererApi } from '../../hooks/useRenderer.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, Select, fmt } from '../ui/controls.js';

/**
 * LUT input and export.
 *
 * The export is a real bake, not a fit: the identity lattice is pushed
 * through the same shader programs the viewer just used, so the exported
 * cube reproduces the grade exactly rather than approximating it.
 *
 * What a 3D LUT cannot carry is stated up front rather than discovered
 * later. Halation, grain and power windows depend on where a pixel is, and a
 * cube only knows what colour it is. Saying so before the download beats a
 * support thread about why the LUT "looks different".
 */

interface Props {
  renderer: RendererApi;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

const SIZES = [17, 25, 33, 49, 65] as const;

export function LutPanel({ renderer, onNotify }: Props) {
  const store = useStore();
  const grade = useGrade();
  const inputRef = useRef<HTMLInputElement>(null);
  const [exportSize, setExportSize] = useState<number>(33);
  const [busy, setBusy] = useState(false);

  const loadFile = async (file: File) => {
    try {
      const lut = toLut3D(parseCube(await file.text()));
      store.update(
        (g) => ({
          ...g,
          lut: {
            ...g.lut,
            enabled: true,
            name: lut.title || file.name,
            size: lut.size,
            data: lut.data,
            intensity: g.lut.intensity,
          },
        }),
        `Load LUT: ${file.name}`,
      );
      store.commit();
      renderer.invalidate();
      onNotify(`Loaded ${file.name} (${lut.size}³).`, 'success');
    } catch (e) {
      onNotify(e instanceof Error ? e.message : `Could not read ${file.name}.`, 'error');
    }
  };

  const clearLut = () => {
    store.update(
      (g) => ({ ...g, lut: { ...g.lut, enabled: false, name: null, size: 0, data: null } }),
      'Remove LUT',
    );
    store.commit();
    renderer.invalidate();
  };

  const exportLut = () => {
    if (!renderer.renderer) {
      onNotify('The grading engine is not ready yet.', 'error');
      return;
    }
    setBusy(true);
    // Yield first so the button's disabled state paints before the bake
    // blocks the main thread on a 65-cube.
    window.setTimeout(() => {
      try {
        const data = renderer.renderer!.bakeLut(grade, exportSize);
        const text = writeCube(exportSize, data, { title: grade.name || 'EasyColor grade' });
        download(text, `${sanitise(grade.name || 'easycolor-grade')}.cube`, 'text/plain');
        onNotify(`Exported a ${exportSize}³ LUT.`, 'success');
      } catch (e) {
        onNotify(e instanceof Error ? e.message : 'Could not bake the LUT.', 'error');
      } finally {
        setBusy(false);
      }
    }, 0);
  };

  const spatialEffects = [
    grade.film.halation.enabled && grade.film.halation.strength > 0 ? 'halation' : null,
    grade.film.grain.enabled && grade.film.grain.amount > 0 ? 'grain' : null,
    grade.windows.some((w) => w.enabled) ? 'power windows' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="panel">
      <Section title="Input LUT">
        {grade.lut.data ? (
          <>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>
                Loaded
              </span>
              <span className="control-value">{grade.lut.size}³</span>
            </div>
            <p className="hint" style={{ color: 'var(--text)' }}>
              {grade.lut.name}
            </p>

            <Checkbox
              label="Apply this LUT"
              checked={grade.lut.enabled}
              onChange={(checked) => {
                store.update((g) => ({ ...g, lut: { ...g.lut, enabled: checked } }), 'Toggle LUT');
                store.commit();
                renderer.invalidate();
              }}
            />

            <Slider
              label="Intensity"
              value={grade.lut.intensity}
              min={0}
              max={1}
              step={0.01}
              defaultValue={1}
              format={fmt.percent}
              disabled={!grade.lut.enabled}
              onChange={(value, done) => {
                store.update((g) => ({ ...g, lut: { ...g.lut, intensity: value } }), 'LUT intensity', 'lut:intensity');
                if (done) store.commit();
              }}
            />

            <Select
              label="Apply at"
              value={grade.lut.stage}
              options={[
                { value: 'display', label: 'After camera conversion (creative LUT)' },
                { value: 'log', label: 'Before conversion (log-to-Rec.709 LUT)' },
              ]}
              onChange={(stage) => {
                store.update((g) => ({ ...g, lut: { ...g.lut, stage } }), 'LUT stage');
                store.commit();
              }}
            />
            <p className="hint">
              A LUT built to convert log footage expects to see log. Applying it after the camera
              conversion corrects the same image twice, which is what makes a "broken" LUT look
              washed out and green.
            </p>

            <div className="row" style={{ marginTop: 8 }}>
              <Button small variant="ghost" onClick={() => inputRef.current?.click()}>
                Replace
              </Button>
              <Button small variant="danger" onClick={clearLut}>
                Remove
              </Button>
            </div>
          </>
        ) : (
          <div className="empty">
            No LUT loaded.
            <br />
            <Button small onClick={() => inputRef.current?.click()}>
              Choose a .cube file
            </Button>
            <p className="hint">You can also drop one straight onto the viewer.</p>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept=".cube,.CUBE"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadFile(file);
            e.target.value = '';
          }}
        />
      </Section>

      <Section title="Export LUT">
        <Select
          label="Cube size"
          value={String(exportSize)}
          options={SIZES.map((s) => ({
            value: String(s),
            label: `${s}³ — ${s ** 3} entries${s === 33 ? ' (standard)' : ''}`,
          }))}
          onChange={(v) => setExportSize(Number(v))}
        />

        <Button onClick={exportLut} disabled={busy || !renderer.ready}>
          {busy ? 'Baking…' : 'Export .cube'}
        </Button>

        <p className="hint">
          The bake replays the actual grading shader over an identity lattice, so the cube matches
          what you are looking at rather than approximating it.
        </p>

        {grade.source.logTransform !== 'none' && (
          <p className="hint">
            This LUT includes the {grade.source.logTransform.toUpperCase()} conversion, so it maps
            camera log straight to your graded Rec.709. Apply it to the original log clip, not to
            footage that has already been converted.
          </p>
        )}

        {spatialEffects.length > 0 && (
          <p className="hint warn">
            {spatialEffects.join(', ')} {spatialEffects.length === 1 ? 'is' : 'are'} not included: a
            3D LUT maps colour to colour and cannot know where a pixel sits in the frame. Everything
            else — the conversion, primaries, wheels, curves, film stock, colour zones and skin
            corrections — bakes in exactly.
          </p>
        )}
      </Section>
    </div>
  );
}

function download(text: string, filename: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a short
  // delay is the pragmatic fix everyone lands on.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function sanitise(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'easycolor-grade';
}

export { download, sanitise };
