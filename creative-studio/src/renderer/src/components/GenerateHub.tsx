import { useState } from 'react';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { AiStudio } from './AiStudio';
import { GenerateWorkspace } from './GenerateWorkspace';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const KEY = 'cs-generate-view';

/** The AI Generate tab: the new AI Studio by default, with the original screen (video, local AI, limits) one click away. */
export function GenerateHub(p: Props) {
  const [view, setView] = useState<'studio' | 'classic'>(() => {
    try { return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'studio'; } catch { return 'studio'; }
  });
  const choose = (v: 'studio' | 'classic') => { setView(v); try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };
  return (
    <div>
      <div className="btn-row" role="group" aria-label="AI Generate view" style={{ marginBottom: 10 }}>
        <button className={`btn small${view === 'studio' ? ' primary' : ''}`} aria-pressed={view === 'studio'} onClick={() => choose('studio')}>AI Studio</button>
        <button className={`btn small${view === 'classic' ? ' primary' : ''}`} aria-pressed={view === 'classic'} onClick={() => choose('classic')}>Classic (video, local AI, spending limit)</button>
      </div>
      {view === 'studio' ? <AiStudio {...p} /> : <GenerateWorkspace {...p} />}
    </div>
  );
}
