import { useEffect, useRef, useState } from 'react';
import { FaceTracker, applyTrackToWindow } from '@easycolor/core';
import type { TrackState } from '@easycolor/core';
import type { GradeStore } from '../state/store.js';
import type { RendererApi } from './useRenderer.js';

/**
 * Drives a power window from the face tracker.
 *
 * Runs at ~8Hz on a 320-wide frame — tracking is statistics, not detail, and
 * at that size a full update is well under a millisecond, so it never
 * competes with the render loop for the frame budget.
 *
 * Geometry updates go through the store with a single merge key, so an
 * entire tracking session coalesces into one history entry — the same
 * contract as a long manual drag. The frame it tracks from is the *base*
 * image, before windows apply, so the window's own correction can never
 * feed back into the thing it is tracking.
 */

export interface FaceTrackingApi {
  /** null when not tracking anything. */
  state: TrackState | null;
}

interface Options {
  renderer: RendererApi;
  store: GradeStore;
  /** The window being driven, or null to stop. */
  windowId: string | null;
  /** Called when the window disappears (deleted) so the owner can clear it. */
  onWindowGone: () => void;
}

const INTERVAL_MS = 120;
const FRAME_WIDTH = 320;

export function useFaceTracking({ renderer, store, windowId, onWindowGone }: Options): FaceTrackingApi {
  const [state, setState] = useState<TrackState | null>(null);
  const trackerRef = useRef<FaceTracker | null>(null);

  useEffect(() => {
    if (!windowId) {
      setState(null);
      return;
    }

    const tracker = new FaceTracker();
    trackerRef.current = tracker;
    setState('lost');

    const tick = () => {
      const grade = store.getGrade();
      if (!grade.windows.some((w) => w.id === windowId)) {
        onWindowGone();
        return;
      }

      const frame = renderer.renderer?.renderSize.width
        ? renderer.renderer.grabScopeFrame(FRAME_WIDTH, 'base')
        : null;
      if (!frame) {
        setState('lost');
        return;
      }

      const result = tracker.update(frame, grade.skin);
      setState(result.state);
      if (!result.ellipse) return;

      const ellipse = result.ellipse;
      store.update(
        (g) => {
          const index = g.windows.findIndex((w) => w.id === windowId);
          if (index < 0) return g;
          const windows = [...g.windows];
          windows[index] = applyTrackToWindow(windows[index], ellipse);
          return { ...g, windows };
        },
        'Track face',
        `track:${windowId}`,
      );
    };

    tick();
    const id = window.setInterval(tick, INTERVAL_MS);

    return () => {
      window.clearInterval(id);
      trackerRef.current = null;
      // Ending a tracking session closes its history entry, exactly as
      // releasing the pointer closes a drag.
      store.commit();
    };
  }, [windowId, renderer, store, onWindowGone]);

  return { state };
}
