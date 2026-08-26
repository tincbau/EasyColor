import type { DesktopBridge } from '@easycolor/core';

/**
 * Desktop detection.
 *
 * The same bundle runs in a browser tab and inside Electron. Rather than
 * building two variants, every desktop-only feature asks for the bridge and
 * renders nothing when it is absent — so the browser build has no dead
 * Electron code in it and no feature can half-exist.
 */
export function getDesktopBridge(): DesktopBridge | null {
  const bridge = (globalThis as { easycolor?: DesktopBridge }).easycolor;
  return bridge?.isDesktop ? bridge : null;
}

export const IS_DESKTOP = getDesktopBridge() !== null;
