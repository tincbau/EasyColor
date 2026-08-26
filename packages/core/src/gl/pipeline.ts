/**
 * The render pipeline.
 *
 * Pass order, and why each boundary is where it is:
 *
 *   1  base      camera conversion + primary grade      (pure per-pixel)
 *   1b reference the A/B "before" image                 (only when comparing)
 *   2  qualBlur  blurred copy for matte qualification   (spatial)
 *   3  zones     HSL zones, skin, power windows         (pure per-pixel*)
 *   4  halation  threshold + bloom                      (spatial)
 *   5  final     grain, overlays, compare, output       (spatial + view-only)
 *
 * (*) Power windows are positional, so the LUT baker skips them; everything
 * else in pass 3 is a function of colour alone and bakes cleanly.
 *
 * The split between "pure per-pixel" and "spatial" is what makes the
 * one-click .CUBE export exact rather than approximate: the baker replays
 * passes 1 and 3 over an identity Hald image and gets, by construction, the
 * same numbers the viewer showed.
 */

import { VERTEX_SHADER } from './shaders/common.glsl.js';
import { buildBaseFragmentShader } from './shaders/base.frag.js';
import { buildZonesFragmentShader } from './shaders/zones.frag.js';
import { buildFinalFragmentShader } from './shaders/final.frag.js';
import { buildBlurFragmentShader, buildHalationThresholdShader, MAX_BLUR_TAPS } from './shaders/blur.frag.js';
import { BLIT_FRAGMENT_SHADER } from './blit.frag.js';
import {
  Program,
  RenderTarget,
  createEmptyVao,
  drawFullscreen,
  supportsFloatTargets,
} from './glutil.js';
import { decodeHalfArray } from './halfFloat.js';
import { CURVE_LUT_SIZE } from '../curves/spline.js';
import type { GradeState } from '../state/grade.js';
import {
  curvesAreActive,
  matteMode,
  packCurves,
  packFilm,
  packSkin,
  packSource,
  packWindows,
  packZones,
} from './uniforms.js';

export type SourceImage = TexImageSource;

export interface RendererOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Render at a fraction of source resolution. Dropping to 0.5 while
   * scrubbing keeps a 4K viewer interactive on integrated graphics; the
   * grade itself is resolution-independent, so nothing is lost but detail.
   */
  processScale?: number;
}

export interface BakeLutOptions {
  /**
   * Include power windows in the bake.
   *
   * Off by default, and for the viewer's own "export LUT" that is correct: a
   * window is positional and a cube only knows colour. The exporter switches
   * it on for a different purpose — it bakes one cube per window with that
   * window's shape widened to cover the frame, then reapplies the real shape
   * as a mask outside the LUT. That reproduces a window exactly rather than
   * dropping it.
   */
  includeWindows?: boolean;
}

export interface SampledPixel {
  /** Colour before any zone or window edit — the stable identity of a subject. */
  base: [number, number, number];
  /** Colour as displayed, after everything. */
  graded: [number, number, number];
}

const HALATION_DOWNSCALE = 2;

