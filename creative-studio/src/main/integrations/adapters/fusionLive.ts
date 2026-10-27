// Fusion's window shown INSIDE OmniCandy (the Software tab), like Blender and Unreal: after app.launch (or app.show) the host docks
// the window of the running Fusion into OmniCandy. The adapter only reports the process id; docking itself is the host's.

export interface FusionLiveHooks { onShow?: (pid: number) => void; onExit?: (pid: number) => void }
let hooks: FusionLiveHooks | null = null;
export function setFusionLiveHooks(h: FusionLiveHooks | null): void { hooks = h; }
export const fusionLive = (): FusionLiveHooks | null => hooks;

/** The running Fusion, or null. (Windows reports no "main window" for Fusion's Qt windows, so the process itself is what counts; the host finds the window.) Replaced in tests. */
export const fusionProcess: { windowPid: () => Promise<number | null> } = {
  windowPid: async () => {
    const { runProcess } = await import('../process');
    const script = "(Get-Process -Name Fusion360 -ErrorAction SilentlyContinue | Select-Object -First 1).Id";
    const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10_000, label: 'PowerShell' }).catch(() => null);
    const n = Number((r?.out ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  },
};
