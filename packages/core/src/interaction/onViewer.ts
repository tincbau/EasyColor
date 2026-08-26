/**
 * Direct on-viewer grading.
 *
 * The whole tool is three verbs: click to pick what you mean, drag to change
 * it, release. Everything below exists to make those three feel unambiguous.
 *
 * Design decisions worth knowing about:
 *
 * - **A click resolves against existing zones first.** Clicking a jacket you
 *   already pushed toward teal finds that zone and keeps dragging it. It does
 *   not stack a second zone on top, which is what makes repeated passes over
 *   the same subject converge instead of compounding.
 *
 * - **Matching uses the pre-grade colour.** A zone's identity is where the
 *   subject started, not where you have moved it to. Match on the graded
 *   colour instead and a zone walks out from under its own selection as soon
 *   as you rotate its hue.
 *
 * - **Drags are absolute, not incremental.** Every update is computed from a
 *   baseline captured when the drag began, so a slow drag and a fast drag
 *   ending at the same place give the same result, and nothing accumulates
 *   floating-point drift over a long gesture.
 *
 * - **Axes are locked, not blended.** Horizontal is hue, vertical is
 *   saturation, and a modifier collapses both onto one property. Diagonal
 *   drags that quietly change two things at once are how people lose control
 *   of a grade.
 */

import type { GradeState, HslZone, WheelValue } from '../state/grade.js';
import { MAX_HSL_ZONES, createZone } from '../state/grade.js';
import { cloneGrade } from '../state/grade.js';
import { toLch, zoneWeight } from './qualifier.js';
import type { Lch } from './qualifier.js';
import type { SampledPixel } from '../gl/pipeline.js';

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

/** Which property a drag is currently changing. Drives the on-screen HUD. */
export type DragAxis = 'hue' | 'saturation' | 'luminance' | 'both';

export function axisFor(mods: Modifiers): DragAxis {
  // Shift wins over Ctrl/Alt when both are held: saturation is the more
  // common lock, and an ambiguous combination should still do one thing.
  if (mods.shift) return 'saturation';
  if (mods.ctrl || mods.alt || mods.meta) return 'luminance';
  return 'both';
}

/* ------------------------------------------------------------------ */
/* Sensitivities                                                       */
/* ------------------------------------------------------------------ */

/**
 * How far a full-width or full-height drag moves each property.
 * Tuned so a comfortable 200px gesture on a 1000px viewer is a clear but
 * recoverable change — roughly 12 degrees of hue or 20% of saturation.
 */
export const SENSITIVITY = {
  /** Degrees of hue rotation across the full viewer width. */
  hueDegPerWidth: 60,
  /** Saturation multiplier change across the full viewer height. */
  satPerHeight: 1.0,
  /** Stops of exposure across the full viewer height. */
  stopsPerHeight: 2.0,
  /** Wheel luma ring change across the full viewer height. */
  wheelLumaPerHeight: 0.5,
  /** Wheel colour balance change across the full viewer width. */
  wheelColorPerWidth: 0.35,
  /** Exposure stops across the full height of a scope panel. */
  scopeStopsPerHeight: 3.0,
} as const;

/** Below this qualifier weight, a click is treated as landing on new colour. */
export const ZONE_MATCH_THRESHOLD = 0.3;

/* ------------------------------------------------------------------ */
/* HSL zone grading                                                    */
/* ------------------------------------------------------------------ */

export interface HslDrag {
  zoneId: string;
  /** The zone exactly as it was when the pointer went down. */
  baseline: HslZone;
  /** True when this drag created the zone, so a cancel can remove it again. */
  created: boolean;
}

export interface BeginHslResult {
  grade: GradeState;
  drag: HslDrag | null;
  /** Set when nothing could be done, e.g. the zone budget is full. */
  problem?: string;
}

let zoneCounter = 0;
function nextZoneId(): string {
  zoneCounter += 1;
  return `zone-${Date.now().toString(36)}-${zoneCounter.toString(36)}`;
}

/** Reset the id counter. Only useful to make tests deterministic. */
export function resetZoneIds(): void {
  zoneCounter = 0;
}

/**
 * Find the zone that best covers a colour.
 * Returns null when no existing zone claims it strongly enough.
 */
export function findZoneFor(grade: GradeState, lch: Lch): HslZone | null {
  let best: HslZone | null = null;
  let bestWeight = ZONE_MATCH_THRESHOLD;

  for (const zone of grade.zones) {
    const w = zoneWeight(zone, lch);
    if (w > bestWeight) {
      bestWeight = w;
      best = zone;
    }
  }
  return best;
}

