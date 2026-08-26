import { useState } from 'react';
import type { RendererApi } from '../hooks/useRenderer.js';
import { PrimariesPanel } from './panels/PrimariesPanel.js';
import { WheelsPanel } from './panels/WheelsPanel.js';
import { CurvesPanel } from './panels/CurvesPanel.js';
import { ColorZonesPanel } from './panels/ColorZonesPanel.js';
import { SkinPanel } from './panels/SkinPanel.js';
import { FilmPanel } from './panels/FilmPanel.js';
import { WindowsPanel } from './panels/WindowsPanel.js';
import { LutPanel } from './panels/LutPanel.js';
import { MatchPanel } from './panels/MatchPanel.js';
import { HistoryPanel } from './panels/HistoryPanel.js';
import { useGradeSlice } from '../state/StoreContext.js';

export type InspectorTab =
  | 'primaries'
  | 'wheels'
  | 'curves'
  | 'zones'
  | 'skin'
  | 'film'
  | 'windows'
  | 'lut'
  | 'match'
  | 'history';

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'primaries', label: 'Primary' },
  { id: 'wheels', label: 'Wheels' },
  { id: 'curves', label: 'Curves' },
  { id: 'zones', label: 'Colours' },
  { id: 'skin', label: 'Skin' },
  { id: 'film', label: 'Film' },
  { id: 'windows', label: 'Windows' },
  { id: 'lut', label: 'LUT' },
  { id: 'match', label: 'Match' },
  { id: 'history', label: 'History' },
];

interface Props {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  renderer: RendererApi;
  hasMedia: boolean;
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  selectedWindowId: string | null;
  onSelectWindow: (id: string | null) => void;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
  onPickSkin: () => void;
}

export function Inspector(props: Props) {
  const zoneCount = useGradeSlice((g) => g.zones.length);
  const windowCount = useGradeSlice((g) => g.windows.length);

  return (
    <div className="inspector">
      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const count =
            t.id === 'zones' ? zoneCount : t.id === 'windows' ? windowCount : 0;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={props.tab === t.id}
              className={`tab${props.tab === t.id ? ' active' : ''}`}
              onClick={() => props.onTabChange(t.id)}
            >
              {t.label}
              {count > 0 && (
                <span className="tab-count" aria-label={`${count} active`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <Panel {...props} />
    </div>
  );
}

function Panel({
  tab,
  renderer,
  hasMedia,
  selectedZoneId,
  onSelectZone,
  selectedWindowId,
  onSelectWindow,
  onNotify,
  onPickSkin,
}: Props) {
  switch (tab) {
    case 'primaries':
      return <PrimariesPanel />;
    case 'wheels':
      return <WheelsPanel />;
    case 'curves':
      return <CurvesPanel />;
    case 'zones':
      return <ColorZonesPanel selectedZoneId={selectedZoneId} onSelectZone={onSelectZone} />;
    case 'skin':
      return (
        <SkinPanel
          renderer={renderer}
          hasMedia={hasMedia}
          onNotify={onNotify}
          onPickSkin={onPickSkin}
        />
      );
    case 'film':
      return <FilmPanel />;
    case 'windows':
      return (
        <WindowsPanel
          selectedWindowId={selectedWindowId}
          onSelectWindow={onSelectWindow}
          onNotify={onNotify}
        />
      );
    case 'lut':
      return <LutPanel renderer={renderer} onNotify={onNotify} />;
    case 'match':
      return <MatchPanel renderer={renderer} hasMedia={hasMedia} onNotify={onNotify} />;
    case 'history':
      return <HistoryPanel />;
  }
}
