/**
 * Thin WebGL2 helpers: program compilation with readable errors, render
 * targets that resize in place, and uniform caching.
 *
 * Shader compile failures are reported with the offending line quoted,
 * because a driver message like "ERROR: 0:412: 'x' : undeclared identifier"
 * is useless when the shader is assembled from six generated fragments.
 */

export class ShaderError extends Error {
  constructor(message: string, readonly source: string, readonly log: string) {
    super(message);
    this.name = 'ShaderError';
  }
}

function annotate(source: string, log: string): string {
  const lines = source.split('\n');
  const out: string[] = [log.trim()];
  const seen = new Set<number>();

  for (const m of log.matchAll(/(\d+):(\d+)/g)) {
    const lineNo = parseInt(m[2], 10);
    if (!Number.isFinite(lineNo) || seen.has(lineNo)) continue;
    seen.add(lineNo);
    for (let i = Math.max(1, lineNo - 2); i <= Math.min(lines.length, lineNo + 2); i++) {
      out.push(`${i === lineNo ? '>' : ' '} ${String(i).padStart(4)} | ${lines[i - 1]}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create shader object');

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new ShaderError(`${kind} shader failed to compile:\n${annotate(source, log)}`, source, log);
  }
  return shader;
}

export class Program {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    readonly label = 'program',
  ) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

    const program = gl.createProgram();
    if (!program) throw new Error('Could not create program object');

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    // Shaders can be deleted straight after linking; the program keeps them.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '(no log)';
      gl.deleteProgram(program);
      throw new ShaderError(`${label} failed to link: ${log}`, fragmentSource, log);
    }

    this.program = program;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.uniforms.set(name, l);
    }
    return l;
  }

  /* Setters are no-ops when a uniform was optimised out, which happens
     constantly as features are toggled off. That is expected, not an error. */

  int(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  float(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  bool(name: string, v: boolean): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v ? 1 : 0);
  }
  vec2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }
  vec3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }
  vec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }
  vec4Array(name: string, data: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, data);
  }
  intArray(name: string, data: Int32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1iv(l, data);
  }
  mat3(name: string, columnMajor: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix3fv(l, false, columnMajor);
  }
  texture(name: string, unit: number, texture: WebGLTexture | null, target = 0x0de1): void {
    const l = this.loc(name);
    if (!l) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
    gl.uniform1i(l, unit);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

export interface RenderTargetOptions {
  /** Half-float keeps headroom through the chain; UNSIGNED_BYTE is the fallback. */
  float?: boolean;
  /** Linear filtering. Off for anything read back as data. */
  linear?: boolean;
}

/** A resizable colour-only framebuffer. */
export class RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width = 0;
  height = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    private readonly opts: RenderTargetOptions = {},
  ) {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error('Could not allocate render target');
    this.texture = tex;
    this.framebuffer = fbo;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = opts.linear === false ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    // Clamping matters for the blur passes: wrapping would bleed the right
    // edge of the frame into the left.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    this.resize(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;

    const gl = this.gl;
    this.width = w;
    this.height = h;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.opts.float) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}

/** Draw the full-screen triangle. Requires a bound program and a VAO. */
export function drawFullscreen(gl: WebGL2RenderingContext): void {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function createEmptyVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Could not create vertex array object');
  return vao;
}

/**
 * Half-float render targets need EXT_color_buffer_float (or _half_float) to
 * be *renderable*, not merely creatable. Ask before relying on them.
 */
export function supportsFloatTargets(gl: WebGL2RenderingContext): boolean {
  return (
    gl.getExtension('EXT_color_buffer_half_float') !== null ||
    gl.getExtension('EXT_color_buffer_float') !== null
  );
}
