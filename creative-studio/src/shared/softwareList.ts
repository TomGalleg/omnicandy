import type { ExternalAppInfo, IntegrationStatus } from './integrations';

/** Lower is better: what a person most wants to see first when a program is found more than once. */
const RANK: Record<IntegrationStatus, number> = {
  connected: 0, limited: 0, available: 1, detected: 1, 'not-running': 1, 'api-unavailable': 1, 'needs-repair': 1, unsupported: 2, incompatible: 3,
};

/** Compares dotted versions ("5.8.4" vs "5.4.4"); a missing version sorts last. */
export function compareVersions(a: string | null, b: string | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number), pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface SoftwareRow { app: ExternalAppInfo; /** Other copies of the same program that were found and are not shown. */ others: number }

/** One row per program: the same program found twice (an old and a new install, two paths) shows only its best copy. */
export function groupInstalls(apps: ExternalAppInfo[]): SoftwareRow[] {
  const groups = new Map<string, ExternalAppInfo[]>();
  for (const a of apps) {
    const key = a.adapterId ?? a.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.values()].map((list) => {
    const sorted = list.slice().sort((x, y) => RANK[x.status] - RANK[y.status] || compareVersions(x.version, y.version));
    return { app: sorted[0]!, others: sorted.length - 1 };
  });
}

/** What to do next when a program is found but OmniCandy cannot reach it yet. Null when the status line already says enough. */
export function nextStep(a: Pick<ExternalAppInfo, 'adapterId' | 'name' | 'status'>): string | null {
  if (a.status !== 'api-unavailable' && a.status !== 'not-running') return null;
  const id = `${a.adapterId ?? ''} ${a.name}`.toLowerCase();
  if (id.includes('unreal')) return 'Open the Unreal Editor on a project, turn on the Unreal MCP and All Toolsets plugins and Auto Start Server, then press Connect.';
  if (id.includes('fusion')) return 'Open Fusion with a document, turn on Preferences > General > API > "Fusion MCP Server", then press Connect.';
  if (id.includes('resolve')) return 'Start DaVinci Resolve (Studio edition, "External scripting using" set to Local), then press Connect.';
  return null;
}
