/**
 * One-click looks.
 *
 * Each preset is a partial grade merged over whatever is already there, so
 * applying a look keeps the camera conversion and exposure work you have
 * already done rather than resetting the shot. That is the difference
 * between a look you can start from and a look you have to undo.
 */

import type { GradeState } from './grade.js';
import { cloneGrade } from './grade.js';

export interface LookPreset {
  id: string;
  label: string;
  group: 'Cinematic' | 'Film' | 'Documentary' | 'Stylised';
  description: string;
  apply(grade: GradeState): GradeState;
}

function withPrimaries(g: GradeState, p: Partial<GradeState['primaries']>): GradeState {
  const next = cloneGrade(g);
  next.primaries = { ...next.primaries, ...p };
  return next;
}

export const LOOK_PRESETS: LookPreset[] = [
  {
    id: 'neutral',
    label: 'Reset look',
    group: 'Cinematic',
    description: 'Clears the creative grade. Keeps the camera conversion and exposure.',
    apply: (g) => {
      const base = cloneGrade(g);
      const fresh = cloneGrade(g);
      fresh.primaries = {
        ...fresh.primaries,
        contrast: 0,
        saturation: 1,
        vibrance: 0,
        highlights: 0,
        shadows: 0,
        temperature: 0,
        tint: 0,
      };
      fresh.wheels = {
        lift: { r: 0, g: 0, b: 0, luma: 0 },
        gamma: { r: 0, g: 0, b: 0, luma: 0 },
        gain: { r: 0, g: 0, b: 0, luma: 0 },
        offset: { r: 0, g: 0, b: 0, luma: 0 },
      };
      fresh.zones = [];
      fresh.film = { ...fresh.film, stock: 'none', density: 0 };
      // Exposure and the camera conversion are deliberately carried over.
      fresh.primaries.exposure = base.primaries.exposure;
      fresh.source = base.source;
      return fresh;
    },
  },
  {
    id: 'teal-orange',
    label: 'Teal & Orange',
    group: 'Cinematic',
    description: 'Cool shadows, warm skin. The blockbuster default, applied with restraint.',
    apply: (g) => {
      const next = withPrimaries(g, { contrast: 0.14, saturation: 1.04 });
      next.wheels = {
        ...next.wheels,
        lift: { r: -0.05, g: 0.0, b: 0.09, luma: 0.01 },
        gain: { r: 0.06, g: 0.01, b: -0.05, luma: 0 },
      };
      return next;
    },
  },
  {
    id: 'bleach-bypass',
    label: 'Bleach Bypass',
    group: 'Stylised',
    description: 'Silver retained in the print: high contrast, low saturation, harsh highlights.',
    apply: (g) => {
      const next = withPrimaries(g, { contrast: 0.42, saturation: 0.52, highlights: 0.18 });
      next.film = { ...next.film, density: 0.1 };
      return next;
    },
  },
  {
    id: 'day-for-night',
    label: 'Day for Night',
    group: 'Stylised',
    description: 'Underexposed and blue-shifted, with highlights held back from clipping.',
    apply: (g) => {
      const next = withPrimaries(g, {
        exposure: g.primaries.exposure - 1.4,
        temperature: -0.42,
        contrast: 0.2,
        saturation: 0.78,
        highlights: -0.3,
      });
      next.wheels = { ...next.wheels, lift: { r: -0.03, g: 0.0, b: 0.07, luma: -0.02 } };
      return next;
    },
  },
  {
    id: 'faded-print',
    label: 'Faded Print',
    group: 'Film',
    description: 'Lifted blacks and rolled highlights, like a release print left in the sun.',
    apply: (g) => {
      const next = withPrimaries(g, { contrast: -0.08, saturation: 0.86 });
      next.wheels = {
        ...next.wheels,
        lift: { r: 0.05, g: 0.03, b: 0.04, luma: 0.06 },
        gain: { r: 0, g: 0, b: 0, luma: -0.05 },
      };
      next.curves = {
        ...next.curves,
        master: [
          { x: 0, y: 0.06 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 0.94 },
        ],
      };
      return next;
    },
  },
  {
    id: 'clean-doc',
    label: 'Clean Documentary',
    group: 'Documentary',
    description: 'Honest colour with a little shape. Nothing you would have to defend in a grade review.',
    apply: (g) => withPrimaries(g, { contrast: 0.1, saturation: 1.02, vibrance: 0.12, shadows: 0.04 }),
  },
  {
    id: 'warm-portrait',
    label: 'Warm Portrait',
    group: 'Documentary',
    description: 'Gentle warmth and a softer top end, tuned for faces.',
    apply: (g) => {
      const next = withPrimaries(g, {
        temperature: 0.12,
        contrast: 0.06,
        vibrance: 0.16,
        highlights: -0.12,
      });
      next.skin = { ...next.skin, enabled: true, satGain: 1.04 };
      return next;
    },
  },
  {
    id: 'night-neon',
    label: 'Neon Night',
    group: 'Stylised',
    description: 'Deep blacks, saturated practicals, and the halation to sell them.',
    apply: (g) => {
      const next = withPrimaries(g, { contrast: 0.24, saturation: 1.18, shadows: -0.12 });
      next.film = {
        ...next.film,
        stock: 'cinestill800t',
        stockIntensity: 0.75,
        halation: { ...next.film.halation, enabled: true, threshold: 0.55, radius: 34, strength: 0.6 },
        grain: { ...next.film.grain, enabled: true, amount: 0.3 },
      };
      return next;
    },
  },
];

export const LOOK_PRESET_BY_ID = Object.fromEntries(LOOK_PRESETS.map((p) => [p.id, p]));
