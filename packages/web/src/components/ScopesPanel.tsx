import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SKIN_TONE_LINE_DEG,
  beginScopeDrag,
  computeHistogram,
  computeParade,
  computeVectorscope,
  computeWaveform,
  updateScopeDrag,
} from '@easycolor/core';
import type { ScopeDrag } from '@easycolor/core';
import { useStore } from '../state/StoreContext.js';
import type { RendererApi } from '../hooks/useRenderer.js';
import { Button } from './ui/controls.js';

/**
 * Real-time scopes.
 *
 * Two things make these usable rather than decorative:
 *
 * - **They are draggable.** Grab the trace and pull: without a modifier that
 *   is overall exposure, with Shift it is the wheel for whichever tonal
 *   range you grabbed. Reading a scope and then hunting for the right slider
 *   is a step that does not need to exist.
 *
 * - **They are throttled, not skipped.** Scopes update on a timer rather
 *   than every frame, because reading pixels back from the GPU stalls the
 *   pipeline. At ~12Hz they feel live and cost almost nothing; at 60Hz they
 *   halve the viewer's frame rate.
 */

export type ScopeKind = 'waveform' | 'parade' | 'histogram' | 'vectorscope';

const SCOPE_LABEL: Record<ScopeKind, string> = {
  waveform: 'Waveform',
  parade: 'RGB Parade',
  histogram: 'Histogram',
  vectorscope: 'Vectorscope',
};

const REFRESH_MS = 80;

interface Props {
  renderer: RendererApi;
  active: ScopeKind[];
  onToggle: (kind: ScopeKind) => void;
  hasMedia: boolean;
}

export function ScopesPanel({ renderer, active, onToggle, hasMedia }: Props) {
  const [frame, setFrame] = useState<{ data: Uint8Array; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!hasMedia || active.length === 0) return;
    let cancelled = false;

    const id = window.setInterval(() => {
      if (cancelled) return;
      const grabbed = renderer.grabFrame(420);
      if (grabbed) setFrame(grabbed);
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [renderer, hasMedia, active.length]);

  return (
    <div className="scopes">
      <div className="scopes-head">
        {(Object.keys(SCOPE_LABEL) as ScopeKind[]).map((kind) => (
          <Button
            key={kind}
            small
            variant="ghost"
            active={active.includes(kind)}
            onClick={() => onToggle(kind)}
          >
            {SCOPE_LABEL[kind]}
          </Button>
        ))}
        <div className="spacer" style={{ flex: 1 }} />
        <span className="hint" style={{ margin: 0 }}>
          Drag a scope to set exposure · Shift for the tonal range you grabbed
        </span>
      </div>

      <div className="scopes-body">
        {active.length === 0 && (
          <div className="scope">
            <div className="scope-label">No scopes shown</div>
          </div>
        )}
        {active.map((kind) => (
          <ScopeView key={kind} kind={kind} frame={frame} />
        ))}
      </div>
    </div>
  );
}

function ScopeView({
  kind,
  frame,
}: {
  kind: ScopeKind;
  frame: { data: Uint8Array; width: number; height: number } | null;
}) {
  const store = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ drag: ScopeDrag; startY: number; height: number } | null>(null);

  const draggable = kind !== 'vectorscope';

  const onPointerDown = (e: React.PointerEvent) => {
    if (!draggable) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    // Scopes draw black at the bottom, so invert to get a 0..1 level.
    const level = 1 - (e.clientY - rect.top) / Math.max(1, rect.height);
    dragRef.current = {
      drag: beginScopeDrag(store.getGrade(), Math.min(1, Math.max(0, level))),
      startY: e.clientY,
      height: rect.height,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const state = dragRef.current;
    if (!state) return;
    const dv = (e.clientY - state.startY) / Math.max(1, state.height);
    store.update(
      (g) =>
        updateScopeDrag(g, state.drag, dv, {
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
        }),
      e.shiftKey ? `Adjust ${state.drag.range}` : 'Exposure',
      e.shiftKey ? `wheel:${state.drag.wheel}` : 'primaries:exposure',
    );
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    store.commit();
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, w, h);

    if (!frame) return;

    switch (kind) {
      case 'waveform':
        drawWaveform(ctx, w, h, computeWaveform(frame, Math.min(512, w)), '#d8d8d8');
        drawIreGraticule(ctx, w, h);
        break;
      case 'parade': {
        const parade = computeParade(frame, Math.min(512, Math.floor(w / 3)));
        const third = w / 3;
        drawWaveform(ctx, third, h, parade.red, '#ff5a4d', 0);
        drawWaveform(ctx, third, h, parade.green, '#4ede7a', third);
        drawWaveform(ctx, third, h, parade.blue, '#5aa0ff', third * 2);
        drawIreGraticule(ctx, w, h);
        // Dividers, so the three channels don't read as one wide trace.
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.moveTo(third, 0);
        ctx.lineTo(third, h);
        ctx.moveTo(third * 2, 0);
        ctx.lineTo(third * 2, h);
        ctx.stroke();
        break;
      }
      case 'histogram':
        drawHistogram(ctx, w, h, computeHistogram(frame));
        break;
      case 'vectorscope':
        drawVectorscope(ctx, w, h, computeVectorscope(frame, 256));
        break;
    }
  }, [frame, kind]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div className={`scope${draggable ? ' draggable' : ''}`}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <div className="scope-label">{SCOPE_LABEL[kind]}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  wf: { data: Uint32Array; width: number; levels: number; peak: number },
  color: string,
  offsetX = 0,
): void {
  const image = ctx.createImageData(Math.floor(width), Math.floor(height));
  const rgb = hexToRgb(color);

  // A square-root response, not linear. A waveform's counts are extremely
  // skewed — a flat sky puts thousands of pixels on one level and a face
  // puts three on another — and a linear mapping renders everything but the
  // sky invisible.
  const scale = 1 / Math.sqrt(Math.max(1, wf.peak));

  for (let y = 0; y < image.height; y++) {
    const level = Math.floor((1 - y / image.height) * (wf.levels - 1));
    for (let x = 0; x < image.width; x++) {
      const col = Math.floor((x / image.width) * wf.width);
      const count = wf.data[col * wf.levels + level];
      if (count === 0) continue;

      const intensity = Math.min(1, Math.sqrt(count) * scale * 2.4);
      const i = (y * image.width + x) * 4;
      image.data[i] = rgb[0];
      image.data[i + 1] = rgb[1];
      image.data[i + 2] = rgb[2];
      image.data[i + 3] = Math.round(intensity * 255);
    }
  }

  ctx.putImageData(image, Math.round(offsetX), 0);
}

