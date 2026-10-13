// Follows another process's main window (position, size, minimized) via resources/window-tracker.ps1,
// and can make one of our windows an owned window of it. Windows-only; no native modules.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface TrackedWindowState {
  alive: boolean;
  found?: boolean;
  /** Physical screen pixels. */
  x?: number; y?: number; w?: number; h?: number;
  minimized?: boolean;
  maximized?: boolean;
  owned?: boolean;
}

export class WindowTracker extends EventEmitter<{ state: [TrackedWindowState]; exit: [] }> {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  last: TrackedWindowState | null = null;

  constructor(scriptPath: string, targetPid: number, panelHwnd: bigint) {
    super();
    this.proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-TargetPid', String(targetPid), '-PanelHwnd', panelHwnd.toString(),
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
          this.emit('state', s);
        } catch { /* ignore partial/garbled line */ }
      }
    });
    this.proc.on('exit', () => this.emit('exit'));
    this.proc.on('error', () => this.emit('exit'));
  }

  private send(cmd: string) {
    if (this.proc.exitCode === null && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  own() { this.send('own'); }
  disown() { this.send('disown'); }
  /** Restores and moves the tracked window (physical pixels). */
  move(r: { x: number; y: number; width: number; height: number }) {
    this.send(`move ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}`);
  }

  stop() {
    this.disown();
    this.proc.stdin.end();
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill(); }, 1000);
  }
}
