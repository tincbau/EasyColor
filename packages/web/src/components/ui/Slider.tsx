import { useCallback, useRef } from 'react';

/**
 * A drag slider tuned for colour work.
 *
 * Three behaviours that a plain `<input type=range>` doesn't give you, and
 * that a colourist will reach for within the first minute:
 *
 * - **The label is a scrubber.** Dragging the name of a control adjusts it,
 *   which is how every NLE behaves and means you never have to hit a thumb.
 * - **Shift is fine adjustment**, a quarter of normal speed, because the
 *   difference between +0.02 and +0.05 of tint is a real difference.
 * - **Double-click resets to default**, since the fastest way to judge a
 *   control is to take it away.
 */

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Value the control returns to on double-click. */
  defaultValue?: number;
  /** Rendered readout. Defaults to a fixed-precision number. */
  format?: (value: number) => string;
  /** Draw a detent mark here, e.g. at the neutral point. */
  detent?: number;
  disabled?: boolean;
  onChange: (value: number, done: boolean) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.001,
  defaultValue,
  format,
  detent,
  disabled,
  onChange,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startValue: number; pointerId: number } | null>(null);

  const neutral = defaultValue ?? detent ?? min;
  const modified = Math.abs(value - neutral) > (step ?? 0.001) / 2;

  const quantise = useCallback(
    (v: number) => {
      const clamped = Math.min(max, Math.max(min, v));
      if (!step) return clamped;
      return Math.round(clamped / step) * step;
    },
    [min, max, step],
  );

  /** Absolute positioning: jump to wherever the track was clicked. */
  const setFromClientX = useCallback(
    (clientX: number, done: boolean) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = (clientX - rect.left) / Math.max(1, rect.width);
      onChange(quantise(min + t * (max - min)), done);
    },
    [min, max, onChange, quantise],
  );

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startValue: value, pointerId: e.pointerId };
    setFromClientX(e.clientX, false);
  };

  const onTrackPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    if (e.shiftKey) {
      // Fine mode is relative to where the drag started, so entering it
      // mid-drag doesn't make the value jump.
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const delta = ((e.clientX - dragRef.current.startX) / Math.max(1, rect.width)) * (max - min);
      onChange(quantise(dragRef.current.startValue + delta * 0.25), false);
      return;
    }
    setFromClientX(e.clientX, false);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    onChange(value, true);
  };

  /** Relative scrubbing from the label. */
  const onLabelPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    const startX = e.clientX;
    const startValue = value;
    const range = max - min;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const speed = ev.shiftKey ? 0.0008 : 0.0032;
      onChange(quantise(startValue + (ev.clientX - startX) * range * speed), false);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      onChange(value, true);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const coarse = (max - min) / 100;
    const amount = e.shiftKey ? coarse * 0.25 : coarse;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(quantise(value - amount), true);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(quantise(value + amount), true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(neutral, true);
    }
  };

  const t = (value - min) / Math.max(1e-9, max - min);
  const detentT = detent === undefined ? null : (detent - min) / Math.max(1e-9, max - min);
  const fillFrom = detentT ?? 0;

  return (
    <div className="control" data-disabled={disabled || undefined}>
      <div className="control-head">
        <span className="control-label" onPointerDown={onLabelPointerDown}>
          {label}
        </span>
        <span className={`control-value${modified ? ' modified' : ''}`}>
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <div
        ref={trackRef}
        className="slider-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : value.toFixed(2)}
        aria-disabled={disabled}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => !disabled && onChange(neutral, true)}
      >
        <div className="slider-rail" />
        <div
          className="slider-fill"
          style={{
            left: `${Math.min(fillFrom, t) * 100}%`,
            width: `${Math.abs(t - fillFrom) * 100}%`,
          }}
        />
        {detentT !== null && <div className="slider-detent" style={{ left: `${detentT * 100}%` }} />}
        <div className="slider-thumb" style={{ left: `${t * 100}%` }} />
      </div>
    </div>
  );
}
