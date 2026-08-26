/**
 * Camera log -> scene-linear transforms.
 *
 * Each transform is declared once, with its TypeScript implementation and
 * its GLSL body side by side in the same object, so the CPU and GPU copies
 * can't quietly drift apart. `buildLogGlsl()` assembles the shader half.
 */

export type LogTransformId =
  | 'none'
  | 'slog3'
  | 'logc3'
  | 'logc4'
  | 'vlog'
  | 'clog3'
  | 'redlog3g10'
  | 'djidlog'
  | 'flog';

export interface LogTransform {
  id: LogTransformId;
  /** Name as the camera manufacturer writes it. */
  label: string;
  /** Manufacturer grouping, for the UI's option groups. */
  vendor: string;
  /** Log code value (0..1) -> scene-linear reflectance, 0.18 = mid grey. */
  toLinear(v: number): number;
  /** GLSL body of the same function, operating on `float v`, returning float. */
  glsl: string;
}

const IDENTITY: LogTransform = {
  id: 'none',
  label: 'Rec.709 / already corrected',
  vendor: 'Generic',
  // Treat the input as display-referred Rec.709 and undo the display gamma.
  toLinear: (v) => (v <= 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45)),
  glsl: `return v <= 0.081 ? v / 4.5 : pow((v + 0.099) / 1.099, 1.0 / 0.45);`,
};

