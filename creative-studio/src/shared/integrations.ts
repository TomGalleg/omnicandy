// Universal Application Integration Framework: the contract shared by main, renderer and adapters.
// This layer is for EXTERNAL third-party software only. The 13 native Craft apps keep their own
// first-party integrations (liveApps.ts, liveTask.ts) and are never routed through here.

export const ADAPTER_SDK_VERSION = 1;

/** How an application can be controlled. Official APIs and scripting come before UI automation. */
export type ControlMethod = 'api' | 'scripting' | 'mcp' | 'cli' | 'file-exchange' | 'ui-automation' | 'visual';

/** Ordered by preference: the manager picks the first method an adapter declares. */
export const METHOD_PREFERENCE: ControlMethod[] = ['api', 'scripting', 'mcp', 'cli', 'file-exchange', 'ui-automation', 'visual'];

/** What the user is asked to allow, scoped per application. */
export type Permission =
  | 'read-info' | 'launch' | 'open-files' | 'read-project' | 'modify-project'
  | 'write-files' | 'execute-scripts' | 'ui-automation' | 'network';

export const PERMISSION_LABEL: Record<Permission, string> = {
  'read-info': 'Read application information',
  launch: 'Start the application',
  'open-files': 'Open files',
  'read-project': 'Read project data',
  'modify-project': 'Modify project data',
  'write-files': 'Write or export files',
  'execute-scripts': 'Run scripts inside the application',
  'ui-automation': 'Control the application window',
  network: 'Use network services',
};

/** Operations an adapter may implement. The router only calls what an adapter declares. */
export type CapabilityId =
  | 'detect' | 'inspectCapabilities' | 'connect' | 'disconnect' | 'healthCheck' | 'launch' | 'openProject'
  | 'executeCommand' | 'getExecutionStatus' | 'cancelOperation' | 'saveProject' | 'exportFile'
  | 'importFile' | 'getApplicationState' | 'dispose';

export type ParamType = 'string' | 'number' | 'boolean';
export interface ParamSpec { type: ParamType; description: string; required?: boolean; default?: string | number | boolean; min?: number; max?: number }

/** A typed command an adapter exposes. */
export interface CommandSpec {
  id: string;
  label: string;
  description: string;
  params: Record<string, ParamSpec>;
  permissions: Permission[];
  /** Always asks the user, even when the permissions were granted before. */
  destructive?: boolean;
  /** Running it twice with the same params gives the same result. */
  idempotent?: boolean;
  /** Longest it may run, ms. */
  timeoutMs?: number;
}

export type AdapterMaturity = 'verified' | 'experimental' | 'stub';

/** Versioned, declarative description of an adapter; what plugin loading validates. */
export interface AdapterManifest {
  id: string;
  name: string;
  vendor: string;
  sdkVersion: number;
  maturity: AdapterMaturity;
  /** Case-insensitive executable names this adapter drives (without folder). */
  exeNames: string[];
  /** Regexes (as strings) tested against the program's display name. */
  displayNames: string[];
  /** Inclusive supported version range, "major.minor[.patch]". */
  versions: { min?: string; max?: string };
  methods: ControlMethod[];
  capabilities: CapabilityId[];
  commands: CommandSpec[];
  /** Plain-language note shown to the user (requirements, administrator rights, licence...). */
  notes?: string;
}

export type IntegrationStatus = 'detected' | 'available' | 'connected' | 'limited' | 'unsupported' | 'needs-repair' | 'incompatible' | 'not-running' | 'api-unavailable';

export const STATUS_LABEL: Record<IntegrationStatus, string> = {
  detected: 'Detected',
  available: 'Available to connect',
  connected: 'Connected',
  limited: 'Limited functionality',
  unsupported: 'Unsupported',
  'needs-repair': 'Needs repair',
  incompatible: 'Incompatible version',
  'not-running': 'Not running',
  'api-unavailable': 'Scripting not available',
};

export interface DiscoveredApp {
  /** Stable key for this installation (lower-cased executable path). */
  key: string;
  name: string;
  publisher: string | null;
  version: string | null;
  exePath: string;
  installType: 'installed' | 'portable' | 'path' | 'user' | 'running';
  source: 'registry' | 'app-paths' | 'common-dir' | 'path' | 'running' | 'user';
}

/** What the UI and the router see for one application. */
export interface ExternalAppInfo extends DiscoveredApp {
  adapterId: string | null;
  adapterName: string | null;
  maturity: AdapterMaturity | null;
  methods: ControlMethod[];
  status: IntegrationStatus;
  statusDetail: string;
  commands: CommandSpec[];
  /** Permissions already granted for this app. */
  granted: Permission[];
  /** Permissions its commands may ask for. */
  permissionsNeeded: Permission[];
  notes: string | null;
}

/** Result of a scan: found applications plus adapters whose program was not found. */
export interface ExternalScan {
  apps: ExternalAppInfo[];
  missing: Array<{ adapterId: string; name: string; vendor: string; maturity: AdapterMaturity }>;
}

export type CommandErrorKind =
  | 'not-connected' | 'unsupported' | 'permission-denied' | 'invalid-params' | 'timeout' | 'cancelled'
  | 'app-error' | 'verification-failed' | 'missing-app' | 'internal';

export interface CommandResult {
  ok: boolean;
  /** True only when the manager (or adapter) checked the outcome, e.g. the file exists and re-opens. */
  verified: boolean;
  message: string;
  /** Human-readable facts that were actually checked. */
  evidence: string[];
  outputs: Array<{ path: string; bytes: number; kind: string }>;
  data?: Record<string, unknown>;
  error?: { kind: CommandErrorKind; message: string };
  durationMs: number;
}

export interface ProgressEvent { opId: string; appKey: string; commandId: string; stage: string; fraction?: number }

export interface ApprovalRequest { app: ExternalAppInfo; command: CommandSpec; params: Record<string, unknown>; needed: Permission[]; destructive: boolean }
export type ApprovalAnswer = 'once' | 'always' | 'deny';

/** "major.minor.patch" comparison; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function versionSupported(v: string | null, range: AdapterManifest['versions']): 'ok' | 'unknown' | 'too-old' | 'too-new' {
  if (!v) return 'unknown';
  if (range.min && compareVersions(v, range.min) < 0) return 'too-old';
  if (range.max && compareVersions(v, range.max) > 0) return 'too-new';
  return 'ok';
}
