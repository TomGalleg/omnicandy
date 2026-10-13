import type { Asset } from '@shared/types';
import type { LiveApi } from '../useLive';
import { isTaskActive, LiveDocument, LiveSteps } from './live/LiveParts';

const OPENABLE = new Set(['pcraft', 'psd', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp', 'gif', 'svg']);

/** Edit workspace: drive the real PhotoCraft window. Controls pop out next to PhotoCraft by default. */
export function LivePanel({ selected, liveApi, onProjectChanged }: { selected: Asset | null; liveApi: LiveApi; onProjectChanged: () => void }) {
  const { live, busy, act } = liveApi;
  const openable = !!selected && OPENABLE.has(selected.sourceFormat);
  const isOpen = live?.status === 'ready' && !!live.asset;
  const taskActive = isTaskActive(live?.collab.phase ?? 'idle');

  return (
    <div className="live">
      <div className="live-bar">
        <span className={`chip ${isOpen ? 'real' : live?.status === 'error' ? 'warn' : 'off'}`}>
          <span className="dot" />
          {live?.status === 'starting' ? 'Starting PhotoCraft…' : isOpen ? `PhotoCraft live · ${live!.asset!.name}` : live?.status === 'error' ? 'PhotoCraft: error' : 'PhotoCraft live: not started'}
        </span>
        <span className="spacer" />
        {isOpen && (live!.poppedOut
          ? <button className="btn small" disabled={busy} onClick={() => void act('Dock controls', window.studio.live.dock)}>Dock controls here</button>
          : <button className="btn small" disabled={busy} onClick={() => void act('Pop out controls', window.studio.live.popOut)}>Pop out next to PhotoCraft</button>)}
        <button className="btn small" disabled={!openable || busy || taskActive}
          title={!selected ? 'Select an image in the media browser' : !openable ? `${selected.sourceFormat.toUpperCase()} can't be opened in PhotoCraft` : ''}
          onClick={() => void act('Open in PhotoCraft', () => window.studio.live.open(selected!.id))}>
          {isOpen && live!.asset!.id === selected?.id ? 'Re-open in PhotoCraft' : `Open ${selected ? selected.name : 'selection'} in PhotoCraft`}
        </button>
      </div>

      {live?.status === 'error' && <div className="notice" role="alert">{live.error}</div>}

      {!isOpen ? (
        <div className="empty-state">
          <div className="empty-card">
            <h2>Edit in the real PhotoCraft window</h2>
            <p>Select an image on the left, then press <strong>Open … in PhotoCraft</strong>. PhotoCraft opens in its own window and the controls pop out in a slim panel docked to its left edge. They follow the window when you move or resize it.</p>
            <p>Creative Studio drives PhotoCraft over a token-protected local connection and can only read your project and write to its <span className="mono">work/live</span> folder. Your library file is never changed: use <strong>Save as new version</strong> to keep results.</p>
          </div>
        </div>
      ) : live!.poppedOut ? (
        <div className="empty-state">
          <div className="empty-card">
            <h2>Controls are next to PhotoCraft</h2>
            <p>The automation steps, Take Control and Save buttons are in the panel docked to the left of the PhotoCraft window ({live!.asset!.name}).</p>
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <button className="btn" disabled={busy} onClick={() => void act('Dock controls', window.studio.live.dock)}>Dock controls back here</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="live-grid">
          <LiveSteps liveApi={liveApi} />
          <LiveDocument liveApi={liveApi} onSaved={onProjectChanged} />
        </div>
      )}
    </div>
  );
}
