/**
 * Preload bridge.
 *
 * Everything the renderer can reach is enumerated here. Context isolation is
 * on and node integration is off, so the web app — which also runs in a
 * plain browser tab where it has none of this — gets exactly this surface
 * and nothing more.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '@easycolor/core';
import type { DesktopBridge, ExportProgress, ExportRequest } from '@easycolor/core';

const bridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version ?? '1.0.0',

  probeSystem: () => ipcRenderer.invoke(CHANNELS.probeSystem),
  openMediaDialog: () => ipcRenderer.invoke(CHANNELS.openMediaDialog),
  probeMedia: (path) => ipcRenderer.invoke(CHANNELS.probeMedia, path),
  decodeFrame: (path, timeSeconds, maxWidth) =>
    ipcRenderer.invoke(CHANNELS.decodeFrame, path, timeSeconds, maxWidth),

  saveDialog: (defaultName, filters) =>
    ipcRenderer.invoke(CHANNELS.saveDialog, defaultName, filters),
  writeFile: (path, contents) => ipcRenderer.invoke(CHANNELS.writeFile, path, contents),
  readTextFile: (path) => ipcRenderer.invoke(CHANNELS.readTextFile, path),

  startExport: (request: ExportRequest) => ipcRenderer.invoke(CHANNELS.startExport, request),
  cancelExport: (jobId) => ipcRenderer.invoke(CHANNELS.cancelExport, jobId),

  onExportProgress: (listener: (progress: ExportProgress) => void) => {
    const handler = (_event: unknown, progress: ExportProgress) => listener(progress);
    ipcRenderer.on(CHANNELS.exportProgress, handler);
    return () => {
      ipcRenderer.off(CHANNELS.exportProgress, handler);
    };
  },
};

contextBridge.exposeInMainWorld('easycolor', bridge);
