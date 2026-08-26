/**
 * Monotone cubic interpolation for the RGB curve editor.
 *
 * Plain Catmull-Rom overshoots between close control points, which shows up
 * as a curve that dips below a point you dragged up — visible as banding or
 * a tone reversal in the shadows. Fritsch-Carlson clamps the tangents so the
 * curve can never reverse direction between two points.
 */

export interface CurvePoint {
  /** Input, 0..1. */
  x: number;
  /** Output, 0..1. */
  y: number;
}

export const DEFAULT_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function isDefaultCurve(points: CurvePoint[]): boolean {
  return (
    points.length === 2 &&
    points[0].x === 0 &&
    points[0].y === 0 &&
    points[1].x === 1 &&
    points[1].y === 1
  );
}

function sortAndDedupe(points: CurvePoint[]): CurvePoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const p of sorted) {
    // Two points at the same x make the slope infinite; keep the later one.
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 1e-6) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * Build a sampler for a set of control points.
 * Returns a function mapping input 0..1 -> output (unclamped at the ends so
 * callers can decide whether to clip).
 */
export function buildCurveSampler(rawPoints: CurvePoint[]): (x: number) => number {
  const p = sortAndDedupe(rawPoints);

  if (p.length === 0) return (x) => x;
  if (p.length === 1) {
    const only = p[0];
    return () => only.y;
  }

  const n = p.length;
  const dx: number[] = new Array(n - 1);
  const slope: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1].x - p[i].x;
    slope[i] = (p[i + 1].y - p[i].y) / dx[i];
  }

  // Initial tangents: one-sided at the ends, averaged in the middle.
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      // A local extremum. A zero tangent is what stops the overshoot.
      m[i] = 0;
    } else {
      m[i] = (slope[i - 1] + slope[i]) / 2;
    }
  }

  // Fritsch-Carlson: keep each tangent inside a circle of radius 3*slope.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  return (x: number): number => {
    if (x <= p[0].x) return p[0].y + m[0] * (x - p[0].x);
    if (x >= p[n - 1].x) return p[n - 1].y + m[n - 1] * (x - p[n - 1].x);

    // Binary search for the containing span.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid].x <= x) lo = mid;
      else hi = mid;
    }

    const h = dx[lo];
    const t = (x - p[lo].x) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite basis.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * p[lo].y + h10 * h * m[lo] + h01 * p[lo + 1].y + h11 * h * m[lo + 1];
  };
}

/** Number of entries in the curve texture handed to the shader. */
export const CURVE_LUT_SIZE = 256;

/**
 * Bake master + R/G/B curves into a single RGBA8 strip.
 * Channel layout: R,G,B carry the per-channel curves; A carries the master.
 * The shader applies master first, then the per-channel curve.
 */
export function bakeCurveTexture(curves: {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}): Uint8Array {
  const samplers = {
    master: buildCurveSampler(curves.master),
    red: buildCurveSampler(curves.red),
    green: buildCurveSampler(curves.green),
    blue: buildCurveSampler(curves.blue),
  };

  const out = new Uint8Array(CURVE_LUT_SIZE * 4);
  for (let i = 0; i < CURVE_LUT_SIZE; i++) {
    const x = i / (CURVE_LUT_SIZE - 1);
    out[i * 4 + 0] = quantise(samplers.red(x));
    out[i * 4 + 1] = quantise(samplers.green(x));
    out[i * 4 + 2] = quantise(samplers.blue(x));
    out[i * 4 + 3] = quantise(samplers.master(x));
  }
  return out;
}

function quantise(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round(c * 255);
}
