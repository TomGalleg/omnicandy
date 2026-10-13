// The short list of edits next to the open app, grouped by what they do. Used in the Edit tab and
// in the pop-out panel beside the app's own window.

import { useState } from 'react';
import type { EditorApp, QuickEdit } from '@shared/appEditors';
import type { Asset, ProjectManifest } from '@shared/types';
import type { LiveApi } from '../../useLive';
import { LiveSteps } from './LiveParts';

interface Props {
  app: EditorApp;
  asset: Asset;
  manifest: ProjectManifest | null;
  liveApi: LiveApi;
  /** False until the file is open in the app. */
  enabled: boolean;
  onProjectChanged: () => void;
  onSelectAsset: (id: string) => void;
  log: (source: string, msg: string) => void;
}

const defaults = (op: QuickEdit) => Object.fromEntries(op.params.map((p) => [p.key, p.default])) as Record<string, number | string>;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function EditTools({ app, asset, liveApi, enabled, onProjectChanged, onSelectAsset, log }: Props) {
  const { live, busy, act } = liveApi;
  const [openOp, setOpenOp] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, number | string>>({});
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState<{ text: string; error?: boolean; newId?: string } | null>(null);

  const groups = new Map<string, QuickEdit[]>();
  for (const op of app.quickEdits) {
    const g = op.group ?? 'Edits';
    groups.set(g, [...(groups.get(g) ?? []), op]);
  }
  // "Make a copy" (new file, not an edit in the app) always goes last.
  const ordered = [...groups].sort(([a], [b]) => Number(a === 'Make a copy') - Number(b === 'Make a copy'));
  const running = ['running', 'pausing'].includes(live?.collab.phase ?? '');

  const apply = (op: QuickEdit, v: Record<string, number | string>) => {
    if (op.copyOnly) {
      setCopyBusy(true); setCopyMsg(null);
      window.studio.edit.apply(asset.id, op.id, v)
        .then((r) => { setCopyMsg({ text: `${r.message} Saved as a new version.`, newId: r.assetIds[0] }); log(app.id, r.message); onProjectChanged(); })
        .catch((e) => setCopyMsg({ text: errText(e), error: true }))
        .finally(() => setCopyBusy(false));
      return;
    }
    void act(op.label, () => window.studio.live.quickEdit(op.id, v));
  };

  const click = (op: QuickEdit) => {
    if (!op.params.length) { apply(op, {}); return; }
    setOpenOp(openOp === op.id ? null : op.id);
    setValues(defaults(op));
  };

  return (
    <div className="tools">
      <div className="tools-head">
        <h3>Edits</h3>
        <span className="asset-meta">{enabled ? `Applied in ${app.name}. Undo anytime.` : `Waiting for ${app.name}…`}</span>
      </div>
      {ordered.map(([group, ops]) => (
        <section key={group} className="tool-group">
          <h4>{group}{group === 'Make a copy' && <span className="asset-meta"> · makes a new file</span>}</h4>
          <div className="tool-buttons">
            {ops.map((op) => {
              const disabled = (op.copyOnly ? copyBusy : !enabled || busy || running);
              return (
                <div key={op.id} className={`tool${openOp === op.id ? ' open' : ''}`}>
                  <button className="tool-btn" disabled={disabled} aria-expanded={op.params.length ? openOp === op.id : undefined} onClick={() => click(op)}>
                    {op.label}{op.params.length > 0 && <span aria-hidden> …</span>}
                  </button>
                  {openOp === op.id && (
                    <div className="tool-params">
                      {op.params.map((p) => (
                        <label className="field" key={p.key}>
                          <span>{p.label}{p.type === 'number' && <strong> {values[p.key]}{p.unit ? ` ${p.unit}` : ''}</strong>}</span>
                          {p.type === 'number'
                            ? <input type="range" min={p.min} max={p.max} step={p.step} value={Number(values[p.key] ?? p.default)}
                                onChange={(e) => setValues((v) => ({ ...v, [p.key]: Number(e.target.value) }))} />
                            : <select value={String(values[p.key] ?? p.default)} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}>
                                {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>}
                        </label>
                      ))}
                      <button className="btn small primary" disabled={disabled} onClick={() => { apply(op, values); setOpenOp(null); }}>Apply</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {copyMsg && (
        <div className={copyMsg.error ? 'wf-msg error' : 'asset-meta'}>
          {copyMsg.text} {copyMsg.newId && <button className="btn small ghost" onClick={() => onSelectAsset(copyMsg.newId!)}>Show it</button>}
        </div>
      )}
      {live?.message && enabled && <div className="asset-meta tools-msg">{live.message}</div>}

      {app.id === 'photocraft' && enabled && (
        <details className="tool-group automation">
          <summary>Automation (several steps, take control any time)</summary>
          <LiveSteps liveApi={liveApi} compact />
        </details>
      )}
      {enabled && live && live.history.length > 0 && (
        <details className="tool-group">
          <summary>History ({live.history.length})</summary>
          <ol className="live-history">{live.history.map((h, i) => <li key={i}>{h}</li>)}</ol>
        </details>
      )}
    </div>
  );
}
