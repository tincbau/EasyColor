import { useEffect, useRef, useState } from 'react';
import type { PowerWindow } from '@easycolor/core';
import { useGradeSlice, useStore } from '../state/StoreContext.js';

/**
 * On-screen handles for power windows.
 *
 * Drawn as an SVG outline rather than a filled overlay: a power window is a
 * mask over the picture, and the picture is the thing being judged. Anything
 * that tints or dims what is inside the mask defeats the purpose of looking
 * at it.
 *
 * The gizmo shows two outlines — the hard edge and the outer extent of the
 * feather — because "how soft is this edge" is otherwise invisible until you
 * turn the correction up far enough to see it, by which point it is too
 * strong to judge.
 */

interface Props {
  selectedWindowId: string | null;
  onSelectWindow: (id: string | null) => void;
  containerRef: React.RefObject<HTMLElement>;
}

type HandleKind = 'move' | 'rx' | 'ry' | 'rotate' | 'softness';

interface DragState {
  kind: HandleKind;
  id: string;
  startX: number;
  startY: number;
  baseline: PowerWindow;
  rect: DOMRect;
}

const HANDLE_RADIUS = 5;

export function WindowGizmos({ selectedWindowId, onSelectWindow, containerRef }: Props) {
  const store = useStore();
  const windows = useGradeSlice((g) => g.windows);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [containerRef]);

  if (size.width < 2 || size.height < 2) return null;

  const { width, height } = size;

  const beginDrag = (e: React.PointerEvent, kind: HandleKind, window: PowerWindow) => {
    const el = containerRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelectWindow(window.id);
    dragRef.current = {
      kind,
      id: window.id,
      startX: e.clientX,
      startY: e.clientY,
      baseline: { ...window },
      rect: el.getBoundingClientRect(),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;

    const du = (e.clientX - drag.startX) / drag.rect.width;
    const dv = (e.clientY - drag.startY) / drag.rect.height;
    const base = drag.baseline;

    store.update(
      (g) => {
        const index = g.windows.findIndex((w) => w.id === drag.id);
        if (index < 0) return g;

        const next = { ...base };
        switch (drag.kind) {
          case 'move':
            next.cx = clamp(base.cx + du, -0.5, 1.5);
            next.cy = clamp(base.cy + dv, -0.5, 1.5);
            break;
          case 'rx':
            // Resize about the centre, so a window stays where you put it.
            next.rx = clamp(base.rx + rotateDelta(du, dv, base.rotation).x, 0.01, 2);
            break;
          case 'ry':
            next.ry = clamp(base.ry + rotateDelta(du, dv, base.rotation).y, 0.01, 2);
            break;
          case 'rotate': {
            const angle = Math.atan2(
              e.clientY - (drag.rect.top + base.cy * drag.rect.height),
              e.clientX - (drag.rect.left + base.cx * drag.rect.width),
            );
            // The rotate handle sits above the window, so add 90 degrees to
            // make the handle point at the cursor rather than lag it.
            next.rotation = (angle * 180) / Math.PI + 90;
            break;
          }
          case 'softness':
            next.softness = clamp(base.softness + dv * 1.6, 0.002, 1);
            break;
        }

        const windowsNext = [...g.windows];
        windowsNext[index] = next;
        return { ...g, windows: windowsNext };
      },
      `Adjust ${drag.baseline.label}`,
      `window:${drag.id}:${drag.kind}`,
    );
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    store.commit();
  };

  return (
    <svg
      className="viewer-gizmos"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{ pointerEvents: 'none' }}
    >
      {windows.map((w) => {
        if (!w.enabled) return null;
        const selected = w.id === selectedWindowId;
        const cx = w.cx * width;
        const cy = w.cy * height;
        const rx = w.rx * width;
        const ry = w.ry * height;
        const softRx = rx * (1 + w.softness);
        const softRy = ry * (1 + w.softness);

        const stroke = selected ? '#4aa8ff' : 'rgba(255,255,255,0.55)';
        const transform = `rotate(${w.rotation} ${cx} ${cy})`;

        return (
          <g key={w.id} transform={transform}>
            {/* Feather extent, dashed. */}
            <Outline
              shape={w.shape}
              cx={cx}
              cy={cy}
              rx={softRx}
              ry={softRy}
              corner={w.corner}
              stroke={stroke}
              opacity={0.4}
              dash="4 4"
            />
            {/* Hard edge. Two strokes, dark under light, so the outline stays
                visible over both a blown highlight and a crushed shadow. */}
            <Outline
              shape={w.shape}
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              corner={w.corner}
              stroke="rgba(0,0,0,0.65)"
              width={3}
            />
            <Outline
              shape={w.shape}
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              corner={w.corner}
              stroke={stroke}
              width={1.25}
            />

            {/* Handles */}
            <Handle x={cx} y={cy} title="Move" onPointerDown={(e) => beginDrag(e, 'move', w)} />
            <Handle x={cx + rx} y={cy} title="Width" onPointerDown={(e) => beginDrag(e, 'rx', w)} />
            <Handle x={cx} y={cy + ry} title="Height" onPointerDown={(e) => beginDrag(e, 'ry', w)} />
            <line
              x1={cx}
              y1={cy - ry}
              x2={cx}
              y2={cy - ry - 22}
              stroke={stroke}
              strokeWidth={1}
              opacity={0.7}
            />
            <Handle
              x={cx}
              y={cy - ry - 22}
              title="Rotate"
              onPointerDown={(e) => beginDrag(e, 'rotate', w)}
            />
            <Handle
              x={cx - softRx}
              y={cy}
              title="Softness"
              square
              onPointerDown={(e) => beginDrag(e, 'softness', w)}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Outline({
  shape,
  cx,
  cy,
  rx,
  ry,
  corner,
  stroke,
  width = 1.25,
  opacity = 1,
  dash,
}: {
  shape: PowerWindow['shape'];
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  corner: number;
  stroke: string;
  width?: number;
  opacity?: number;
  dash?: string;
}) {
  const common = {
    fill: 'none',
    stroke,
    strokeWidth: width,
    opacity,
    strokeDasharray: dash,
    vectorEffect: 'non-scaling-stroke' as const,
  };

  if (shape === 'rect') {
    // The shader's superellipse has no exact SVG equivalent; a rounded rect
    // whose radius tracks the same parameter is close enough to aim with.
    const r = Math.min(rx, ry) * corner;
    return <rect x={cx - rx} y={cy - ry} width={rx * 2} height={ry * 2} rx={r} ry={r} {...common} />;
  }
  return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} {...common} />;
}

function Handle({
  x,
  y,
  title,
  square,
  onPointerDown,
}: {
  x: number;
  y: number;
  title: string;
  square?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const props = {
    className: 'handle',
    fill: '#101010',
    stroke: '#ffffff',
    strokeWidth: 1.5,
    onPointerDown,
  };
  return (
    <g>
      <title>{title}</title>
      {square ? (
        <rect
          x={x - HANDLE_RADIUS}
          y={y - HANDLE_RADIUS}
          width={HANDLE_RADIUS * 2}
          height={HANDLE_RADIUS * 2}
          {...props}
        />
      ) : (
        <circle cx={x} cy={y} r={HANDLE_RADIUS} {...props} />
      )}
      {/* A larger invisible target: a 5px handle is not grabbable in practice. */}
      <circle cx={x} cy={y} r={13} fill="transparent" className="handle" onPointerDown={onPointerDown} />
    </g>
  );
}

/** Project a screen-space delta onto the window's rotated axes. */
function rotateDelta(du: number, dv: number, rotationDeg: number): { x: number; y: number } {
  const r = (-rotationDeg * Math.PI) / 180;
  return {
    x: du * Math.cos(r) - dv * Math.sin(r),
    y: du * Math.sin(r) + dv * Math.cos(r),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
