import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginHslGrade,
  beginScopeDrag,
  beginTonalGrade,
  cancelHslGrade,
  dragWasNoOp,
  updateHslGrade,
  updateTonalGrade,
  axisFor,
  qualifierFromSample,
} from '@easycolor/core';
import type { GradeState, HslDrag, Modifiers, TonalDrag } from '@easycolor/core';
import { useGrade, useStore } from '../state/StoreContext.js';
import type { RendererApi } from '../hooks/useRenderer.js';
import type { MediaSource } from '../hooks/useMedia.js';
import { WindowGizmos } from './WindowGizmos.js';
import type { ViewerTool } from './Toolbar.js';

/**
 * The viewer, and the direct-grading surface on top of it.
 *
 * The interaction model is deliberately narrow. A pointer-down samples the
 * image and decides *what* the gesture is about; the drag then changes it;
 * release commits one undo step. No mode dialogs, no confirm, no handles to
 * find first.
 *
 * A live HUD follows the cursor during a drag, naming the thing being
 * changed and the numbers being applied. Direct manipulation without a
 * readout is guesswork — the HUD is what turns "I dragged until it looked
 * right" into "I rotated that blue 14 degrees", which is the difference
 * between a look you can reproduce and one you can't.
 */

interface ViewerProps {
  renderer: RendererApi;
  media: MediaSource;
  tool: ViewerTool;
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  selectedWindowId: string | null;
  onSelectWindow: (id: string | null) => void;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
  onOpenFiles: (files: FileList) => void;
}

interface HudState {
  x: number;
  y: number;
  lines: string[];
}

type ActiveDrag =
  | { kind: 'hsl'; drag: HslDrag; startX: number; startY: number }
  | { kind: 'tonal'; drag: TonalDrag; startX: number; startY: number }
  | { kind: 'wipe' };

