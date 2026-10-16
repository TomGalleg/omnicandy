// Universal Connect: the beginner-facing layer on top of the external integration framework.
// Pure types and plain-language helpers shared by main and renderer. Nothing here touches the machine.

import {
  PERMISSION_LABEL, STATUS_LABEL,
  type ExternalAppInfo, type IntegrationStatus, type Permission, type SignatureState,
} from './integrations';

/** Shown (and matched in main) when the user declines the native install confirmation. */
export const INSTALL_CANCELLED_MESSAGE = 'Installation was cancelled.';

/** Where an installable adapter package was found. */
export type OfferSource = 'bundled' | 'inbox' | 'installed-off';

/** An adapter that is not active yet but could be: shipped with CreateCraft, waiting in the inbox, or installed but turned off. */
export interface AdapterOffer {
  source: OfferSource;
  /** Package file or folder (not set for an installed adapter that is only turned off). */
  path: string | null;
  adapterId: string;
  name: string;
  version: string;
  publisherName: string | null;
  signature: SignatureState;
  publisherTrusted: boolean;
  /** What its commands may ask for, so the permissions can be explained before anything is installed. */
  permissions: Permission[];
}

/**
 * - installed: an adapter is active for this program.
 * - available: an adapter exists and can be installed (bundled, in the inbox, or installed but turned off).
 * - planned: CreateCraft knows the program but only has a placeholder.
 * - none: no adapter of any kind.
 */
export type AdapterState = 'installed' | 'available' | 'planned' | 'none';

export type ConnectGroup = 'connected' | 'ready' | 'needs-adapter' | 'attention' | 'incompatible' | 'unsupported';

export interface ConnectEntry extends ExternalAppInfo {
  adapterState: AdapterState;
  /** The adapter is not fully verified (Resolve, every installed package): features may be limited or untested. */
  experimental: boolean;
  group: ConnectGroup;
  /** Can be picked in the setup wizard. */
  selectable: boolean;
  /** One short line for a beginner. */
  headline: string;
  /** One or two sentences: what it means and what happens next. */
  explanation: string;
  /** The adapter that would be installed to connect this program, if one is available. */
  offer: AdapterOffer | null;
  /** The program's location was added by the user or remembered from an earlier scan, so it can be forgotten. */
  forgettable: boolean;
}

export interface ConnectOverview {
  entries: ConnectEntry[];
  /** Adapters whose program was not found on this PC. */
  notDetected: Array<{ adapterId: string; name: string; vendor: string; adapterState: AdapterState; experimental: boolean }>;
  /** True until the user has finished the guided setup once. */
  firstRun: boolean;
  scannedAt: string;
}

export type ConnectOutcomeState = 'verified' | 'verified-limited' | 'blocked' | 'failed';

/** Result of connecting one application AND checking it works. Never "verified" without a real check. */
export interface ConnectOutcome {
  key: string;
  state: ConnectOutcomeState;
  status: IntegrationStatus;
  /** Short plain-language result. */
  headline: string;
  /** What to do next, plain language. */
  detail: string;
  /** Facts that were actually checked. */
  evidence: string[];
  /** The raw message for advanced users. */
  technical: string;
}

export type BrowseResult =
  | { kind: 'cancelled' }
  | { kind: 'added'; key: string; name: string; message: string }
  | { kind: 'already-known'; key: string; name: string; message: string }
  /** The chosen file or folder is not a program CreateCraft has an adapter (or a planned one) for. Nothing was saved. */
  | { kind: 'no-match'; name: string; message: string };

export interface ForgetResult {
  /** The program is still found by a live signal (an uninstall record, a shortcut...), so it will keep showing up. */
  stillDetected: boolean;
  message: string;
}

// ---- plain language ----

export interface PermissionPlain { title: string; detail: string; level: 'low' | 'medium' | 'high' }

