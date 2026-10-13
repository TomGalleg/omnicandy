// REAL live control of the PhotoCraft desktop app.
//
// Launches `photocraft.exe --control <port>` with:
//   - a random 64-hex control token, written to a file only main can read and passed by path
//     (PHOTOCRAFT_CONTROL_TOKEN_FILE); it never reaches the renderer, logs or project files;
//   - automation roots (PHOTOCRAFT_AUTOMATION_READ_ROOT / _WRITE_ROOT) so PhotoCraft itself refuses
//     any automated open/save outside the project (read) and its work/live folder (write).
// Then talks to it through `photocraft-cli mcp --bridge 127.0.0.1:<port> --control-token-file …`.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { photocraftCommand, type EditValues } from '@shared/appEditors';
import type { AppOperation } from '@shared/contracts';
import { McpClient } from './mcpClient';

/** What the live task controller needs from an open document. Implemented for real below; faked in tests. */
export interface LiveDoc {
  open(absPath: string): Promise<{ name: string }>;
  run(op: AppOperation): Promise<void>;
  /** Undo-history step names of the active document (changes whenever anyone edits it). */
  history(): Promise<string[]>;
  /**
   * Writes the open document for a new library version into `dir` (the app's write root):
   * the editable/main file first, plus an optional PNG preview. Paths returned are inside `dir`.
   */
  writeVersion(dir: string, base: string): Promise<{ main: string; preview?: string }>;
  undo?(): Promise<void>;
  /** Engine commands for a quick edit from src/shared/appEditors.ts. */
  quickEditSteps?(opId: string, values: EditValues): AppOperation[];
  /** PNG of the live app window, from the app's own screenshot tool. */
  screenshot?(maxSide: number): Promise<Buffer | null>;
}

export function versionOf(history: string[]): string {
  return `${history.length}:${createHash('sha1').update(history.join('\u0000')).digest('hex').slice(0, 12)}`;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function waitForPort(port: number, timeoutMs: number, isDead: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (isDead()) return reject(new Error('PhotoCraft exited before it was ready.'));
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('PhotoCraft did not open its control port in time.'));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

export interface LivePhotoCraftOptions {
  installDir: string;
  /** Private directory for the token file (app userData). */
  secretsDir: string;
  readRoot: string;
  writeRoot: string;
}

export class LivePhotoCraft implements LiveDoc {
  private gui: ChildProcess | null = null;
  private mcp: McpClient | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly o: LivePhotoCraftOptions) {}

  /** Process id of the PhotoCraft window this session started (for window docking). */
  get pid(): number | null {
    return this.connected ? this.gui!.pid ?? null : null;
  }

  get connected(): boolean {
    return !!this.mcp?.alive && !!this.gui && this.gui.exitCode === null;
  }

  /** Starts PhotoCraft (or reuses the running one) and connects the bridge. */
  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    this.stop();
    await fs.mkdir(this.o.secretsDir, { recursive: true });
    await fs.mkdir(this.o.writeRoot, { recursive: true });
    const tokenFile = path.join(this.o.secretsDir, 'photocraft-control-token');
    await fs.writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const port = await freePort();

    const gui = spawn(path.join(this.o.installDir, 'photocraft.exe'), ['--control', String(port)], {
      env: {
        ...process.env,
        PHOTOCRAFT_CONTROL_TOKEN_FILE: tokenFile,
        PHOTOCRAFT_AUTOMATION_READ_ROOT: this.o.readRoot,
        PHOTOCRAFT_AUTOMATION_WRITE_ROOT: this.o.writeRoot,
      },
      stdio: 'ignore',
      windowsHide: false,
    });
    this.gui = gui;
    gui.on('exit', () => { if (this.gui === gui) { this.gui = null; this.mcp?.close(); this.mcp = null; } });

    await waitForPort(port, 30_000, () => gui.exitCode !== null);
    this.mcp = await McpClient.start(path.join(this.o.installDir, 'photocraft-cli.exe'), [
      'mcp', '--bridge', `127.0.0.1:${port}`, '--control-token-file', tokenFile,
    ]);
  }

  private client(): McpClient {
    if (!this.connected || !this.mcp) throw new Error('PhotoCraft is not running (was its window closed?).');
    return this.mcp;
  }

  async open(absPath: string): Promise<{ name: string }> {
    const r = (await this.client().callTool('doc_open', { path: absPath })) as { name?: string };
    return { name: r?.name ?? path.basename(absPath) };
  }

  async run(op: AppOperation): Promise<void> {
    await this.client().callTool('command_run', { id: op.command, params: op.params, wait: true }, 300_000);
  }

  async history(): Promise<string[]> {
    const r = (await this.client().callTool('doc_inspect', {})) as { history?: unknown };
    return Array.isArray(r?.history) ? r.history.map(String) : [];
  }

  async saveNative(absPath: string): Promise<void> {
    await this.client().callTool('doc_save', { path: absPath }, 300_000);
  }

  async exportPng(absPath: string): Promise<void> {
    // Bridge mode picks the format from the extension (an explicit `format` is headless-only).
    await this.client().callTool('doc_export', { path: absPath }, 300_000);
  }

  async writeVersion(dir: string, base: string): Promise<{ main: string; preview?: string }> {
    const main = path.join(dir, `${base}.pcraft`);
    const preview = path.join(dir, `${base}.png`);
    await this.saveNative(main);
    await this.exportPng(preview);
    return { main, preview };
  }

  async undo(): Promise<void> {
    await this.client().callTool('command_run', { id: 'edit.undo', params: {}, wait: true });
  }

  quickEditSteps(opId: string, values: EditValues): AppOperation[] {
    return [photocraftCommand(opId, values)];
  }

  async screenshot(maxSide: number): Promise<Buffer | null> {
    const r = (await this.client().request('tools/call', { name: 'ui_screenshot', arguments: { max_side: maxSide } })) as { content?: Array<{ type: string; data?: string }> };
    const img = r.content?.find((c) => c.type === 'image');
    return img?.data ? Buffer.from(img.data, 'base64') : null;
  }

  /** Closes the PhotoCraft window this session started, discarding unsaved changes. Tests only. */
  killApp() {
    const g = this.gui;
    this.stop();
    g?.kill();
  }

  /** Disconnects. PhotoCraft stays open so any unsaved work in its window is not lost. */
  stop() {
    this.mcp?.close();
    this.mcp = null;
    this.gui = null;
  }
}
