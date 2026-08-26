/**
 * The complete grade document.
 *
 * Everything that defines a look lives in this one serialisable object:
 * the history stack snapshots it, the project file is it, and the shader
 * uniforms are derived from it. Nothing about a look is stored anywhere else.
 */

import type { CurvePoint } from '../curves/spline.js';
import { DEFAULT_CURVE } from '../curves/spline.js';
import type { LogTransformId } from '../color/log.js';
import type { DisplayRenderId } from '../color/gamut.js';
import type { FilmStockId } from '../film/stocks.js';

/**
 * Hard caps. These are shader array sizes, so raising one means recompiling
 * the program — the pipeline does that automatically, but every extra slot
 * costs uniform space on weaker GPUs, so keep them modest.
 */
export const MAX_HSL_ZONES = 8;
export const MAX_POWER_WINDOWS = 4;

/* ------------------------------------------------------------------ */
/* Colour wheels                                                       */
/* ------------------------------------------------------------------ */

export interface WheelValue {
  /** Chroma offsets, -1..1, neutral at 0. */
  r: number;
  g: number;
  b: number;
  /** The master luma ring around the wheel, -1..1, neutral at 0. */
  luma: number;
}

export const NEUTRAL_WHEEL: WheelValue = { r: 0, g: 0, b: 0, luma: 0 };

export interface Wheels {
  lift: WheelValue;
  gamma: WheelValue;
  gain: WheelValue;
  offset: WheelValue;
}

/* ------------------------------------------------------------------ */
/* On-viewer HSL qualifier zones                                       */
/* ------------------------------------------------------------------ */

/**
 * One independently-graded colour.
 *
 * A zone is created when you click a colour on the viewer and persists until
 * you delete it. Zones never overwrite each other: their mattes are weighted
 * and normalised at blend time, so grading the sky after grading the skin
 * leaves the skin exactly as it was.
 *
 * All qualification happens in Oklab, where a fixed hue window stays
 * perceptually the same width across the whole wheel.
 */
export interface HslZone {
  id: string;
  label: string;
  enabled: boolean;
  /** Show this zone's matte alone, for checking the qualifier. */
  solo: boolean;

  /* --- qualifier --- */
  /** Oklab hue, degrees 0..360. */
  hue: number;
  /** Half-width of the fully-selected hue band, degrees. */
  hueWidth: number;
  /** Feather beyond the band before the matte reaches zero, degrees. */
  hueSoftness: number;

  /** Oklab chroma window. Excludes near-neutrals from a hue selection. */
  chromaLow: number;
  chromaHigh: number;
  chromaSoftness: number;

  /** Oklab L window. Lets you grade a colour only where it's dark, etc. */
  lumaLow: number;
  lumaHigh: number;
  lumaSoftness: number;

  /* --- edits --- */
  /** Hue rotation applied to the selection, degrees. */
  hueShift: number;
  /** Chroma multiplier, 1 = unchanged. */
  satGain: number;
  /** Exposure on the selection, in stops. */
  lumGain: number;
  /** Direct Oklab a/b push. Used by palette matching and fine tuning. */
  labOffsetA: number;
  labOffsetB: number;

  /** Overall strength of this zone's edit, 0..1. */
  strength: number;

  /** Display-referred colour that was clicked, for the UI swatch. */
  sampleRgb: [number, number, number];
}

export function createZone(id: string, sampleRgb: [number, number, number], hue: number, chroma: number, lightness: number): HslZone {
  return {
    id,
    label: describeHue(hue),
    enabled: true,
    solo: false,
    hue,
    hueWidth: 18,
    hueSoftness: 22,
    chromaLow: Math.max(0.008, chroma * 0.25),
    chromaHigh: 0.5,
    chromaSoftness: 0.05,
    lumaLow: Math.max(0, lightness - 0.45),
    lumaHigh: Math.min(1.4, lightness + 0.45),
    lumaSoftness: 0.25,
    hueShift: 0,
    satGain: 1,
    lumGain: 0,
    labOffsetA: 0,
    labOffsetB: 0,
    strength: 1,
    sampleRgb,
  };
}