export class GradeRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly floatTargets: boolean;

  private readonly baseProgram: Program;
  private readonly zonesProgram: Program;
  private readonly finalProgram: Program;
  private readonly blurProgram: Program;
  private readonly thresholdProgram: Program;
  private readonly blitProgram: Program;

  private baseRT: RenderTarget;
  private referenceRT: RenderTarget;
  private qualA: RenderTarget;
  private qualB: RenderTarget;
  private zonesRT: RenderTarget;
  private bloomA: RenderTarget;
  private bloomB: RenderTarget;
  private scopeRT: RenderTarget;

  private sourceTexture: WebGLTexture;
  private curveTexture: WebGLTexture;
  private filmCurveTexture: WebGLTexture;
  private lutTexture: WebGLTexture | null = null;
  private lutSize = 0;

  private sourceWidth = 1;
  private sourceHeight = 1;
  private sourceFlipY = false;

  private renderWidth = 1;
  private renderHeight = 1;
  private processScale: number;

  private curveSignature = '';
  private filmSignature = '';
  private lutSignature = '';

  private disposed = false;

  constructor(private readonly options: RendererOptions) {
    const gl = options.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // Colour work is not worth doing on a power-saving integrated GPU when
      // a discrete one is present.
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;

    if (!gl) {
      throw new Error(
        'WebGL2 is not available. EasyColor needs WebGL2 for its grading pipeline — ' +
          'update your browser or enable hardware acceleration.',
      );
    }

    this.gl = gl;
    this.processScale = options.processScale ?? 1;
    this.floatTargets = supportsFloatTargets(gl);
    this.vao = createEmptyVao(gl);

    this.baseProgram = new Program(gl, VERTEX_SHADER, buildBaseFragmentShader(), 'base');
    this.zonesProgram = new Program(gl, VERTEX_SHADER, buildZonesFragmentShader(), 'zones');
    this.finalProgram = new Program(gl, VERTEX_SHADER, buildFinalFragmentShader(), 'final');
    this.blurProgram = new Program(gl, VERTEX_SHADER, buildBlurFragmentShader(), 'blur');
    this.thresholdProgram = new Program(gl, VERTEX_SHADER, buildHalationThresholdShader(), 'threshold');
    this.blitProgram = new Program(gl, VERTEX_SHADER, BLIT_FRAGMENT_SHADER, 'blit');

    const f = { float: this.floatTargets };
    this.baseRT = new RenderTarget(gl, 1, 1, f);
    this.referenceRT = new RenderTarget(gl, 1, 1, f);
    this.qualA = new RenderTarget(gl, 1, 1, f);
    this.qualB = new RenderTarget(gl, 1, 1, f);
    this.zonesRT = new RenderTarget(gl, 1, 1, f);
    this.bloomA = new RenderTarget(gl, 1, 1, f);
    this.bloomB = new RenderTarget(gl, 1, 1, f);
    this.scopeRT = new RenderTarget(gl, 1, 1, { linear: false });

    this.sourceTexture = this.createTexture2D();
    this.curveTexture = this.createCurveTexture();
    this.filmCurveTexture = this.createCurveTexture();
  }

  /* ---------------------------------------------------------------- */
  /* Texture setup                                                     */
  /* ---------------------------------------------------------------- */

  private createTexture2D(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createCurveTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = this.createTexture2D();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, CURVE_LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    return tex;
  }

  /** Upload a frame. Call once per video frame, or once per still. */
  setSource(image: SourceImage, flipY = false): void {
    const gl = this.gl;
    const width = getSourceWidth(image);
    const height = getSourceHeight(image);
    if (width === 0 || height === 0) return;

    this.sourceWidth = width;
    this.sourceHeight = height;
    this.sourceFlipY = flipY;

    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Images, video frames and decoded camera data all have row 0 at the top;
    // GL puts row 0 at the bottom. Flipping once here, at the only place
    // outside pixels enter the pipeline, keeps every downstream stage — the
    // eyedropper, the scopes, the power window coordinates — on one
    // convention. Flipping later instead means fixing it in five places and
    // getting one of them wrong.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.resizeTargets();
  }

  /**
   * Upload raw pixel data. The desktop app uses this for 10-bit 4:2:2 frames
   * decoded by FFmpeg, where the browser's own decoder would have already
   * flattened them to 8-bit.
   */
  setSourceData(
    data: Uint8Array | Uint16Array | Float32Array,
    width: number,
    height: number,
    flipY = false,
  ): void {
    const gl = this.gl;
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.sourceFlipY = flipY;

    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Same top-down row order as the DOM sources above; see `setSource`.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    if (data instanceof Float32Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    } else if (data instanceof Uint16Array) {
      // 10- and 12-bit camera frames arrive in a 16-bit container. They are
      // normalised to float here rather than uploaded as RGBA16UI, because an
      // integer texture needs a usampler2D and loses hardware filtering — and
      // the whole point of decoding 10-bit is to keep the gradients smooth.
      const norm = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) norm[i] = data[i] / 65535;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, norm);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.resizeTargets();
  }

  /** Load a 3D LUT. Pass null to clear. */
  setLut(size: number, data: Float32Array | null, signature: string): void {
    const gl = this.gl;
    if (this.lutSignature === signature) return;
    this.lutSignature = signature;

    if (!data || size < 2) {
      if (this.lutTexture) {
        gl.deleteTexture(this.lutTexture);
        this.lutTexture = null;
      }
      this.lutSize = 0;
      return;
    }

    if (!this.lutTexture) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('Could not create 3D LUT texture');
      this.lutTexture = tex;
    }

    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    // RGB32F rather than RGB8: creative LUTs routinely contain values that
    // 8 bits would band badly, and a 33-cube is only a few hundred kilobytes.
    const rgba = new Float32Array(size * size * size * 4);
    for (let i = 0, j = 0; i < size * size * size; i++) {
      rgba[j++] = data[i * 3 + 0];
      rgba[j++] = data[i * 3 + 1];
      rgba[j++] = data[i * 3 + 2];
      rgba[j++] = 1;
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba);
    this.lutSize = size;
  }

  setProcessScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.1, scale));
    if (clamped === this.processScale) return;
    this.processScale = clamped;
    this.resizeTargets();
  }

  private resizeTargets(): void {
    const gl = this.gl;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    const fit = Math.min(1, maxTex / Math.max(this.sourceWidth, this.sourceHeight));
    const scale = this.processScale * fit;

    const w = Math.max(1, Math.round(this.sourceWidth * scale));
    const h = Math.max(1, Math.round(this.sourceHeight * scale));
    if (w === this.renderWidth && h === this.renderHeight) return;

    this.renderWidth = w;
    this.renderHeight = h;

    this.baseRT.resize(w, h);
    this.referenceRT.resize(w, h);
    this.qualA.resize(w, h);
    this.qualB.resize(w, h);
    this.zonesRT.resize(w, h);
    this.bloomA.resize(
      Math.max(1, Math.round(w / HALATION_DOWNSCALE)),
      Math.max(1, Math.round(h / HALATION_DOWNSCALE)),
    );
    this.bloomB.resize(
      Math.max(1, Math.round(w / HALATION_DOWNSCALE)),
      Math.max(1, Math.round(h / HALATION_DOWNSCALE)),
    );
  }

  get renderSize(): { width: number; height: number } {
    return { width: this.renderWidth, height: this.renderHeight };
  }

  get sourceSize(): { width: number; height: number } {
    return { width: this.sourceWidth, height: this.sourceHeight };
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Render one frame to the canvas.
   * `time` drives animated grain and the marching-ants matte contour.
   */
  render(grade: GradeState, time = 0): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    this.syncCurveTextures(grade);
    this.syncLut(grade);

    const needsReference = grade.viewer.bypass || grade.viewer.compare !== 'off';

    this.renderBase(grade, this.baseRT, 0);
    if (needsReference) {
      this.renderBase(grade, this.referenceRT, grade.viewer.reference === 'source' ? 2 : 1);
    }

    const qualRef = this.renderQualifierReference(grade);
    this.renderZones(grade, qualRef, /* includeWindows */ true, this.zonesRT);

    const halationActive = grade.film.halation.enabled && grade.film.halation.strength > 0;
    if (halationActive) this.renderHalation(grade);

    this.renderFinal(grade, halationActive, needsReference, time);
  }

  private renderBase(grade: GradeState, target: RenderTarget, outputMode: number): void {
    const gl = this.gl;
    const p = this.baseProgram;
    const src = packSource(grade);
    const film = packFilm(grade);
    const pr = grade.primaries;

    target.bind();
    p.use();

    p.texture('uSource', 0, this.sourceTexture);
    p.vec2('uSourceSize', this.sourceWidth, this.sourceHeight);
    p.bool('uFlipY', this.sourceFlipY);

    p.int('uLogMode', src.logMode);
    p.mat3('uGamut', src.gamut);
    p.bool('uApplyGamut', src.applyGamut);
    p.int('uDisplayMode', src.displayMode);

    p.float('uExposure', pr.exposure);
    p.float('uTemperature', pr.temperature);
    p.float('uTint', pr.tint);
    p.float('uContrast', pr.contrast);
    p.float('uPivot', pr.pivot);
    p.float('uSaturation', pr.saturation);
    p.float('uVibrance', pr.vibrance);
    p.float('uHighlights', pr.highlights);
    p.float('uShadows', pr.shadows);

    const w = grade.wheels;
    p.vec4('uLift', w.lift.r, w.lift.g, w.lift.b, w.lift.luma);
    p.vec4('uGamma', w.gamma.r, w.gamma.g, w.gamma.b, w.gamma.luma);
    p.vec4('uGain', w.gain.r, w.gain.g, w.gain.b, w.gain.luma);
    p.vec4('uOffset', w.offset.r, w.offset.g, w.offset.b, w.offset.luma);

    p.texture('uCurves', 1, this.curveTexture);
    p.bool('uCurvesActive', curvesAreActive(grade));

    p.bool('uFilmActive', film.active);
    p.mat3('uFilmMatrix', film.matrix);
    p.texture('uFilmCurves', 2, this.filmCurveTexture);
    p.float('uFilmIntensity', film.intensity);
    p.float('uFilmSaturation', film.saturation);
    p.vec3('uFilmShadowTint', ...film.shadowTint);
    p.vec3('uFilmHighlightTint', ...film.highlightTint);
    p.float('uDensity', film.density);

    const lutActive = grade.lut.enabled && this.lutTexture !== null && this.lutSize >= 2;
    p.texture('uLut', 3, this.lutTexture, gl.TEXTURE_3D);
    p.bool('uLutActive', lutActive);
    p.float('uLutIntensity', grade.lut.intensity);
    p.int('uLutStage', grade.lut.stage === 'log' ? 0 : 1);
    p.float('uLutSize', Math.max(2, this.lutSize));

    p.int('uOutputMode', outputMode);

    drawFullscreen(gl);
  }

  /**
   * Build the texture zone mattes are qualified against.
   *
   * Returns `baseRT` unchanged when softness is off, so the common case
   * costs nothing.
   */
  private renderQualifierReference(grade: GradeState): RenderTarget {
    const needsZones = grade.zones.length > 0 || grade.skin.enabled;
    if (!needsZones || grade.qualifierSoftness <= 0.05) return this.baseRT;

    const gl = this.gl;
    const sigma = grade.qualifierSoftness;
    const taps = Math.min(MAX_BLUR_TAPS, Math.max(1, Math.ceil(sigma * 1.5)));

    this.blurPass(this.baseRT, this.qualA, 1, 0, sigma, taps);
    this.blurPass(this.qualA, this.qualB, 0, 1, sigma, taps);
    void gl;
    return this.qualB;
  }

  private blurPass(
    from: RenderTarget,
    to: RenderTarget,
    dx: number,
    dy: number,
    sigma: number,
    taps: number,
  ): void {
    const gl = this.gl;
    const p = this.blurProgram;
    to.bind();
    p.use();
    p.texture('uTex', 0, from.texture);
    p.vec2('uTexel', 1 / from.width, 1 / from.height);
    p.vec2('uDirection', dx, dy);
    p.float('uSigma', sigma);
    p.int('uTaps', taps);
    drawFullscreen(gl);
  }

  private renderZones(
    grade: GradeState,
    qualRef: RenderTarget,
    includeWindows: boolean,
    target: RenderTarget,
  ): void {
    const gl = this.gl;
    const p = this.zonesProgram;

    const zones = packZones(grade.zones, grade.viewer.overlayZoneId);
    const windows = includeWindows
      ? packWindows(grade.windows, grade.viewer.overlayWindowId)
      : packWindows([], null);
    const skin = packSkin(grade.skin);

    target.bind();
    p.use();

    p.texture('uBase', 0, this.baseRT.texture);
    p.texture('uQualRef', 1, qualRef.texture);
    p.vec2('uResolution', target.width, target.height);
    p.float('uAspect', target.width / Math.max(1, target.height));
    p.float('uPivot', grade.primaries.pivot);

    p.int('uZoneCount', zones.count);
    p.vec4Array('uZone0', zones.z0);
    p.vec4Array('uZone1', zones.z1);
    p.vec4Array('uZone2', zones.z2);
    p.vec4Array('uZone3', zones.z3);
    p.intArray('uZoneFlags', zones.flags);
    p.bool('uAnySolo', zones.anySolo);

    p.bool('uSkinActive', skin.active);
    p.vec4('uSkin0', ...skin.s0);
    p.vec4('uSkin1', ...skin.s1);
    p.vec4('uSkin2', ...skin.s2);

    p.int('uWindowCount', windows.count);
    p.vec4Array('uWin0', windows.w0);
    p.vec4Array('uWin1', windows.w1);
    p.vec4Array('uWin2', windows.w2);
    p.vec4Array('uWin3', windows.w3);
    p.intArray('uWinFlags', windows.flags);

    const mode = matteMode(grade);
    p.int('uMatteMode', mode);
    p.int('uMatteIndex', mode === 3 ? windows.matteIndex : zones.matteIndex);

    drawFullscreen(gl);
  }

  private renderHalation(grade: GradeState): void {
    const gl = this.gl;
    const h = grade.film.halation;

    // Threshold into the half-resolution bloom buffer.
    this.bloomA.bind();
    this.thresholdProgram.use();
    this.thresholdProgram.texture('uTex', 0, this.zonesRT.texture);
    this.thresholdProgram.float('uThreshold', h.threshold);
    this.thresholdProgram.float('uKnee', 0.08);
    drawFullscreen(gl);

    // Radius is authored at 1080p and scales with the frame, so a look holds
    // when the same grade is applied to a 4K master.
    const resScale = this.renderHeight / 1080 / HALATION_DOWNSCALE;
    const sigma = Math.max(0.5, h.radius * resScale);
    const taps = Math.min(MAX_BLUR_TAPS, Math.max(2, Math.ceil(sigma * 1.5)));

    this.blurPass(this.bloomA, this.bloomB, 1, 0, sigma, taps);
    this.blurPass(this.bloomB, this.bloomA, 0, 1, sigma, taps);
  }

  private renderFinal(
    grade: GradeState,
    halationActive: boolean,
    hasReference: boolean,
    time: number,
  ): void {
    const gl = this.gl;
    const p = this.finalProgram;
    const canvas = this.options.canvas;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    p.use();

    p.texture('uGraded', 0, this.zonesRT.texture);
    p.texture('uReference', 1, hasReference ? this.referenceRT.texture : this.zonesRT.texture);
    p.texture('uHalation', 2, this.bloomA.texture);
    p.vec2('uResolution', canvas.width, canvas.height);

    const h = grade.film.halation;
    p.bool('uHalationActive', halationActive);
    p.float('uHalationStrength', h.strength);
    p.vec3('uHalationTint', ...h.tint);

    const g = grade.film.grain;
    p.bool('uGrainActive', g.enabled);
    p.float('uGrainAmount', g.amount);
    p.float('uGrainSize', g.size);
    p.float('uGrainShadowBias', g.shadowBias);
    p.float('uGrainChroma', g.chroma);
    // A frozen seed is essential when matching stills; an animated one is
    // essential when the alternative is grain that sticks to the screen.
    p.float('uGrainSeed', g.animated ? (time * 37.13) % 1000 : 0);

    p.int('uCompareMode', grade.viewer.compare === 'wipe' ? 1 : grade.viewer.compare === 'sideBySide' ? 2 : 0);
    p.float('uWipe', grade.viewer.wipe);
    p.bool('uWipeVertical', grade.viewer.wipeVertical);
    p.bool('uBypass', grade.viewer.bypass);

    const overlay =
      grade.viewer.overlay === 'falseColor'
        ? 1
        : grade.viewer.overlay === 'none'
          ? 0
          : 2;
    p.int('uOverlay', overlay);
    p.float('uTime', time);
    p.bool('uMatteHatch', grade.viewer.overlay === 'zoneMatte' || grade.viewer.overlay === 'windowMatte');
    // Cyan reads clearly against skin, foliage and sky alike, which is where
    // mattes are usually being checked.
    p.vec3('uMatteColor', 0.1, 0.95, 0.95);

    drawFullscreen(gl);
  }

  /* ---------------------------------------------------------------- */
  /* Readback                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Sample one pixel, in normalised viewer coordinates with y down.
   *
   * Returns both the pre-zone colour and the displayed colour. The on-viewer
   * tool matches clicks against the *base* colour: once you have rotated a
   * shirt from blue to teal, clicking it again still resolves to the zone
   * you created, because its identity never moved.
   */
  samplePixel(u: number, v: number): SampledPixel {
    const x = Math.min(this.renderWidth - 1, Math.max(0, Math.round(u * this.renderWidth)));
    // Framebuffers are bottom-up; viewer coordinates are top-down.
    const y = Math.min(this.renderHeight - 1, Math.max(0, Math.round((1 - v) * this.renderHeight)));

    return {
      base: this.readOnePixel(this.baseRT, x, y),
      graded: this.readOnePixel(this.zonesRT, x, y),
    };
  }

  /**
   * Average a small square instead of a single pixel.
   *
   * A single pixel on grainy or noisy footage is a lottery — sample the same
   * cheek twice and get two different hues. Averaging a patch is what makes
   * click-to-grade land on the colour a person actually sees.
   */
  samplePatch(u: number, v: number, radiusPx = 3): SampledPixel {
    const gl = this.gl;
    const size = radiusPx * 2 + 1;

    const cx = Math.round(u * this.renderWidth);
    const cy = Math.round((1 - v) * this.renderHeight);
    const x = Math.min(Math.max(cx - radiusPx, 0), Math.max(0, this.renderWidth - size));
    const y = Math.min(Math.max(cy - radiusPx, 0), Math.max(0, this.renderHeight - size));
    const w = Math.min(size, this.renderWidth);
    const h = Math.min(size, this.renderHeight);

    const avg = (rt: RenderTarget): [number, number, number] => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
      const px = this.readRegion(x, y, w, h);
      let r = 0;
      let g = 0;
      let b = 0;
      const n = w * h;
      for (let i = 0; i < n; i++) {
        r += px[i * 4 + 0];
        g += px[i * 4 + 1];
        b += px[i * 4 + 2];
      }
      return [r / n, g / n, b / n];
    };

    return { base: avg(this.baseRT), graded: avg(this.zonesRT) };
  }

  private readOnePixel(rt: RenderTarget, x: number, y: number): [number, number, number] {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, rt.framebuffer);
    const px = this.readRegion(x, y, 1, 1);
    return [px[0], px[1], px[2]];
  }

  /**
   * Read a region of the currently bound framebuffer as normalised floats.
   *
   * WebGL2 only guarantees one readable format per attachment, and which one
   * it is depends on the driver — so ask rather than assume. Guessing wrong
   * throws INVALID_OPERATION and silently returns zeroes, which shows up as
   * an eyedropper that always reports black.
   */
  private readRegion(x: number, y: number, w: number, h: number): Float32Array {
    const gl = this.gl;
    const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;

    if (readType === gl.FLOAT) {
      const buf = new Float32Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, buf);
      return buf;
    }
    if (readType === gl.HALF_FLOAT) {
      const buf = new Uint16Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.HALF_FLOAT, buf);
      return decodeHalfArray(buf);
    }

    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255;
    return out;
  }

  /**
   * Grab a downscaled copy of the graded image for the scopes.
   *
   * Scopes are statistical, so they do not need full resolution — and
   * reading back a 4K frame every refresh would stall the GPU pipeline hard
   * enough to halve the viewer's frame rate.
   */
  grabScopeFrame(maxWidth = 480): { data: Uint8Array; width: number; height: number } {
    const gl = this.gl;
    const aspect = this.renderHeight / Math.max(1, this.renderWidth);
    const w = Math.max(1, Math.min(maxWidth, this.renderWidth));
    const h = Math.max(1, Math.round(w * aspect));

    this.scopeRT.resize(w, h);
    this.scopeRT.bind();
    gl.bindVertexArray(this.vao);
    this.blitProgram.use();
    this.blitProgram.texture('uTex', 0, this.zonesRT.texture);
    // Scopes are statistical, so row order does not affect the result — but
    // the palette and skin tools also read this buffer and present swatches
    // back to the user, so it is kept upright.
    this.blitProgram.bool('uFlipY', true);
    drawFullscreen(gl);

    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width: w, height: h };
  }

  /* ---------------------------------------------------------------- */
  /* LUT baking                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Bake the per-pixel half of the grade into a cube.
   *
   * The identity Hald image is pushed through the same base and zones
   * programs the viewer uses, so what comes out is not an approximation of
   * the look — it is the look, sampled on a lattice.
   *
   * Spatial effects are excluded by construction: halation, grain and power
   * windows depend on where a pixel is, and a 3D LUT only knows what colour
   * it is. The UI says so before exporting.
   */
  bakeLut(grade: GradeState, size = 33, options: BakeLutOptions = {}): Float32Array {
    const gl = this.gl;
    const includeWindows = options.includeWindows ?? false;

    const savedSourceW = this.sourceWidth;
    const savedSourceH = this.sourceHeight;
    const savedFlip = this.sourceFlipY;
    const savedScale = this.processScale;

    const width = size * size;
    const height = size;

    // Identity Hald: r varies fastest along x within each tile, b selects
    // the tile, g runs down the rows. This is the CUBE ordering, laid flat.
    const hald = new Uint8Array(width * height * 4);
    for (let bi = 0; bi < size; bi++) {
      for (let gi = 0; gi < size; gi++) {
        for (let ri = 0; ri < size; ri++) {
          const x = bi * size + ri;
          const y = gi;
          const o = (y * width + x) * 4;
          hald[o + 0] = Math.round((ri / (size - 1)) * 255);
          hald[o + 1] = Math.round((gi / (size - 1)) * 255);
          hald[o + 2] = Math.round((bi / (size - 1)) * 255);
          hald[o + 3] = 255;
        }
      }
    }

    const haldTex = this.createTexture2D();
    gl.bindTexture(gl.TEXTURE_2D, haldTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Explicitly unflipped: this lattice is generated here and read back by
    // index, so its rows must arrive in the order they were written.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, hald);

    const bakeBase = new RenderTarget(gl, width, height, { float: this.floatTargets, linear: false });
    const bakeOut = new RenderTarget(gl, width, height, { float: this.floatTargets, linear: false });

    const realSource = this.sourceTexture;
    const realBase = this.baseRT;
    try {
      gl.bindVertexArray(this.vao);
      this.syncCurveTextures(grade);
      this.syncLut(grade);

      this.sourceTexture = haldTex;
      this.sourceWidth = width;
      this.sourceHeight = height;
      this.sourceFlipY = false;
      this.renderWidth = width;
      this.renderHeight = height;

      this.renderBase(grade, bakeBase, 0);

      // Qualify against the unblurred lattice: the Hald has no spatial
      // structure, so a blur here would only smear unrelated colours together.
      this.baseRT = bakeBase;
      this.renderZones(grade, bakeBase, includeWindows, bakeOut);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bakeOut.framebuffer);
      const pixels = this.readRegion(0, 0, width, height);

      const out = new Float32Array(size * size * size * 3);
      let p = 0;
      for (let bi = 0; bi < size; bi++) {
        for (let gi = 0; gi < size; gi++) {
          for (let ri = 0; ri < size; ri++) {
            const x = bi * size + ri;
            const y = gi;
            const o = (y * width + x) * 4;
            out[p++] = clamp01(pixels[o + 0]);
            out[p++] = clamp01(pixels[o + 1]);
            out[p++] = clamp01(pixels[o + 2]);
          }
        }
      }
      return out;
    } finally {
      this.sourceTexture = realSource;
      this.baseRT = realBase;
      this.sourceWidth = savedSourceW;
      this.sourceHeight = savedSourceH;
      this.sourceFlipY = savedFlip;
      this.processScale = savedScale;
      this.renderWidth = 0;
      this.renderHeight = 0;
      this.resizeTargets();

      gl.deleteTexture(haldTex);
      bakeBase.dispose();
      bakeOut.dispose();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Internal sync                                                     */
  /* ---------------------------------------------------------------- */

  private syncCurveTextures(grade: GradeState): void {
    const gl = this.gl;

    const sig = JSON.stringify(grade.curves);
    if (sig !== this.curveSignature) {
      this.curveSignature = sig;
      gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, CURVE_LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, packCurves(grade),
      );
    }

    const filmSig = `${grade.film.stock}`;
    if (filmSig !== this.filmSignature) {
      this.filmSignature = filmSig;
      gl.bindTexture(gl.TEXTURE_2D, this.filmCurveTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, CURVE_LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, packFilm(grade).curves,
      );
    }
  }

  private syncLut(grade: GradeState): void {
    const sig = grade.lut.data ? `${grade.lut.name}:${grade.lut.size}:${grade.lut.data.length}` : 'none';
    this.setLut(grade.lut.size, grade.lut.enabled ? grade.lut.data : null, sig);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;

    this.baseProgram.dispose();
    this.zonesProgram.dispose();
    this.finalProgram.dispose();
    this.blurProgram.dispose();
    this.thresholdProgram.dispose();
    this.blitProgram.dispose();

    this.baseRT.dispose();
    this.referenceRT.dispose();
    this.qualA.dispose();
    this.qualB.dispose();
    this.zonesRT.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.scopeRT.dispose();

    gl.deleteTexture(this.sourceTexture);
    gl.deleteTexture(this.curveTexture);
    gl.deleteTexture(this.filmCurveTexture);
    if (this.lutTexture) gl.deleteTexture(this.lutTexture);
    gl.deleteVertexArray(this.vao);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function getSourceWidth(image: SourceImage): number {
  const anyImage = image as { videoWidth?: number; naturalWidth?: number; width?: number };
  return anyImage.videoWidth || anyImage.naturalWidth || anyImage.width || 0;
}

function getSourceHeight(image: SourceImage): number {
  const anyImage = image as { videoHeight?: number; naturalHeight?: number; height?: number };
  return anyImage.videoHeight || anyImage.naturalHeight || anyImage.height || 0;
}
