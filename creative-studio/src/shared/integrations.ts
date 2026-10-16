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
  /** Runs as a job (renders, exports): returns a job handle at once; progress, cancel and result via the job. */
  longRunning?: boolean;
}

/** What an adapter needs before it can work; shown before the user connects. */
export interface AdapterRequirement {
  kind: 'application' | 'edition' | 'running' | 'runtime' | 'preference' | 'licence' | 'other';
  text: string;
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
  /** The adapter's own version (packages); built-in adapters are versioned with CreateCraft. */
  version?: string;
  description?: string;
  license?: string;
  /** Several supported application version ranges; `versions` stays the overall hull. */
  versionRanges?: Array<{ min?: string; max?: string }>;
  requirements?: AdapterRequirement[];
  /** Where the adapter came from. */
  source?: 'built-in' | 'package';
  /** Packages only: how far the publisher is trusted. */
  trust?: TrustLevel;
  /** The adapter needs no installed program (it brings its own logic); CreateCraft lists it directly. */
  selfContained?: boolean;
}

/** built-in: ships with CreateCraft. trusted-publisher: signed by a publisher the user trusted. unsigned: no signature. */
export type TrustLevel = 'built-in' | 'trusted-publisher' | 'unsigned';

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
  adapterVersion: string | null;
  origin: 'built-in' | 'package' | null;
  trust: TrustLevel | null;
  requirements: AdapterRequirement[];
  selfContained: boolean;
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

export interface ApprovalRequest {
  app: ExternalAppInfo; command: CommandSpec; params: Record<string, unknown>; needed: Permission[]; destructive: boolean;
  /** An unsigned package: it is asked every time and "always" is not offered. */
  untrusted?: boolean;
}
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

export function versionSupported(v: string | null, range: AdapterManifest['versions'], ranges?: AdapterManifest['versionRanges']): 'ok' | 'unknown' | 'too-old' | 'too-new' {
  if (!v) return 'unknown';
  const all = ranges?.length ? ranges : [range];
  const inside = (r: { min?: string; max?: string }) => (!r.min || compareVersions(v, r.min) >= 0) && (!r.max || compareVersions(v, r.max) <= 0);
  if (all.some(inside)) return 'ok';
  // Outside every range: older than the oldest supported version, otherwise newer (or in a gap between ranges).
  const lowest = all.every((r) => r.min) ? all.map((r) => r.min!).sort(compareVersions)[0] : undefined;
  return lowest && compareVersions(v, lowest) < 0 ? 'too-old' : 'too-new';
}

// ---- installable adapter packages ----

export const PACKAGE_MANIFEST_VERSION = 1;
export const PACKAGE_EXTENSION = '.ccadapter';

export type SignatureState = 'valid' | 'unsigned' | 'invalid';

/** What the user is shown before installing: everything is recomputed in main, never trusted from the renderer. */
export interface PackageReview {
  /** Where it was read from (file or folder). */
  path: string;
  /** Blocking problems; when non-empty the package cannot be installed. */
  problems: string[];
  /** Warnings that do not block (unsigned, new publisher, ...). */
  warnings: string[];
  id: string | null;
  name: string | null;
  version: string | null;
  description: string | null;
  license: string | null;
  homepage: string | null;
  publisherName: string | null;
  /** First 16 bytes of SHA-256 of the signing key, grouped; null when unsigned. */
  fingerprint: string | null;
  signature: SignatureState;
  publisherTrusted: boolean;
  applicationName: string | null;
  selfContained: boolean;
  sdk: { min: number; max: number } | null;
  requirements: AdapterRequirement[];
  commands: Array<{ id: string; label: string; description: string; permissions: Permission[]; destructive: boolean; longRunning: boolean }>;
  /** Union of the permissions its commands may use. */
  permissions: Permission[];
  installedVersion: string | null;
  action: 'install' | 'update' | 'reinstall' | 'blocked';
  fileCount: number;
  bytes: number;
}

export interface PackageApproval {
  /** Subset of the requested permissions the user allowed. Commands needing others are refused. */
  permissions: Permission[];
  /** Required to install an unsigned package. */
  allowUnsigned?: boolean;
  /** Required to install a signed package from a publisher not trusted yet; remembers the publisher. */
  trustPublisher?: boolean;
}

export type InstalledState = 'ok' | 'disabled' | 'tampered' | 'incompatible' | 'missing-files' | 'crash-disabled';

export interface InstalledAdapter {
  id: string;
  name: string;
  version: string;
  description: string | null;
  license: string | null;
  publisherName: string;
  fingerprint: string | null;
  trust: TrustLevel;
  enabled: boolean;
  state: InstalledState;
  stateDetail: string;
  applicationName: string;
  selfContained: boolean;
  sdkCompatible: boolean;
  requirements: AdapterRequirement[];
  approvedPermissions: Permission[];
  requestedPermissions: Permission[];
  commandCount: number;
  installedAt: string;
  /** Ran inside the OS-level Node permission model (no spawning, no writes) as opposed to plain process isolation. */
  restricted: boolean;
}

export interface PackageListing { installed: InstalledAdapter[]; inbox: PackageReview[]; inboxDir: string; trustedPublishers: Array<{ fingerprint: string; name: string; addedAt: string }> }

// ---- jobs ----

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface JobInfo {
  id: string;
  appKey: string;
  appName: string;
  commandId: string;
  status: JobStatus;
  stage: string;
  fraction: number | null;
  startedAt: string;
  finishedAt: string | null;
  result: CommandResult | null;
}