/**
 * Pointer-down on the viewer with the HSL tool.
 *
 * `sample` should come from `GradeRenderer.samplePatch`, not a single pixel:
 * on grainy footage a one-pixel sample lands somewhere different every time
 * you click the same face.
 */
export function beginHslGrade(grade: GradeState, sample: SampledPixel): BeginHslResult {
  const lch = toLch(sample.base);

  const existing = findZoneFor(grade, lch);
  if (existing) {
    return { grade, drag: { zoneId: existing.id, baseline: { ...existing }, created: false } };
  }

  if (grade.zones.length >= MAX_HSL_ZONES) {
    return {
      grade,
      drag: null,
      problem:
        `All ${MAX_HSL_ZONES} colour zones are in use. Delete one, or widen an ` +
        `existing zone to cover this colour too.`,
    };
  }

  const zone = createZone(nextZoneId(), sample.graded, lch.h, lch.c, lch.l);
  const next = cloneGrade(grade);
  next.zones = [...next.zones, zone];

  return { grade: next, drag: { zoneId: zone.id, baseline: { ...zone }, created: true } };
}

/**
 * Pointer-move during an HSL drag.
 * `du` and `dv` are displacements as a fraction of viewer width and height,
 * with `dv` positive downward — the same sign convention the DOM uses.
 */
export function updateHslGrade(
  grade: GradeState,
  drag: HslDrag,
  du: number,
  dv: number,
  mods: Modifiers,
): GradeState {
  const index = grade.zones.findIndex((z) => z.id === drag.zoneId);
  if (index < 0) return grade;

  const base = drag.baseline;
  const axis = axisFor(mods);

  // Screen y grows downward; dragging up should brighten and saturate.
  const up = -dv;

  const zone: HslZone = { ...grade.zones[index] };

  switch (axis) {
    case 'saturation': {
      // Locked to saturation: take whichever axis the user moved further, so
      // the lock works whether they drag sideways or up.
      const amount = Math.abs(du) > Math.abs(up) ? du : up;
      zone.hueShift = base.hueShift;
      zone.satGain = clampSat(base.satGain + amount * SENSITIVITY.satPerHeight);
      zone.lumGain = base.lumGain;
      break;
    }
    case 'luminance': {
      const amount = Math.abs(du) > Math.abs(up) ? du : up;
      zone.hueShift = base.hueShift;
      zone.satGain = base.satGain;
      zone.lumGain = clampStops(base.lumGain + amount * SENSITIVITY.stopsPerHeight);
      break;
    }
    default: {
      zone.hueShift = wrapDegrees(base.hueShift + du * SENSITIVITY.hueDegPerWidth);
      zone.satGain = clampSat(base.satGain + up * SENSITIVITY.satPerHeight);
      zone.lumGain = base.lumGain;
      break;
    }
  }

  const next = cloneGrade(grade);
  next.zones = [...next.zones];
  next.zones[index] = zone;
  return next;
}

/** Undo a drag that created a zone but never actually moved it. */
export function cancelHslGrade(grade: GradeState, drag: HslDrag): GradeState {
  if (!drag.created) return grade;
  const next = cloneGrade(grade);
  next.zones = next.zones.filter((z) => z.id !== drag.zoneId);
  return next;
}

/**
 * True when a drag left the zone exactly where it started — a plain click.
 * Used to decide whether to keep a newly created zone or discard it, so
 * clicking around to inspect colours doesn't litter the zone list.
 */
export function dragWasNoOp(grade: GradeState, drag: HslDrag): boolean {
  const zone = grade.zones.find((z) => z.id === drag.zoneId);
  if (!zone) return true;
  return (
    zone.hueShift === drag.baseline.hueShift &&
    zone.satGain === drag.baseline.satGain &&
    zone.lumGain === drag.baseline.lumGain
  );
}

/* ------------------------------------------------------------------ */
/* Direct tonal range grading                                          */
/* ------------------------------------------------------------------ */

export type TonalRange = 'shadows' | 'midtones' | 'highlights';

/** Which wheel a given brightness belongs to. */
export function tonalRangeFor(luma: number): TonalRange {
  if (luma < 0.33) return 'shadows';
  if (luma < 0.66) return 'midtones';
  return 'highlights';
}