/** Human-readable name for a hue, used to label a freshly sampled zone. */
export function describeHue(hue: number): string {
  const names: Array<[number, string]> = [
    [15, 'Red'],
    [45, 'Orange'],
    [75, 'Yellow'],
    [110, 'Skin'],
    [150, 'Green'],
    [200, 'Teal'],
    [250, 'Cyan'],
    [290, 'Blue'],
    [330, 'Magenta'],
    [360, 'Red'],
  ];
  const h = ((hue % 360) + 360) % 360;
  for (const [limit, name] of names) if (h < limit) return name;
  return 'Red';
}

/* ------------------------------------------------------------------ */
/* Power windows                                                       */
/* ------------------------------------------------------------------ */

export type WindowShape = 'ellipse' | 'rect' | 'vignette';

export interface PowerWindow {
  id: string;
  label: string;
  enabled: boolean;
  shape: WindowShape;

  /** Centre in normalised viewer coords, 0..1 with y down. */
  cx: number;
  cy: number;
  /**
   * Half-extents, in units of frame *height* on both axes.
   *
   * Both radii share one axis deliberately: it makes the shape isotropic, so
   * equal radii are a circle on any aspect ratio and the feather is the same
   * width all the way round. Measuring rx against width instead would make
   * every "circle" an oval on anything but a square frame.
   */
  rx: number;
  ry: number;
  /** Rotation in degrees, clockwise. */
  rotation: number;
  /** Edge feather, 0..1 of the radius. */
  softness: number;
  /** Corner rounding for rectangles, 0..1. */
  corner: number;
  invert: boolean;

  /* --- the grade inside the window --- */
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  /** Master opacity of the window's effect. */
  opacity: number;
}

export function createWindow(id: string, shape: WindowShape): PowerWindow {
  const isVignette = shape === 'vignette';
  return {
    id,
    label: shape === 'ellipse' ? 'Ellipse' : shape === 'rect' ? 'Rectangle' : 'Vignette',
    enabled: true,
    shape,
    cx: 0.5,
    cy: 0.5,
    rx: isVignette ? 0.78 : 0.22,
    ry: isVignette ? 0.78 : 0.22,
    rotation: 0,
    softness: isVignette ? 0.8 : 0.4,
    corner: 0.15,
    invert: isVignette,
    exposure: isVignette ? -0.7 : 0,
    contrast: 0,
    saturation: isVignette ? 0.92 : 1,
    temperature: 0,
    tint: 0,
    opacity: 1,
  };
}

/* ------------------------------------------------------------------ */
/* Film emulation                                                      */
/* ------------------------------------------------------------------ */

export interface HalationSettings {
  enabled: boolean;
  /** Luminance above which highlights start to bloom, 0..1. */
  threshold: number;
  /** Bloom radius in pixels at 1080p, scaled with resolution. */
  radius: number;
  /** Blend strength, 0..1. */
  strength: number;
  /** Colour of the halo. Real film halation is red-orange. */
  tint: [number, number, number];
}

export interface GrainSettings {
  enabled: boolean;
  /** Overall intensity, 0..1. */
  amount: number;
  /** Grain cell size in pixels. Larger = coarser stock. */
  size: number;
  /**
   * How much more grain lands in the shadows than the highlights.
   * Real negative film grains up in the toe, so 0 looks like video noise.
   */
  shadowBias: number;
  /** Per-channel independence, 0 = monochrome grain, 1 = full colour. */
  chroma: number;
  /** Animate grain per frame rather than freezing it. */
  animated: boolean;
}

export interface FilmSettings {
  stock: FilmStockId;
  /** Blend of the stock's look against the ungraded image, 0..1. */
  stockIntensity: number;
  /**
   * Subtractive density. Emulates light passing through dye layers: colours
   * darken as they saturate, instead of clipping toward white the way an
   * additive saturation control does.
   */
  density: number;
  halation: HalationSettings;
  grain: GrainSettings;
}

/* ------------------------------------------------------------------ */
/* LUT                                                                 */
/* ------------------------------------------------------------------ */

export interface LutState {
  enabled: boolean;
  name: string | null;
  /** Edge size of the loaded cube, e.g. 33. */
  size: number;
  /** RGB triplets, length size^3 * 3, in the CUBE file's r-fastest order. */
  data: Float32Array | null;
  /** Dry/wet blend, 0..1. */
  intensity: number;
  /**
   * Whether the LUT expects log input. A creative LUT built for S-Log3 must
   * see log, not the corrected image, or it double-corrects.
   */
  stage: 'log' | 'display';
}

