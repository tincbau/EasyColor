import { useGrade, useStore } from '../state/StoreContext.js';
import { Button } from './ui/controls.js';

/**
 * The toolbar.
 *
 * Tool choice sits on the far left because it changes what a click on the
 * image means, and that is the single most consequential piece of state in
 * the app. Compare and overlay controls sit together on the right because
 * they are both about *looking* rather than changing.
 */

export type ViewerTool = 'hsl' | 'tonal' | 'window' | 'wipe' | 'picker';

export const TOOLS: Array<{ id: ViewerTool; label: string; key: string; hint: string }> = [
  {
    id: 'hsl',
    label: 'Colour',
    key: '1',
    hint: 'Click a colour and drag. Left/right hue, up/down saturation. Shift = saturation only, Ctrl = luminance only.',
  },
  {
    id: 'tonal',
    label: 'Tonal',
    key: '2',
    hint: 'Drag on a shadow, midtone or highlight. EasyColor picks Lift, Gamma or Gain for you.',
  },
  { id: 'window', label: 'Window', key: '3', hint: 'Drag the on-screen handles of a power window.' },
  { id: 'wipe', label: 'Wipe', key: '4', hint: 'Drag to move the A/B compare wipe.' },
  { id: 'picker', label: 'Pick skin', key: '5', hint: 'Click a face to set the skin qualifier.' },
];

interface Props {
  tool: ViewerTool;
  onToolChange: (tool: ViewerTool) => void;
  onOpenMedia: () => void;
  onSaveProject: () => void;
  onOpenProject: () => void;
  showScopes: boolean;
  onToggleScopes: () => void;
  fps: number;
  mediaName: string;
}

export function Toolbar({
  tool,
  onToolChange,
  onOpenMedia,
  onSaveProject,
  onOpenProject,
  showScopes,
  onToggleScopes,
  fps,
  mediaName,
}: Props) {
  const store = useStore();
  const grade = useGrade();
  const viewer = grade.viewer;

  const cycleOverlay = () => {
    store.updateViewer((v) => ({
      ...v,
      overlay: v.overlay === 'falseColor' ? 'none' : 'falseColor',
    }));
  };

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <span>EasyColor</span>
      </div>

      <div className="group">
        {TOOLS.map((t) => (
          <Button
            key={t.id}
            small
            variant="ghost"
            active={tool === t.id}
            title={`${t.hint}  (${t.key})`}
            onClick={() => onToolChange(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <div className="group">
        <Button small variant="ghost" onClick={onOpenMedia} title="Open a still or clip">
          Open
        </Button>
        <Button small variant="ghost" onClick={onOpenProject} title="Open a saved grade">
          Load grade
        </Button>
        <Button small variant="ghost" onClick={onSaveProject} title="Save this grade">
          Save grade
        </Button>
      </div>

      <div className="group">
        <Button
          small
          variant="ghost"
          disabled={!store.canUndo}
          onClick={() => store.undo()}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </Button>
        <Button
          small
          variant="ghost"
          disabled={!store.canRedo}
          onClick={() => store.redo()}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </Button>
      </div>

      <div className="spacer" />

      <div className="group">
        <Button
          small
          variant="ghost"
          active={viewer.bypass}
          onClick={() => store.updateViewer((v) => ({ ...v, bypass: !v.bypass }))}
          title="Bypass the whole grade (hold \ or press B)"
        >
          Bypass
        </Button>
        <Button
          small
          variant="ghost"
          active={viewer.compare === 'wipe'}
          onClick={() =>
            store.updateViewer((v) => ({ ...v, compare: v.compare === 'wipe' ? 'off' : 'wipe' }))
          }
          title="Wipe compare (W)"
        >
          Wipe
        </Button>
        <Button
          small
          variant="ghost"
          active={viewer.compare === 'sideBySide'}
          onClick={() =>
            store.updateViewer((v) => ({
              ...v,
              compare: v.compare === 'sideBySide' ? 'off' : 'sideBySide',
            }))
          }
          title="Side by side compare"
        >
          Split
        </Button>
        {viewer.compare !== 'off' && (
          <>
            <Button
              small
              variant="ghost"
              onClick={() => store.updateViewer((v) => ({ ...v, wipeVertical: !v.wipeVertical }))}
              title="Swap the wipe between horizontal and vertical"
            >
              {viewer.wipeVertical ? 'Vertical' : 'Horizontal'}
            </Button>
            <Button
              small
              variant="ghost"
              onClick={() =>
                store.updateViewer((v) => ({
                  ...v,
                  reference: v.reference === 'source' ? 'corrected' : 'source',
                }))
              }
              title="What the 'before' side shows"
            >
              {viewer.reference === 'source' ? 'vs source' : 'vs corrected'}
            </Button>
          </>
        )}
      </div>

      <div className="group">
        <Button
          small
          variant="ghost"
          active={viewer.overlay === 'falseColor'}
          onClick={cycleOverlay}
          title="False colour exposure overlay (F)"
        >
          False colour
        </Button>
        <Button small variant="ghost" active={showScopes} onClick={onToggleScopes} title="Show scopes">
          Scopes
        </Button>
      </div>

      <span className="hint" style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11 }}>
        {mediaName ? `${mediaName} · ` : ''}
        {fps > 0 ? `${fps} fps` : ''}
      </span>
    </div>
  );
}
