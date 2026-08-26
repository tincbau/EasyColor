import type { ReactNode } from 'react';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  group?: string;
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
}) {
  const groups = new Map<string, SelectOption<T>[]>();
  for (const o of options) {
    const key = o.group ?? '';
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }

  return (
    <div className="control">
      {label && (
        <div className="control-head">
          <span className="control-label" style={{ cursor: 'default' }}>
            {label}
          </span>
        </div>
      )}
      <select className="field" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {[...groups.entries()].map(([group, list]) =>
          group === '' ? (
            list.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ) : (
            <optgroup key={group} label={group}>
              {list.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
    </div>
  );
}

export function Button({
  children,
  onClick,
  active,
  disabled,
  title,
  variant,
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  variant?: 'ghost' | 'danger';
  small?: boolean;
}) {
  const classes = ['btn'];
  if (variant) classes.push(variant);
  if (active) classes.push('active');
  if (small) classes.push('small');

  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

/** Formatters shared by every panel, so the same quantity always reads the same. */
export const fmt = {
  stops: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`,
  signed: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`,
  percent: (v: number) => `${Math.round(v * 100)}%`,
  percentSigned: (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`,
  multiplier: (v: number) => `${v.toFixed(2)}x`,
  degrees: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°`,
  degreesAbs: (v: number) => `${v.toFixed(1)}°`,
  pixels: (v: number) => `${v.toFixed(1)} px`,
  plain: (v: number) => v.toFixed(3),
};