/* ------------------------------------------------------------------ */
/* Skin tone suite                                                     */
/* ------------------------------------------------------------------ */

export interface SkinSettings {
  enabled: boolean;
  /** Diagnostic overlay drawn over the viewer without dimming it. */
  showIsolation: boolean;
  /** Centre of the skin qualifier, Oklab hue in degrees. */
  hue: number;
  hueWidth: number;
  hueSoftness: number;
  chromaLow: number;
  chromaHigh: number;
  lumaLow: number;
  lumaHigh: number;
  /** Rotation toward the 123 deg vectorscope line, degrees. */
  hueShift: number;
  satGain: number;
  lumGain: number;
  /** Softens skin texture slightly without touching edges elsewhere. */
  smoothing: number;
  strength: number;
}

/* ------------------------------------------------------------------ */
/* Viewer / compare                                                    */
/* ------------------------------------------------------------------ */

export type CompareMode = 'off' | 'wipe' | 'sideBySide';

/**
 * What the "before" side of an A/B compare shows.
 * `source` is the untouched clip — for log footage that means flat log.
 * `corrected` keeps the camera conversion and drops only the creative grade,
 * which is usually the more useful comparison.
 */
export type CompareReference = 'source' | 'corrected';
export type ViewerOverlay = 'none' | 'falseColor' | 'skinIsolation' | 'zoneMatte' | 'windowMatte';

export interface ViewerState {
  compare: CompareMode;
  /** Wipe position, 0..1 across the frame. */
  wipe: number;
  /** Vertical wipe instead of horizontal. */
  wipeVertical: boolean;
  reference: CompareReference;
  /** Bypass the whole grade — the hotkey toggle. */
  bypass: boolean;
  overlay: ViewerOverlay;
  /** Which zone's matte to show when overlay is 'zoneMatte'. */
  overlayZoneId: string | null;
  overlayWindowId: string | null;
}

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

export interface Primaries {
  /** Exposure in stops. */
  exposure: number;
  /** -1 cool .. +1 warm. */
  temperature: number;
  /** -1 green .. +1 magenta. */
  tint: number;
  /** -1..1, pivoting around `pivot`. */
  contrast: number;
  /**
   * Contrast pivot, in video levels (gamma-encoded), not linear.
   * 0.435 is where 18% scene grey lands after the Rec.709 encode, so the
   * default pivots around mid grey the way a colourist expects.
   */
  pivot: number;
  /** Global chroma multiplier. */
  saturation: number;
  /**
   * Saturation weighted toward already-desaturated pixels, so skin doesn't
   * blow out while a dull background comes up.
   */
  vibrance: number;
  /** Recovery controls, -1..1. */
  highlights: number;
  shadows: number;
}

export interface Curves {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export interface GradeState {
  /** Schema version, so old project files can be migrated. */
  version: 1;
  name: string;

  source: {
    logTransform: LogTransformId;
    displayRender: DisplayRenderId;
    /** Apply the camera's gamut matrix along with its log curve. */
    applyGamut: boolean;
  };

  primaries: Primaries;
  wheels: Wheels;
  curves: Curves;

  /**
   * Radius, in pixels, of the blur applied to the image *before* it is
   * qualified. The image itself is never blurred — only the reference the
   * mattes are built from. This is what keeps an isolated colour edit from
   * showing the block edges of 4:2:0 chroma subsampling.
   */
  qualifierSoftness: number;

