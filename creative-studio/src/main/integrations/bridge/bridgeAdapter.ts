// An adapter whose whole job is done by a plugin inside the program (internal-only integrations). It runs no third-party
// code in OmniCandy at all: every command is a typed request over the authenticated bridge, answered from inside the
// program's own API context.

import type { AdapterManifest, CommandSpec, DiscoveredApp, Permission, TrustLevel } from '@shared/integrations';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';
import { BridgeError } from './protocol';
import type { PluginLink } from './link';

export const NOT_CONNECTED_WAIT_MS = 1200;

/** Turns a bridge failure into the adapter error kinds the manager understands. */
export function toAdapterError(e: unknown): Error {
  if (!(e instanceof BridgeError)) return e instanceof Error ? e : new Error(String(e));
  switch (e.kind) {
    case 'unsupported': return new AdapterError('unsupported', e.message);
    case 'invalid-result': return new AdapterError('verification-failed', e.message);
    case 'plugin-error':
      return new AdapterError(e.pluginKind === 'invalid-params' ? 'invalid-params' : e.pluginKind === 'verification-failed' ? 'verification-failed' : e.pluginKind === 'unsupported' ? 'unsupported' : 'app-error', e.message);
    default: return new AdapterError('app-error', e.message);
  }
}

export async function pluginHealth(link: PluginLink, appName: string, waitMs = NOT_CONNECTED_WAIT_MS): Promise<HealthResult> {
  const s = await link.waitForSession(waitMs);
  if (!s) return { ok: false, state: 'not-running', detail: `${appName} has to be open so its OmniCandy add-in can connect. Open ${appName} (restart it if it was already open when the add-in was installed), then try again.` };
  try {
    const r = await link.health(10_000);
    return { ok: true, detail: `${s.appName}${s.appVersion ? ` ${s.appVersion}` : ''} answered a real check from inside the program through the add-in. ${r.message}`.trim() };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export interface BridgeFactoryOptions {
  manifest: AdapterManifest;
  link: PluginLink;
  /** Anchor file for self-contained packages. */
  anchorPath?: string;
  approved: Permission[];
  trust: TrustLevel;
}

export function makeBridgeFactory(o: BridgeFactoryOptions): AdapterFactory {
  const appName = o.manifest.name;
  return {
    manifest: o.manifest,
    permissionCeiling: [...o.approved],
    alwaysAsk: o.trust === 'unsigned',
    deferProbe: false,
    anchorPath: o.manifest.selfContained ? o.anchorPath : undefined,
    availableCommands: () => { const s = o.link.session(); return s?.registered ? new Set(s.capabilities) : null; },
    create: (): ExternalAdapter => ({
      probe: async (_app: DiscoveredApp): Promise<ProbeResult> => ({ version: o.link.session()?.appVersion ?? o.manifest.version ?? null }),
      connect: async () => undefined,
      disconnect: async () => undefined,
      healthCheck: () => pluginHealth(o.link, appName),
      dispose: async () => undefined,
      execute: async (command: CommandSpec, params, ctx: ExecuteContext): Promise<AdapterOutcome> => {
        try {
          const r = await o.link.call(command.id, params, { timeoutMs: command.timeoutMs, signal: ctx.signal, onProgress: ctx.progress });
          return { message: r.message, outputs: [], data: r.data, evidence: r.evidence, verified: r.verified };
        } catch (e) { throw toAdapterError(e); }
      },
    }),
  };
}
