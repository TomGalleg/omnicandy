import { useCallback } from 'react';
import logo from './assets/logo.png';
import { LiveDocument, LiveSteps, TaskControls } from './components/live/LiveParts';
import { useAppearance } from './useAppearance';
import { useLive } from './useLive';

/** The pop-out control panel docked to the left edge of the PhotoCraft window. */
export function PanelApp() {
  useAppearance();
  const log = useCallback(() => {}, []);
  const liveApi = useLive(log);
  const { live, busy, act } = liveApi;

  return (
    <div className="dock-panel">
      <header className="dock-head">
        <img className="brand-logo" src={logo} alt="" />
        <div className="dock-title">
          <strong>Creative Studio</strong>
          <span className="asset-meta">{live?.asset ? `PhotoCraft · ${live.asset.name}` : 'PhotoCraft'}</span>
        </div>
        <button className="btn small" disabled={busy} title="Close this panel and show the controls in the main window" onClick={() => void act('Dock', window.studio.live.dock)}>Dock</button>
      </header>
      <div className="dock-body">
        <section className="panel-card compact" aria-live="polite">
          <h2 style={{ fontSize: 14 }}>Task</h2>
          <TaskControls liveApi={liveApi} />
        </section>
        <LiveSteps liveApi={liveApi} compact />
        <LiveDocument liveApi={liveApi} compact />
      </div>
    </div>
  );
}
