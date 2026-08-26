import { useCallback, useRef, useState } from 'react';
import type { MediaInfo } from '@easycolor/core';
import { getDesktopBridge } from '../desktop/bridge.js';
import type { RendererApi } from './useRenderer.js';

/**
 * Native clip loading, desktop only.
 *
 * Frames arrive from FFmpeg as 16-bit RGBA and go straight into the GL
 * pipeline. Nothing about this path touches a `<video>` element, which is
 * what makes 10-bit 4:2:2 camera formats openable at all — and what keeps
 * their extra latitude intact instead of letting the browser flatten it to
 * 8-bit Rec.709 on the way in.
 */

export interface DesktopMediaApi {
  info: MediaInfo | null;
  loading: boolean;
  currentTime: number;
  open: (path?: string) => Promise<MediaInfo | null>;
  seek: (timeSeconds: number) => Promise<void>;
  close: () => void;
}

export function useDesktopMedia(
  renderer: RendererApi,
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void,
  onLogTransformSuggested: (id: string, info: MediaInfo) => void,
): DesktopMediaApi {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // A scrub fires far faster than FFmpeg can seek and decode. Rather than
  // queueing every request, keep only the newest one and drop the rest —
  // the intermediate frames are already stale by the time they arrive.
  const inFlight = useRef(false);
  const pending = useRef<number | null>(null);

  const decodeAt = useCallback(
    async (path: string, timeSeconds: number) => {
      const bridge = getDesktopBridge();
      if (!bridge) return;

      if (inFlight.current) {
        pending.current = timeSeconds;
        return;
      }
      inFlight.current = true;

      try {
        // Decoding at the display size rather than full resolution keeps
        // scrubbing responsive on 4K and 6K sources; the grade itself is
        // resolution-independent, and the master re-render works from the
        // original file at full size regardless.
        const frame = await bridge.decodeFrame(path, timeSeconds, 2048);
        renderer.renderer?.setSourceData(frame.data, frame.width, frame.height);
        renderer.invalidate();
        setCurrentTime(timeSeconds);
      } catch (error) {
        onNotify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        inFlight.current = false;
        const next = pending.current;
        pending.current = null;
        if (next !== null && next !== timeSeconds) void decodeAt(path, next);
      }
    },
    [onNotify, renderer],
  );

  const open = useCallback(
    async (path?: string): Promise<MediaInfo | null> => {
      const bridge = getDesktopBridge();
      if (!bridge) return null;

      setLoading(true);
      try {
        const chosen = path ?? (await bridge.openMediaDialog());
        if (!chosen) return null;

        const probed = await bridge.probeMedia(chosen);
        setInfo(probed);
        setCurrentTime(0);
        await decodeAt(chosen, 0);

        if (probed.suggestedLogTransform) {
          onLogTransformSuggested(probed.suggestedLogTransform, probed);
        }
        return probed;
      } catch (error) {
        onNotify(error instanceof Error ? error.message : String(error), 'error');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [decodeAt, onLogTransformSuggested, onNotify],
  );

  const seek = useCallback(
    async (timeSeconds: number) => {
      if (!info) return;
      await decodeAt(info.path, Math.max(0, Math.min(info.durationSeconds, timeSeconds)));
    },
    [decodeAt, info],
  );

  const close = useCallback(() => {
    setInfo(null);
    setCurrentTime(0);
  }, []);

  return { info, loading, currentTime, open, seek, close };
}
