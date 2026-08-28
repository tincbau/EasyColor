/**
 * Face tracking by skin-cluster analysis.
 *
 * Classical machine vision, not a neural detector, and that is a considered
 * choice rather than a shortcut: a model would need megabytes of weights
 * fetched at runtime, which the sandboxed preview blocks outright and the
 * offline desktop build cannot assume. This tracker instead builds on the
 * skin qualifier the app already has — the same Oklab windows the skin
 * panel measures with — so tuning the qualifier for a subject ("Pick skin
 * from image") tunes the tracker with it.
 *
 * The pipeline per frame:
 *
 *   1. Skin-probability map — the qualifier evaluated per pixel.
 *   2. Connected components over the thresholded map, because a frame
 *      usually contains more skin than the face: hands, arms, a second
 *      person. Components make them separable.
 *   3. Component choice — by mass, biased hard toward the component nearest
 *      the previous track, so a hand entering frame does not steal the
 *      window off the face it was placed on.
 *   4. Moment-based ellipse fit — weighted centroid and covariance; the
 *      eigenvectors give the axes and orientation. For a uniform elliptical
 *      blob the semi-axis is exactly 2·√eigenvalue, so the fit is not a
 *      heuristic, it is the shape's own geometry.
 *   5. Temporal smoothing — exponential, with the ellipse angle wrapped on
 *      its 180° period, and a grace period of missed frames before the
 *      track is declared lost, so one bad frame does not snap the window
 *      away.
 *
 * Honest limits, stated rather than discovered: it tracks the dominant
 * skin-coloured region, so it wants one clear face; it can be pulled by
 * large hands near the face; and heavy colour casts need the qualifier
 * re-picked before it can see skin at all.
 */

import type { FramePixels } from '../scopes/compute.js';
import type { PowerWindow, SkinSettings } from '../state/grade.js';
import { skinWeight, toLch } from '../interaction/qualifier.js';

export interface FaceEllipse {
  /** Centre, normalised 0..1, y down. */
  cx: number;
  cy: number;
  /** Semi-axes in units of frame *height* — the power window convention. */
  rx: number;
  ry: number;
  /** Major-axis angle in degrees, same convention as PowerWindow.rotation. */
  rotation: number;
  /** Fraction of qualified mass in the chosen component, 0..1-ish. */
  confidence: number;
}

export interface DetectOptions {
  /** Skip pixels for speed; 1 at scope-frame sizes is already cheap. */
  stride?: number;
  /** Qualifier weight below this is background. */
  threshold?: number;
  /** Minimum weighted mass (in sampled pixels) for a usable component. */
  minMass?: number;
  /** Grow the fitted ellipse by this factor — a face is bigger than its skin. */
  padding?: number;
  /** Previous centre in normalised coords, to bias component choice. */
  near?: { cx: number; cy: number } | null;
}

/**
 * Plausibility gates — the difference between a tracker and a smear.
 *
 * On real footage the qualifier accepts more than faces: wood, sand, walls,
 * hair. Without gates, all of it merges into one sprawling component, the
 * moment fit wraps a frame-sized ellipse around it, and the window becomes
 * a gradient smeared across the whole image. Every candidate fit has to
 * *look like a face region* before it is allowed to drive anything:
 *
 * - not too large — an ellipse covering a third of the frame is a wall;
 * - not too elongated — a 10:1 blob is an arm or a strip of panelling;
 * - dense — a face fills its own fitted ellipse, while a straggle of
 *   background warm tones bridged together does not.
 *
 * A fit that fails is skipped in favour of the next candidate, and when no
 * candidate passes the answer is honestly "no face", which the tracker
 * turns into searching — never into applying the implausible thing.
 */
const MAX_AREA_FRACTION = 0.28;
const MAX_MAJOR_FRACTION = 0.95;
const MAX_ASPECT = 8;
const MIN_FILL_RATIO = 0.3;

/**
 * Detect the best face-candidate ellipse in one frame.
 * Returns null when nothing passes the mass threshold.
 */
