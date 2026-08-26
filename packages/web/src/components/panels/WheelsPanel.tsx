import type { WheelValue } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import { ColorWheel } from '../ui/ColorWheel.js';
import { Button, Section } from '../ui/controls.js';

const NEUTRAL: WheelValue = { r: 0, g: 0, b: 0, luma: 0 };

const WHEELS = [
  { key: 'lift', name: 'Lift', hint: 'Shadows. Pivoted at white, so it opens or crushes the blacks.' },
  { key: 'gamma', name: 'Gamma', hint: 'Midtones. Where most of a face lives.' },
  { key: 'gain', name: 'Gain', hint: 'Highlights. Pivoted at black, so it scales the top end.' },
  { key: 'offset', name: 'Offset', hint: 'The whole image, equally. Useful for a flat cast.' },
] as const;

/**
 * The three-way wheels, plus Offset.
 *
 * These are the same controls the on-viewer tonal tool drives — dragging a
 * shadow on the image moves Lift here, and this panel is where you refine
 * what that gesture did. Keeping both views on one state, rather than
 * having a separate "direct" mode, is what makes the two feel like one tool.
 */
export function WheelsPanel() {
  const store = useStore();
  const grade = useGrade();

  const setWheel = (key: (typeof WHEELS)[number]['key'], name: string) =>
    (value: WheelValue, done: boolean) => {
      store.update(
        (g) => ({ ...g, wheels: { ...g.wheels, [key]: value } }),
        `${name} wheel`,
        `wheel:${key}`,
      );
      if (done) store.commit();
    };

  const resetAll = () => {
    store.update(
      (g) => ({
        ...g,
        wheels: {
          lift: { ...NEUTRAL },
          gamma: { ...NEUTRAL },
          gain: { ...NEUTRAL },
          offset: { ...NEUTRAL },
        },
      }),
      'Reset wheels',
    );
    store.commit();
  };

  return (
    <div className="panel">
      <Section title="Colour wheels">
        <div className="wheels">
          {WHEELS.map((w) => (
            <ColorWheel
              key={w.key}
              name={w.name}
              value={grade.wheels[w.key]}
              onChange={setWheel(w.key, w.name)}
              onReset={() => {
                store.update(
                  (g) => ({ ...g, wheels: { ...g.wheels, [w.key]: { ...NEUTRAL } } }),
                  `Reset ${w.name}`,
                );
                store.commit();
              }}
            />
          ))}
        </div>
        <p className="hint">
          Drag inside a wheel for colour balance, or around its outer ring for the master luma.
          Double-click a wheel to reset it.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <Button small variant="ghost" onClick={resetAll}>
            Reset all wheels
          </Button>
        </div>
      </Section>

      <Section title="What each wheel does">
        {WHEELS.map((w) => (
          <p key={w.key} className="hint">
            <strong style={{ color: 'var(--text)' }}>{w.name}</strong> — {w.hint}
          </p>
        ))}
        <p className="hint" style={{ marginTop: 10 }}>
          You can also grade these directly on the image: pick the Tonal tool, then drag on a
          shadow, a midtone or a highlight and EasyColor picks the matching wheel for you.
        </p>
      </Section>
    </div>
  );
}
