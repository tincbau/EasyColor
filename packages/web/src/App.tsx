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
import { download, sanitise } from './components/panels/LutPanel.js';

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

        if (name.endsWith(PROJECT_EXTENSION) || name.endsWith('.json')) {
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

  const saveProject = () => {
    const grade = store.getGrade();
    download(
      serialiseProject(grade),
      `${sanitise(grade.name || 'easycolor-grade')}${PROJECT_EXTENSION}`,
      'application/json',
    );
    notify('Grade saved.', 'success');
  };

  const toggleScope = (kind: ScopeKind) => {
    setScopes((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );
  };

  return (
    <div className={`app${showScopes ? '' : ' no-scopes'}`}>
      <div className="toolbar-area">
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          onOpenMedia={() => mediaInputRef.current?.click()}
          onOpenProject={() => projectInputRef.current?.click()}
          onSaveProject={saveProject}
          showScopes={showScopes}
          onToggleScopes={toggleScopes}
          fps={renderer.fps}
          mediaName={media.media.name}
        />
      </div>

      <div className="viewer-area">
        <Viewer
          renderer={renderer}
          media={media.media}
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
      </div>

      {showScopes && (
        <div className="scopes-area">
          <ScopesPanel
            renderer={renderer}
            active={scopes}
            onToggle={toggleScope}
            hasMedia={media.media.kind !== 'none'}
          />
        </div>
      )}

      <div className="inspector-area">
        <Inspector
          tab={tab}
          onTabChange={setTab}
          renderer={renderer}
          hasMedia={media.media.kind !== 'none'}
          selectedZoneId={selectedZoneId}
          onSelectZone={setSelectedZoneId}
          selectedWindowId={selectedWindowId}
          onSelectWindow={setSelectedWindowId}
          onNotify={notify}
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
