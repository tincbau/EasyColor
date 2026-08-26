import { describeHue } from '@easycolor/core';
import type { HslZone } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, fmt } from '../ui/controls.js';

/**
 * The colour zones created by the on-viewer HSL tool.
 *
 * This panel is the numeric view of a gesture that already happened. Nothing
 * here is the primary way to work — you make zones by clicking the image —
 * but a look you cannot inspect is a look you cannot hand to anyone else, so
 * everything the drag set is editable, nameable and dismissible here.
 */

interface Props {
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
}

export function ColorZonesPanel({ selectedZoneId, onSelectZone }: Props) {
  const store = useStore();
  const grade = useGrade();

  const patchZone = (id: string, patch: Partial<HslZone>, label: string, merge: string | null) => {
    store.update(
      (g) => {
        const index = g.zones.findIndex((z) => z.id === id);
        if (index < 0) return g;
        const zones = [...g.zones];
        zones[index] = { ...zones[index], ...patch };
        return { ...g, zones };
      },
      label,
      merge,
    );
  };

  const removeZone = (id: string) => {
    store.update((g) => ({ ...g, zones: g.zones.filter((z) => z.id !== id) }), 'Delete colour zone');
    store.commit();
    if (selectedZoneId === id) onSelectZone(null);
  };

  const showMatte = (id: string | null) => {
    store.updateViewer((viewer) => ({
      ...viewer,
      overlay: viewer.overlay === 'zoneMatte' && viewer.overlayZoneId === id ? 'none' : 'zoneMatte',
      overlayZoneId: id,
    }));
  };

  return (
    <div className="panel">
      <Section title="Qualifier softness">
        <Slider
          label="Matte softness"
          value={grade.qualifierSoftness}
          min={0}
          max={12}
          step={0.1}
          defaultValue={2.5}
          detent={2.5}
          format={fmt.pixels}
          onChange={(value, done) => {
            store.update((g) => ({ ...g, qualifierSoftness: value }), 'Qualifier softness', 'qualifier');
            if (done) store.commit();
          }}
        />
        <p className="hint">
          Blurs the image the mattes are built from — never the image itself. Compressed footage
          carries its colour at half resolution, so a selection built from the raw pixels inherits
          the codec's 2×2 chroma blocks as stair-stepping along the edge. A couple of pixels here
          removes that without softening the picture at all.
        </p>
      </Section>

      <Section title={`Colour zones (${grade.zones.length})`}>
        {grade.zones.length === 0 ? (
          <div className="empty">
            No colour zones yet.
            <br />
            Pick the <strong>Colour</strong> tool and click any colour in the image, then drag:
            left and right for hue, up and down for saturation.
          </div>
        ) : (
          grade.zones.map((zone) => (
            <ZoneCard
              key={zone.id}
              zone={zone}
              expanded={zone.id === selectedZoneId}
              onToggle={() => onSelectZone(zone.id === selectedZoneId ? null : zone.id)}
              onPatch={(patch, label, merge) => patchZone(zone.id, patch, label, merge)}
              onCommit={() => store.commit()}
              onRemove={() => removeZone(zone.id)}
              onShowMatte={() => showMatte(zone.id)}
              matteShown={
                grade.viewer.overlay === 'zoneMatte' && grade.viewer.overlayZoneId === zone.id
              }
            />
          ))
        )}

        {grade.zones.length > 1 && (
          <p className="hint">
            Zones are independent. Where two overlap their edits blend rather than stack, so
            grading one colour can never undo another.
          </p>
        )}
      </Section>
    </div>
  );
}