/** What each permission means to someone who has never heard of adapters. `PERMISSION_LABEL` stays the technical name. */
export const PERMISSION_PLAIN: Record<Permission, PermissionPlain> = {
  'read-info': { title: 'Check which version is installed', detail: 'Reads the program’s name and version. Changes nothing.', level: 'low' },
  launch: { title: 'Start the program for you', detail: 'Opens the program when CreateCraft needs it.', level: 'low' },
  'open-files': { title: 'Open files in the program', detail: 'Asks the program to open a file you point it to.', level: 'medium' },
  'read-project': { title: 'Look at what is open in the program', detail: 'Reads your project’s contents, for example which objects or clips it has. Changes nothing.', level: 'low' },
  'modify-project': { title: 'Change your work inside the program', detail: 'Edits the project that is open. CreateCraft asks you every time before anything is deleted or overwritten.', level: 'high' },
  'write-files': { title: 'Save new files for this project', detail: 'Writes results (renders, exports, copies) into this project’s own work folder. Your original files are not overwritten.', level: 'medium' },
  'execute-scripts': { title: 'Run automation steps inside the program', detail: 'Tells the program to run built-in automation, the way a macro or plugin would. This is how most things get done, so it is as powerful as that program’s own scripting.', level: 'high' },
  'ui-automation': { title: 'Click and type in the program’s window', detail: 'Controls the program as if CreateCraft were using the mouse and keyboard. Keep the window visible while it works.', level: 'high' },
  network: { title: 'Use the internet', detail: 'Lets the connection send or fetch data online.', level: 'high' },
};

export const PERMISSION_LEVEL_LABEL: Record<PermissionPlain['level'], string> = { low: 'Low impact', medium: 'Writes files', high: 'Powerful' };

/** The permission as one line: the plain title plus the technical name for advanced users. */
export const permissionLine = (p: Permission): string => `${PERMISSION_PLAIN[p].title} (${PERMISSION_LABEL[p].toLowerCase()})`;