/** Broadcast reference lines: 0, 50 and 100 IRE, plus 18% grey. */
function drawIreGraticule(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  for (const [ire, label, strong] of [
    [0, '0', true],
    [18, '18%', false],
    [50, '50', false],
    [100, '100', true],
  ] as Array<[number, string, boolean]>) {
    const y = height * (1 - ire / 100);
    ctx.strokeStyle = strong ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(label, 3, Math.min(height - 6, Math.max(6, y - 6)));
  }
  ctx.restore();
}

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hist: { red: Uint32Array; green: Uint32Array; blue: Uint32Array; bins: number; peak: number },
): void {
  ctx.save();
  // Additive blending: where all three channels overlap the result reads
  // white, which is exactly the information a colourist wants from an RGB
  // histogram — where the image is neutral.
  ctx.globalCompositeOperation = 'lighter';

  const channels: Array<[Uint32Array, string]> = [
    [hist.red, 'rgba(255,90,77,0.75)'],
    [hist.green, 'rgba(78,222,122,0.75)'],
    [hist.blue, 'rgba(90,160,255,0.75)'],
  ];

  for (const [data, color] of channels) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < hist.bins; i++) {
      const x = (i / (hist.bins - 1)) * width;
      const y = height - Math.min(1, data[i] / hist.peak) * height * 0.94;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  for (const t of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(t * width, 0);
    ctx.lineTo(t * width, height);
    ctx.stroke();
  }
}

function drawVectorscope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  vs: { data: Uint32Array; size: number; peak: number; meanAngle: number },
): void {
  const dim = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = dim * 0.46;

  /* --- trace --- */
  const image = ctx.createImageData(Math.floor(width), Math.floor(height));
  const scale = 1 / Math.sqrt(Math.max(1, vs.peak));

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      // Map the canvas back into the accumulation grid.
      const gx = Math.floor(((x - cx) / (radius / 0.45) + 0.5) * vs.size);
      const gy = Math.floor(((y - cy) / (radius / 0.45) + 0.5) * vs.size);
      if (gx < 0 || gy < 0 || gx >= vs.size || gy >= vs.size) continue;

      const count = vs.data[gy * vs.size + gx];
      if (count === 0) continue;

      const intensity = Math.min(1, Math.sqrt(count) * scale * 2.6);
      const i = (y * image.width + x) * 4;
      image.data[i] = 120;
      image.data[i + 1] = 235;
      image.data[i + 2] = 160;
      image.data[i + 3] = Math.round(intensity * 255);
    }
  }
  ctx.putImageData(image, 0, 0);

  /* --- graticule --- */
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;

  for (const r of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  /* --- the skin tone line ---
     The one graticule mark that gets used constantly, so it is drawn
     brighter than the rest and labelled with its angle. */
  const skin = (SKIN_TONE_LINE_DEG * Math.PI) / 180;
  ctx.strokeStyle = 'rgba(255, 190, 150, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(skin) * radius, cy - Math.sin(skin) * radius);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255, 190, 150, 0.9)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(
    '123°',
    cx + Math.cos(skin) * radius * 0.78 + 4,
    cy - Math.sin(skin) * radius * 0.78,
  );

  /* --- where the frame's colour actually sits --- */
  if (Number.isFinite(vs.meanAngle)) {
    const mean = (vs.meanAngle * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(74, 168, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(mean) * radius, cy - Math.sin(mean) * radius);
    ctx.stroke();
  }

  ctx.restore();
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
