// DaVinci Resolve's window shown INSIDE OmniCandy (the Software tab), like Blender, Unreal and Fusion: after app.launch (or app.show) the
// host docks the window of the running Resolve into OmniCandy. The adapter only reports the process id; docking itself is the host's.

export interface ResolveLiveHooks { onShow?: (pid: number) => void; onExit?: (pid: number) => void }
let hooks: ResolveLiveHooks | null = null;
export function setResolveLiveHooks(h: ResolveLiveHooks | null): void { hooks = h; }
export const resolveLive = (): ResolveLiveHooks | null => hooks;

/** The running Resolve, or null. The host finds the window from the process. Replaced in tests. */
export const resolveProcess: { windowPid: () => Promise<number | null> } = {
  windowPid: async () => {
    const { runProcess } = await import('../process');
    const script = '(Get-Process -Name Resolve -ErrorAction SilentlyContinue | Select-Object -First 1).Id';
    const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10_000, label: 'PowerShell' }).catch(() => null);
    const n = Number((r?.out ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  },
};
