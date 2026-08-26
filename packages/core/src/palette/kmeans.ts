/**
 * Palette extraction by k-means in Oklab.
 *
 * Clustering in Oklab rather than RGB is what makes the result look like a
 * palette a person would pick: distances are perceptual, so two blues that
 * look the same end up in the same cluster even when their RGB values are
 * far apart, and a small but vivid accent colour survives instead of being
 * swallowed by a large dull one.
 *
 * Initialisation is k-means++, which matters here — random seeding on an
 * image with a dominant background regularly produces a palette where three
 * of five swatches are the same wall.
 */

import { linearToOklab, linearToSrgb, oklabToLinear, srgbToLinear } from '../color/space.js';
import type { FramePixels } from '../scopes/compute.js';

export interface Swatch {
  /** Display-referred sRGB, 0..1. */
  rgb: [number, number, number];
  lab: [number, number, number];
  /** Share of sampled pixels in this cluster, 0..1. */
  weight: number;
}

export interface PaletteOptions {
  /** Number of swatches. Five reads well and clusters reliably. */
  count?: number;
  /** Sample every nth pixel. */
  stride?: number;
  maxIterations?: number;
  /** Ignore near-black and near-white, which cluster into meaningless greys. */
  ignoreExtremes?: boolean;
  seed?: number;
}

/** Deterministic PRNG, so the same image always yields the same palette. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function labDistanceSq(a: [number, number, number], b: [number, number, number]): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  // Lightness is weighted down: a palette should group by colour first, or
  // every image resolves into "dark thing, mid thing, light thing".
  return dl * dl * 0.35 + da * da + db * db;
}

export function extractPalette(frame: FramePixels, options: PaletteOptions = {}): Swatch[] {
  const count = Math.max(1, options.count ?? 5);
  const stride = Math.max(1, options.stride ?? 3);
  const maxIterations = options.maxIterations ?? 24;
  const ignoreExtremes = options.ignoreExtremes ?? true;
  const rand = mulberry32(options.seed ?? 0x5eed);

  const { data, width, height } = frame;
  const points: Array<[number, number, number]> = [];

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;

      if (ignoreExtremes) {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if (mx < 0.04 || mn > 0.97) continue;
      }

      points.push(linearToOklab([srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]));
    }
  }

  if (points.length === 0) return [];
  const k = Math.min(count, points.length);

  /* ---- k-means++ seeding ---- */

  const centroids: Array<[number, number, number]> = [];
  centroids.push([...points[Math.floor(rand() * points.length)]] as [number, number, number]);

  const nearest = new Float64Array(points.length).fill(Infinity);

  for (let c = 1; c < k; c++) {
    let total = 0;
    const last = centroids[c - 1];
    for (let i = 0; i < points.length; i++) {
      const d = labDistanceSq(points[i], last);
      if (d < nearest[i]) nearest[i] = d;
      total += nearest[i];
    }

    // Pick the next seed with probability proportional to its distance from
    // the seeds chosen so far.
    let target = rand() * total;
    let chosen = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      target -= nearest[i];
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push([...points[chosen]] as [number, number, number]);
  }

  /* ---- Lloyd iterations ---- */

  const assignment = new Int32Array(points.length).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false;

    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = labDistanceSq(points[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved = true;
      }
    }

    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assignment[i]];
      s[0] += points[i][0];
      s[1] += points[i][1];
      s[2] += points[i][2];
      s[3] += 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c][3] === 0) continue;
      centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }

    // Converged: no point changed cluster, so further iterations are identical.
    if (!moved) break;
  }

  /* ---- results ---- */

  const counts = new Array(centroids.length).fill(0);
  for (let i = 0; i < points.length; i++) counts[assignment[i]]++;

  const swatches: Swatch[] = centroids.map((lab, c) => {
    const lin = oklabToLinear(lab);
    return {
      lab,
      rgb: [
        clamp01(linearToSrgb(lin[0])),
        clamp01(linearToSrgb(lin[1])),
        clamp01(linearToSrgb(lin[2])),
      ],
      weight: counts[c] / points.length,
    };
  });

  return swatches.filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
