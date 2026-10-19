// Adapter SDK (contract version 1). An adapter drives ONE external application family through a
// control method it really has. The manager owns permissions, timeouts, verification and logging, so
// an adapter only has to do the application-specific part and report facts.

import type { AdapterManifest, CommandSpec, DiscoveredApp, Permission } from '@shared/integrations';

export interface ProbeResult {
  /** Version read from the program itself ("4.0.2"), or null when it could not be read. */
  version: string | null;
  detail?: string;
}

/**
 * `state` lets an adapter say WHY it is not usable, so the UI can show a precise status instead of a
 * generic failure: the program is not running (live-session applications such as Resolve), or it runs
 * but its scripting interface is not reachable (edition or preference).
 */
export interface HealthResult { ok: boolean; detail: string; state?: 'not-running' | 'api-unavailable' }

export interface ExecuteContext {
  app: DiscoveredApp;
  /** Private working folder for this application inside the project; outputs go here. */
  workDir: string;
  /** Aborted on cancel or timeout; adapters must stop their work and clean up. */
  signal: AbortSignal;
  progress(stage: string, fraction?: number): void;
}

export interface AdapterOutcome {
  message: string;
  /** Files produced; the manager checks they exist and are not empty. */
  outputs: string[];
  data?: Record<string, unknown>;
  /** Facts the adapter itself checked (for example "re-opened in Blender: 1 mesh, 1 camera, 1 light"). */
  evidence?: string[];
  /** The adapter confirmed the outcome beyond file existence. */
  verified?: boolean;
}

/** Thrown by adapters to classify a failure; anything else becomes 'app-error' / 'internal'. */
export class AdapterError extends Error {
  constructor(readonly kind: 'app-error' | 'unsupported' | 'invalid-params' | 'missing-app' | 'verification-failed', message: string) { super(message); }
}

export interface ExternalAdapter {
  /** Reads the real version and checks the program can be driven. Must not modify anything. */
  probe(app: DiscoveredApp): Promise<ProbeResult>;
  connect(app: DiscoveredApp): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthResult>;
  execute(command: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome>;
  dispose(): Promise<void>;
}

/** What the plugin loader registers: declarative manifest plus a factory (one adapter per connection). */
export interface AdapterFactory {
  manifest: AdapterManifest;
  create(): ExternalAdapter;
  /**
   * Packages only. The permissions the user approved at install: the manager refuses any command that needs
   * another one, whatever the manifest declares. Absent for built-in adapters.
   */
  permissionCeiling?: Permission[];
  /** Do not run adapter code while scanning (unsigned packages run only when the user presses Connect). */
  deferProbe?: boolean;
  /** Ask before every run and never offer "always allow" (unsigned packages). */
  alwaysAsk?: boolean;
  /** Self-contained adapters: a file inside the package that stands in for the program (must exist). */
  anchorPath?: string;
  /**
   * Integrations with a plugin inside the program: the commands the plugin has registered right now. Null means "no live
   * information" (not connected); the manager then does not narrow. Commands outside the set are refused as unsupported.
   */
  availableCommands?(): ReadonlySet<string> | null;
  /** Forget crash counters etc. (Repair). */
  reset?(): void;
}

const PERMISSIONS = new Set(['read-info', 'launch', 'open-files', 'read-project', 'modify-project', 'write-files', 'execute-scripts', 'ui-automation', 'network']);
const METHODS = new Set(['api', 'scripting', 'mcp', 'cli', 'file-exchange', 'ui-automation', 'visual']);

/** Validates a manifest before it is registered. Returns the problems (empty when fine). */
export function validateManifest(m: AdapterManifest, sdkVersion: number): string[] {
  const p: string[] = [];
  if (m.sdkVersion !== sdkVersion) p.push(`built for adapter SDK ${m.sdkVersion}, this OmniCandi speaks ${sdkVersion}`);
  if (!/^[a-z0-9][a-z0-9.-]{1,60}$/.test(m.id)) p.push('id must be lower-case letters, digits, "." or "-"');
  if (!m.exeNames.length && !m.selfContained) p.push('exeNames is empty');
  for (const r of m.versionRanges ?? []) {
    for (const v of [r.min, r.max]) if (v !== undefined && !/^\d+(\.\d+){0,2}$/.test(v)) p.push(`bad version "${v}" in versionRanges`);
  }
  for (const x of m.methods) if (!METHODS.has(x)) p.push(`unknown control method "${x}"`);
  const ids = new Set<string>();
  for (const c of m.commands) {
    if (ids.has(c.id)) p.push(`duplicate command ${c.id}`);
    ids.add(c.id);
    for (const x of c.permissions) if (!PERMISSIONS.has(x)) p.push(`${c.id}: unknown permission "${x}"`);
    if (m.maturity === 'stub') p.push(`${c.id}: a stub adapter must not declare commands`);
  }
  if (m.commands.length && !m.capabilities.includes('executeCommand')) p.push('declares commands without the executeCommand capability');
  return p;
}
