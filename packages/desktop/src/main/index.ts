/**
 * Electron main process.
 *
 * The renderer is the same web app that ships to the browser — it detects
 * the bridge on `window.easycolor` and adds the desktop-only panels. One
 * codebase, so a fix to the grading UI reaches every shell at once.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { CHANNELS } from '@easycolor/core';
import type { ExportRequest } from '@easycolor/core';
import { probeSystem } from './ffmpeg.js';
import { decodeFrame, probeMedia } from './decode.js';
import { cancelExport, startExport } from './export.js';

const isDev = !app.isPackaged;

/** The built web app, copied in by the build script. */
function rendererEntry(): string {
  return join(__dirname, '..', '..', '..', 'web', 'dist', 'index.html');
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    // The grading surround must be neutral before the first paint, or the
    // window flashes white and re-adapts the user's eyes at launch.
    backgroundColor: '#101010',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links belong in the user's browser, never in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadFile(rendererEntry());

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.probeSystem, () => probeSystem());

  ipcMain.handle(CHANNELS.openMediaDialog, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open footage',
      properties: ['openFile'],
      filters: [
        {
          name: 'Video and stills',
          extensions: [
            // Camera formats the browser cannot open, which is the point of
            // this dialog existing.
            'mp4', 'mov', 'mxf', 'mkv', 'avi', 'm4v', 'braw', 'r3d',
            'mts', 'm2ts', 'webm',
            'png', 'jpg', 'jpeg', 'tif', 'tiff', 'exr', 'dpx',
          ],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(CHANNELS.probeMedia, (_event, path: string) => probeMedia(path));

  ipcMain.handle(
    CHANNELS.decodeFrame,
    async (_event, path: string, timeSeconds: number, maxWidth: number) => {
      const frame = await decodeFrame(path, timeSeconds, maxWidth);
      // Transfer rather than copy: a 4K frame is 70MB and structured-cloning
      // it on every scrub would dominate the frame time.
      return frame;
    },
  );

  ipcMain.handle(
    CHANNELS.saveDialog,
    async (_event, defaultName: string, filters: Array<{ name: string; extensions: string[] }>) => {
      const result = await dialog.showSaveDialog({
        title: 'Save',
        defaultPath: defaultName,
        filters,
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
  );

  ipcMain.handle(CHANNELS.writeFile, (_event, path: string, contents: string) =>
    writeFile(path, contents, 'utf8'),
  );

  ipcMain.handle(CHANNELS.readTextFile, (_event, path: string) => readFile(path, 'utf8'));

  ipcMain.handle(CHANNELS.startExport, (event, request: ExportRequest) =>
    startExport(request, (progress) => {
      // The window can be closed mid-render; posting to a destroyed
      // WebContents throws and would take the job down with it.
      if (!event.sender.isDestroyed()) {
        event.sender.send(CHANNELS.exportProgress, progress);
      }
    }),
  );

  ipcMain.handle(CHANNELS.cancelExport, (_event, jobId: string) => cancelExport(jobId));
}
