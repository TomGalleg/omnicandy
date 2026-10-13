import { useCallback, useEffect, useState } from 'react';
import { editorFor } from '@shared/appEditors';
import type { ProjectManifest } from '@shared/types';
import logo from './assets/logo.png';
import { TaskControls } from './components/live/LiveParts';
import { useAppearance } from './useAppearance';
import { useLive } from './useLive';

/** The controls panel docked beside an ArtCraft app when it is open in its own window. */
export function PanelApp() {
  useAppearance();
  const log = useCallback(() => {}, []);
  const liveApi = useLive(log);
  const { live, busy, act } = liveApi;
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const reload = useCallback(() => { void window.studio.loadProject().then(setManifest); }, []);
  useEffect(reload, [reload]);

  const asset = manifest?.assets.find((a) => a.id === live?.asset?.id) ?? null;
  const app = asset ? editorFor(asset.sourceFormat) : null;

  return (
    <div className="dock-panel">
      <header className="dock-head">
        <img className="brand-logo" src={logo} alt="" />
        <div className="dock-title">
          <strong>CreateCraft</strong>
          <span className="asset-meta">{live?.asset ? `${app?.name ?? ''} · ${live.asset.name}` : ''}</span>
        </div>
        <button className="btn small" disabled={busy} title="Put the app back inside CreateCraft" onClick={() => void act('Put back', window.studio.live.dock)}>Put back</button>
      </header>
      <div className="dock-body">
        <div className="btn-row">
          <button className="btn small" disabled={busy} onClick={() => void act('Undo', window.studio.live.undo)}>Undo</button>
          <button className="btn small primary" disabled={busy || !!live?.collab.activeOperation}
            onClick={() => void act('Save', async () => { const s = await window.studio.live.saveVersion(); reload(); return s; })}>Save as new version</button>
        </div>
        {app?.id === 'photocraft' && (
          <section className="panel-card compact" aria-live="polite">
            <h2 style={{ fontSize: 14 }}>Task</h2>
            <TaskControls liveApi={liveApi} />
          </section>
        )}
      </div>
    </div>
  );
}