/** Folder an executable belongs to: its folder, or the parent when it sits in `bin`. Used to tell two installs of one program apart. */
export function installRoot(exePath: string): string {
  const parts = exePath.replace(/\//g, '\\').split('\\');
  parts.pop();
  if (parts.length > 1 && parts[parts.length - 1]!.toLowerCase() === 'bin') parts.pop();
  return parts.join('\\').toLowerCase();
}

/** Two executables of the same installation (FreeCAD.exe and FreeCADCmd.exe in one bin folder). */
export const sameInstall = (a: string, b: string): boolean => installRoot(a) === installRoot(b);

// ---- classification ----

interface ClassifyInput { app: ExternalAppInfo; offer: AdapterOffer | null; forgettable: boolean }

/**
 * Turns a framework record into what the setup screen shows. Pure and deterministic so every status wording is unit tested.
 * The framework status stays the source of truth; this only chooses words, a group and whether the entry can be selected.
 */
export function classifyApp({ app, offer, forgettable }: ClassifyInput): ConnectEntry {
  const name = app.adapterName ?? app.name;
  const planned = app.maturity === 'stub';
  const hasAdapter = !!app.adapterId && !planned;
  const experimental = hasAdapter && app.maturity === 'experimental';
  const adapterState: AdapterState = hasAdapter ? 'installed' : offer ? 'available' : planned ? 'planned' : 'none';
  const make = (group: ConnectGroup, selectable: boolean, headline: string, explanation: string): ConnectEntry =>
    ({ ...app, adapterState, experimental, group, selectable, headline, explanation, offer, forgettable });

  if (!hasAdapter) {
    if (offer) {
      return make('needs-adapter', true, 'Connector available',
        `CreateCraft has a connector for ${name}. Setting it up installs the connector (you review it first), then connects and tests ${name}.`);
    }
    if (planned) {
      return make('unsupported', false, 'Not supported yet',
        `CreateCraft recognises ${name} on this PC, but it cannot control it yet: the connector for it has not been built. Nothing is wrong with your installation, and nothing was changed.`);
    }
    return make('unsupported', false, 'No connector for this program',
      `CreateCraft found ${name}, but it has no connector for it, so it cannot control it. If someone gives you a connector file (.ccadapter) for ${name}, you can add it in Settings > Integrations.`);
  }

  const status = app.status;
  switch (status) {
    case 'connected':
      return make('connected', false, 'Connected and tested', `${name} is connected and passed a real check.`);
    case 'limited':
      return make('connected', false, 'Connected (experimental)', `${name} is connected and passed its check, but this connector is experimental: some features may be limited or untested.`);
    case 'incompatible':
      return make('incompatible', false, 'This version is not supported', `${app.statusDetail} Install a supported version of ${name} to connect it.`);
    case 'not-running':
      return make('attention', true, 'Open the program first', `${name} has to be open for CreateCraft to connect. Open it, then try again.`);
    case 'api-unavailable':
      return make('attention', true, 'Automation is switched off', `${name} is running, but its automation interface is not reachable. ${app.statusDetail}`);
    case 'needs-repair':
      return make('attention', true, 'Needs a quick repair', `CreateCraft could not talk to ${name} last time. Setting it up again runs a repair and re-tests it.`);
    default:
      return make('ready', true, experimental ? 'Ready to connect (experimental)' : 'Ready to connect',
        experimental
          ? `The connector for ${name} is installed. It is experimental, so some features may be limited or untested.`
          : `The connector for ${name} is installed. Connecting starts it and runs a real test.`);
  }
}

/** Entries that setup can act on, in the order a beginner expects: connector available, ready, then ones needing attention. */
export const SELECTABLE_ORDER: ConnectGroup[] = ['ready', 'needs-adapter', 'attention'];

export const GROUP_TITLE: Record<ConnectGroup, string> = {
  ready: 'Ready to connect',
  'needs-adapter': 'Connector available',
  attention: 'Needs attention',
  connected: 'Already connected',
  incompatible: 'Version not supported',
  unsupported: 'Found, but not supported yet',
};

export const GROUP_ORDER: ConnectGroup[] = ['ready', 'needs-adapter', 'attention', 'connected', 'incompatible', 'unsupported'];

/** Plain label for the framework status, for chips. */
export const plainStatusLabel = (s: IntegrationStatus): string => STATUS_LABEL[s];

/** Turns a failed connect into a calm explanation plus what to try. `technical` always carries the raw text. */
export function explainConnectFailure(status: IntegrationStatus, name: string, raw: string): { headline: string; detail: string } {
  switch (status) {
    case 'not-running': return { headline: `${name} is not open`, detail: `Open ${name}, wait until it has finished starting, then press Try again.` };
    case 'api-unavailable': return { headline: `${name}’s automation is not available`, detail: `${raw} Check that automation is switched on in ${name}’s preferences (some editions do not include it).` };
    case 'incompatible': return { headline: `This version of ${name} is not supported`, detail: raw };
    default: return { headline: `Could not connect to ${name}`, detail: `CreateCraft could not start or test ${name}. Nothing was changed. You can try again, or use Repair in Settings > Integrations.` };
  }
}

/**
 * Text of the native "Run X in Y?" question, in plain language first and the technical permission names after it
 * (advanced users still see exactly what is asked). Pure so the wording is tested.
 */
export function approvalDetail(r: { command: { description: string }; params: Record<string, unknown>; needed: Permission[]; destructive: boolean; untrusted?: boolean }): string {
  const nl = String.fromCharCode(10);
  const lines: string[] = [r.command.description, ''];
  if (r.needed.length) {
    lines.push('To do this CreateCraft needs your OK to:');
    for (const p of r.needed) lines.push(`  • ${PERMISSION_PLAIN[p].title}`);
    lines.push(`Technical: ${r.needed.map((p) => PERMISSION_LABEL[p].toLowerCase()).join('; ')}.`);
  } else lines.push('You already allowed everything this needs.');
  if (Object.keys(r.params).length) lines.push('', `Settings: ${Object.entries(r.params).map(([k, v]) => `${k} ${String(v)}`).join(', ')}`);
  lines.push('');
  if (r.untrusted) lines.push('This connector is NOT signed, so CreateCraft cannot tell who made it. You are asked every time.');
  lines.push(r.destructive
    ? 'This can change or remove work you already have and may not be undoable. You are asked every time.'
    : 'New files go into this project’s external folder; your existing files are not changed.');
  return lines.join(nl);
}

export const ADAPTER_STATE_LABEL: Record<AdapterState, string> = {
  installed: 'Connector installed',
  available: 'Connector available',
  planned: 'Planned, not built yet',
  none: 'No connector',
};

/** Short chip text for an entry (the full sentence is `headline` / `explanation`). */
export function chipText(e: Pick<ConnectEntry, 'group' | 'status' | 'adapterState'>): string {
  switch (e.group) {
    case 'connected': return STATUS_LABEL[e.status];
    case 'ready': return 'Ready to connect';
    case 'needs-adapter': return 'Connector available';
    case 'attention': return STATUS_LABEL[e.status];
    case 'incompatible': return 'Version not supported';
    default: return e.adapterState === 'planned' ? 'Not supported yet' : 'No connector';
  }
}

/** Chip colour class used by the existing `.chip` styles. */
export const GROUP_CHIP: Record<ConnectGroup, string> = { connected: 'ok', ready: 'real', 'needs-adapter': 'real', attention: 'warn', incompatible: 'warn', unsupported: 'off' };
