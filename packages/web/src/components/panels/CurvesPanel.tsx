import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CURVE, buildCurveSampler } from '@easycolor/core';
import type { CurvePoint, Curves } from '@easycolor/core';
import { useGrade, useStore } from '../../state/StoreContext.js';
import { Button, Section } from '../ui/controls.js';

/**
 * The four-channel curve editor.
 *
 * Curves are the one control where a colourist's hand is more precise than
 * any slider, so the editor's job is to stay out of the way: click to add a
 * point, drag to move it, drag it off the graph to delete it. Points cannot
 * pass through each other, which is what keeps the underlying spline
 * monotone and stops a stray drag inverting the shadows.
 */

type Channel = keyof Curves;

const CHANNELS: Array<{ key: Channel; label: string; color: string }> = [
  { key: 'master', label: 'Master', color: '#d8d8d8' },
  { key: 'red', label: 'Red', color: '#ff5a4d' },
  { key: 'green', label: 'Green', color: '#4ede7a' },
  { key: 'blue', label: 'Blue', color: '#5aa0ff' },
];

const SIZE = 300;
const PAD = 10;
const HIT_RADIUS = 12;

export function CurvesPanel() {
  const store = useStore();
  const grade = useGrade();
  const [channel, setChannel] = useState<Channel>('master');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ index: number } | null>(null);

  const points = grade.curves[channel];
  const color = CHANNELS.find((c) => c.key === channel)!.color;

  const toCanvas = useCallback((p: CurvePoint) => {
    const inner = SIZE - PAD * 2;
    return { x: PAD + p.x * inner, y: PAD + (1 - p.y) * inner };
  }, []);

  const fromCanvas = useCallback((x: number, y: number): CurvePoint => {
    const inner = SIZE - PAD * 2;
    return {
      x: clamp01((x - PAD) / inner),
      y: clamp01(1 - (y - PAD) / inner),
    };
  }, []);

  const setPoints = useCallback(
    (next: CurvePoint[], label: string, merge: string | null) => {
      store.update(
        (g) => ({ ...g, curves: { ...g.curves, [channel]: next } }),
        label,
        merge,
      );
    },
    [channel, store],
  );

  /* ---- painting ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0c0c0c';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const inner = SIZE - PAD * 2;

    /* Grid at quarters, with the diagonal marked: the diagonal is "no
       change", and seeing how far the curve departs from it is most of
       what reading a curve is. */
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const t = PAD + (inner * i) / 4;
      ctx.beginPath();
      ctx.moveTo(t, PAD);
      ctx.lineTo(t, PAD + inner);
      ctx.moveTo(PAD, t);
      ctx.lineTo(PAD + inner, t);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + inner);
    ctx.lineTo(PAD + inner, PAD);
    ctx.stroke();
    ctx.setLineDash([]);

    /* The other channels, dimmed, so a red curve is visible in context. */
    for (const c of CHANNELS) {
      if (c.key === channel) continue;
      const other = grade.curves[c.key];
      if (isDefault(other)) continue;
      drawCurve(ctx, other, c.color, 0.28);
    }

    drawCurve(ctx, points, color, 1);

    /* Control points. */
    for (const p of points) {
      const { x, y } = toCanvas(p);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#101010';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, inner, inner);
  }, [points, channel, color, grade.curves, toCanvas]);

  /* ---- interaction ---- */

  const findPoint = (x: number, y: number): number => {
    for (let i = 0; i < points.length; i++) {
      const c = toCanvas(points[i]);
      if (Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS) return i;
    }
    return -1;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const existing = findPoint(x, y);
    if (existing >= 0) {
      if (e.altKey || e.button === 2) {
        removePoint(existing);
        return;
      }
      dragRef.current = { index: existing };
      return;
    }

    const p = fromCanvas(x, y);
    const next = [...points, p].sort((a, b) => a.x - b.x);
    setPoints(next, 'Add curve point', null);
    dragRef.current = { index: next.findIndex((q) => q === p) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const p = fromCanvas(e.clientX - rect.left, e.clientY - rect.top);

    const next = [...points];
    const isEnd = drag.index === 0 || drag.index === next.length - 1;

    // The endpoints stay pinned to x=0 and x=1: a curve that doesn't span
    // the full input range has undefined behaviour outside it.
    const x = isEnd ? next[drag.index].x : clampBetween(p.x, next, drag.index);
    next[drag.index] = { x, y: p.y };

    setPoints(next, 'Adjust curve', `curve:${channel}:${drag.index}`);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    store.commit();
  };

  const removePoint = (index: number) => {
    if (index === 0 || index === points.length - 1) return;
    setPoints(points.filter((_, i) => i !== index), 'Remove curve point', null);
    store.commit();
  };

  const resetChannel = () => {
    setPoints([...DEFAULT_CURVE], `Reset ${channel} curve`, null);
    store.commit();
  };

  const resetAll = () => {
    store.update(
      (g) => ({
        ...g,
        curves: {
          master: [...DEFAULT_CURVE],
          red: [...DEFAULT_CURVE],
          green: [...DEFAULT_CURVE],
          blue: [...DEFAULT_CURVE],
        },
      }),
      'Reset all curves',
    );
    store.commit();
  };

  return (
    <div className="panel">
      <Section title="Curves">
        <div className="group" style={{ marginBottom: 8, width: 'fit-content' }}>
          {CHANNELS.map((c) => (
            <Button
              key={c.key}
              small
              variant="ghost"
              active={channel === c.key}
              onClick={() => setChannel(c.key)}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: c.color,
                  display: 'inline-block',
                }}
              />
              {c.label}
              {!isDefault(grade.curves[c.key]) && <span aria-label="modified"> •</span>}
            </Button>
          ))}
        </div>

        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: SIZE, aspectRatio: '1', cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={(e) => e.preventDefault()}
        />

        <p className="hint">
          Click to add a point, drag to shape it, Alt-click or right-click to remove one. The
          endpoints stay locked to the edges. Points cannot cross, which keeps the curve monotone —
          so a drag can never invert your shadows.
        </p>

        <div className="row" style={{ marginTop: 8 }}>
          <Button small variant="ghost" onClick={resetChannel} disabled={isDefault(points)}>
            Reset {channel}
          </Button>
          <Button small variant="ghost" onClick={resetAll}>
            Reset all
          </Button>
        </div>
      </Section>
    </div>
  );
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  points: CurvePoint[],
  color: string,
  alpha: number,
): void {
  const sampler = buildCurveSampler(points);
  const inner = SIZE - PAD * 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = alpha === 1 ? 2 : 1.25;
  ctx.beginPath();

  for (let i = 0; i <= 128; i++) {
    const x = i / 128;
    const y = clamp01(sampler(x));
    const px = PAD + x * inner;
    const py = PAD + (1 - y) * inner;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function isDefault(points: CurvePoint[]): boolean {
  return (
    points.length === 2 &&
    points[0].x === 0 &&
    points[0].y === 0 &&
    points[1].x === 1 &&
    points[1].y === 1
  );
}

/** Keep a dragged point strictly between its neighbours. */
function clampBetween(x: number, points: CurvePoint[], index: number): number {
  const gap = 0.004;
  const lo = index > 0 ? points[index - 1].x + gap : 0;
  const hi = index < points.length - 1 ? points[index + 1].x - gap : 1;
  return Math.min(hi, Math.max(lo, x));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
