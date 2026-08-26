import { MAX_POWER_WINDOWS, createWindow } from '@easycolor/core';
import type { PowerWindow, WindowShape } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, fmt } from '../ui/controls.js';

interface Props {
  selectedWindowId: string | null;
  onSelectWindow: (id: string | null) => void;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

/**
 * Power windows: local corrections inside a shape.
 *
 * A vignette is not a separate feature here, it is an inverted ellipse with
 * negative exposure — which is what a vignette has always been. Presenting
 * it that way means the moment you want a vignette that is off-centre, or
 * warmer rather than darker, the controls for that are already in front of
 * you.
 */
export function WindowsPanel({ selectedWindowId, onSelectWindow, onNotify }: Props) {
  const store = useStore();
  const grade = useGrade();

  const addWindow = (shape: WindowShape) => {
    if (grade.windows.length >= MAX_POWER_WINDOWS) {
      onNotify(`Up to ${MAX_POWER_WINDOWS} power windows at once. Delete one to add another.`, 'error');
      return;
    }
    const window = createWindow(`win-${Date.now().toString(36)}`, shape);
    store.update((g) => ({ ...g, windows: [...g.windows, window] }), `Add ${window.label}`);
    store.commit();
    onSelectWindow(window.id);
  };

  const patch = (id: string, changes: Partial<PowerWindow>, label: string, merge: string | null) => {
    store.update(
      (g) => {
        const index = g.windows.findIndex((w) => w.id === id);
        if (index < 0) return g;
        const windows = [...g.windows];
        windows[index] = { ...windows[index], ...changes };
        return { ...g, windows };
      },
      label,
      merge,
    );
  };

  const remove = (id: string) => {
    store.update((g) => ({ ...g, windows: g.windows.filter((w) => w.id !== id) }), 'Delete window');
    store.commit();
    if (selectedWindowId === id) onSelectWindow(null);
  };

  return (
    <div className="panel">
      <Section title="Add a window">
        <div className="row wrap">
          <Button small onClick={() => addWindow('ellipse')}>
            Ellipse
          </Button>
          <Button small onClick={() => addWindow('rect')}>
            Rectangle
          </Button>
          <Button small onClick={() => addWindow('vignette')}>
            Vignette
          </Button>
        </div>
        <p className="hint">
          Switch to the <strong>Window</strong> tool to drag the handles on screen. The dashed
          outline shows how far the feather reaches.
        </p>
      </Section>

      <Section title={`Windows (${grade.windows.length}/${MAX_POWER_WINDOWS})`}>
        {grade.windows.length === 0 ? (
          <div className="empty">No power windows yet.</div>
        ) : (
          grade.windows.map((w) => {
            const expanded = w.id === selectedWindowId;
            const bind = (key: keyof PowerWindow, label: string) =>
              (value: number, done: boolean) => {
                patch(w.id, { [key]: value } as Partial<PowerWindow>, label, `window:${w.id}:${key}`);
                if (done) store.commit();
              };

            return (
              <div key={w.id} className={`zone${expanded ? ' selected' : ''}`}>
                <div
                  className="zone-head"
                  onClick={() => onSelectWindow(expanded ? null : w.id)}
                >
                  <span className="zone-title">
                    <span className="zone-name">{w.label}</span>
                    <span className="zone-summary">
                      {fmt.stops(w.exposure)} · {fmt.multiplier(w.saturation)}
                      {w.invert ? ' · inverted' : ''}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={w.enabled}
                    title="Enable this window"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      patch(w.id, { enabled: e.target.checked }, 'Toggle window', null);
                      store.commit();
                    }}
                  />
                </div>

                {expanded && (
                  <div className="zone-body">
                    <div className="control">
                      <div className="control-head">
                        <span className="control-label" style={{ cursor: 'default' }}>
                          Name
                        </span>
                      </div>
                      <input
                        className="field"
                        value={w.label}
                        onChange={(e) =>
                          patch(w.id, { label: e.target.value }, 'Rename window', `window:${w.id}:label`)
                        }
                        onBlur={() => store.commit()}
                      />
                    </div>

                    <Slider
                      label="Softness"
                      value={w.softness}
                      min={0.002}
                      max={1}
                      step={0.005}
                      format={fmt.percent}
                      onChange={bind('softness', 'Window softness')}
                    />
                    <Slider
                      label="Rotation"
                      value={w.rotation}
                      min={-180}
                      max={180}
                      step={0.5}
                      detent={0}
                      format={fmt.degreesAbs}
                      onChange={bind('rotation', 'Window rotation')}
                    />
                    {w.shape === 'rect' && (
                      <Slider
                        label="Corner rounding"
                        value={w.corner}
                        min={0}
                        max={1}
                        step={0.01}
                        format={fmt.percent}
                        onChange={bind('corner', 'Window corners')}
                      />
                    )}
                    <Slider
                      label="Opacity"
                      value={w.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      defaultValue={1}
                      format={fmt.percent}
                      onChange={bind('opacity', 'Window opacity')}
                    />

                    <h4
                      style={{
                        margin: '12px 0 6px',
                        fontSize: 11,
                        letterSpacing: '0.07em',
                        color: 'var(--text-faint)',
                      }}
                    >
                      CORRECTION INSIDE
                    </h4>
                    <Slider
                      label="Exposure"
                      value={w.exposure}
                      min={-3}
                      max={3}
                      step={0.01}
                      detent={0}
                      format={fmt.stops}
                      onChange={bind('exposure', 'Window exposure')}
                    />
                    <Slider
                      label="Contrast"
                      value={w.contrast}
                      min={-1}
                      max={1}
                      step={0.01}
                      detent={0}
                      format={fmt.signed}
                      onChange={bind('contrast', 'Window contrast')}
                    />
                    <Slider
                      label="Saturation"
                      value={w.saturation}
                      min={0}
                      max={2}
                      step={0.01}
                      defaultValue={1}
                      detent={1}
                      format={fmt.multiplier}
                      onChange={bind('saturation', 'Window saturation')}
                    />
                    <Slider
                      label="Temperature"
                      value={w.temperature}
                      min={-1}
                      max={1}
                      step={0.005}
                      detent={0}
                      format={fmt.signed}
                      onChange={bind('temperature', 'Window temperature')}
                    />
                    <Slider
                      label="Tint"
                      value={w.tint}
                      min={-1}
                      max={1}
                      step={0.005}
                      detent={0}
                      format={fmt.signed}
                      onChange={bind('tint', 'Window tint')}
                    />

                    <div className="row between" style={{ marginTop: 10 }}>
                      <Checkbox
                        label="Invert"
                        checked={w.invert}
                        onChange={(checked) => {
                          patch(w.id, { invert: checked }, 'Invert window', null);
                          store.commit();
                        }}
                      />
                      <div className="row">
                        <Button
                          small
                          variant="ghost"
                          active={
                            grade.viewer.overlay === 'windowMatte' &&
                            grade.viewer.overlayWindowId === w.id
                          }
                          onClick={() =>
                            store.updateViewer((viewer) => ({
                              ...viewer,
                              overlay:
                                viewer.overlay === 'windowMatte' && viewer.overlayWindowId === w.id
                                  ? 'none'
                                  : 'windowMatte',
                              overlayWindowId: w.id,
                            }))
                          }
                        >
                          Show matte
                        </Button>
                        <Button small variant="danger" onClick={() => remove(w.id)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </Section>
    </div>
  );
}
