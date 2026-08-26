import { FILM_STOCKS, getStock } from '@easycolor/core';
import type { FilmStockId } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import { Slider } from '../ui/Slider.js';
import { Checkbox, Section, Select, fmt } from '../ui/controls.js';

/**
 * Film emulation.
 *
 * Choosing a stock also loads that stock's grain and halation defaults,
 * because those are not decoration — they are part of what makes a stock
 * recognisable. CineStill 800T without its red highlight bloom is just
 * Vision3 500T, which is precisely the difference between the two films.
 * The defaults are only defaults: everything stays adjustable afterwards.
 */
export function FilmPanel() {
  const store = useStore();
  const grade = useGrade();
  const film = grade.film;
  const stock = getStock(film.stock);

  const selectStock = (id: FilmStockId) => {
    const next = getStock(id);
    store.update(
      (g) => ({
        ...g,
        film: {
          ...g.film,
          stock: id,
          stockIntensity: id === 'none' ? g.film.stockIntensity : 1,
          grain:
            id === 'none'
              ? g.film.grain
              : {
                  ...g.film.grain,
                  enabled: next.grain.amount > 0,
                  amount: next.grain.amount,
                  size: next.grain.size,
                  shadowBias: next.grain.shadowBias,
                  chroma: next.grain.chroma,
                },
          halation:
            id === 'none'
              ? g.film.halation
              : {
                  ...g.film.halation,
                  enabled: next.halation.strength > 0,
                  threshold: next.halation.threshold,
                  radius: next.halation.radius,
                  strength: next.halation.strength,
                  tint: [...next.halation.tint] as [number, number, number],
                },
        },
      }),
      `Film stock: ${next.label}`,
    );
    store.commit();
  };

  const bindFilm = (key: 'stockIntensity' | 'density', label: string) =>
    (value: number, done: boolean) => {
      store.update((g) => ({ ...g, film: { ...g.film, [key]: value } }), label, `film:${key}`);
      if (done) store.commit();
    };

  const bindHalation = (key: keyof typeof film.halation, label: string) =>
    (value: number, done: boolean) => {
      store.update(
        (g) => ({ ...g, film: { ...g.film, halation: { ...g.film.halation, [key]: value } } }),
        label,
        `halation:${String(key)}`,
      );
      if (done) store.commit();
    };

  const bindGrain = (key: keyof typeof film.grain, label: string) =>
    (value: number, done: boolean) => {
      store.update(
        (g) => ({ ...g, film: { ...g.film, grain: { ...g.film.grain, [key]: value } } }),
        label,
        `grain:${String(key)}`,
      );
      if (done) store.commit();
    };

  return (
    <div className="panel">
      <Section title="Film stock">
        <Select<FilmStockId>
          value={film.stock}
          options={FILM_STOCKS.map((s) => ({
            value: s.id,
            label: s.id === 'none' ? s.label : `${s.maker} ${s.label}`,
            group: s.id === 'none' ? undefined : s.maker,
          }))}
          onChange={selectStock}
        />
        {film.stock !== 'none' && (
          <>
            <p className="hint">{stock.character}</p>
            <Slider
              label="Stock intensity"
              value={film.stockIntensity}
              min={0}
              max={1}
              step={0.01}
              defaultValue={1}
              format={fmt.percent}
              onChange={bindFilm('stockIntensity', 'Stock intensity')}
            />
          </>
        )}
      </Section>

      <Section title="Density">
        <Slider
          label="Subtractive density"
          value={film.density}
          min={0}
          max={1}
          step={0.01}
          format={fmt.percent}
          onChange={bindFilm('density', 'Film density')}
        />
        <p className="hint">
          Darkens colours as they saturate, the way light losing energy through dye layers does.
          It is the opposite of a saturation control, which pushes colours toward white until they
          clip — and it is the single biggest reason an emulation reads as film rather than as
          "more colourful".
        </p>
      </Section>

      <Section title="Halation">
        <Checkbox
          label="Enable halation"
          checked={film.halation.enabled}
          onChange={(checked) => {
            store.update(
              (g) => ({ ...g, film: { ...g.film, halation: { ...g.film.halation, enabled: checked } } }),
              'Toggle halation',
            );
            store.commit();
          }}
        />
        <p className="hint">
          Light passing through the emulsion, bouncing off the film base and exposing the layers a
          second time from behind. The red layer sits furthest from the base, which is why the halo
          is red-orange.
        </p>

        <Slider
          label="Threshold"
          value={film.halation.threshold}
          min={0.2}
          max={1}
          step={0.005}
          defaultValue={0.72}
          format={fmt.plain}
          disabled={!film.halation.enabled}
          onChange={bindHalation('threshold', 'Halation threshold')}
        />
        <Slider
          label="Bloom radius"
          value={film.halation.radius}
          min={1}
          max={80}
          step={0.5}
          defaultValue={18}
          format={fmt.pixels}
          disabled={!film.halation.enabled}
          onChange={bindHalation('radius', 'Halation radius')}
        />
        <p className="hint">
          Radius is measured at 1080p and scales with the frame, so a look holds when you apply the
          same grade to a 4K master.
        </p>
        <Slider
          label="Strength"
          value={film.halation.strength}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.35}
          format={fmt.percent}
          disabled={!film.halation.enabled}
          onChange={bindHalation('strength', 'Halation strength')}
        />

        <div className="control">
          <div className="control-head">
            <span className="control-label" style={{ cursor: 'default' }}>
              Halo colour
            </span>
          </div>
          <input
            type="color"
            className="field"
            style={{ height: 30, padding: 2 }}
            disabled={!film.halation.enabled}
            value={rgbToHex(film.halation.tint)}
            onChange={(e) => {
              const tint = hexToRgb(e.target.value);
              store.update(
                (g) => ({ ...g, film: { ...g.film, halation: { ...g.film.halation, tint } } }),
                'Halation colour',
                'halation:tint',
              );
              store.commit();
            }}
          />
        </div>
      </Section>

      <Section title="Grain">
        <Checkbox
          label="Enable grain"
          checked={film.grain.enabled}
          onChange={(checked) => {
            store.update(
              (g) => ({ ...g, film: { ...g.film, grain: { ...g.film.grain, enabled: checked } } }),
              'Toggle grain',
            );
            store.commit();
          }}
        />
        <Slider
          label="Amount"
          value={film.grain.amount}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.25}
          format={fmt.percent}
          disabled={!film.grain.enabled}
          onChange={bindGrain('amount', 'Grain amount')}
        />
        <Slider
          label="Size"
          value={film.grain.size}
          min={0.5}
          max={6}
          step={0.05}
          defaultValue={1.6}
          format={fmt.pixels}
          disabled={!film.grain.enabled}
          onChange={bindGrain('size', 'Grain size')}
        />
        <Slider
          label="Shadow bias"
          value={film.grain.shadowBias}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.6}
          format={fmt.percent}
          disabled={!film.grain.enabled}
          onChange={bindGrain('shadowBias', 'Grain shadow bias')}
        />
        <p className="hint">
          Real negative grains up in the toe of the curve, so shadows are grainier than highlights.
          At zero this looks like sensor noise instead.
        </p>
        <Slider
          label="Colour"
          value={film.grain.chroma}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.35}
          format={fmt.percent}
          disabled={!film.grain.enabled}
          onChange={bindGrain('chroma', 'Grain colour')}
        />
        <Checkbox
          label="Animate grain"
          checked={film.grain.animated}
          disabled={!film.grain.enabled}
          onChange={(checked) => {
            store.update(
              (g) => ({ ...g, film: { ...g.film, grain: { ...g.film.grain, animated: checked } } }),
              'Toggle grain animation',
            );
            store.commit();
          }}
        />
        <p className="hint">
          Frozen grain sticks to the screen on moving footage. Turn it off only when matching a
          still frame.
        </p>
      </Section>
    </div>
  );
}

function rgbToHex(rgb: [number, number, number]): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