/** Sony S-Log3, per Sony's "S-Log3 and S-Gamut3" technical summary. */
const SLOG3: LogTransform = {
  id: 'slog3',
  label: 'S-Log3',
  vendor: 'Sony',
  toLinear: (v) =>
    v >= 171.2102946929 / 1023
      ? (Math.pow(10, (v * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01)
      : ((v * 1023 - 95) * 0.01125) / (171.2102946929 - 95),
  glsl: `
    return v >= 171.2102946929 / 1023.0
      ? (pow(10.0, (v * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01)
      : ((v * 1023.0 - 95.0) * 0.01125) / (171.2102946929 - 95.0);`,
};

/** ARRI LogC3 (EI 800 curve). */
const LOGC3: LogTransform = {
  id: 'logc3',
  label: 'LogC3 (EI 800)',
  vendor: 'ARRI',
  // The shadow segment is the published EI 800 linear leg, y = e*x + f with
  // e = 5.367655 and f = 0.092809. An older, widely copied variant uses
  // v/0.9661776 - 0.04378604; that one does not meet the log segment at the
  // cut point, so the curve reverses direction there and shadows invert.
  toLinear: (v) =>
    v > 0.1496582
      ? (Math.pow(10, (v - 0.385537) / 0.2471896) - 0.052272) / 5.555556
      : (v - 0.092809) / 5.367655,
  glsl: `
    return v > 0.1496582
      ? (pow(10.0, (v - 0.385537) / 0.2471896) - 0.052272) / 5.555556
      : (v - 0.092809) / 5.367655;`,
};

/** ARRI LogC4. */
const LOGC4: LogTransform = {
  id: 'logc4',
  label: 'LogC4',
  vendor: 'ARRI',
  toLinear: (v) => {
    const a = (Math.pow(2, 18) - 16) / 117.45;
    const b = (1023 - 95) / 1023;
    const c = 95 / 1023;
    const s = (7 * Math.log(2) * Math.pow(2, 7 - 14 * c / b)) / (a * b);
    const t = (Math.pow(2, 14 * (-c / b) + 6) - 64) / a;
    return v < 0 ? v * s + t : (Math.pow(2, (14 * (v - c)) / b + 6) - 64) / a;
  },
  glsl: `
    const float a = (262144.0 - 16.0) / 117.45;
    const float b = (1023.0 - 95.0) / 1023.0;
    const float c = 95.0 / 1023.0;
    float s = (7.0 * log(2.0) * pow(2.0, 7.0 - 14.0 * c / b)) / (a * b);
    float t = (pow(2.0, 14.0 * (-c / b) + 6.0) - 64.0) / a;
    return v < 0.0 ? v * s + t : (pow(2.0, (14.0 * (v - c)) / b + 6.0) - 64.0) / a;`,
};

/** Panasonic V-Log. */
const VLOG: LogTransform = {
  id: 'vlog',
  label: 'V-Log',
  vendor: 'Panasonic',
  toLinear: (v) =>
    v < 0.181
      ? (v - 0.125) / 5.6
      : Math.pow(10, (v - 0.598206) / 0.241514) - 0.00873,
  glsl: `
    return v < 0.181
      ? (v - 0.125) / 5.6
      : pow(10.0, (v - 0.598206) / 0.241514) - 0.00873;`,
};

/** Canon Log 3 (positive segment; the negative segment is rarely reached). */
const CLOG3: LogTransform = {
  id: 'clog3',
  label: 'Canon Log 3',
  vendor: 'Canon',
  // Three segments, and they must meet exactly: at the 0.15277891 cut both
  // the linear leg and the log leg have to evaluate to 0.014. That constraint
  // fixes the highlight offset at 0.12240537 — the value is not free.
  toLinear: (v) => {
    if (v < 0.097465473) return -(Math.pow(10, (0.12783901 - v) / 0.36726845) - 1) / 14.98325;
    if (v <= 0.15277891) return (v - 0.12512219) / 1.9754798;
    return (Math.pow(10, (v - 0.12240537) / 0.36726845) - 1) / 14.98325;
  },
  glsl: `
    if (v < 0.097465473) return -(pow(10.0, (0.12783901 - v) / 0.36726845) - 1.0) / 14.98325;
    if (v <= 0.15277891) return (v - 0.12512219) / 1.9754798;
    return (pow(10.0, (v - 0.12240537) / 0.36726845) - 1.0) / 14.98325;`,
};

/** RED Log3G10. */
const REDLOG3G10: LogTransform = {
  id: 'redlog3g10',
  label: 'Log3G10',
  vendor: 'RED',
  toLinear: (v) => (Math.pow(10, v / 0.224282) - 1) / 155.975327 - 0.01,
  glsl: `return (pow(10.0, v / 0.224282) - 1.0) / 155.975327 - 0.01;`,
};

/** DJI D-Log. */
const DJIDLOG: LogTransform = {
  id: 'djidlog',
  label: 'D-Log',
  vendor: 'DJI',
  toLinear: (v) =>
    v <= 0.14
      ? (v - 0.0929) / 6.025
      : (Math.pow(10, (3.89616 * v - 2.27752)) - 0.0108) / 0.9892,
  glsl: `
    return v <= 0.14
      ? (v - 0.0929) / 6.025
      : (pow(10.0, 3.89616 * v - 2.27752) - 0.0108) / 0.9892;`,
};

/** Fujifilm F-Log. */
const FLOG: LogTransform = {
  id: 'flog',
  label: 'F-Log',
  vendor: 'Fujifilm',
  toLinear: (v) =>
    v < 0.100537775223865
      ? (v - 0.092864) / 8.735631
      : (Math.pow(10, (v - 0.790453) / 0.344676) - 0.009468) / 0.555556,
  glsl: `
    return v < 0.100537775223865
      ? (v - 0.092864) / 8.735631
      : (pow(10.0, (v - 0.790453) / 0.344676) - 0.009468) / 0.555556;`,
};

export const LOG_TRANSFORMS: LogTransform[] = [
  IDENTITY,
  SLOG3,
  LOGC3,
  LOGC4,
  VLOG,
  CLOG3,
  REDLOG3G10,
  DJIDLOG,
  FLOG,
];

export const LOG_TRANSFORM_BY_ID: Record<LogTransformId, LogTransform> = Object.fromEntries(
  LOG_TRANSFORMS.map((t) => [t.id, t]),
) as Record<LogTransformId, LogTransform>;

/** Index of a transform in `LOG_TRANSFORMS`; this is what the shader switches on. */
export function logTransformIndex(id: LogTransformId): number {
  const i = LOG_TRANSFORMS.findIndex((t) => t.id === id);
  return i < 0 ? 0 : i;
}

/**
 * Assemble the GLSL half of every transform into a single dispatch function.
 * Generated from the same table the CPU path uses, so adding a camera means
 * touching exactly one place.
 */
export function buildLogGlsl(): string {
  const fns = LOG_TRANSFORMS.map(
    (t, i) => `float ec_log_${i}(float v) {\n${t.glsl.trim()}\n}`,
  ).join('\n');

  const dispatch = LOG_TRANSFORMS.map(
    (_, i) => `  if (mode == ${i}) return ec_log_${i}(v);`,
  ).join('\n');

  return `${fns}

float ecLogToLinear(float v, int mode) {
${dispatch}
  return v;
}

vec3 ecLogToLinear(vec3 c, int mode) {
  return vec3(ecLogToLinear(c.r, mode), ecLogToLinear(c.g, mode), ecLogToLinear(c.b, mode));
}`;
}

/** CPU-side counterpart of the shader dispatch. */
export function logToLinear(c: [number, number, number], id: LogTransformId): [number, number, number] {
  const t = LOG_TRANSFORM_BY_ID[id] ?? IDENTITY;
  return [t.toLinear(c[0]), t.toLinear(c[1]), t.toLinear(c[2])];
}
