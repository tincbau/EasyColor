/**
 * Analog film stock emulations.
 *
 * Each stock is a parameter bundle rather than a baked LUT: a channel-mix
 * matrix (how the dye layers cross-talk), per-channel tone curves (the
 * characteristic curve of the emulsion), a split-tone, and the grain and
 * halation the stock is known for. Describing stocks this way keeps them a
 * few hundred bytes each, lets them be blended continuously, and means a
 * stock still responds to the grade underneath it instead of flattening it.
 *
 * These are stylistic interpretations, not colorimetric scans of the
 * emulsions. They aim to land where a colourist would expect the stock to
 * sit, not to be measurement-accurate.
 */

import type { CurvePoint } from '../curves/spline.js';
import type { Mat3 } from '../color/gamut.js';
import { IDENTITY_MAT } from '../color/gamut.js';

export type FilmStockId =
  | 'none'
  | 'kodachrome64'
  | 'portra400'
  | 'portra800'
  | 'ektar100'
  | 'vision3_250d'
  | 'vision3_500t'
  | 'fuji_eterna'
  | 'fuji_velvia50'
  | 'fuji_pro400h'
  | 'cinestill800t'
  | 'cinestill50d'
  | 'agfa_vista'
  | 'ilford_hp5'
  | 'trix400';

export interface FilmStock {
  id: FilmStockId;
  label: string;
  maker: string;
  /** One line a colourist would recognise the stock by. */
  character: string;

  /** Dye-layer cross-talk, applied in display-linear. */
  matrix: Mat3;
  /** Characteristic curve, per channel, over 0..1 display-referred. */
  curves: {
    master: CurvePoint[];
    red: CurvePoint[];
    green: CurvePoint[];
    blue: CurvePoint[];
  };
  /** Chroma multiplier the stock applies. */
  saturation: number;
  /** Subtractive density baked into the stock. */
  density: number;
  /** Split tone, as display-linear RGB offsets. */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];

  /** Defaults the UI loads alongside the stock; the user can override them. */
  grain: { amount: number; size: number; shadowBias: number; chroma: number };
  halation: { threshold: number; radius: number; strength: number; tint: [number, number, number] };
}

const LINEAR: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** A gentle S-curve; `toe` lifts or crushes the black, `shoulder` rolls the white. */
function sCurve(toe: number, shoulder: number, contrast = 0.06): CurvePoint[] {
  return [
    { x: 0, y: toe },
    { x: 0.25, y: 0.25 - contrast },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.75 + contrast * 0.8 },
    { x: 1, y: shoulder },
  ];
}

