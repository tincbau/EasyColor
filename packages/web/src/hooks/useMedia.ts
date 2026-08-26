import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Source media loading.
 *
 * Object URLs are revoked when the source is replaced. Without that, opening
 * a dozen clips in a session leaks every one of them — and a 4K video blob
 * is not a small leak.
 */

export type MediaKind = 'none' | 'image' | 'video';

export interface MediaSource {
  kind: MediaKind;
  element: HTMLImageElement | HTMLVideoElement | null;
  width: number;
  height: number;
  name: string;
  /** Present for video only. */
  duration: number;
}

export const EMPTY_MEDIA: MediaSource = {
  kind: 'none',
  element: null,
  width: 0,
  height: 0,
  name: '',
  duration: 0,
};

export interface MediaApi {
  media: MediaSource;
  loading: boolean;
  loadFile: (file: File) => Promise<void>;
  loadUrl: (url: string, name: string) => Promise<void>;
  clear: () => void;
}

const IMAGE_TYPES = /^image\//;
const VIDEO_TYPES = /^video\//;

export function useMedia(onError: (message: string) => void): MediaApi {
  const [media, setMedia] = useState<MediaSource>(EMPTY_MEDIA);
  const [loading, setLoading] = useState(false);
  const urlRef = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => revoke, [revoke]);

  const loadUrl = useCallback(
    async (url: string, name: string): Promise<void> => {
      setLoading(true);
      const isVideo = /\.(mp4|mov|m4v|webm|mkv|mxf)$/i.test(name) || VIDEO_TYPES.test(name);

      try {
        if (isVideo) {
          const video = document.createElement('video');
          video.src = url;
          video.crossOrigin = 'anonymous';
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          // Videos are decoded to a texture, never shown directly.
          video.style.display = 'none';

          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () =>
              reject(
                new Error(
                  `The browser could not decode ${name}. ` +
                    'Browsers only decode a narrow set of codecs — H.264 and VP9 in MP4 or WebM. ' +
                    'For camera formats like XAVC S-I or All-Intra, use the desktop app.',
                ),
              );
            video.load();
          });

          setMedia({
            kind: 'video',
            element: video,
            width: video.videoWidth,
            height: video.videoHeight,
            name,
            duration: video.duration,
          });
        } else {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.src = url;
          await image.decode();

          setMedia({
            kind: 'image',
            element: image,
            width: image.naturalWidth,
            height: image.naturalHeight,
            name,
            duration: 0,
          });
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : `Could not open ${name}.`);
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  const loadFile = useCallback(
    async (file: File): Promise<void> => {
      if (!IMAGE_TYPES.test(file.type) && !VIDEO_TYPES.test(file.type) && !/\.(mov|mxf|mkv)$/i.test(file.name)) {
        onError(`${file.name} is not an image or video file.`);
        return;
      }
      revoke();
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      await loadUrl(url, file.name);
    },
    [loadUrl, onError, revoke],
  );

  const clear = useCallback(() => {
    revoke();
    setMedia(EMPTY_MEDIA);
  }, [revoke]);

  return { media, loading, loadFile, loadUrl, clear };
}
