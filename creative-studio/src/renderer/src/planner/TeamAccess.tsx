import { useEffect, useState } from 'react';
import { CAPABILITY_LABEL, LEVEL_LABEL, PRESETS, PRESET_BLURB, PRESET_LABEL, ACCESS_LEVELS, minLevel, type AccessLevel } from '@shared/teamAccess';
import { centsToDollars, dollarsToCents, type AccessChange, type AccessView } from '@shared/teamAccessView';
import { TOOLBOXES } from '@shared/directorToolbox';
import type { DirectorKey } from '@shared/town';
import { errMsg } from './plannerUi';

const api = () => window.studio.director;

/**
 * What one director may do, in plain words: how careful they are (a preset), what each of their abilities is set to, how much they may spend alone, and an on/off switch.
 * Every change saves at once into the project folder and applies at the director's very next action, even in the middle of a task. Things that always ask
 * (deleting, installing, publishing, sensitive commands) are not listed because no setting turns them off.
 */
export function TeamAccess({ director, name, defaultOpen = false }: { director: DirectorKey; name: string; defaultOpen?: boolean }) {
  const [view, setView] = useState<AccessView | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (v: AccessView) => { setView(v); setCap(v.spendCapCents === null ? '' : centsToDollars(v.spendCapCents)); };
  useEffect(() => { let live = true; setView(null); void api().access(director).then((v) => { if (live) show(v); }).catch((e) => { if (live) setError(errMsg(e)); }); return () => { live = false; }; }, [director]);

  const change = async (c: AccessChange) => {
    setBusy(true); setError(null);
    try { show(await api().setAccess(director, c)); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const saveCap = () => { const cents = dollarsToCents(cap); if (cents === undefined) { setError('Type an amount like 5 or 5.50, or leave it empty for no limit.'); return; } void change({ kind: 'spend-cap', cents }); };
  if (!view) return error ? <p className="pl-error" role="alert">{error}</p> : null;

  const box = TOOLBOXES[director];
  return (
    <details className="pl-fold tw-team-access" open={defaultOpen || undefined}>
      <summary>Team access: what {name} may do<span className="pl-count">{view.revoked ? 'Off' : PRESET_LABEL[view.preset]}</span></summary>
      <div className="pl-stack">
        <p className="pl-hint">{view.works ? `${name} can make and change files in your project.` : `${name} advises: they can look and suggest, and cannot change your files.`} Anything that deletes, installs software or puts something outside OmniCandy always asks you first, whatever is set here.</p>

        {view.aiVia && <p className="pl-hint">Anything that uses AI (pictures, video, models) goes through the AI Director. Its access, spending limit and on/off switch decide it, so they are set on the AI Director's card, not here.</p>}

        <div className="pl-row">
          <strong>{view.revoked ? `${name}'s access is switched off.` : `${name}'s access is on.`}</strong>{' '}
          <button className="btn small" disabled={busy} onClick={() => void change({ kind: 'revoked', revoked: !view.revoked })}>{view.revoked ? 'Switch back on' : 'Switch off'}</button>
        </div>
        {view.revoked && <p className="pl-hint">They are stopped, even in the middle of a task, and can do nothing until you switch them back on.</p>}

        <fieldset disabled={busy || view.revoked} className="pl-fieldset">
          <legend>How careful should {name} be?</legend>
          {PRESETS.map((p) => (
            <label key={p} className="pl-radio">
              <input type="radio" name={`preset-${director}`} checked={view.preset === p} onChange={() => void change({ kind: 'preset', preset: p })} />
              <span><strong>{PRESET_LABEL[p]}{p === box.preset ? ' (starts here)' : ''}</strong> — {PRESET_BLURB[p]}</span>
            </label>
          ))}
        </fieldset>

        <table className="pl-table">
          <caption className="pl-hint">What each ability is set to. Choosing a preset above resets these.</caption>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.capability}>
                <th scope="row">{CAPABILITY_LABEL[r.capability]}</th>
                <td>
                  <select aria-label={CAPABILITY_LABEL[r.capability]} value={r.level} disabled={busy || view.revoked} onChange={(e) => void change({ kind: 'level', capability: r.capability, level: e.target.value as AccessLevel })}>
                    {ACCESS_LEVELS.filter((l) => l !== 'none' ? minLevel(l, r.max) === l : true).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {view.canSpend && (
          <div className="pl-row">
            <label>Spending {name} may do without asking, in dollars{' '}
              <input type="text" inputMode="decimal" value={cap} placeholder="No limit: always ask" disabled={busy || view.revoked} onChange={(e) => setCap(e.target.value)} onBlur={saveCap} onKeyDown={(e) => { if (e.key === 'Enter') saveCap(); }} style={{ width: '9em' }} />
            </label>
            <p className="pl-hint">{view.spendCapCents === null ? 'With no limit, every paid action shows you the price and asks.' : `Up to $${centsToDollars(view.spendCapCents)}, only when their ability to make media is set to Allowed. Spent so far: $${centsToDollars(view.spentCents)}. Beyond it, you are asked.`}</p>
          </div>
        )}

        {error && <p className="pl-error" role="alert">{error}</p>}
        <div><button className="btn small" disabled={busy} onClick={() => void change({ kind: 'reset' })}>Go back to {name}'s starting settings</button></div>
      </div>
    </details>
  );
}
