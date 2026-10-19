// Follows another process's main window (position, size, minimized) via resources/window-tracker.ps1,
// and can make one of our windows an owned window of it. Windows-only; no native modules.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

export interface TrackedWindowState {
  alive: boolean;
  found?: boolean;
  /** Physical screen pixels. */
  x?: number; y?: number; w?: number; h?: number;
  minimized?: boolean;
  maximized?: boolean;
  owned?: boolean;
}

let trackerSeq = 0;

export class WindowTracker extends EventEmitter<{ state: [TrackedWindowState]; exit: [] }> {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  last: TrackedWindowState | null = null;
  private readonly seq = ++trackerSeq;

  /** targetPid 0 = pre-started: call target(pid) later. cloak = hide the window the instant it appears. */
  constructor(scriptPath: string, targetPid: number, panelHwnd: bigint, cloak = false) {
    super();
    this.proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-TargetPid', String(targetPid), '-PanelHwnd', panelHwnd.toString(), ...(cloak ? ['-Cloak'] : []),
    ], { windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const s = JSON.parse(line) as TrackedWindowState;
          this.last = s;
          if (process.env.CS_MCP_TRACE) { try { appendFileSync(process.env.CS_MCP_TRACE, `${new Date().toISOString()} window-tracker#${this.seq} <- ${line.slice(0, 200)}
`); } catch { /* ignore */ } }
          this.emit('state', s);
        } catch { /* ignore partial/garbled line */ }
      }
    });
    // The script exits by itself when the app closes; a write that races that exit must not crash the main process (EPIPE).
    this.proc.stdin.on('error', () => { /* tracker already gone */ });
    this.proc.on('exit', () => this.emit('exit'));
    this.proc.on('error', () => this.emit('exit'));
  }

  private send(cmd: string) {
    const trace = process.env.CS_MCP_TRACE; // same opt-in wire trace as McpClient
    if (trace) { try { appendFileSync(trace, `${new Date().toISOString()} window-tracker#${this.seq} -> ${cmd}
`); } catch { /* tracing never breaks a call */ } }
    if (this.proc.exitCode === null && this.proc.stdin.writable) { try { this.proc.stdin.write(cmd + '\n'); } catch { /* tracker already gone */ } }
  }

  target(pid: number) { this.send(`target ${pid}`); }
  uncloak() { this.send('uncloak'); }
  own() { this.send('own'); }
  /** Borderless target owned by `host` (stays above it, hides/minimizes with it). */
  embed(host: bigint) { this.send(`embed ${host.toString()}`); }
  unembed() { this.send('unembed'); }
  show() { this.send('show'); }
  hide() { this.send('hide'); }
  minimize() { this.send('minimize'); }
  disown() { this.send('disown'); }
  /** Restores and moves the tracked window (physical pixels). */
  move(r: { x: number; y: number; width: number; height: number }) {
    this.send(`move ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}`);
  }

  stop() {
    this.disown();
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill(); }, 1000);
  }
}
