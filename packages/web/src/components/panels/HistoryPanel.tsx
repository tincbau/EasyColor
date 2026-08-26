import { useHistoryRevision, useStore } from '../../state/StoreContext.js';
import { Button, Section } from '../ui/controls.js';

/**
 * The action history.
 *
 * Entries past the current position are kept and shown dimmed rather than
 * deleted on sight, so stepping back to compare two versions of a grade
 * doesn't destroy the newer one until you actually edit from there.
 */
export function HistoryPanel() {
  const store = useStore();
  useHistoryRevision();

  const entries = store.entries;
  const current = store.historyIndex;

  return (
    <div className="panel">
      <Section title="History">
        <div className="row" style={{ marginBottom: 8 }}>
          <Button small variant="ghost" disabled={!store.canUndo} onClick={() => store.undo()}>
            Undo
          </Button>
          <Button small variant="ghost" disabled={!store.canRedo} onClick={() => store.redo()}>
            Redo
          </Button>
        </div>

        <div className="history-list">
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className={`history-entry${index === current ? ' current' : ''}${
                index > current ? ' future' : ''
              }`}
              onClick={() => store.jumpTo(index)}
            >
              <span className="history-index">{index}</span>
              <span style={{ flex: 1 }}>{entry.label}</span>
              <span className="history-index">
                {new Date(entry.at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            </button>
          ))}
        </div>

        <p className="hint">
          Click any step to jump there. A continuous drag is a single step, so scrubbing a slider
          does not bury the change you made before it.
        </p>
      </Section>
    </div>
  );
}
