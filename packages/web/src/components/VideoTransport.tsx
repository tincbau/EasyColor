import { useEffect, useRef, useState } from 'react';

/**
 * Transport for browser-decoded video.
 *
 * The desktop transport drives FFmpeg seeks; this one drives an
 * HTMLVideoElement directly, which is what the web build grades from. It
 * exists because grading happens on paused frames: without a way to stop
 * on the frame that matters, a video is only gradeable by luck.
 *
 * State lives in the video element itself — play position, paused-ness —
 * and this component mirrors it, rather than keeping a copy that can
 * drift. React re-renders are driven by the element's own events.
 */

interface Props {
  video: HTMLVideoElement;
}

export function VideoTransport({ video }: Props) {
  const [, force] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    for (const event of ['play', 'pause', 'timeupdate', 'seeked', 'durationchange']) {
      video.addEventListener(event, rerender);
    }
    return () => {
      for (const event of ['play', 'pause', 'timeupdate', 'seeked', 'durationchange']) {
        video.removeEventListener(event, rerender);
      }
    };
  }, [video]);

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const progress = duration > 0 ? video.currentTime / duration : 0;

  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || duration === 0) return;
    const rect = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    video.currentTime = t * duration;
  };

  const togglePlay = () => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  // The browser cannot know the clip's true frame rate, so stepping uses a
  // 25fps frame as its unit — close enough to land on a different frame,
  // which is all a step needs to do.
  const step = (frames: number) => {
    video.pause();
    video.currentTime = Math.min(duration, Math.max(0, video.currentTime + frames / 25));
  };

  return (
    <div className="transport">
      <button
        type="button"
        className="btn ghost small"
        onClick={togglePlay}
        title={video.paused ? 'Play (grading follows the moving image)' : 'Pause on this frame to grade it'}
        aria-label={video.paused ? 'Play' : 'Pause'}
      >
        {video.paused ? '▶' : '⏸'}
      </button>
      <button type="button" className="btn ghost small" onClick={() => step(-1)} title="Back one frame" aria-label="Back one frame">
        ◀
      </button>
      <button type="button" className="btn ghost small" onClick={() => step(1)} title="Forward one frame" aria-label="Forward one frame">
        ▶▏
      </button>

      <span className="transport-time">{clock(video.currentTime)}</span>

      <div
        ref={trackRef}
        className="transport-track"
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={video.currentTime}
        aria-valuetext={clock(video.currentTime)}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as Element).setPointerCapture(e.pointerId);
          draggingRef.current = true;
          // Scrubbing while playing fights the playhead; pause first so the
          // frame under the pointer is the frame that stays.
          video.pause();
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
          if (e.key === ' ') {
            e.preventDefault();
            togglePlay();
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            step(e.shiftKey ? -25 : -1);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            step(e.shiftKey ? 25 : 1);
          }
        }}
      >
        <div className="transport-rail" />
        <div className="transport-fill" style={{ width: `${progress * 100}%` }} />
        <div className="transport-head" style={{ left: `${progress * 100}%` }} />
      </div>

      <span className="transport-time">{clock(duration)}</span>
    </div>
  );
}

/** MM:SS.d — a clock, not timecode: the browser does not know the frame rate. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.0';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
