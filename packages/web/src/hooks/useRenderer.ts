import { useCallback, useEffect, useRef, useState } from 'react';
import { GradeRenderer } from '@easycolor/core';
import type { SampledPixel } from '@easycolor/core';
import type { GradeStore } from '../state/store.js';
import type { MediaSource } from './useMedia.js';

/**
 * Owns the GL renderer and the render loop.
 *
 * The loop is demand-driven rather than free-running: it renders when the
 * grade changes, when a video advances, or when animated grain needs a new
 * seed — and otherwise idles. A grading app is a still image most of the
 * time, and a rAF loop that redraws 4K sixty times a second for no reason
 * spins the fans and drains the battery for nothing.
 */

export interface RendererApi {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  renderer: GradeRenderer | null;
  ready: boolean;
  error: string | null;
  /** Force a redraw, e.g. after loading a LUT. */
  invalidate: () => void;
  /** Sample the image under normalised viewer coordinates. */
  sample: (u: number, v: number) => SampledPixel | null;
  /** Downscaled graded frame for scopes and analysis. */
  grabFrame: (maxWidth?: number) => { data: Uint8Array; width: number; height: number } | null;
  /** Frames actually drawn in the last second. */
  fps: number;
}

export function useRenderer(store: GradeStore, media: MediaSource): RendererApi {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GradeRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  const dirtyRef = useRef(true);
  const lastRevisionRef = useRef(-1);
  const lastSourceRef = useRef<unknown>(null);

  const invalidate = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  /* ---- create and destroy the renderer with the canvas ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      rendererRef.current = new GradeRenderer({ canvas });
      setReady(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReady(false);
      return;
    }

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      setReady(false);
    };
  }, []);

  /* ---- upload a new source ---- */

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !media.element) return;

    if (media.kind === 'image') {
      renderer.setSource(media.element);
      lastSourceRef.current = media.element;
      dirtyRef.current = true;
      return;
    }

    if (media.kind === 'video') {
      const video = media.element as HTMLVideoElement;

      // Upload the current frame regardless of playback state. The render
      // loop only re-uploads while the video is *advancing*, so without
      // this a paused video — which is what a video is the moment it
      // loads, and what it is for most of a grading session — never
      // reaches the GPU at all and the viewer stays black.
      const uploadFrame = () => {
        if (video.readyState >= 2) {
          renderer.setSource(video);
          dirtyRef.current = true;
        }
      };

      uploadFrame();
      lastSourceRef.current = video;

      // Seeking while paused produces a new frame with no play event; the
      // pause itself must show the frame it stopped on, not the one from
      // half a second before the click.
      video.addEventListener('seeked', uploadFrame);
      video.addEventListener('loadeddata', uploadFrame);
      video.addEventListener('pause', uploadFrame);
      return () => {
        video.removeEventListener('seeked', uploadFrame);
        video.removeEventListener('loadeddata', uploadFrame);
        video.removeEventListener('pause', uploadFrame);
      };
    }
  }, [media.element, media.kind, ready]);

  /* ---- the loop ---- */

  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let frames = 0;
    let fpsWindowStart = performance.now();
    const start = performance.now();

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      if (!renderer || !canvas) return;

      const grade = store.getGrade();
      const revision = store.getRevision();

      if (revision !== lastRevisionRef.current) {
        lastRevisionRef.current = revision;
        dirtyRef.current = true;
      }

      // A playing video is new pixels every frame; a paused one is not.
      const video = media.kind === 'video' ? (media.element as HTMLVideoElement | null) : null;
      const videoAdvancing = video !== null && !video.paused && !video.ended && video.readyState >= 2;
      if (videoAdvancing) {
        renderer.setSource(video);
        dirtyRef.current = true;
      }

      // Animated grain has to keep moving even on a frozen frame, or it
      // reads as dirt on the sensor rather than grain in the emulsion.
      if (grade.film.grain.enabled && grade.film.grain.animated && videoAdvancing) {
        dirtyRef.current = true;
      }
      // The marching-ants matte contour is animated too.
      if (grade.viewer.overlay === 'zoneMatte' || grade.viewer.overlay === 'windowMatte') {
        dirtyRef.current = true;
      }

      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const size = renderer.renderSize;
      if (size.width > 0 && (canvas.width !== size.width || canvas.height !== size.height)) {
        canvas.width = size.width;
        canvas.height = size.height;
      }

      renderer.render(grade, (performance.now() - start) / 1000);

      frames++;
      const now = performance.now();
      if (now - fpsWindowStart >= 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsWindowStart)));
        frames = 0;
        fpsWindowStart = now;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, store, media.element, media.kind]);

  /* ---- redraw when the store changes, even between frames ---- */

  useEffect(() => store.subscribe(invalidate), [store, invalidate]);

  const sample = useCallback((u: number, v: number): SampledPixel | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    // A patch average, not a single pixel: on grainy footage one pixel gives
    // a different answer every time you click the same thing.
    return renderer.samplePatch(u, v, 3);
  }, []);

  const grabFrame = useCallback((maxWidth = 480) => {
    const renderer = rendererRef.current;
    if (!renderer || renderer.renderSize.width <= 1) return null;
    return renderer.grabScopeFrame(maxWidth);
  }, []);

  return {
    canvasRef,
    renderer: rendererRef.current,
    ready,
    error,
    invalidate,
    sample,
    grabFrame,
    fps,
  };
}
