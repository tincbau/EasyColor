/**
 * Adobe .CUBE LUT reading and writing.
 *
 * The format is deliberately loose in the wild — LUTs come with CRLF
 * endings, BOMs, comments, tabs, out-of-spec DOMAIN lines and trailing
 * blank rows. The parser accepts all of that rather than rejecting a file a
 * colourist knows works elsewhere.
 */

export interface Lut3D {
  kind: '3D';
  title: string;
  /** Edge size, e.g. 17, 33, 64. */
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** size^3 * 3 floats, red index varying fastest (the CUBE convention). */
  data: Float32Array;
}

export interface Lut1D {
  kind: '1D';
  title: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** size * 3 floats. */
  data: Float32Array;
}

export type ParsedLut = Lut3D | Lut1D;

export class CubeParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
    this.name = 'CubeParseError';
  }
}

export function parseCube(text: string): ParsedLut {
  // Strip a UTF-8 BOM, which Windows tools add and which otherwise poisons
  // the first keyword.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\r|\n/);

  let title = '';
  let size3d = 0;
  let size1d = 0;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Comments run to end of line; some exporters put them after data.
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (line === '') continue;

    const upper = line.toUpperCase();

    if (upper.startsWith('TITLE')) {
      const m = line.match(/"([^"]*)"/);
      title = m ? m[1] : line.slice(5).trim();
      continue;
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      size3d = parseInt(line.split(/\s+/)[1], 10);
      if (!Number.isFinite(size3d) || size3d < 2 || size3d > 256) {
        throw new CubeParseError(`LUT_3D_SIZE of ${size3d} is out of range`, i + 1);
      }
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      size1d = parseInt(line.split(/\s+/)[1], 10);
      if (!Number.isFinite(size1d) || size1d < 2 || size1d > 65536) {
        throw new CubeParseError(`LUT_1D_SIZE of ${size1d} is out of range`, i + 1);
      }
      continue;
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      readTriple(line, domainMin, i + 1);
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      readTriple(line, domainMax, i + 1);
      continue;
    }
    if (upper.startsWith('LUT_3D_INPUT_RANGE') || upper.startsWith('LUT_1D_INPUT_RANGE')) {
      const parts = line.split(/\s+/);
      const lo = Number(parts[1]);
      const hi = Number(parts[2]);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        domainMin[0] = domainMin[1] = domainMin[2] = lo;
        domainMax[0] = domainMax[1] = domainMax[2] = hi;
      }
      continue;
    }

    // Anything else must be a data row.
    const parts = line.split(/[\s,]+/);
    if (parts.length < 3) {
      throw new CubeParseError(`Expected three numbers, got "${line}"`, i + 1);
    }
    for (let k = 0; k < 3; k++) {
      const v = Number(parts[k]);
      if (!Number.isFinite(v)) {
        throw new CubeParseError(`"${parts[k]}" is not a number`, i + 1);
      }
      values.push(v);
    }
  }

  if (size3d > 0) {
    const expected = size3d * size3d * size3d * 3;
    if (values.length !== expected) {
      throw new CubeParseError(
        `LUT_3D_SIZE ${size3d} needs ${expected / 3} rows but the file has ${values.length / 3}`,
      );
    }
    return {
      kind: '3D',
      title,
      size: size3d,
      domainMin,
      domainMax,
      data: Float32Array.from(values),
    };
  }

  if (size1d > 0) {
    const expected = size1d * 3;
    if (values.length !== expected) {
      throw new CubeParseError(
        `LUT_1D_SIZE ${size1d} needs ${size1d} rows but the file has ${values.length / 3}`,
      );
    }
    return {
      kind: '1D',
      title,
      size: size1d,
      domainMin,
      domainMax,
      data: Float32Array.from(values),
    };
  }

  throw new CubeParseError('No LUT_3D_SIZE or LUT_1D_SIZE declaration found');
}

function readTriple(line: string, out: [number, number, number], lineNo: number): void {
  const parts = line.split(/[\s,]+/).slice(1);
  for (let i = 0; i < 3; i++) {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) throw new CubeParseError(`Bad domain value "${parts[i]}"`, lineNo);
    out[i] = v;
  }
}

/**
 * Promote a 1D LUT to a 3D cube so the shader only ever deals with one kind.
 * A 1D LUT is a per-channel transfer function, so the cube is separable.
 */
export function lut1DTo3D(lut: Lut1D, size = 33): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  const sample = (channel: number, x: number): number => {
    const pos = Math.min(Math.max(x, 0), 1) * (lut.size - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, lut.size - 1);
    const f = pos - i0;
    const a = lut.data[i0 * 3 + channel];
    const b = lut.data[i1 * 3 + channel];
    return a + (b - a) * f;
  };

  let p = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        data[p++] = sample(0, ri / (size - 1));
        data[p++] = sample(1, gi / (size - 1));
        data[p++] = sample(2, bi / (size - 1));
      }
    }
  }

  return {
    kind: '3D',
    title: lut.title,
    size,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
    data,
  };
}

/** Always hand the pipeline a 3D cube, whatever the file contained. */
export function toLut3D(lut: ParsedLut): Lut3D {
  return lut.kind === '3D' ? lut : lut1DTo3D(lut);
}

/**
 * Rearrange CUBE order (red fastest) into the row-major layout a WebGL
 * `TEXTURE_3D` upload expects, which is also red-fastest — so this is a
 * straight copy, kept as a named step because the two orders are easy to
 * confuse and getting it wrong produces a subtly channel-swapped image.
 */
export function cubeToTexture3D(lut: Lut3D): Float32Array {
  return lut.data;
}

export interface WriteCubeOptions {
  title?: string;
  /** Decimal places written per value. Six is plenty for 16-bit output. */
  precision?: number;
}

/** Serialise a cube to .CUBE text. */
export function writeCube(
  size: number,
  data: Float32Array | number[],
  opts: WriteCubeOptions = {},
): string {
  const expected = size * size * size * 3;
  if (data.length !== expected) {
    throw new Error(`Expected ${expected} values for a ${size}^3 cube, got ${data.length}`);
  }
  const precision = opts.precision ?? 6;
  const title = (opts.title ?? 'EasyColor').replace(/"/g, "'");

  const out: string[] = [];
  out.push(`TITLE "${title}"`);
  out.push('');
  out.push(`LUT_3D_SIZE ${size}`);
  out.push('DOMAIN_MIN 0.0 0.0 0.0');
  out.push('DOMAIN_MAX 1.0 1.0 1.0');
  out.push('');

  for (let i = 0; i < expected; i += 3) {
    out.push(
      `${fmt(data[i], precision)} ${fmt(data[i + 1], precision)} ${fmt(data[i + 2], precision)}`,
    );
  }
  out.push('');
  return out.join('\n');
}

function fmt(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0.000000';
  return v.toFixed(precision);
}