export const FILM_STOCKS: FilmStock[] = [
  {
    id: 'none',
    label: 'None',
    maker: '',
    character: 'No emulation.',
    matrix: IDENTITY_MAT,
    curves: { master: LINEAR, red: LINEAR, green: LINEAR, blue: LINEAR },
    saturation: 1,
    density: 0,
    shadowTint: [0, 0, 0],
    highlightTint: [0, 0, 0],
    grain: { amount: 0, size: 1.5, shadowBias: 0.5, chroma: 0.3 },
    halation: { threshold: 0.75, radius: 16, strength: 0, tint: [1, 0.4, 0.2] },
  },
  {
    id: 'kodachrome64',
    label: 'Kodachrome 64',
    maker: 'Kodak',
    character: 'Dense reds, cool blue shadows, near-black blacks. The 1970s National Geographic look.',
    matrix: [
      1.09, -0.06, -0.03,
      -0.05, 1.04, 0.01,
      -0.02, -0.08, 1.10,
    ],
    curves: {
      master: sCurve(0.004, 0.985, 0.075),
      red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.525 }, { x: 1, y: 1 }],
      green: LINEAR,
      blue: [{ x: 0, y: 0.012 }, { x: 0.5, y: 0.482 }, { x: 1, y: 0.985 }],
    },
    saturation: 1.14,
    density: 0.28,
    shadowTint: [-0.006, -0.002, 0.016],
    highlightTint: [0.012, 0.004, -0.008],
    grain: { amount: 0.18, size: 1.2, shadowBias: 0.55, chroma: 0.2 },
    halation: { threshold: 0.8, radius: 12, strength: 0.18, tint: [1, 0.32, 0.14] },
  },
  {
    id: 'portra400',
    label: 'Portra 400',
    maker: 'Kodak',
    character: 'The portrait standard. Creamy skin, low contrast, forgiving highlights.',
    matrix: [
      1.02, 0.01, -0.03,
      -0.01, 1.01, 0.00,
      -0.01, -0.03, 1.04,
    ],
    curves: {
      master: sCurve(0.022, 0.96, 0.028),
      red: [{ x: 0, y: 0.016 }, { x: 0.5, y: 0.512 }, { x: 1, y: 0.97 }],
      green: [{ x: 0, y: 0.014 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.965 }],
      blue: [{ x: 0, y: 0.02 }, { x: 0.5, y: 0.492 }, { x: 1, y: 0.955 }],
    },
    saturation: 0.94,
    density: 0.16,
    shadowTint: [0.008, 0.004, 0.006],
    highlightTint: [0.014, 0.008, -0.004],
    grain: { amount: 0.22, size: 1.5, shadowBias: 0.6, chroma: 0.3 },
    halation: { threshold: 0.7, radius: 20, strength: 0.28, tint: [1, 0.38, 0.18] },
  },
  {
    id: 'portra800',
    label: 'Portra 800',
    maker: 'Kodak',
    character: 'Portra pushed. Warmer, grainier, holds up under tungsten.',
    matrix: [
      1.04, 0.00, -0.04,
      -0.01, 1.02, -0.01,
      -0.02, -0.04, 1.06,
    ],
    curves: {
      master: sCurve(0.03, 0.955, 0.036),
      red: [{ x: 0, y: 0.022 }, { x: 0.5, y: 0.522 }, { x: 1, y: 0.975 }],
      green: [{ x: 0, y: 0.018 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.96 }],
      blue: [{ x: 0, y: 0.028 }, { x: 0.5, y: 0.486 }, { x: 1, y: 0.945 }],
    },
    saturation: 0.98,
    density: 0.2,
    shadowTint: [0.012, 0.004, 0.004],
    highlightTint: [0.018, 0.008, -0.006],
    grain: { amount: 0.4, size: 2.0, shadowBias: 0.62, chroma: 0.4 },
    halation: { threshold: 0.66, radius: 24, strength: 0.34, tint: [1, 0.36, 0.16] },
  },
  {
    id: 'ektar100',
    label: 'Ektar 100',
    maker: 'Kodak',
    character: 'The most saturated colour negative made. Punchy blues, fine grain.',
    matrix: [
      1.12, -0.08, -0.04,
      -0.06, 1.09, -0.03,
      -0.03, -0.09, 1.12,
    ],
    curves: {
      master: sCurve(0.006, 0.99, 0.062),
      red: LINEAR,
      green: LINEAR,
      blue: [{ x: 0, y: 0 }, { x: 0.5, y: 0.508 }, { x: 1, y: 1 }],
    },
    saturation: 1.2,
    density: 0.24,
    shadowTint: [-0.004, 0, 0.01],
    highlightTint: [0.004, 0.004, 0.006],
    grain: { amount: 0.12, size: 1.1, shadowBias: 0.5, chroma: 0.22 },
    halation: { threshold: 0.78, radius: 14, strength: 0.2, tint: [1, 0.34, 0.15] },
  },
  {
    id: 'vision3_250d',
    label: 'Vision3 250D',
    maker: 'Kodak',
    character: 'Modern daylight motion picture negative. Neutral, huge latitude.',
    matrix: [
      1.03, -0.01, -0.02,
      -0.02, 1.03, -0.01,
      -0.01, -0.03, 1.04,
    ],
    curves: {
      master: sCurve(0.014, 0.972, 0.03),
      red: LINEAR,
      green: LINEAR,
      blue: [{ x: 0, y: 0.008 }, { x: 0.5, y: 0.498 }, { x: 1, y: 0.98 }],
    },
    saturation: 1.02,
    density: 0.14,
    shadowTint: [0.002, 0.004, 0.008],
    highlightTint: [0.008, 0.006, 0],
    grain: { amount: 0.2, size: 1.4, shadowBias: 0.58, chroma: 0.3 },
    halation: { threshold: 0.72, radius: 18, strength: 0.3, tint: [1, 0.38, 0.18] },
  },
  {
    id: 'vision3_500t',
    label: 'Vision3 500T',
    maker: 'Kodak',
    character: 'Tungsten-balanced night stock. Cool shadows, warm practicals, visible halation.',
    matrix: [
      1.02, 0.01, -0.03,
      -0.02, 1.02, 0.00,
      0.00, -0.05, 1.05,
    ],
    curves: {
      master: sCurve(0.028, 0.96, 0.034),
      red: [{ x: 0, y: 0.014 }, { x: 0.5, y: 0.508 }, { x: 1, y: 0.972 }],
      green: LINEAR,
      blue: [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.504 }, { x: 1, y: 0.968 }],
    },
    saturation: 0.99,
    density: 0.18,
    shadowTint: [-0.004, 0.002, 0.018],
    highlightTint: [0.02, 0.008, -0.008],
    grain: { amount: 0.45, size: 2.1, shadowBias: 0.68, chroma: 0.45 },
    halation: { threshold: 0.6, radius: 28, strength: 0.5, tint: [1, 0.3, 0.12] },
  },
  {
    id: 'fuji_eterna',
    label: 'Eterna 250D',
    maker: 'Fujifilm',
    character: 'Low contrast, muted, green-leaning. The classic soft cinema palette.',
    matrix: [
      0.99, 0.03, -0.02,
      -0.01, 1.02, -0.01,
      -0.01, 0.01, 1.00,
    ],
    curves: {
      master: sCurve(0.038, 0.93, 0.012),
      red: [{ x: 0, y: 0.026 }, { x: 0.5, y: 0.49 }, { x: 1, y: 0.935 }],
      green: [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.505 }, { x: 1, y: 0.945 }],
      blue: [{ x: 0, y: 0.034 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.93 }],
    },
    saturation: 0.86,
    density: 0.1,
    shadowTint: [0, 0.008, 0.006],
    highlightTint: [0.004, 0.008, 0.004],
    grain: { amount: 0.16, size: 1.5, shadowBias: 0.55, chroma: 0.28 },
    halation: { threshold: 0.74, radius: 16, strength: 0.22, tint: [1, 0.42, 0.24] },
  },
  {
    id: 'fuji_velvia50',
    label: 'Velvia 50',
    maker: 'Fujifilm',
    character: 'Landscape slide film. Extreme saturation, deep greens, crushed shadows.',
    matrix: [
      1.16, -0.12, -0.04,
      -0.08, 1.16, -0.08,
      -0.04, -0.10, 1.14,
    ],
    curves: {
      master: sCurve(0, 0.995, 0.095),
      red: LINEAR,
      green: [{ x: 0, y: 0 }, { x: 0.5, y: 0.512 }, { x: 1, y: 1 }],
      blue: [{ x: 0, y: 0 }, { x: 0.5, y: 0.496 }, { x: 1, y: 0.995 }],
    },
    saturation: 1.34,
    density: 0.36,
    shadowTint: [-0.008, 0, 0.004],
    highlightTint: [0, 0.004, 0],
    grain: { amount: 0.1, size: 1.0, shadowBias: 0.45, chroma: 0.18 },
    halation: { threshold: 0.82, radius: 10, strength: 0.14, tint: [1, 0.36, 0.18] },
  },
  {
    id: 'fuji_pro400h',
    label: 'Pro 400H',
    maker: 'Fujifilm',
    character: 'Airy pastels and mint-green shadows. The wedding film.',
    matrix: [
      1.00, 0.02, -0.02,
      -0.02, 1.03, -0.01,
      -0.01, 0.00, 1.01,
    ],
    curves: {
      master: sCurve(0.042, 0.94, 0.016),
      red: [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.494 }, { x: 1, y: 0.945 }],
      green: [{ x: 0, y: 0.036 }, { x: 0.5, y: 0.506 }, { x: 1, y: 0.95 }],
      blue: [{ x: 0, y: 0.04 }, { x: 0.5, y: 0.508 }, { x: 1, y: 0.955 }],
    },
    saturation: 0.9,
    density: 0.08,
    shadowTint: [0, 0.01, 0.008],
    highlightTint: [0.006, 0.01, 0.008],
    grain: { amount: 0.24, size: 1.7, shadowBias: 0.6, chroma: 0.34 },
    halation: { threshold: 0.68, radius: 22, strength: 0.26, tint: [1, 0.44, 0.26] },
  },
  {
    id: 'cinestill800t',
    label: 'CineStill 800T',
    maker: 'CineStill',
    character: 'Vision3 500T with the remjet removed, so highlights bloom red. Neon nights.',
    matrix: [
      1.03, 0.01, -0.04,
      -0.02, 1.02, 0.00,
      0.00, -0.06, 1.06,
    ],
    curves: {
      master: sCurve(0.032, 0.955, 0.04),
      red: [{ x: 0, y: 0.018 }, { x: 0.5, y: 0.514 }, { x: 1, y: 0.978 }],
      green: LINEAR,
      blue: [{ x: 0, y: 0.034 }, { x: 0.5, y: 0.508 }, { x: 1, y: 0.972 }],
    },
    saturation: 1.04,
    density: 0.2,
    shadowTint: [-0.006, 0.002, 0.024],
    highlightTint: [0.028, 0.006, -0.01],
    grain: { amount: 0.42, size: 2.0, shadowBias: 0.66, chroma: 0.42 },
    // The signature: no anti-halation backing, so this is deliberately extreme.
    halation: { threshold: 0.5, radius: 42, strength: 0.85, tint: [1, 0.22, 0.08] },
  },
  {
    id: 'cinestill50d',
    label: 'CineStill 50D',
    maker: 'CineStill',
    character: 'Fine-grained daylight sibling. Clean, with the same red highlight bloom.',
    matrix: [
      1.04, -0.01, -0.03,
      -0.02, 1.04, -0.02,
      -0.01, -0.04, 1.05,
    ],
    curves: {
      master: sCurve(0.012, 0.975, 0.042),
      red: LINEAR,
      green: LINEAR,
      blue: [{ x: 0, y: 0.01 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.985 }],
    },
    saturation: 1.06,
    density: 0.18,
    shadowTint: [0, 0.002, 0.012],
    highlightTint: [0.02, 0.006, -0.006],
    grain: { amount: 0.14, size: 1.2, shadowBias: 0.5, chroma: 0.24 },
    halation: { threshold: 0.58, radius: 34, strength: 0.6, tint: [1, 0.24, 0.1] },
  },
  {
    id: 'agfa_vista',
    label: 'Vista 200',
    maker: 'Agfa',
    character: 'Cheap consumer negative. Bright reds, slightly plastic, very likeable.',
    matrix: [
      1.08, -0.02, -0.06,
      -0.03, 1.04, -0.01,
      -0.02, -0.04, 1.06,
    ],
    curves: {
      master: sCurve(0.016, 0.97, 0.05),
      red: [{ x: 0, y: 0.008 }, { x: 0.5, y: 0.528 }, { x: 1, y: 0.985 }],
      green: LINEAR,
      blue: [{ x: 0, y: 0.018 }, { x: 0.5, y: 0.494 }, { x: 1, y: 0.97 }],
    },
    saturation: 1.12,
    density: 0.2,
    shadowTint: [0.006, 0, 0.01],
    highlightTint: [0.014, 0.004, 0],
    grain: { amount: 0.3, size: 1.8, shadowBias: 0.6, chroma: 0.38 },
    halation: { threshold: 0.7, radius: 20, strength: 0.3, tint: [1, 0.36, 0.16] },
  },
  {
    id: 'ilford_hp5',
    label: 'HP5 Plus 400',
    maker: 'Ilford',
    character: 'Black and white. Wide latitude, prominent grain, soft shoulder.',
    matrix: [
      0.299, 0.587, 0.114,
      0.299, 0.587, 0.114,
      0.299, 0.587, 0.114,
    ],
    curves: {
      master: sCurve(0.026, 0.955, 0.04),
      red: LINEAR,
      green: LINEAR,
      blue: LINEAR,
    },
    saturation: 0,
    density: 0.12,
    shadowTint: [0, 0, 0],
    highlightTint: [0, 0, 0],
    grain: { amount: 0.5, size: 2.2, shadowBias: 0.55, chroma: 0 },
    halation: { threshold: 0.76, radius: 16, strength: 0.16, tint: [1, 1, 1] },
  },
  {
    id: 'trix400',
    label: 'Tri-X 400',
    maker: 'Kodak',
    character: 'Black and white with more bite than HP5. Deep blacks, gritty grain.',
    matrix: [
      0.26, 0.60, 0.14,
      0.26, 0.60, 0.14,
      0.26, 0.60, 0.14,
    ],
    curves: {
      master: sCurve(0.008, 0.985, 0.07),
      red: LINEAR,
      green: LINEAR,
      blue: LINEAR,
    },
    saturation: 0,
    density: 0.22,
    shadowTint: [0, 0, 0],
    highlightTint: [0, 0, 0],
    grain: { amount: 0.62, size: 2.4, shadowBias: 0.6, chroma: 0 },
    halation: { threshold: 0.78, radius: 14, strength: 0.14, tint: [1, 1, 1] },
  },
];

export const FILM_STOCK_BY_ID: Record<FilmStockId, FilmStock> = Object.fromEntries(
  FILM_STOCKS.map((s) => [s.id, s]),
) as Record<FilmStockId, FilmStock>;

export function getStock(id: FilmStockId): FilmStock {
  return FILM_STOCK_BY_ID[id] ?? FILM_STOCK_BY_ID.none;
}
