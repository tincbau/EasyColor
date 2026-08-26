import { useCallback, useRef, useState } from 'react';
import {
  PROJECT_EXTENSION,
  deserialiseProject,
  parseCube,
  serialiseProject,
  toLut3D,
} from '@easycolor/core';
import { StoreProvider, useStore } from './state/StoreContext.js';
import { GradeStore } from './state/store.js';
import { useMedia } from './hooks/useMedia.js';
import { useRenderer } from './hooks/useRenderer.js';
import { useToasts } from './hooks/useToasts.js';
import { useShortcuts } from './hooks/useShortcuts.js';
import { Toolbar } from './components/Toolbar.js';
import type { ViewerTool } from './components/Toolbar.js';
import { Viewer } from './components/Viewer.js';
import { Inspector } from './components/Inspector.js';
import type { InspectorTab } from './components/Inspector.js';
import { ScopesPanel } from './components/ScopesPanel.js';
import type { ScopeKind } from './components/ScopesPanel.js';
import { sanitise, saveTextFile } from './lib/download.js';
import { useDesktopMedia } from './hooks/useDesktopMedia.js';
import { getDesktopBridge } from './desktop/bridge.js';
import { Transport } from './components/Transport.js';
import { LOG_TRANSFORM_BY_ID } from '@easycolor/core';
import type { LogTransformId } from '@easycolor/core';

const store = new GradeStore();

export function App() {
  return (
    <StoreProvider store={store}>
      <Workspace />
    </StoreProvider>
  );
}