const RANGE_TO_WHEEL: Record<TonalRange, keyof GradeState['wheels']> = {
  shadows: 'lift',
  midtones: 'gamma',
  highlights: 'gain',
};

export interface TonalDrag {
  range: TonalRange;
  wheel: keyof GradeState['wheels'];
  baseline: WheelValue;
  /** Luminance that was sampled, for the HUD readout. */
  luma: number;
}

/**
 * Pointer-down on the viewer with the tonal tool.
 *
 * The range is chosen from the brightness under the cursor, so grabbing a
 * shadow and dragging adjusts Lift without anyone having to first decide
 * which of three wheels a given part of the frame lives in.
 */
export function beginTonalGrade(grade: GradeState, sample: SampledPixel): TonalDrag {
  const rgb = sample.graded;
  const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  const range = tonalRangeFor(luma);
  const wheel = RANGE_TO_WHEEL[range];
  return { range, wheel, baseline: { ...grade.wheels[wheel] }, luma };
}

/**
 * Pointer-move during a tonal drag.
 * Vertical moves the wheel's master luma ring; horizontal balances it warm
 * or cool. A modifier locks to one or the other.
 */
export function updateTonalGrade(
  grade: GradeState,
  drag: TonalDrag,
  du: number,
  dv: number,
  mods: Modifiers,
): GradeState {
  const up = -dv;
  const axis = axisFor(mods);
  const base = drag.baseline;

  const value: WheelValue = { ...base };

  const lockedToColor = axis === 'saturation';
  const lockedToLuma = axis === 'luminance';

  if (!lockedToColor) {
    value.luma = clampUnit(base.luma + up * SENSITIVITY.wheelLumaPerHeight);
  }
  if (!lockedToLuma) {
    // Horizontal runs cool-to-warm: pushing right adds red and pulls blue,
    // which is the direction a temperature slider moves.
    const warm = du * SENSITIVITY.wheelColorPerWidth;
    value.r = clampUnit(base.r + warm);
    value.b = clampUnit(base.b - warm);
  }

  const next = cloneGrade(grade);
  next.wheels = { ...next.wheels, [drag.wheel]: value };
  return next;
}

/* ------------------------------------------------------------------ */
/* Scope dragging                                                      */
/* ------------------------------------------------------------------ */

export interface ScopeDrag {
  /** 0..1 level that was grabbed on the scope's vertical axis. */
  level: number;
  range: TonalRange;
  baselineExposure: number;
  baselineWheel: WheelValue;
  wheel: keyof GradeState['wheels'];
}

/**
 * Pointer-down on a waveform, parade or histogram.
 *
 * `level` is where on the 0..1 luminance axis the pointer landed. Grabbing
 * the trace at black and pulling down moves Lift; grabbing it at white moves
 * Gain. It is the same mental model as dragging on the image, applied to the
 * one place where you can see exactly which level you are grabbing.
 */
export function beginScopeDrag(grade: GradeState, level: number): ScopeDrag {
  const range = tonalRangeFor(level);
  const wheel = RANGE_TO_WHEEL[range];
  return {
    level,
    range,
    baselineExposure: grade.primaries.exposure,
    baselineWheel: { ...grade.wheels[wheel] },
    wheel,
  };
}

/**
 * Pointer-move on a scope.
 *
 * Without a modifier this is overall exposure, which is what people reach
 * for when they drag a waveform. Holding Shift narrows it to the wheel for
 * the tonal range that was grabbed.
 */
export function updateScopeDrag(
  grade: GradeState,
  drag: ScopeDrag,
  dv: number,
  mods: Modifiers,
): GradeState {
  const up = -dv;
  const next = cloneGrade(grade);

  if (mods.shift) {
    next.wheels = {
      ...next.wheels,
      [drag.wheel]: {
        ...drag.baselineWheel,
        luma: clampUnit(drag.baselineWheel.luma + up * SENSITIVITY.wheelLumaPerHeight),
      },
    };
  } else {
    next.primaries = {
      ...next.primaries,
      exposure: clampStops(drag.baselineExposure + up * SENSITIVITY.scopeStopsPerHeight),
    };
  }

  return next;
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

function wrapDegrees(d: number): number {
  let v = ((d + 180) % 360 + 360) % 360 - 180;
  if (v === -180) v = 180;
  return v;
}

function clampSat(v: number): number {
  return Math.min(3, Math.max(0, v));
}

function clampStops(v: number): number {
  return Math.min(4, Math.max(-4, v));
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(-1, v));
}
