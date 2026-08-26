/**
 * Turning a grade into an export plan.
 *
 * A finished master is rendered by FFmpeg, not by the viewer's GL pipeline,
 * so the grade has to be expressed as things FFmpeg can apply: 3D LUTs,
 * mask images, and a filter chain. This module does that translation once,
 * here, so the desktop exporter and the Premiere bridge cannot drift apart
 * in how they interpret a look.
 *
 * The division of labour:
 *
 *   per-pixel grade   one 65-cube, baked from the real shader. Tetrahedral
 *                     interpolation on both sides means the match is exact
 *                     to well under a code value at 10-bit.
 *   power windows     one extra cube per window, baked with that window's
 *                     shape widened to cover the frame, plus a static mask
 *                     image carrying the real shape. Compositing the two
 *                     through the mask reproduces the window exactly —
 *                     which beats the usual answer of dropping windows from
 *                     a LUT-based export.
 *   halation, grain   filter-chain approximations, because they are spatial
 *                     and stochastic. What differs is stated in `notes`
 *                     rather than left for someone to discover.
 */

import type { GradeState, PowerWindow } from '../state/grade.js';
import { cloneGrade } from '../state/grade.js';

export interface WindowLayer {
  window: PowerWindow;
  /**
   * The grade with this window widened to cover the whole frame, so baking
   * it yields "the image as it looks fully inside this window".
   */
  grade: GradeState;
}

export interface ExportPlan {
  /** The grade with every window disabled: the base layer's cube. */
  base: GradeState;
  /** One layer per enabled window, in the order they are composited. */
  windows: WindowLayer[];
  halation: GradeState['film']['halation'] | null;
  grain: GradeState['film']['grain'] | null;
  /** Plain-language notes about anything the export approximates. */
  notes: string[];
}

/**
 * Widen a window so its mask covers everything.
 *
 * The correction inside the window is a pure function of colour; only the
 * *shape* is positional. Baking with the shape removed separates the two,
 * and the shape comes back as a mask image at composite time.
 */
export function widenWindow(window: PowerWindow): PowerWindow {
  return {
    ...window,
    cx: 0.5,
    cy: 0.5,
    rx: 10,
    ry: 10,
    rotation: 0,
    softness: 0.002,
    corner: 1,
    invert: false,
    // Opacity stays on the mask, not in the cube, so a partially transparent
    // window still composites correctly.
    opacity: 1,
  };
}

export function buildExportPlan(grade: GradeState): ExportPlan {
  const notes: string[] = [];

  const enabledWindows = grade.windows.filter((w) => w.enabled);

  const base = cloneGrade(grade);
  base.windows = [];
  base.viewer = { ...base.viewer, compare: 'off', bypass: false, overlay: 'none' };

  const windows: WindowLayer[] = enabledWindows.map((window) => {
    const layerGrade = cloneGrade(grade);
    layerGrade.windows = [widenWindow(window)];
    layerGrade.viewer = { ...layerGrade.viewer, compare: 'off', bypass: false, overlay: 'none' };
    return { window, grade: layerGrade };
  });

  const halation =
    grade.film.halation.enabled && grade.film.halation.strength > 0 ? grade.film.halation : null;
  const grain = grade.film.grain.enabled && grade.film.grain.amount > 0 ? grade.film.grain : null;

  if (halation) {
    notes.push(
      'Halation is rendered by the encoder as a threshold, blur and screen blend. It matches the ' +
        'viewer closely but is not bit-identical, because the two use different blur kernels.',
    );
  }
  if (grain) {
    notes.push(
      'Grain is rendered by the encoder at a single strength. The viewer weights grain toward the ' +
        'shadows, which the encoder cannot reproduce, so exported grain reads slightly flatter in ' +
        'bright areas.',
    );
  }
  if (windows.length > 0) {
    notes.push(
      `${windows.length} power window${windows.length === 1 ? '' : 's'} exported as static ` +
        'masks — position, softness and rotation are reproduced exactly.',
    );
  }
  if (grade.zones.length > 0 || grade.skin.enabled) {
    notes.push('Colour zones and skin corrections bake into the main cube exactly.');
  }

  return { base, windows, halation, grain, notes };
}

/**
 * Render a power window's mask to an 8-bit greyscale buffer.
 *
 * This mirrors `ecWindowMask` in `zones.frag.ts` — the superellipse, the
 * aspect correction, the rotation, the feather and the inversion. The two
 * must stay in step; if they drift, an exported window lands somewhere
 * slightly different from the one on screen, which is the kind of bug that
 * only shows up on a finished master.
 */
export function renderWindowMask(
  window: PowerWindow,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const aspect = width / Math.max(1, height);

  const rot = (window.rotation * Math.PI) / 180;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);

  // Radii are in units of frame height on both axes; see `ecWindowMask`.
  const rrx = Math.max(window.rx, 1e-4);
  const rry = Math.max(window.ry, 1e-4);

  const isRect = window.shape === 'rect';
  const n = isRect ? 16 + (2 - 16) * clamp01(window.corner) : 2;
  const soft = Math.min(1, Math.max(0.0015, window.softness));
  const inner = 1 - soft;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;

      let px = (u - window.cx) * aspect;
      let py = v - window.cy;

      const rx2 = px * cs + py * sn;
      const ry2 = -px * sn + py * cs;
      px = rx2;
      py = ry2;

      const qx = Math.abs(px) / rrx;
      const qy = Math.abs(py) / rry;

      const d = isRect
        ? Math.pow(Math.pow(qx, n) + Math.pow(qy, n), 1 / n)
        : Math.hypot(qx, qy);

      let mask = 1 - smoothstep(inner, 1, d);
      if (window.invert) mask = 1 - mask;

      out[y * width + x] = Math.round(clamp01(mask * window.opacity) * 255);
    }
  }

  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 >= edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