export function detectFace(
  frame: FramePixels,
  skin: SkinSettings,
  options: DetectOptions = {},
): FaceEllipse | null {
  const stride = Math.max(1, options.stride ?? 1);
  const threshold = options.threshold ?? 0.45;
  const minMass = options.minMass ?? 60;
  const padding = options.padding ?? 1.45;

  const { data, width, height } = frame;
  const gw = Math.floor(width / stride);
  const gh = Math.floor(height / stride);
  if (gw < 2 || gh < 2) return null;

  // Qualify with the panel's settings whether or not corrections are
  // enabled — the tracker is a consumer of the qualifier, not of the grade.
  const probe: SkinSettings = { ...skin, enabled: true, strength: 1 };

  /* ---- 1. skin-probability map ---- */

  const weights = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y = gy * stride;
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * stride;
      const i = (y * width + x) * 4;
      const w = skinWeight(probe, toLch([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]));
      if (w > threshold) weights[gy * gw + gx] = w;
    }
  }

  /* ---- 1b. one erosion pass ----
     Kills isolated speckle and, more importantly, the one-cell bridges
     through which a face merges with a warm background into a single
     sprawling component. The weights themselves are kept — erosion only
     decides membership. */

  const eroded = new Float32Array(gw * gh);
  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const p = gy * gw + gx;
      if (
        weights[p] > 0 &&
        weights[p - 1] > 0 &&
        weights[p + 1] > 0 &&
        weights[p - gw] > 0 &&
        weights[p + gw] > 0
      ) {
        eroded[p] = weights[p];
      }
    }
  }

  /* ---- 2. connected components (4-neighbour flood fill) ---- */

  const labels = new Int32Array(gw * gh).fill(-1);
  interface Component {
    mass: number;
    sx: number;
    sy: number;
  }
  const components: Component[] = [];
  const stack: number[] = [];

  for (let seed = 0; seed < eroded.length; seed++) {
    if (eroded[seed] === 0 || labels[seed] !== -1) continue;

    const label = components.length;
    const component: Component = { mass: 0, sx: 0, sy: 0 };
    components.push(component);

    stack.length = 0;
    stack.push(seed);
    labels[seed] = label;

    while (stack.length > 0) {
      const p = stack.pop()!;
      const w = eroded[p];
      const px = p % gw;
      const py = (p / gw) | 0;

      component.mass += w;
      component.sx += w * px;
      component.sy += w * py;

      if (px > 0 && eroded[p - 1] > 0 && labels[p - 1] === -1) { labels[p - 1] = label; stack.push(p - 1); }
      if (px < gw - 1 && eroded[p + 1] > 0 && labels[p + 1] === -1) { labels[p + 1] = label; stack.push(p + 1); }
      if (py > 0 && eroded[p - gw] > 0 && labels[p - gw] === -1) { labels[p - gw] = label; stack.push(p - gw); }
      if (py < gh - 1 && eroded[p + gw] > 0 && labels[p + gw] === -1) { labels[p + gw] = label; stack.push(p + gw); }
    }
  }

  if (components.length === 0) return null;

  /* ---- 3. rank the candidates ---- */

  let totalMass = 0;
  for (const c of components) totalMass += c.mass;

  const ranked = components
    .map((c, index) => {
      if (c.mass < minMass) return null;
      let score = c.mass;
      if (options.near) {
        // Continuity beats size: a component near the previous track is
        // worth several times its mass, so a hand entering frame has to be
        // much larger than the face before it can steal the window.
        const ccx = c.sx / c.mass / gw;
        const ccy = c.sy / c.mass / gh;
        const d = Math.hypot(ccx - options.near.cx, ccy - options.near.cy);
        score *= 1 + 4 * Math.max(0, 1 - d / 0.35);
      }
      return { index, score, component: c };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  /* ---- 4. fit candidates in order; the first plausible one wins ---- */

  for (const candidate of ranked) {
    const chosen = candidate.component;
    const bestIndex = candidate.index;
    const mcx = chosen.sx / chosen.mass;
    const mcy = chosen.sy / chosen.mass;

    let cxx = 0;
    let cyy = 0;
    let cxy = 0;
    for (let p = 0; p < eroded.length; p++) {
      if (labels[p] !== bestIndex) continue;
      const w = eroded[p];
      const dx = (p % gw) - mcx;
      const dy = ((p / gw) | 0) - mcy;
      cxx += w * dx * dx;
      cyy += w * dy * dy;
      cxy += w * dx * dy;
    }
    cxx /= chosen.mass;
    cyy /= chosen.mass;
    cxy /= chosen.mass;

    // Eigen-decomposition of the 2x2 covariance, closed form.
    const mean = (cxx + cyy) / 2;
    const diff = (cxx - cyy) / 2;
    const spread = Math.hypot(diff, cxy);
    const l1 = Math.max(mean + spread, 1e-6);
    const l2 = Math.max(mean - spread, 1e-6);
    const angle = (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI;

    // Semi-axes in grid cells: exact for a uniform ellipse (a = 2√λ).
    const a1 = 2 * Math.sqrt(l1);
    const a2 = 2 * Math.sqrt(l2);

    /* ---- the plausibility gates ---- */

    if (Math.PI * a1 * a2 > MAX_AREA_FRACTION * gw * gh) continue;
    if (2 * a1 > MAX_MAJOR_FRACTION * gh && 2 * a1 > MAX_MAJOR_FRACTION * gw) continue;
    if (a1 / a2 > MAX_ASPECT) continue;
    // A face fills its fitted ellipse; a straggle of bridged background
    // does not. Mass is Σweight over member cells, so mass over ellipse
    // area is exactly the fill ratio.
    if (chosen.mass / (Math.PI * a1 * a2) < MIN_FILL_RATIO) continue;

    const major = a1 * padding;
    const minor = a2 * padding;

    return {
      cx: (mcx * stride + stride / 2) / width,
      cy: (mcy * stride + stride / 2) / height,
      rx: (major * stride) / height,
      ry: (minor * stride) / height,
      rotation: angle,
      confidence: totalMass > 0 ? chosen.mass / totalMass : 0,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Temporal tracking                                                   */
/* ------------------------------------------------------------------ */

export interface TrackerOptions {
  /** EMA factor for position, 0..1 — higher follows faster. */
  followPosition?: number;
  /** EMA factor for size and rotation, kept slower than position. */
  followShape?: number;
  /** Detections to miss before the track is declared lost. */
  graceFrames?: number;
  detect?: DetectOptions;
}

export type TrackState = 'tracking' | 'coasting' | 'lost';

export interface TrackResult {
  state: TrackState;
  ellipse: FaceEllipse | null;
}

export class FaceTracker {
  private smoothed: FaceEllipse | null = null;
  private misses = 0;

  private readonly followPosition: number;
  private readonly followShape: number;
  private readonly graceFrames: number;
  private readonly detectOptions: DetectOptions;

  constructor(options: TrackerOptions = {}) {
    this.followPosition = options.followPosition ?? 0.4;
    this.followShape = options.followShape ?? 0.25;
    this.graceFrames = options.graceFrames ?? 6;
    this.detectOptions = options.detect ?? {};
  }

  reset(): void {
    this.smoothed = null;
    this.misses = 0;
  }

  update(frame: FramePixels, skin: SkinSettings): TrackResult {
    const detected = detectFace(frame, skin, {
      ...this.detectOptions,
      near: this.smoothed ? { cx: this.smoothed.cx, cy: this.smoothed.cy } : null,
    });

    if (!detected) {
      this.misses++;
      if (this.misses > this.graceFrames || !this.smoothed) {
        this.smoothed = null;
        return { state: 'lost', ellipse: null };
      }
      // Coast on the last good fit: one occluded frame must not snap the
      // window away from where the face was a tenth of a second ago.
      return { state: 'coasting', ellipse: this.smoothed };
    }

    this.misses = 0;

    if (!this.smoothed) {
      this.smoothed = detected;
    } else {
      const a = this.followPosition;
      const b = this.followShape;
      this.smoothed = {
        cx: lerp(this.smoothed.cx, detected.cx, a),
        cy: lerp(this.smoothed.cy, detected.cy, a),
        rx: lerp(this.smoothed.rx, detected.rx, b),
        ry: lerp(this.smoothed.ry, detected.ry, b),
        // The ellipse angle repeats every 180°, so the blend has to take
        // the short way round or a fit hopping between +89° and -89° spins
        // the window through a half turn.
        rotation: this.smoothed.rotation + wrap180(detected.rotation - this.smoothed.rotation) * b,
        confidence: detected.confidence,
      };
    }

    return { state: 'tracking', ellipse: this.smoothed };
  }
}

/** Apply a track to a power window, leaving its correction untouched. */
export function applyTrackToWindow(window: PowerWindow, ellipse: FaceEllipse): PowerWindow {
  return {
    ...window,
    cx: ellipse.cx,
    cy: ellipse.cy,
    // 0.8 of frame height as the ceiling, not the geometry-legal 3: the
    // detection gates should never let anything that large through, but a
    // window driven by a tracker must be incapable of becoming a full-frame
    // gradient even if they somehow do.
    rx: Math.min(0.8, Math.max(0.02, ellipse.rx)),
    ry: Math.min(0.8, Math.max(0.02, ellipse.ry)),
    rotation: ellipse.rotation,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrap180(deg: number): number {
  let d = ((deg + 90) % 180 + 180) % 180 - 90;
  if (d === -90) d = 90;
  return d;
}