export function Viewer({
  renderer,
  media,
  tool,
  selectedZoneId,
  onSelectZone,
  selectedWindowId,
  onSelectWindow,
  onNotify,
  onOpenFiles,
}: ViewerProps) {
  const store = useStore();
  const grade = useGrade();
  const viewerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fit, setFit] = useState({ width: 0, height: 0 });

  const hasMedia = media.kind !== 'none';

  /**
   * Fit the image to the pane, in whole pixels.
   *
   * Computed here rather than left to `max-width`/`max-height` because the
   * pointer surface and the power-window gizmos are positioned against this
   * box: if CSS and JavaScript disagree about it by even a pixel, a click
   * samples the wrong pixel and a gizmo handle sits slightly off its shape.
   */
  useEffect(() => {
    const container = viewerRef.current;
    if (!container || !media.width || !media.height) {
      setFit({ width: 0, height: 0 });
      return;
    }

    const recompute = () => {
      const padding = 24;
      const availableW = Math.max(1, container.clientWidth - padding);
      const availableH = Math.max(1, container.clientHeight - padding);
      const scale = Math.min(availableW / media.width, availableH / media.height);
      setFit({
        width: Math.max(1, Math.floor(media.width * scale)),
        height: Math.max(1, Math.floor(media.height * scale)),
      });
    };

    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    recompute();
    return () => observer.disconnect();
  }, [media.width, media.height]);

  /** Client coordinates -> normalised image coordinates, y down. */
  const toImageCoords = useCallback((clientX: number, clientY: number) => {
    const el = surfaceRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      u: (clientX - rect.left) / rect.width,
      v: (clientY - rect.top) / rect.height,
      rect,
    };
  }, []);

  const modifiersFrom = (e: PointerEvent | React.PointerEvent): Modifiers => ({
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
  });

  /* ---------------------------------------------------------------- */
  /* Pointer down: decide what the gesture is about                    */
  /* ---------------------------------------------------------------- */

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasMedia || !renderer.ready) return;
    // The window tool works through its own SVG handles.
    if (tool === 'window') return;

    const coords = toImageCoords(e.clientX, e.clientY);
    if (!coords) return;

    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    if (tool === 'wipe') {
      dragRef.current = { kind: 'wipe' };
      applyWipe(coords.u, coords.v);
      return;
    }

    const sample = renderer.sample(coords.u, coords.v);
    if (!sample) return;

    if (tool === 'picker') {
      // Set the skin qualifier from whatever was clicked, and switch the
      // panel on so the result is immediately visible.
      store.update(
        (g) => ({ ...g, skin: { ...qualifierFromSample(sample.base, g.skin), enabled: true } }),
        'Pick skin tone',
      );
      store.commit();
      onNotify('Skin qualifier set from the sampled pixel.', 'success');
      return;
    }

    if (tool === 'hsl') {
      const result = beginHslGrade(grade, sample);
      if (!result.drag) {
        if (result.problem) onNotify(result.problem, 'error');
        return;
      }
      if (result.grade !== grade) {
        store.update(result.grade, 'Add colour zone', `zone:${result.drag.zoneId}`);
      }
      onSelectZone(result.drag.zoneId);
      dragRef.current = { kind: 'hsl', drag: result.drag, startX: e.clientX, startY: e.clientY };
      updateHud(e.clientX, e.clientY, hslHud(result.drag, 0, 0, modifiersFrom(e)));
      return;
    }

    if (tool === 'tonal') {
      const drag = beginTonalGrade(grade, sample);
      dragRef.current = { kind: 'tonal', drag, startX: e.clientX, startY: e.clientY };
      updateHud(e.clientX, e.clientY, tonalHud(drag, grade, modifiersFrom(e)));
    }
  };

  /* ---------------------------------------------------------------- */
  /* Pointer move: apply the drag                                      */
  /* ---------------------------------------------------------------- */

  const onPointerMove = (e: React.PointerEvent) => {
    const active = dragRef.current;
    const coords = toImageCoords(e.clientX, e.clientY);
    if (!coords) return;

    if (!active) {
      // Idle hover: show what is under the cursor. Cheap enough to do live,
      // and it turns the viewer into a permanent eyedropper.
      if (hasMedia && renderer.ready && (tool === 'hsl' || tool === 'picker')) {
        const sample = renderer.sample(coords.u, coords.v);
        if (sample) updateHud(e.clientX, e.clientY, hoverHud(sample.graded));
      }
      return;
    }

    const mods = modifiersFrom(e);

    if (active.kind === 'wipe') {
      applyWipe(coords.u, coords.v);
      return;
    }

    const rect = coords.rect;
    const du = (e.clientX - active.startX) / Math.max(1, rect.width);
    const dv = (e.clientY - active.startY) / Math.max(1, rect.height);

    if (active.kind === 'hsl') {
      store.update(
        (g) => updateHslGrade(g, active.drag, du, dv, mods),
        'Grade colour',
        `zone:${active.drag.zoneId}`,
      );
      updateHud(e.clientX, e.clientY, hslHud(active.drag, du, dv, mods, store.getGrade()));
    } else {
      store.update(
        (g) => updateTonalGrade(g, active.drag, du, dv, mods),
        `Grade ${active.drag.range}`,
        `wheel:${active.drag.wheel}`,
      );
      updateHud(e.clientX, e.clientY, tonalHud(active.drag, store.getGrade(), mods));
    }
  };

  /* ---------------------------------------------------------------- */
  /* Pointer up: commit, or discard a zone that was only inspected     */
  /* ---------------------------------------------------------------- */

  const endDrag = (e: React.PointerEvent) => {
    const active = dragRef.current;
    dragRef.current = null;
    setHud(null);
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (!active) return;

    if (active.kind === 'hsl') {
      const current = store.getGrade();
      // A click that created a zone but never moved it was someone looking,
      // not grading. Discard the history entry rather than pushing a
      // compensating one: an inspect-click should leave no trace at all, not
      // two dead steps to undo through.
      if (active.drag.created && dragWasNoOp(current, active.drag)) {
        if (!store.discardLast(`zone:${active.drag.zoneId}`)) {
          store.update(cancelHslGrade(current, active.drag), 'Cancel colour zone');
        }
        onSelectZone(null);
      }
    }

    store.commit();
  };

  const applyWipe = (u: number, v: number) => {
    store.updateViewer((viewer) => ({
      ...viewer,
      compare: viewer.compare === 'off' ? 'wipe' : viewer.compare,
      wipe: Math.min(1, Math.max(0, viewer.wipeVertical ? v : u)),
    }));
  };

  const updateHud = (clientX: number, clientY: number, lines: string[]) => {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setHud({ x: clientX - rect.left, y: clientY - rect.top, lines });
  };

  /* ---------------------------------------------------------------- */
  /* Drag and drop                                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const stageStyle = fit.width ? { width: fit.width, height: fit.height } : undefined;

  return (
    <div
      ref={viewerRef}
      className="viewer"
      onDragEnter={() => setDragOver(true)}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) onOpenFiles(e.dataTransfer.files);
      }}
    >
      {renderer.error && (
        <div className="viewer-empty">
          <strong>Cannot start the grading engine</strong>
          <p className="hint">{renderer.error}</p>
        </div>
      )}

      {!renderer.error && !hasMedia && (
        <div className="viewer-empty">
          <strong>Drop a still or a clip to start</strong>
          <p className="hint">
            Then click any colour in the image and drag to grade it. Drag left and right for hue,
            up and down for saturation. Hold <kbd>Shift</kbd> for saturation only, or{' '}
            <kbd>Ctrl</kbd> for luminance only.
          </p>
          <p className="hint">
            You can also drop a <code>.cube</code> LUT or an <code>.ecgrade</code> project here.
          </p>
        </div>
      )}

      <div ref={stageRef} className="viewer-stage" style={stageStyle} hidden={!hasMedia}>
        <canvas ref={renderer.canvasRef} />

        <div
          ref={surfaceRef}
          className={`viewer-surface tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            if (!dragRef.current) setHud(null);
          }}
        />

        {tool === 'window' && (
          <WindowGizmos
            selectedWindowId={selectedWindowId}
            onSelectWindow={onSelectWindow}
            containerRef={surfaceRef}
          />
        )}

        <div className="viewer-badge">
          {grade.viewer.bypass && <span className="badge live">Bypass</span>}
          {grade.viewer.compare !== 'off' && !grade.viewer.bypass && (
            <span className="badge">
              {grade.viewer.compare === 'wipe' ? 'Wipe' : 'Side by side'} ·{' '}
              {grade.viewer.reference === 'source' ? 'source' : 'corrected'}
            </span>
          )}
          {grade.viewer.overlay !== 'none' && (
            <span className="badge">{OVERLAY_LABEL[grade.viewer.overlay]}</span>
          )}
          {selectedZoneId && tool === 'hsl' && (
            <span className="badge">
              {grade.zones.find((z) => z.id === selectedZoneId)?.label ?? ''}
            </span>
          )}
        </div>

        {hud && (
          <div
            className="viewer-hud"
            style={hudPosition(hud, surfaceRef.current)}
          >
            {hud.lines.join('\n')}
          </div>
        )}
      </div>

      {dragOver && <div className="dropzone">Drop to open</div>}
    </div>
  );
}

const OVERLAY_LABEL: Record<string, string> = {
  falseColor: 'False colour',
  skinIsolation: 'Skin isolation',
  zoneMatte: 'Zone matte',
  windowMatte: 'Window matte',
};

/** Keep the HUD inside the viewer and out from under the cursor. */
function hudPosition(hud: HudState, surface: HTMLElement | null): React.CSSProperties {
  const width = surface?.clientWidth ?? 0;
  const height = surface?.clientHeight ?? 0;
  const flipX = hud.x > width - 190;
  const flipY = hud.y > height - 110;
  return {
    left: flipX ? undefined : hud.x + 16,
    right: flipX ? width - hud.x + 16 : undefined,
    top: flipY ? undefined : hud.y + 16,
    bottom: flipY ? height - hud.y + 16 : undefined,
  };
}

