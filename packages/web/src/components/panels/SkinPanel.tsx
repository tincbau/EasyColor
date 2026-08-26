import { useCallback, useEffect, useState } from 'react';
import {
  SKIN_TONE_LINE_DEG,
  analyzeSkin,
  describeSelection,
  solveSkinHueShift,
} from '@easycolor/core';
import type { SkinAnalysis } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import type { RendererApi } from '../../hooks/useRenderer.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, fmt } from '../ui/controls.js';

/**
 * The skin tone suite.
 *
 * Skin is the one subject in a frame that has an objectively correct answer:
 * it sits on the 123 degree line of a vectorscope regardless of ethnicity or
 * lighting — only the distance along the line changes. So this panel measures
 * where the skin actually is, states the error in degrees, and can solve for
 * the rotation that fixes it.
 *
 * The auto-align is solved numerically rather than applying the measured
 * error as a hue shift. An Oklab hue rotation and a vectorscope angle are
 * related but not equal, so the naive version lands close and stops. This
 * one bisects until the cluster is on the line.
 */

interface Props {
  renderer: RendererApi;
  hasMedia: boolean;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
  onPickSkin: () => void;
}

export function SkinPanel({ renderer, hasMedia, onNotify, onPickSkin }: Props) {
  const store = useStore();
  const grade = useGrade();
  const skin = grade.skin;
  const [analysis, setAnalysis] = useState<SkinAnalysis | null>(null);

  /* Measure continuously while the panel is open. The analysis runs on the
     same downscaled frame the scopes use, so it costs one readback. */
  const measure = useCallback(() => {
    if (!hasMedia) return;
    const frame = renderer.grabFrame(320);
    if (!frame) return;
    setAnalysis(analyzeSkin(frame, skin, 2));
  }, [hasMedia, renderer, skin]);

  useEffect(() => {
    measure();
    const id = window.setInterval(measure, 400);
    return () => window.clearInterval(id);
  }, [measure]);

  const bind = (key: keyof typeof skin, label: string) => (value: number, done: boolean) => {
    store.update((g) => ({ ...g, skin: { ...g.skin, [key]: value } }), label, `skin:${key}`);
    if (done) store.commit();
  };

  const autoAlign = () => {
    if (!analysis || analysis.samples.length < 40) {
      onNotify(
        'Not enough skin selected to align. Use "Pick skin from image" and click a face first.',
        'error',
      );
      return;
    }

    const shift = solveSkinHueShift(analysis.samples);
    if (Math.abs(shift) < 0.05) {
      onNotify('Skin is already on the 123° line.', 'info');
      return;
    }

    store.update(
      (g) => ({ ...g, skin: { ...g.skin, enabled: true, hueShift: g.skin.hueShift + shift } }),
      'Align skin to 123°',
    );
    store.commit();
    onNotify(`Rotated skin ${shift >= 0 ? '+' : ''}${shift.toFixed(1)}° onto the line.`, 'success');
  };

  const toggleIsolation = () => {
    store.updateViewer((viewer) => ({
      ...viewer,
      overlay: viewer.overlay === 'skinIsolation' ? 'none' : 'skinIsolation',
    }));
  };

  const isolationOn = grade.viewer.overlay === 'skinIsolation';
  const errorClass =
    analysis === null
      ? ''
      : Math.abs(analysis.angleError) < 1.5
        ? ' ok'
        : Math.abs(analysis.angleError) > 8
          ? ' warn'
          : '';

  return (
    <div className="panel">
      <Section title="Skin tone">
        <Checkbox
          label="Enable skin tone corrections"
          checked={skin.enabled}
          onChange={(checked) => {
            store.update((g) => ({ ...g, skin: { ...g.skin, enabled: checked } }), 'Toggle skin panel');
            store.commit();
          }}
        />

        <div className="row" style={{ marginTop: 10 }}>
          <Button small onClick={onPickSkin}>
            Pick skin from image
          </Button>
          <Button small onClick={autoAlign} disabled={!hasMedia}>
            Align to 123°
          </Button>
        </div>
        <p className="hint">
          Picking sets the qualifier from a pixel you click. Aligning solves for the hue rotation
          that puts the whole selected cluster on the vectorscope's skin tone line.
        </p>
      </Section>

      <Section title="Measurement">
        {!hasMedia ? (
          <p className="hint">Open a still or a clip to measure.</p>
        ) : analysis === null ? (
          <p className="hint">Measuring…</p>
        ) : (
          <>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>
                Skin sits at
              </span>
              <span className="control-value">{analysis.meanAngle.toFixed(1)}°</span>
            </div>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>
                Target
              </span>
              <span className="control-value">{SKIN_TONE_LINE_DEG}°</span>
            </div>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>
                Error
              </span>
              <span className={`control-value${errorClass ? ' modified' : ''}`}>
                {analysis.angleError >= 0 ? '+' : ''}
                {analysis.angleError.toFixed(1)}°
              </span>
            </div>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>
                Frame coverage
              </span>
              <span className="control-value">{(analysis.coverage * 100).toFixed(1)}%</span>
            </div>
            <p className={`hint${errorClass}`}>{describeSelection(analysis)}</p>
          </>
        )}

        <Button small variant="ghost" active={isolationOn} onClick={toggleIsolation}>
          {isolationOn ? 'Hide isolation overlay' : 'Show isolation overlay'}
        </Button>
        <p className="hint">
          The overlay outlines the selection in place. It does not dim, blur or cover the picture —
          you are still judging the actual image while you tune the qualifier.
        </p>
      </Section>

      <Section title="Correction">
        <Slider
          label="Hue rotation"
          value={skin.hueShift}
          min={-60}
          max={60}
          step={0.1}
          detent={0}
          format={fmt.degrees}
          onChange={bind('hueShift', 'Skin hue')}
        />
        <Slider
          label="Saturation"
          value={skin.satGain}
          min={0}
          max={2}
          step={0.01}
          defaultValue={1}
          detent={1}
          format={fmt.multiplier}
          onChange={bind('satGain', 'Skin saturation')}
        />
        <Slider
          label="Luminance"
          value={skin.lumGain}
          min={-2}
          max={2}
          step={0.01}
          detent={0}
          format={fmt.stops}
          onChange={bind('lumGain', 'Skin luminance')}
        />
        <Slider
          label="Chroma smoothing"
          value={skin.smoothing}
          min={0}
          max={1}
          step={0.01}
          format={fmt.percent}
          onChange={bind('smoothing', 'Skin smoothing')}
        />
        <p className="hint">
          Smoothing averages colour inside the selection while leaving luminance detail alone, so
          blotchy skin evens out without the face turning to plastic.
        </p>
        <Slider
          label="Strength"
          value={skin.strength}
          min={0}
          max={1}
          step={0.01}
          defaultValue={1}
          format={fmt.percent}
          onChange={bind('strength', 'Skin strength')}
        />
      </Section>

      <Section title="Qualifier">
        <Slider
          label="Hue centre"
          value={skin.hue}
          min={0}
          max={360}
          step={0.5}
          format={fmt.degreesAbs}
          onChange={bind('hue', 'Skin hue centre')}
        />
        <Slider
          label="Hue width"
          value={skin.hueWidth}
          min={2}
          max={70}
          step={0.5}
          defaultValue={16}
          format={fmt.degreesAbs}
          onChange={bind('hueWidth', 'Skin hue width')}
        />
        <Slider
          label="Hue feather"
          value={skin.hueSoftness}
          min={0}
          max={70}
          step={0.5}
          defaultValue={20}
          format={fmt.degreesAbs}
          onChange={bind('hueSoftness', 'Skin hue feather')}
        />
        <Slider
          label="Chroma from"
          value={skin.chromaLow}
          min={0}
          max={0.2}
          step={0.002}
          format={fmt.plain}
          onChange={bind('chromaLow', 'Skin chroma low')}
        />
        <Slider
          label="Chroma to"
          value={skin.chromaHigh}
          min={0.02}
          max={0.5}
          step={0.002}
          format={fmt.plain}
          onChange={bind('chromaHigh', 'Skin chroma high')}
        />
        <Slider
          label="Luma from"
          value={skin.lumaLow}
          min={0}
          max={1}
          step={0.005}
          format={fmt.plain}
          onChange={bind('lumaLow', 'Skin luma low')}
        />
        <Slider
          label="Luma to"
          value={skin.lumaHigh}
          min={0}
          max={1.4}
          step={0.005}
          format={fmt.plain}
          onChange={bind('lumaHigh', 'Skin luma high')}
        />
      </Section>
    </div>
  );
}
