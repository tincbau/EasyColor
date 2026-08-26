import { useCallback, useEffect, useRef } from 'react';
import type { WheelValue } from '@easycolor/core';

/**
 * A three-way colour wheel with a master luma ring.
 *
 * The disc is a pure chroma control: the three channel offsets it produces
 * always sum to zero, so moving the wheel changes balance without changing
 * exposure. That separation is the reason the luma ring exists as its own
 * control rather than being folded into the disc — a colourist expects to be
 * able to shift colour and brightness independently, and a wheel that does
 * both at once makes both harder to judge.
 *
 * The maths: the angle maps to a direction in RGB space with red at 0
 * degrees, green at 120 and blue at 240. Since cos(t) + cos(t-120) +
 * cos(t-240) is identically zero, every point on the disc is luminance-
 * neutral by construction rather than by correction.
 */

export interface ColorWheelProps {
  name: string;
  value: WheelValue;
  /** Maximum chroma offset at the rim. */
  range?: number;
  size?: number;
  onChange: (value: WheelValue, done: boolean) => void;
  onReset: () => void;
}

const RING_THICKNESS = 9;
const RING_GAP = 3;

export function ColorWheel({
  name,
  value,
  range = 0.5,
  size = 118,
  onChange,
  onReset,
}: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<'disc' | 'ring' | null>(null);

  const discRadius = size / 2 - (RING_THICKNESS + RING_GAP);

  /* ---- geometry ---- */

  const toOffsets = useCallback(
    (x: number, y: number): { r: number; g: number; b: number } => {
      // x, y are -1..1 within the disc.
      const distance = Math.min(1, Math.hypot(x, y));
      const angle = Math.atan2(-y, x);
      const amount = distance * range;
      return {
        r: amount * Math.cos(angle),
        g: amount * Math.cos(angle - (2 * Math.PI) / 3),
        b: amount * Math.cos(angle - (4 * Math.PI) / 3),
      };
    },
    [range],
  );

  const toPosition = useCallback(
    (v: WheelValue): { x: number; y: number } => {
      // Inverse of `toOffsets`. The 1.5 factor falls out of the identity
      // used above; see the module comment.
      const x = v.r - (v.g + v.b) / 2;
      const y = ((v.g - v.b) * Math.sqrt(3)) / 2;
      const amount = Math.hypot(x, y) / 1.5;
      if (amount < 1e-6) return { x: 0, y: 0 };
      const angle = Math.atan2(y, x);
      const distance = Math.min(1, amount / range);
      return { x: Math.cos(angle) * distance, y: -Math.sin(angle) * distance };
    },
    [range],
  );

  /* ---- painting ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;

    /* The chroma disc. Drawn per-pixel because a conic gradient cannot
       also fade to neutral at the centre, and the neutral centre is what
       tells you where "no correction" is. */
    const image = ctx.createImageData(Math.ceil(size), Math.ceil(size));
    for (let py = 0; py < image.height; py++) {
      for (let px = 0; px < image.width; px++) {
        const dx = (px - cx) / discRadius;
        const dy = (py - cy) / discRadius;
        const distance = Math.hypot(dx, dy);
        if (distance > 1.02) continue;

        const angle = Math.atan2(-dy, dx);
        const sat = Math.min(1, distance);

        const r = 0.5 + 0.5 * sat * Math.cos(angle);
        const g = 0.5 + 0.5 * sat * Math.cos(angle - (2 * Math.PI) / 3);
        const b = 0.5 + 0.5 * sat * Math.cos(angle - (4 * Math.PI) / 3);

        // Anti-alias the rim rather than leaving a hard staircase.
        const alpha = distance > 1 ? Math.max(0, 1 - (distance - 1) * 50) : 1;

        const i = (py * image.width + px) * 4;
        image.data[i] = Math.round(r * 255);
        image.data[i + 1] = Math.round(g * 255);
        image.data[i + 2] = Math.round(b * 255);
        image.data[i + 3] = Math.round(alpha * 235);
      }
    }
    ctx.putImageData(image, 0, 0);

    /* The luma ring.
       The empty track is drawn light enough to read against the panel it
       sits on — a track the same value as its background is invisible, and
       an invisible control does not get used. */
    const ringRadius = size / 2 - RING_THICKNESS / 2;
    ctx.lineWidth = RING_THICKNESS;
    ctx.strokeStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Hairlines on both edges of the track, so it reads as a groove rather
    // than a smudge.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    for (const r of [ringRadius - RING_THICKNESS / 2, ringRadius + RING_THICKNESS / 2]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = RING_THICKNESS;

    // The filled arc runs from the top, clockwise for positive and
    // anticlockwise for negative, so the neutral point is unmistakable.
    const sweep = (value.luma / 1) * Math.PI * 0.8;
    if (Math.abs(sweep) > 0.001) {
      ctx.strokeStyle = value.luma > 0 ? '#e8e8e8' : '#141414';
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, -Math.PI / 2, -Math.PI / 2 + sweep, sweep < 0);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - ringRadius - RING_THICKNESS / 2);
    ctx.lineTo(cx, cy - ringRadius + RING_THICKNESS / 2);
    ctx.stroke();

    /* The puck. */
    const pos = toPosition(value);
    const px = cx + pos.x * discRadius;
    const py = cy + pos.y * discRadius;

    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.75;
    ctx.stroke();

    /* Centre mark, so neutral is visible even under the puck. */
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
  }, [size, discRadius, value, toPosition]);

  /* ---- interaction ---- */

  const handlePointer = (e: React.PointerEvent, done: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width / 2);
    const dy = (e.clientY - cy) / (rect.height / 2);
    const distance = Math.hypot(dx, dy);

    const discEdge = discRadius / (size / 2);

    if (dragRef.current === null) {
      dragRef.current = distance > discEdge ? 'ring' : 'disc';
    }

    if (dragRef.current === 'ring') {
      // Angle around the ring maps to the luma value, measured from the top.
      let angle = Math.atan2(dy, dx) + Math.PI / 2;
      if (angle > Math.PI) angle -= Math.PI * 2;
      const luma = Math.max(-1, Math.min(1, angle / (Math.PI * 0.8)));
      onChange({ ...value, luma }, done);
    } else {
      const scaled = distance > 1 ? { x: dx / distance, y: dy / distance } : { x: dx, y: dy };
      const factor = 1 / discEdge;
      const offsets = toOffsets(
        Math.max(-1, Math.min(1, scaled.x * factor)),
        Math.max(-1, Math.min(1, scaled.y * factor)),
      );
      onChange({ ...value, ...offsets }, done);
    }
  };

  const readout = `${signed(value.r)} ${signed(value.g)} ${signed(value.b)}  Y${signed(value.luma)}`;

  return (
    <div className="wheel">
      <span className="wheel-name">{name}</span>
      <canvas
        ref={canvasRef}
        className="wheel-surface"
        style={{ width: size, height: size }}
        role="group"
        aria-label={`${name} colour wheel`}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as Element).setPointerCapture(e.pointerId);
          dragRef.current = null;
          handlePointer(e, false);
        }}
        onPointerMove={(e) => {
          if (dragRef.current === null && e.buttons === 0) return;
          if (e.buttons === 0) return;
          handlePointer(e, false);
        }}
        onPointerUp={(e) => {
          if (dragRef.current !== null) handlePointer(e, true);
          dragRef.current = null;
          (e.target as Element).releasePointerCapture?.(e.pointerId);
        }}
        onDoubleClick={onReset}
      />
      <span className="wheel-readout">{readout}</span>
    </div>
  );
}

function signed(v: number): string {
  const s = v.toFixed(2);
  return v >= 0 ? `+${s}` : s;
}