function hoverHud(rgb: [number, number, number]): string[] {
  const to255 = (v: number) => Math.round(v * 255).toString().padStart(3, ' ');
  const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return [
    `R ${to255(rgb[0])}  G ${to255(rgb[1])}  B ${to255(rgb[2])}`,
    `Y ${(luma * 100).toFixed(1)} IRE`,
  ];
}

function hslHud(
  drag: HslDrag,
  du: number,
  dv: number,
  mods: Modifiers,
  grade?: GradeState,
): string[] {
  const zone = grade?.zones.find((z) => z.id === drag.zoneId);
  const axis = axisFor(mods);
  const lock =
    axis === 'saturation'
      ? 'SATURATION ONLY'
      : axis === 'luminance'
        ? 'LUMINANCE ONLY'
        : 'hue ←→   sat ↑↓';

  const hueShift = zone?.hueShift ?? drag.baseline.hueShift;
  const satGain = zone?.satGain ?? drag.baseline.satGain;
  const lumGain = zone?.lumGain ?? drag.baseline.lumGain;

  return [
    `${zone?.label ?? drag.baseline.label}${drag.created ? '  (new)' : ''}`,
    `hue  ${hueShift >= 0 ? '+' : ''}${hueShift.toFixed(1)}°`,
    `sat  ${satGain.toFixed(2)}x`,
    `lum  ${lumGain >= 0 ? '+' : ''}${lumGain.toFixed(2)} EV`,
    lock,
  ];
}

function tonalHud(drag: TonalDrag, grade: GradeState, mods: Modifiers): string[] {
  const wheel = grade.wheels[drag.wheel];
  const axis = axisFor(mods);
  const lock =
    axis === 'saturation' ? 'COLOUR ONLY' : axis === 'luminance' ? 'LUMA ONLY' : 'warm ←→   luma ↑↓';

  const name = drag.wheel[0].toUpperCase() + drag.wheel.slice(1);
  return [
    `${name}  (${drag.range})`,
    `sampled  ${(drag.luma * 100).toFixed(1)} IRE`,
    `luma  ${wheel.luma >= 0 ? '+' : ''}${wheel.luma.toFixed(3)}`,
    `R ${wheel.r >= 0 ? '+' : ''}${wheel.r.toFixed(3)}  B ${wheel.b >= 0 ? '+' : ''}${wheel.b.toFixed(3)}`,
    lock,
  ];
}

export { beginScopeDrag };
