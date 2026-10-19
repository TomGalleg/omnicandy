// How the rest of OmniCandy reaches ONE installed plugin: a thin, permission-aware view of the bridge server.

import type { Permission } from '@shared/integrations';
import type { BridgeServer, CallOptions, CallResult, SessionInfo } from './server';
import { BridgeError } from './protocol';

export interface PluginLink {
  pluginId: string;
  /** What the installed manifest allows this plugin to offer, and what each capability needs. */
  declared: Map<string, Permission[]>;
  session(): SessionInfo | null;
  waitForSession(ms: number, signal?: AbortSignal): Promise<SessionInfo | null>;
  health(timeoutMs?: number): Promise<CallResult>;
  call(name: string, params: Record<string, string | number | boolean>, opts?: CallOptions): Promise<CallResult>;
}

export function makePluginLink(bridge: BridgeServer, pluginId: string, caps: Array<{ id: string; permissions: Permission[] }>): PluginLink {
  const declared = new Map(caps.map((c) => [c.id, c.permissions]));
  return {
    pluginId, declared,
    session: () => bridge.session(pluginId),
    waitForSession: (ms, signal) => bridge.waitForSession(pluginId, ms, signal),
    health: (t) => bridge.health(pluginId, t),
    call: (name, params, opts) => {
      if (!declared.has(name)) return Promise.reject(new BridgeError('unsupported', `"${name}" is not one of this add-in's declared capabilities.`));
      return bridge.call(pluginId, name, params, opts);
    },
  };
}