function ZoneCard({
  zone,
  expanded,
  onToggle,
  onPatch,
  onCommit,
  onRemove,
  onShowMatte,
  matteShown,
}: {
  zone: HslZone;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<HslZone>, label: string, merge: string | null) => void;
  onCommit: () => void;
  onRemove: () => void;
  onShowMatte: () => void;
  matteShown: boolean;
}) {
  const swatch = `rgb(${zone.sampleRgb.map((v) => Math.round(v * 255)).join(',')})`;

  const bind =
    (key: keyof HslZone, label: string) => (value: number, done: boolean) => {
      onPatch({ [key]: value } as Partial<HslZone>, label, `zone:${zone.id}:${key}`);
      if (done) onCommit();
    };

  const summary = [
    zone.hueShift !== 0 ? `${fmt.degrees(zone.hueShift)}` : null,
    zone.satGain !== 1 ? `${fmt.multiplier(zone.satGain)}` : null,
    zone.lumGain !== 0 ? `${fmt.stops(zone.lumGain)}` : null,
  ]
    .filter(Boolean)
    .join('  ');

  return (
    <div className={`zone${expanded ? ' selected' : ''}`}>
      <div className="zone-head" onClick={onToggle}>
        <span className="zone-swatch" style={{ background: swatch }} />
        <span className="zone-title">
          <span className="zone-name">{zone.label}</span>
          <span className="zone-summary">{summary || 'no change yet'}</span>
        </span>
        <input
          type="checkbox"
          checked={zone.enabled}
          title="Enable this zone"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            onPatch({ enabled: e.target.checked }, 'Toggle zone', null);
            onCommit();
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
              value={zone.label}
              onChange={(e) => onPatch({ label: e.target.value }, 'Rename zone', `zone:${zone.id}:label`)}
              onBlur={onCommit}
            />
          </div>

          <h4 style={{ margin: '12px 0 6px', fontSize: 11, letterSpacing: '0.07em', color: 'var(--text-faint)' }}>
            EDIT
          </h4>
          <Slider
            label="Hue shift"
            value={zone.hueShift}
            min={-180}
            max={180}
            step={0.5}
            detent={0}
            format={fmt.degrees}
            onChange={bind('hueShift', 'Zone hue')}
          />
          <Slider
            label="Saturation"
            value={zone.satGain}
            min={0}
            max={3}
            step={0.01}
            defaultValue={1}
            detent={1}
            format={fmt.multiplier}
            onChange={bind('satGain', 'Zone saturation')}
          />
          <Slider
            label="Luminance"
            value={zone.lumGain}
            min={-4}
            max={4}
            step={0.01}
            detent={0}
            format={fmt.stops}
            onChange={bind('lumGain', 'Zone luminance')}
          />
          <Slider
            label="Strength"
            value={zone.strength}
            min={0}
            max={1}
            step={0.01}
            defaultValue={1}
            format={fmt.percent}
            onChange={bind('strength', 'Zone strength')}
          />

          <h4 style={{ margin: '12px 0 6px', fontSize: 11, letterSpacing: '0.07em', color: 'var(--text-faint)' }}>
            QUALIFIER
          </h4>
          <Slider
            label="Hue centre"
            value={zone.hue}
            min={0}
            max={360}
            step={0.5}
            format={fmt.degreesAbs}
            onChange={(value, done) => {
              onPatch(
                { hue: value, label: zone.label === describeHue(zone.hue) ? describeHue(value) : zone.label },
                'Zone hue centre',
                `zone:${zone.id}:hue`,
              );
              if (done) onCommit();
            }}
          />
          <Slider
            label="Hue width"
            value={zone.hueWidth}
            min={1}
            max={90}
            step={0.5}
            defaultValue={18}
            format={fmt.degreesAbs}
            onChange={bind('hueWidth', 'Zone hue width')}
          />
          <Slider
            label="Hue feather"
            value={zone.hueSoftness}
            min={0}
            max={90}
            step={0.5}
            defaultValue={22}
            format={fmt.degreesAbs}
            onChange={bind('hueSoftness', 'Zone hue feather')}
          />
          <Slider
            label="Chroma from"
            value={zone.chromaLow}
            min={0}
            max={0.4}
            step={0.002}
            format={fmt.plain}
            onChange={bind('chromaLow', 'Zone chroma low')}
          />
          <Slider
            label="Chroma to"
            value={zone.chromaHigh}
            min={0}
            max={0.6}
            step={0.002}
            format={fmt.plain}
            onChange={bind('chromaHigh', 'Zone chroma high')}
          />
          <Slider
            label="Chroma feather"
            value={zone.chromaSoftness}
            min={0.001}
            max={0.25}
            step={0.002}
            defaultValue={0.05}
            format={fmt.plain}
            onChange={bind('chromaSoftness', 'Zone chroma feather')}
          />
          <Slider
            label="Luma from"
            value={zone.lumaLow}
            min={0}
            max={1.2}
            step={0.005}
            format={fmt.plain}
            onChange={bind('lumaLow', 'Zone luma low')}
          />
          <Slider
            label="Luma to"
            value={zone.lumaHigh}
            min={0}
            max={1.4}
            step={0.005}
            format={fmt.plain}
            onChange={bind('lumaHigh', 'Zone luma high')}
          />
          <Slider
            label="Luma feather"
            value={zone.lumaSoftness}
            min={0.001}
            max={0.6}
            step={0.005}
            defaultValue={0.25}
            format={fmt.plain}
            onChange={bind('lumaSoftness', 'Zone luma feather')}
          />

          <div className="row between" style={{ marginTop: 10 }}>
            <Checkbox
              label="Solo"
              checked={zone.solo}
              onChange={(checked) => {
                onPatch({ solo: checked }, 'Solo zone', null);
                onCommit();
              }}
            />
            <div className="row">
              <Button small variant="ghost" active={matteShown} onClick={onShowMatte}>
                Show matte
              </Button>
              <Button small variant="danger" onClick={onRemove}>
                Delete
              </Button>
            </div>
          </div>
          <p className="hint">
            Solo hides every other zone's edit so you can judge this one alone. Show matte outlines
            the selection over the picture without dimming it.
          </p>
        </div>
      )}
    </div>
  );
}
