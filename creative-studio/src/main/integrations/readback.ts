import type { CommandSpec } from '@shared/integrations';

/**
 * External commands whose result may be used as independent read-back evidence by the Independent AI agent.
 *
 * Trust is decided by the HOST, never by an adapter's own `verified` flag or a package's manifest:
 *  - the adapter must be built in (installed packages and private connectors can claim anything), and
 *  - the exact command must be named here. Each entry is a command the built-in adapter itself documents as
 *    read only, and each one re-reads the real application state (a fresh Blender process opens the saved file;
 *    Resolve is queried live) instead of echoing what an edit command reported, and
 *  - the spec must still declare itself idempotent, non-destructive, not long running and without any
 *    write/modify permission, so a later change to the adapter can only remove trust, never grant it.
 * Anything not listed (including every edit command) is an execution receipt only.
 */
export const TRUSTED_READBACK_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  blender: ['scene.inspect', 'scene.inspect_detail', 'discover.search'],
  'davinci.resolve': ['app.info', 'project.list', 'project.inspect'],
};

const WRITING_PERMISSIONS = new Set<string>(['write-files', 'modify-project', 'ui-automation', 'network']);

export function isTrustedReadbackCommand(isBuiltin: ((adapterId: string) => boolean) | undefined, adapterId: string | null | undefined, spec: CommandSpec): boolean {
  if (!isBuiltin || !adapterId || !isBuiltin(adapterId)) return false;
  if (!TRUSTED_READBACK_COMMANDS[adapterId]?.includes(spec.id)) return false;
  return spec.idempotent === true && !spec.destructive && !spec.longRunning && !spec.permissions.some((p) => WRITING_PERMISSIONS.has(p));
}