function Workspace() {
  const store = useStore();
  const { toasts, notify } = useToasts();
  const media = useMedia((message) => notify(message, 'error'));
  const renderer = useRenderer(store, media.media);

  const [tool, setTool] = useState<ViewerTool>('hsl');
  const [tab, setTab] = useState<InspectorTab>('primaries');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const [showScopes, setShowScopes] = useState(true);
  const [scopes, setScopes] = useState<ScopeKind[]>(['waveform', 'parade', 'vectorscope']);

  const mediaInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const bridge = getDesktopBridge();

  /**
   * When the desktop app recognises a camera's log curve from the file's
   * metadata, set it — and say so. Applying a camera profile silently would
   * leave someone wondering why their footage looks different from the last
   * tool that opened it.
   */
  const desktop = useDesktopMedia(
    renderer,
    notify,
    useCallback(
      (id: string, info) => {
        const transform = LOG_TRANSFORM_BY_ID[id as LogTransformId];
        if (!transform) return;
        store.update(
          (g) => ({ ...g, source: { ...g.source, logTransform: id as LogTransformId, displayRender: 'filmic' } }),
          `Camera profile: ${transform.label}`,
        );
        store.commit();
        notify(
          `${info.fileName} looks like ${transform.vendor} ${transform.label}. ` +
            'Applied that camera profile — change it under Primary if it is wrong.',
          'info',
        );
      },
      [notify, store],
    ),
  );

  const toggleScopes = useCallback(() => setShowScopes((v) => !v), []);
  useShortcuts({ store, onToolChange: setTool, onToggleScopes: toggleScopes });

  /**
   * One entry point for every file the app accepts, dispatched by extension.
   * Dropping a LUT, a project and a clip together does the right thing with
   * each, which is a small thing that removes a whole category of "wrong
   * button" mistakes.
   */
  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const name = file.name.toLowerCase();

        if (name.endsWith('.cube')) {
          try {
            const lut = toLut3D(parseCube(await file.text()));
            store.update(
              (g) => ({
                ...g,
                lut: { ...g.lut, enabled: true, name: lut.title || file.name, size: lut.size, data: lut.data },
              }),
              `Load LUT: ${file.name}`,
            );
            store.commit();
            renderer.invalidate();
            notify(`Loaded ${file.name} (${lut.size}³).`, 'success');
            setTab('lut');
          } catch (e) {
            notify(e instanceof Error ? e.message : `Could not read ${file.name}.`, 'error');
          }
          continue;
        }

        // .txt is here because a sandboxed viewer that cannot write a
        // .ecgrade file falls back to appending .txt — a project saved that
        // way has to be openable again without the user renaming it first.
        if (name.endsWith(PROJECT_EXTENSION) || name.endsWith('.json') || name.endsWith('.txt')) {
          try {
            const grade = deserialiseProject(await file.text());
            store.reset(grade, `Open ${file.name}`);
            renderer.invalidate();
            notify(`Opened ${file.name}.`, 'success');
          } catch (e) {
            notify(e instanceof Error ? e.message : `Could not open ${file.name}.`, 'error');
          }
          continue;
        }

        await media.loadFile(file);
      }
    },
    [media, notify, renderer, store],
  );

  const saveProject = async () => {
    const grade = store.getGrade();
    const result = await saveTextFile(
      serialiseProject(grade),
      `${sanitise(grade.name || 'easycolor-grade')}${PROJECT_EXTENSION}`,
      'application/json',
    );

    if (result.ok) notify(result.note ?? 'Grade saved.', 'success');
    else if (result.note) notify(result.note, 'error');
  };

  const toggleScope = (kind: ScopeKind) => {
    setScopes((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );
  };

  /**
   * The viewer sizes itself from the media's dimensions. On desktop the
   * pixels come from FFmpeg rather than a DOM element, so it is handed the
   * dimensions with a null element — enough to lay out, nothing to upload.
   */
  const desktopMediaShim = desktop.info
    ? {
        kind: 'image' as const,
        element: null,
        width: desktop.info.width,
        height: desktop.info.height,
        name: desktop.info.fileName,
        duration: desktop.info.durationSeconds,
      }
    : null;

  const hasAnyMedia = desktop.info !== null || media.media.kind !== 'none';

  return (
    <div className={`app${showScopes ? '' : ' no-scopes'}`}>
      <div className="toolbar-area">
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          onOpenMedia={() => {
            // The desktop build opens through FFmpeg, so it can read camera
            // formats a browser file picker could not decode anyway.
            if (bridge) void desktop.open();
            else mediaInputRef.current?.click();
          }}
          onOpenProject={() => projectInputRef.current?.click()}
          onSaveProject={() => void saveProject()}
          showScopes={showScopes}
          onToggleScopes={toggleScopes}
          fps={renderer.fps}
          mediaName={desktop.info?.fileName ?? media.media.name}
        />
      </div>

      <div className="viewer-area">
        <Viewer
          renderer={renderer}
          media={desktopMediaShim ?? media.media}
          tool={tool}
          selectedZoneId={selectedZoneId}
          onSelectZone={(id) => {
            setSelectedZoneId(id);
            if (id) setTab('zones');
          }}
          selectedWindowId={selectedWindowId}
          onSelectWindow={setSelectedWindowId}
          onNotify={notify}
          onOpenFiles={(files) => void openFiles(files)}
        />
        {desktop.info && (
          <Transport
            info={desktop.info}
            currentTime={desktop.currentTime}
            onSeek={(t) => void desktop.seek(t)}
          />
        )}
      </div>

      {showScopes && (
        <div className="scopes-area">
          <ScopesPanel
            renderer={renderer}
            active={scopes}
            onToggle={toggleScope}
            hasMedia={hasAnyMedia}
          />
        </div>
      )}

      <div className="inspector-area">
        <Inspector
          tab={tab}
          onTabChange={setTab}
          renderer={renderer}
          hasMedia={hasAnyMedia}
          selectedZoneId={selectedZoneId}
          onSelectZone={setSelectedZoneId}
          selectedWindowId={selectedWindowId}
          onSelectWindow={setSelectedWindowId}
          onNotify={notify}
          desktopMedia={desktop.info}
          onPremiereFrame={(frame) => {
            // The exported still is an ordinary PNG on disk, so it loads
            // through exactly the same path as a dropped file.
            void media.loadUrl(frame.url, frame.path);
          }}
          onPickSkin={() => {
            setTool('picker');
            notify('Click a face in the viewer to set the skin qualifier.', 'info');
          }}
        />
      </div>

      <input
        ref={mediaInputRef}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void openFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={projectInputRef}
        type="file"
        accept={`${PROJECT_EXTENSION},.json,.cube`}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void openFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
