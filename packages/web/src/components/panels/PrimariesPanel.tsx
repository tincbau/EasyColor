import {
  DISPLAY_RENDERS,
  LOG_TRANSFORMS,
  LOOK_PRESETS,
  isNeutralGrade,
} from '@easycolor/core';
import type { DisplayRenderId, LogTransformId } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, Select, fmt } from '../ui/controls.js';

/**
 * Camera conversion and the primary grade.
 *
 * Conversion sits at the top because it is the first decision on any log
 * clip and everything downstream depends on it: grading S-Log3 as if it were
 * Rec.709 means fighting a flat, desaturated image with controls that were
 * never going to fix it.
 */
export function PrimariesPanel() {
  const store = useStore();
  const grade = useGrade();
  const p = grade.primaries;

  const setPrimary = (key: keyof typeof p, label: string) => (value: number, done: boolean) => {
    store.update(
      (g) => ({ ...g, primaries: { ...g.primaries, [key]: value } }),
      label,
      `primaries:${key}`,
    );
    if (done) store.commit();
  };

  return (
    <div className="panel">
      <Section title="Camera conversion">
        <Select<LogTransformId>
          label="Source"
          value={grade.source.logTransform}
          options={LOG_TRANSFORMS.map((t) => ({
            value: t.id,
            label: t.id === 'none' ? t.label : `${t.vendor} ${t.label}`,
            group: t.id === 'none' ? undefined : t.vendor,
          }))}
          onChange={(value) => {
            store.update(
              (g) => ({ ...g, source: { ...g.source, logTransform: value } }),
              'Set camera profile',
            );
            store.commit();
          }}
        />

        {grade.source.logTransform !== 'none' && (
          <>
            <Select<DisplayRenderId>
              label="Display rendering"
              value={grade.source.displayRender}
              options={DISPLAY_RENDERS.map((d) => ({ value: d.id, label: d.label }))}
              onChange={(value) => {
                store.update(
                  (g) => ({ ...g, source: { ...g.source, displayRender: value } }),
                  'Set display rendering',
                );
                store.commit();
              }}
            />
            <p className="hint">
              {DISPLAY_RENDERS.find((d) => d.id === grade.source.displayRender)?.hint}
            </p>

            <Checkbox
              label="Apply camera gamut"
              checked={grade.source.applyGamut}
              onChange={(checked) => {
                store.update(
                  (g) => ({ ...g, source: { ...g.source, applyGamut: checked } }),
                  checked ? 'Enable gamut conversion' : 'Disable gamut conversion',
                );
                store.commit();
              }}
            />
            <p className="hint">
              Converts the camera's wide primaries to Rec.709. Without it, log footage stays
              under-saturated no matter how far you push saturation.
            </p>
          </>
        )}
      </Section>

      <Section title="Exposure & balance">
        <Slider
          label="Exposure"
          value={p.exposure}
          min={-4}
          max={4}
          step={0.01}
          detent={0}
          format={fmt.stops}
          onChange={setPrimary('exposure', 'Exposure')}
        />
        <Slider
          label="Temperature"
          value={p.temperature}
          min={-1}
          max={1}
          step={0.005}
          detent={0}
          format={fmt.signed}
          onChange={setPrimary('temperature', 'Temperature')}
        />
        <Slider
          label="Tint"
          value={p.tint}
          min={-1}
          max={1}
          step={0.005}
          detent={0}
          format={fmt.signed}
          onChange={setPrimary('tint', 'Tint')}
        />
      </Section>

      <Section title="Contrast">
        <Slider
          label="Contrast"
          value={p.contrast}
          min={-1}
          max={1}
          step={0.005}
          detent={0}
          format={fmt.signed}
          onChange={setPrimary('contrast', 'Contrast')}
        />
        <Slider
          label="Pivot"
          value={p.pivot}
          min={0.05}
          max={0.95}
          step={0.005}
          defaultValue={0.435}
          detent={0.435}
          format={fmt.plain}
          onChange={setPrimary('pivot', 'Contrast pivot')}
        />
        <p className="hint">
          The pivot is the level contrast rotates around. The default, 0.435, is where 18% grey
          lands after the Rec.709 encode.
        </p>
        <Slider
          label="Highlights"
          value={p.highlights}
          min={-1}
          max={1}
          step={0.005}
          detent={0}
          format={fmt.signed}
          onChange={setPrimary('highlights', 'Highlights')}
        />
        <Slider
          label="Shadows"
          value={p.shadows}
          min={-1}
          max={1}
          step={0.005}
          detent={0}
          format={fmt.signed}
          onChange={setPrimary('shadows', 'Shadows')}
        />
      </Section>

      <Section title="Colour">
        <Slider
          label="Saturation"
          value={p.saturation}
          min={0}
          max={2.5}
          step={0.005}
          defaultValue={1}
          detent={1}
          format={fmt.multiplier}
          onChange={setPrimary('saturation', 'Saturation')}
        />
        <Slider
          label="Vibrance"
          value={p.vibrance}
          min={-1}
          max={1}
          step={0.005}
          detent={0}
          format={fmt.signed}
          onChange={setPrimary('vibrance', 'Vibrance')}
        />
        <p className="hint">
          Vibrance weights its effect toward already-dull pixels, so a flat background comes up
          without pushing skin into a sunburn.
        </p>
      </Section>

      <Section title="Looks">
        <div className="row wrap">
          {LOOK_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              small
              title={preset.description}
              onClick={() => {
                store.update(preset.apply(grade), `Look: ${preset.label}`);
                store.commit();
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <p className="hint">
          A look is applied on top of what you already have — your exposure and camera conversion
          are kept.
        </p>
        {isNeutralGrade(grade) && (
          <p className="hint">This grade is currently neutral: the image is unmodified.</p>
        )}
      </Section>
    </div>
  );
}
