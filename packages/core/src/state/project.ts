/**
 * Project serialisation.
 *
 * A grade is already a plain object, so saving it is mostly JSON. The one
 * awkward part is the loaded 3D LUT: a Float32Array does not survive
 * `JSON.stringify`, and a 33-cube is ~350KB of floats. It is stored as
 * base64 of the raw buffer, which keeps a project file loadable with nothing
 * but a JSON parser while avoiding a 4x blow-up from writing the numbers out
 * as text.
 */

import type { GradeState } from './grade.js';
import { defaultGrade } from './grade.js';

export const PROJECT_EXTENSION = '.ecgrade';
export const PROJECT_MIME = 'application/vnd.easycolor.grade+json';

interface SerialisedLut {
  name: string | null;
  size: number;
  /** base64 of the Float32Array buffer, little-endian. */
  data: string | null;
  enabled: boolean;
  intensity: number;
  stage: 'log' | 'display';
}

export function serialiseProject(grade: GradeState, pretty = true): string {
  const { lut, ...rest } = grade;

  const payload = {
    ...rest,
    // The viewer's compare and overlay state is a workspace preference, not
    // part of the look — reopening a project shouldn't restore a half-dragged
    // wipe or leave a diagnostic overlay switched on.
    viewer: { ...defaultGrade().viewer },
    lut: {
      name: lut.name,
      size: lut.size,
      data: lut.data ? encodeBase64(new Uint8Array(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength)) : null,
      enabled: lut.enabled,
      intensity: lut.intensity,
      stage: lut.stage,
    } satisfies SerialisedLut,
    _app: 'EasyColor',
  };

  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

export class ProjectLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectLoadError';
  }
}

export function deserialiseProject(text: string): GradeState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectLoadError('That file is not valid JSON, so it is not an EasyColor project.');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new ProjectLoadError('That project file is empty or malformed.');
  }

  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new ProjectLoadError(
      `This project was saved by a different version of EasyColor (format ${String(obj.version)}).`,
    );
  }

  // Merge over defaults so a project saved before a control existed still
  // opens, with the new control at its neutral value.
  const base = defaultGrade();
  const lutRaw = (obj.lut ?? {}) as Partial<SerialisedLut>;

  const merged: GradeState = {
    ...base,
    ...(obj as Partial<GradeState>),
    source: { ...base.source, ...(obj.source as object) },
    primaries: { ...base.primaries, ...(obj.primaries as object) },
    wheels: {
      lift: { ...base.wheels.lift, ...((obj.wheels as any)?.lift ?? {}) },
      gamma: { ...base.wheels.gamma, ...((obj.wheels as any)?.gamma ?? {}) },
      gain: { ...base.wheels.gain, ...((obj.wheels as any)?.gain ?? {}) },
      offset: { ...base.wheels.offset, ...((obj.wheels as any)?.offset ?? {}) },
    },
    curves: { ...base.curves, ...(obj.curves as object) },
    skin: { ...base.skin, ...(obj.skin as object) },
    film: {
      ...base.film,
      ...(obj.film as object),
      halation: { ...base.film.halation, ...((obj.film as any)?.halation ?? {}) },
      grain: { ...base.film.grain, ...((obj.film as any)?.grain ?? {}) },
    },
    viewer: { ...base.viewer },
    lut: {
      enabled: lutRaw.enabled ?? false,
      name: lutRaw.name ?? null,
      size: lutRaw.size ?? 0,
      intensity: lutRaw.intensity ?? 1,
      stage: lutRaw.stage ?? 'display',
      data: lutRaw.data ? decodeLutData(lutRaw.data, lutRaw.size ?? 0) : null,
    },
    zones: Array.isArray(obj.zones) ? (obj.zones as GradeState['zones']) : [],
    windows: Array.isArray(obj.windows) ? (obj.windows as GradeState['windows']) : [],
  };

  return merged;
}

function decodeLutData(b64: string, size: number): Float32Array | null {
  try {
    const bytes = decodeBase64(b64);
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const expected = size * size * size * 3;
    if (floats.length !== expected) return null;
    return floats;
  } catch {
    return null;
  }
}

/* Base64 without assuming a browser or Node-specific global. */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const length = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(length);

  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? B64.indexOf(clean[i + 3]) : 0);

    if (p < length) out[p++] = (n >> 16) & 255;
    if (p < length) out[p++] = (n >> 8) & 255;
    if (p < length) out[p++] = n & 255;
  }
  return out;
}
