// The multi-application setup run, as plain logic with no UI and no Electron: one program after another, each with its
// OWN adapter install, trust decision, connection and verification. A failure, a refusal or an exception for one program
// never changes what is reported for another, and a program is "verified" only when the real connection test passed.

import {
  INSTALL_CANCELLED_MESSAGE, sameInstall,
  type ConnectEntry, type ConnectOutcome,
} from './connect';
import type { PackageApproval } from './integrations';

export type StepState = 'todo' | 'running' | 'done' | 'failed' | 'skipped';

export type RunOutcome = 'pending' | 'working' | 'verified' | 'verified-limited' | 'blocked' | 'failed' | 'cancelled' | 'skipped';

export interface AppRun {
  /** Stable id of this row (the program's key when the run started). */
  key: string;
  /** The program's current key: it changes when installing the connector makes another executable of the same install the match. */
  appKey: string;
  name: string;
  /** This program needs its connector installed (or turned on) first. */
  needsAdapter: boolean;
  adapter: StepState;
  connect: StepState;
  outcome: RunOutcome;
  headline: string;
  detail: string;
  evidence: string[];
  /** Raw message for advanced users. */
  technical: string;
}

/** What the user decided about one connector: the permissions and trust they approved, or null for "not this one". */
export type AdapterDecision = { approval: PackageApproval } | null;

export interface SetupDeps {
  /** Shows the connector review for this program and resolves with the user's decision. Never resolves by itself. */
  askAdapter(entry: ConnectEntry): Promise<AdapterDecision>;
  /** Installs (or turns on) the connector. Must go through the native confirmation; rejects with INSTALL_CANCELLED_MESSAGE when declined. */
  installAdapter(entry: ConnectEntry, approval: PackageApproval): Promise<void>;
  /** The current list of programs (after the install the program is listed under its new connector). */
  refresh(): Promise<ConnectEntry[]>;
  /** Connects and really tests one program. */
  connect(key: string): Promise<ConnectOutcome>;
  /** Called after every state change with a fresh copy. */
  onUpdate(runs: AppRun[]): void;
  /** True once the user cancelled the setup; checked between steps. */
  isCancelled(): boolean;
}

const msg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

export const initialRuns = (entries: ConnectEntry[]): AppRun[] =>
  entries.map((e) => ({
    key: e.key, appKey: e.key, name: e.adapterName ?? e.name, needsAdapter: e.group === 'needs-adapter',
    adapter: e.group === 'needs-adapter' ? 'todo' : 'skipped', connect: 'todo', outcome: 'pending',
    headline: 'Waiting', detail: '', evidence: [], technical: '',
  }));

/**
 * Runs the setup for the chosen programs, one at a time (native dialogs are modal and installs change the connector list,
 * so they must not overlap). Returns the final runs; `onUpdate` streams progress.
 */
