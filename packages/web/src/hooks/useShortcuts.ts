import { useEffect } from 'react';
import type { GradeStore } from '../state/store.js';
import type { ViewerTool } from '../components/Toolbar.js';
import { TOOLS } from '../components/Toolbar.js';

/**
 * Keyboard shortcuts.
 *
 * The bypass key deserves a note: it works both as a hold and as a toggle.
 * Holding `\` shows the ungraded image and releasing returns to the grade,
 * which is how you glance; pressing `B` toggles and stays, which is how you
 * leave it while you go and change something. Colourists use both, and
 * picking one would annoy half of them.
 */

interface Options {
  store: GradeStore;
  onToolChange: (tool: ViewerTool) => void;
  onToggleScopes: () => void;
  /** Toggle clip playback. Returns false when there is nothing to play. */
  onTogglePlayback?: () => boolean;
}

export function useShortcuts({
  store,
  onToolChange,
  onToggleScopes,
  onTogglePlayback,
}: Options): void {
  useEffect(() => {
    let bypassHeld = false;

    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }

      // Modifier chords belong to the browser or the OS from here on.
      if (mod || e.altKey) return;

      if (e.key === ' ') {
        // The transport's own scrub track handles space when focused and
        // calls preventDefault, so honouring defaultPrevented avoids a
        // double toggle. A focused button is left alone entirely: space is
        // how a keyboard user presses it, and stealing that to toggle
        // playback would make every button in the app do two things.
        if (e.defaultPrevented) return;
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SUMMARY')) return;
        if (onTogglePlayback?.()) e.preventDefault();
        return;
      }

      const tool = TOOLS.find((t) => t.key === e.key);
      if (tool) {
        e.preventDefault();
        onToolChange(tool.id);
        return;
      }

      switch (e.key.toLowerCase()) {
        case '\\':
          if (!e.repeat) {
            bypassHeld = true;
            store.updateViewer((v) => ({ ...v, bypass: true }));
          }
          e.preventDefault();
          break;
        case 'b':
          e.preventDefault();
          store.updateViewer((v) => ({ ...v, bypass: !v.bypass }));
          break;
        case 'w':
          e.preventDefault();
          store.updateViewer((v) => ({ ...v, compare: v.compare === 'wipe' ? 'off' : 'wipe' }));
          break;
        case 'f':
          e.preventDefault();
          store.updateViewer((v) => ({
            ...v,
            overlay: v.overlay === 'falseColor' ? 'none' : 'falseColor',
          }));
          break;
        case 's':
          e.preventDefault();
          onToggleScopes();
          break;
        case 'escape':
          store.updateViewer((v) => ({ ...v, overlay: 'none' }));
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === '\\' && bypassHeld) {
        bypassHeld = false;
        store.updateViewer((v) => ({ ...v, bypass: false }));
      }
    };

    // Releasing the key while the window is unfocused would otherwise leave
    // the viewer stuck in bypass.
    const onBlur = () => {
      if (bypassHeld) {
        bypassHeld = false;
        store.updateViewer((v) => ({ ...v, bypass: false }));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [store, onToolChange, onToggleScopes, onTogglePlayback]);
}