  zones: HslZone[];
  windows: PowerWindow[];
  skin: SkinSettings;
  film: FilmSettings;
  lut: LutState;
  viewer: ViewerState;
}

export function defaultGrade(): GradeState {
  return {
    version: 1,
    name: 'Untitled grade',
    source: {
      logTransform: 'none',
      displayRender: 'neutral',
      applyGamut: true,
    },
    primaries: {
      exposure: 0,
      temperature: 0,
      tint: 0,
      contrast: 0,
      pivot: 0.435,
      saturation: 1,
      vibrance: 0,
      highlights: 0,
      shadows: 0,
    },
    wheels: {
      lift: { ...NEUTRAL_WHEEL },
      gamma: { ...NEUTRAL_WHEEL },
      gain: { ...NEUTRAL_WHEEL },
      offset: { ...NEUTRAL_WHEEL },
    },
    curves: {
      master: [...DEFAULT_CURVE],
      red: [...DEFAULT_CURVE],
      green: [...DEFAULT_CURVE],
      blue: [...DEFAULT_CURVE],
    },
    qualifierSoftness: 2.5,
    zones: [],
    windows: [],
    skin: {
      enabled: false,
      showIsolation: false,
      hue: 62,
      hueWidth: 16,
      hueSoftness: 20,
      chromaLow: 0.02,
      chromaHigh: 0.22,
      lumaLow: 0.25,
      lumaHigh: 0.95,
      hueShift: 0,
      satGain: 1,
      lumGain: 0,
      smoothing: 0,
      strength: 1,
    },
    film: {
      stock: 'none',
      stockIntensity: 1,
      density: 0,
      halation: {
        enabled: false,
        threshold: 0.72,
        radius: 18,
        strength: 0.35,
        tint: [1, 0.36, 0.16],
      },
      grain: {
        enabled: false,
        amount: 0.25,
        size: 1.6,
        shadowBias: 0.6,
        chroma: 0.35,
        animated: true,
      },
    },
    lut: {
      enabled: false,
      name: null,
      size: 0,
      data: null,
      intensity: 1,
      stage: 'display',
    },
    viewer: {
      compare: 'off',
      wipe: 0.5,
      wipeVertical: false,
      reference: 'corrected',
      bypass: false,
      overlay: 'none',
      overlayZoneId: null,
      overlayWindowId: null,
    },
  };
}

/** Deep clone for the history stack. Float arrays need explicit copying. */
export function cloneGrade(g: GradeState): GradeState {
  return {
    ...g,
    source: { ...g.source },
    primaries: { ...g.primaries },
    wheels: {
      lift: { ...g.wheels.lift },
      gamma: { ...g.wheels.gamma },
      gain: { ...g.wheels.gain },
      offset: { ...g.wheels.offset },
    },
    curves: {
      master: g.curves.master.map((p) => ({ ...p })),
      red: g.curves.red.map((p) => ({ ...p })),
      green: g.curves.green.map((p) => ({ ...p })),
      blue: g.curves.blue.map((p) => ({ ...p })),
    },
    zones: g.zones.map((z) => ({ ...z, sampleRgb: [...z.sampleRgb] as [number, number, number] })),
    windows: g.windows.map((w) => ({ ...w })),
    skin: { ...g.skin },
    film: {
      ...g.film,
      halation: { ...g.film.halation, tint: [...g.film.halation.tint] as [number, number, number] },
      grain: { ...g.film.grain },
    },
    // The LUT payload is immutable once loaded, so sharing the buffer is safe
    // and saves copying a few megabytes on every history entry.
    lut: { ...g.lut },
    viewer: { ...g.viewer },
  };
}

/**
 * True when the grade would change the image. Used to grey out the A/B
 * compare and to warn before discarding an untouched project.
 */
export function isNeutralGrade(g: GradeState): boolean {
  const p = g.primaries;
  const wheelTouched = (w: WheelValue) => w.r !== 0 || w.g !== 0 || w.b !== 0 || w.luma !== 0;
  return (
    p.exposure === 0 &&
    p.temperature === 0 &&
    p.tint === 0 &&
    p.contrast === 0 &&
    p.saturation === 1 &&
    p.vibrance === 0 &&
    p.highlights === 0 &&
    p.shadows === 0 &&
    !wheelTouched(g.wheels.lift) &&
    !wheelTouched(g.wheels.gamma) &&
    !wheelTouched(g.wheels.gain) &&
    !wheelTouched(g.wheels.offset) &&
    g.zones.length === 0 &&
    g.windows.length === 0 &&
    !g.skin.enabled &&
    g.film.stock === 'none' &&
    !g.film.halation.enabled &&
    !g.film.grain.enabled &&
    g.film.density === 0 &&
    !g.lut.enabled &&
    g.source.logTransform === 'none'
  );
}
