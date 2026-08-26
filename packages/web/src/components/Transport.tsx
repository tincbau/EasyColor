import { useCallback, useRef } from 'react';
import type { MediaInfo } from '@easycolor/core';

/**
 * Scrub bar for natively decoded clips.
 *
 * Deliberately a scrubber and not a player. Each position is a seek-and-
 * decode through FFmpeg, which is fast enough to feel direct but is not
 * real-time playback — and a play button that stuttered would be worse than
 * no play button. Grading is done on stills anyway; you find the frame that
 * matters and work on it.
 *
 * Positions are shown as timecode rather than seconds, because that is what
 * gets written on a shot list.
 */

interface Props {
  info: MediaInfo;
  currentTime: number;
  onSeek: (timeSeconds: number) => void;
}

export function Transport({ info, currentTime, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      onSeek(t * info.durationSeconds);
    },
    [info.durationSeconds, onSeek],
  );

  const step = (frames: number) => {
    onSeek(Math.max(0, currentTime + frames / info.fps));
  };

  const progress = info.durationSeconds > 0 ? currentTime / info.durationSeconds : 0;

  return (
    <div className="transport">
      <button
        type="button"
        className="btn ghost small"
        onClick={() => step(-1)}
        title="Previous frame"
        aria-label="Previous frame"
      >
        ◀
      </button>
      <button
        type="button"
        className="btn ghost small"
        onClick={() => step(1)}
        title="Next frame"
        aria-label="Next frame"
      >
        ▶
      </button>

      <span className="transport-time">{timecode(currentTime, info.fps)}</span>

      <div
        ref={trackRef}
        className="transport-track"
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={info.durationSeconds}
        aria-valuenow={currentTime}
        aria-valuetext={timecode(currentTime, info.fps)}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as Element).setPointerCapture(e.pointerId);
          draggingRef.current = true;
          seekFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) seekFromClientX(e.clientX);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          (e.target as Element).releasePointerCapture?.(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            step(e.shiftKey ? -Math.round(info.fps) : -1);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            step(e.shiftKey ? Math.round(info.fps) : 1);
          }
        }}
      >
        <div className="transport-rail" />
        <div className="transport-fill" style={{ width: `${progress * 100}%` }} />
        <div className="transport-head" style={{ left: `${progress * 100}%` }} />
      </div>

      <span className="transport-time">{timecode(info.durationSeconds, info.fps)}</span>

      <span className="transport-meta">
        {info.bitDepth}-bit {info.chromaSubsampling} · {info.codec}
        {info.allIntra ? ' · all-intra' : ''}
      </span>
    </div>
  );
}

/** Non-drop-frame timecode: HH:MM:SS:FF. */
function timecode(seconds: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 25;
  const totalFrames = Math.round(seconds * safeFps);
  const frames = totalFrames % Math.round(safeFps);
  const totalSeconds = Math.floor(totalFrames / safeFps);

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(
    totalSeconds % 60,
  )}:${pad(frames)}`;
}