export async function runSetup(entries: ConnectEntry[], deps: SetupDeps): Promise<AppRun[]> {
  const runs = initialRuns(entries);
  const push = () => deps.onUpdate(runs.map((r) => ({ ...r, evidence: [...r.evidence] })));
  const patch = (i: number, p: Partial<AppRun>) => { runs[i] = { ...runs[i]!, ...p }; push(); };
  const cancelFrom = (i: number, why: string) => {
    for (let j = i; j < runs.length; j++) {
      if (runs[j]!.outcome !== 'pending' && runs[j]!.outcome !== 'working') continue;
      runs[j] = { ...runs[j]!, outcome: 'cancelled', headline: 'Not set up', detail: why, adapter: runs[j]!.adapter === 'todo' ? 'skipped' : runs[j]!.adapter, connect: 'skipped' };
    }
    push();
  };
  push();

  for (let i = 0; i < entries.length; i++) {
    if (deps.isCancelled()) { cancelFrom(i, 'You cancelled the setup before this one was started. Nothing was changed for it.'); break; }
    const entry = entries[i]!;
    const name = runs[i]!.name;
    patch(i, { outcome: 'working', headline: 'Starting…' });
    try {
      let key = entry.key;

      // 1. The connector: reviewed and approved by the user for THIS program, never silently.
      if (entry.group === 'needs-adapter') {
        if (!entry.offer) { patch(i, { outcome: 'failed', adapter: 'failed', connect: 'skipped', headline: 'No connector to install', detail: `No connector for ${name} is available any more.` }); continue; }
        patch(i, { adapter: 'running', headline: 'Waiting for your decision on the connector…' });
        const decision = await deps.askAdapter(entry);
        if (!decision && deps.isCancelled()) { cancelFrom(i, 'You cancelled the setup. Nothing was installed for this one.'); break; }
        if (!decision) { patch(i, { outcome: 'skipped', adapter: 'skipped', connect: 'skipped', headline: 'Skipped', detail: `You chose not to install the connector for ${name}. Nothing was changed.` }); continue; }
        if (deps.isCancelled()) { cancelFrom(i, 'You cancelled the setup. Nothing was installed for this one.'); break; }
        patch(i, { headline: 'Installing the connector…' });
        try { await deps.installAdapter(entry, decision.approval); } catch (e) {
          const m = msg(e);
          if (m === INSTALL_CANCELLED_MESSAGE || /cancelled/i.test(m)) { patch(i, { outcome: 'skipped', adapter: 'skipped', connect: 'skipped', headline: 'Skipped', detail: `The installation was cancelled. Nothing was installed for ${name}.`, technical: m }); continue; }
          patch(i, { outcome: 'failed', adapter: 'failed', connect: 'skipped', headline: 'The connector could not be installed', detail: `Nothing was left half-installed. ${m}`, technical: m });
          continue;
        }
        patch(i, { adapter: 'done' });
        // The program is listed under its new connector now (its key can change: another executable of the same install).
        const list = await deps.refresh();
        const now = list.find((a) => a.key === key) ?? list.find((a) => a.adapterId === entry.offer!.adapterId && (!entry.exePath || sameInstall(a.exePath, entry.exePath)));
        if (!now || now.adapterState !== 'installed') {
          patch(i, { outcome: 'failed', connect: 'skipped', headline: 'Installed, but the program was not found afterwards', detail: `The connector was installed, but OmniCandi could not find ${name} with it. Use Browse for Application to point to it.` });
          continue;
        }
        if (now.group === 'incompatible') { patch(i, { outcome: 'failed', connect: 'skipped', headline: now.headline, detail: now.explanation }); continue; }
        key = now.key;
        patch(i, { appKey: key });
      }

      // 2. Connect and really test it.
      if (deps.isCancelled()) { cancelFrom(i, 'You cancelled the setup. Nothing was connected for this one.'); break; }
      patch(i, { connect: 'running', headline: `Connecting to ${name} and testing it…` });
      const out = await deps.connect(key);
      const ok = out.state === 'verified' || out.state === 'verified-limited';
      patch(i, { outcome: out.state === 'verified' ? 'verified' : out.state === 'verified-limited' ? 'verified-limited' : out.state === 'blocked' ? 'blocked' : 'failed', connect: ok ? 'done' : 'failed', headline: out.headline, detail: out.detail, evidence: out.evidence, technical: out.technical });
    } catch (e) {
      // Whatever went wrong here belongs to this program only.
      patch(i, { outcome: 'failed', adapter: runs[i]!.adapter === 'running' ? 'failed' : runs[i]!.adapter, connect: runs[i]!.connect === 'running' ? 'failed' : runs[i]!.connect, headline: `Could not set up ${name}`, detail: 'Something unexpected went wrong for this program only. The others are not affected. You can try again.', technical: msg(e) });
    }
  }
  return runs;
}

/** One line for the finished setup: counts only what was really verified. */
export function summarise(runs: AppRun[]): string {
  const ok = runs.filter((r) => r.outcome === 'verified' || r.outcome === 'verified-limited').length;
  const rest = runs.length - ok;
  if (!runs.length) return 'Nothing was set up.';
  if (ok === runs.length) return runs.length === 1 ? 'Connected and tested.' : `All ${runs.length} programs are connected and tested.`;
  if (!ok) return runs.length === 1 ? 'Not connected.' : 'None of the programs could be connected.';
  return `${ok} of ${runs.length} connected and tested. ${rest} ${rest === 1 ? 'needs' : 'need'} attention.`;
}
