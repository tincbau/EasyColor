import type { PremiereBridge } from '@easycolor/core';

/**
 * Premiere panel detection.
 *
 * Same shape as the desktop bridge: the UI asks for it and renders the
 * Premiere features only when it is there, so one bundle serves the browser,
 * Electron and the CEP panel without any of them carrying the others' code.
 */
export function getPremiereBridge(): PremiereBridge | null {
  const bridge = (globalThis as { easycolorPremiere?: PremiereBridge }).easycolorPremiere;
  return bridge?.isPremiere ? bridge : null;
}

export const IS_PREMIERE = getPremiereBridge() !== null;
