// The Unreal Editor window shown INSIDE OmniCandy, like Blender's: when the editor is started (editor.launch) or an open one is picked
// (editor.show), the host docks its window into the Software tab so the user watches the work happen there instead of behind OmniCandy.
// The adapter only reports the process id; docking itself (an owned, borderless window kept over the work area) is the host's.

/** onSpawn: an editor that has just been started (its window is caught as it appears). onShow: one that is already open. */
export interface UnrealLiveHooks { onSpawn?: (pid: number) => void; onShow?: (pid: number) => void; onExit?: (pid: number) => void }
let hooks: UnrealLiveHooks | null = null;
export function setUnrealLiveHooks(h: UnrealLiveHooks | null): void { hooks = h; }
export const unrealLive = (): UnrealLiveHooks | null => hooks;

export interface RunningEditor { pid: number; commandLine: string; startedAt: number }
/** Lists the running Unreal editors; replaced in tests. */
export const processHooks: { list: () => Promise<RunningEditor[]>; ownerOfPort: (port: number) => Promise<number | null> } = {
  /** The process that is listening on a local port: for the MCP server, that is the editor OmniCandy is driving. */
  ownerOfPort: async (port) => {
    const { runProcess } = await import('../process');
    const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${Math.trunc(port)} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { timeoutMs: 10_000, label: 'PowerShell' }).catch(() => null);
    const n = Number((r?.out ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  },
  list: async () => {
    const { runProcess } = await import('../process');
    const script = "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | ForEach-Object { \"$($_.ProcessId)|$([DateTimeOffset]$_.CreationDate | ForEach-Object { $_.ToUnixTimeSeconds() })|$($_.CommandLine)\" }";
    const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20_000, label: 'PowerShell' }).catch(() => null);
    const out: RunningEditor[] = [];
    for (const line of (r?.out ?? '').split(/\r?\n/)) {
      const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
      if (m) out.push({ pid: Number(m[1]), startedAt: Number(m[2]), commandLine: m[3]! });
    }
    return out;
  },
};

/** The editor to show: the one running the given project file, else the newest one that has a project open. */
export function pickEditor(editors: RunningEditor[], uproject: string | null): RunningEditor | null {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  if (uproject) return editors.find((e) => norm(e.commandLine).includes(norm(uproject))) ?? null;
  const withProject = editors.filter((e) => /\.uproject/i.test(e.commandLine)).sort((a, b) => b.startedAt - a.startedAt);
  return withProject[0] ?? null;
}
