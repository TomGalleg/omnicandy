// The editable copy of OmniCandy's source that the Build chat works in.
// - Running from its source folder (development): that folder is the workspace.
// - Installed: the installer carries the source (resources/source). "Set up editing" unpacks it to "OmniCandy Source" in the user folder and
//   installs its dependencies. "Rebuild and restart" builds that copy and relaunches into it; if the edited copy never comes up,
//   the original starts instead. "Restore original" puts the shipped source back.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_WORKSPACE, type WorkspaceState } from '@shared/buildSession';
import { findOnPath } from './platform/exec';

export const USE_EDITED = '.use-edited';
export const STARTED_OK = '.started-ok';
const SOURCE_ITEMS = ['src', 'scripts', 'resources', 'fixtures', 'docs', 'package.json', 'package-lock.json', 'electron.vite.config.ts',
  'tsconfig.node.json', 'tsconfig.web.json', 'eslint.config.mjs', 'vitest.config.ts', 'electron-builder.yml', 'CLAUDE.md', 'README.md'];

const exists = (p: string) => fs.access(p).then(() => true, () => false);

export interface WorkspaceDeps {
  appPath: string;
  isPackaged: boolean;
  /** Folder the installer shipped the source in (resources/source), when installed. */
  bundleDir: string | null;
  /** Where the editable copy lives when installed. */
  workspaceDir: string;
  /** What to start if the edited copy does not come up: the installed program, or the dev electron with the app folder. */
  fallbackCommand: { cmd: string; args: string[] };
  emit: () => void;
  quit: () => void;
}

/** Where Node's commands are looked for: the PATH of this process plus the usual install folders (a fresh install is not on an old PATH). */
export function nodeDirs(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = process.platform): string[] {
  const extra = os === 'win32'
    ? [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'), path.join(env.LOCALAPPDATA ?? '', 'Programs', 'nodejs'), path.join(env.APPDATA ?? '', 'npm')]
    : ['/usr/local/bin', '/usr/bin'];
  return extra.filter(Boolean);
}


/** Starts the edited copy after this program has exited. If the copy never reports in (writes .started-ok), the fallback starts instead. */
export async function startWithFallback(root: string, electron: string, fb: { cmd: string; args: string[] }): Promise<void> {
  const ok = path.join(root, STARTED_OK);
  await fs.rm(ok, { force: true });
  if (process.platform === 'win32') {
    const q = (s: string) => `"${s.replace(/"/g, '')}"`;
    const script = path.join(root, '.relaunch.cmd');
    await fs.writeFile(script, [
      '@echo off', 'ping -n 3 127.0.0.1 >nul',
      `start /wait "" ${q(electron)} ${q(root)}`,
      `if not exist ${q(ok)} start "" ${[fb.cmd, ...fb.args].map(q).join(' ')}`,
    ].join('\r\n') + '\r\n');
    spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const script = path.join(root, '.relaunch.sh');
    const lines = ['#!/bin/sh', 'sleep 2', `${q(electron)} ${q(root)}`, `[ -f ${q(ok)} ] || ${[fb.cmd, ...fb.args].map(q).join(' ')}`];
    await fs.writeFile(script, lines.join('\n') + '\n', { mode: 0o755 });
    spawn('sh', [script], { detached: true, stdio: 'ignore' }).unref();
  }
}

export class EditWorkspace {
  private busy: string | null = null;
  private log: string[] = [];
  private nodeFound = false;
  private buildError: string | null = null;
  private editedFailed = false;
  private ready = false;
  private hasBundle = false;

  constructor(private d: WorkspaceDeps) {}

  private get root(): string { return this.d.isPackaged ? this.d.workspaceDir : this.d.appPath; }

  /** Re-reads the disk. Call before showing the state. */
  async refresh(): Promise<void> {
    this.ready = (await exists(path.join(this.root, 'package.json'))) && (await exists(path.join(this.root, 'src', 'renderer')))
      && (await exists(path.join(this.root, 'node_modules', 'electron', 'dist')));
    this.hasBundle = !!this.d.bundleDir && await exists(path.join(this.d.bundleDir, 'package.json'));
    this.nodeFound = (await this.npmEnv()).found;
    // The edited copy was asked for and started once, but it never reported in: the original was started instead.
    this.editedFailed = this.d.isPackaged && await exists(path.join(this.root, USE_EDITED)) && !(await exists(path.join(this.root, STARTED_OK)));
  }

  /** The source folder Claude should work in, or null until it is set up. */
  async sourceRoot(): Promise<string | null> {
    await this.refresh();
    return this.ready || (!this.d.isPackaged && await exists(path.join(this.root, 'src'))) ? this.root : null;
  }

  state(): WorkspaceState {
    const mode = this.d.isPackaged ? 'installed' : 'source';
    const state = this.busy ? 'busy' : this.ready ? 'ready' : this.hasBundle ? 'needs-setup' : 'no-bundle';
    return {
      ...EMPTY_WORKSPACE, mode, state, folder: this.root, step: this.busy, log: this.log.slice(-12), nodeFound: this.nodeFound,
      runningEdited: !this.d.isPackaged && path.resolve(this.d.appPath) === path.resolve(this.d.workspaceDir),
      editedFailed: this.editedFailed, buildError: this.buildError,
    };
  }

  private note(line: string) { this.log = [...this.log, ...line.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)].slice(-200); this.d.emit(); }

  private async npmEnv(): Promise<{ env: NodeJS.ProcessEnv; found: boolean }> {
    const sep = process.platform === 'win32' ? ';' : ':';
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...nodeDirs(), process.env.PATH ?? process.env.Path ?? ''].join(sep) };
    delete env.ELECTRON_RUN_AS_NODE;
    const found = !!(await findOnPath('node', { env })) && !!(await findOnPath('npm', { env }));
    return { env, found };
  }

  /** Runs a command line in the workspace and resolves with its exit code, streaming output into the log. */
  private run(commandLine: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolve) => {
      const child = process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', commandLine], { cwd, env, windowsHide: true })
        : spawn('sh', ['-c', commandLine], { cwd, env });
      child.stdout.on('data', (b: Buffer) => this.note(b.toString()));
      child.stderr.on('data', (b: Buffer) => this.note(b.toString()));
      child.on('error', (e) => { this.note(e.message); resolve(1); });
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  private async withBusy(step: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error('Something is already running. Wait for it to finish.');
    this.busy = step; this.log = []; this.buildError = null; this.d.emit();
    try { await fn(); } finally { this.busy = null; await this.refresh(); this.d.emit(); }
  }

  private async copyBundle(): Promise<void> {
    const from = this.d.bundleDir;
    if (!from || !(await exists(path.join(from, 'package.json')))) throw new Error('This installer does not include the source code.');
    await fs.mkdir(this.root, { recursive: true });
    for (const item of SOURCE_ITEMS) {
      await fs.rm(path.join(this.root, item), { recursive: true, force: true });
      if (await exists(path.join(from, item))) await fs.cp(path.join(from, item), path.join(this.root, item), { recursive: true });
    }
  }

  /** Unpacks the shipped source and installs what it needs. Takes a few minutes the first time. */
  setup(): Promise<void> {
    return this.withBusy('Setting up editing', async () => {
      const { env, found } = await this.npmEnv();
      if (!found) throw new Error('Node.js is needed to rebuild OmniCandy and is not installed. Install it, then press Set up editing again.');
      this.note('Copying the source…');
      await this.copyBundle();
      this.note('Installing what OmniCandy is built from (a few minutes, needs internet)…');
      const code = await this.run('npm install --no-audit --no-fund --loglevel=error', this.root, env);
      if (code !== 0) throw new Error('Installing failed. The last lines above say why; check the internet connection and try again.');
      // Some PCs have npm set to skip install scripts, which also skips Electron's own program download. Fetch it explicitly.
      if (!(await exists(path.join(this.root, 'node_modules', 'electron', 'dist')))) {
        this.note('Downloading the program files…');
        const dl = await this.run('node node_modules/electron/install.js', this.root, env);
        if (dl !== 0) throw new Error('Downloading the program files failed. Check the internet connection and try again.');
      }
      this.note('Done. You can now chat with Claude about changing OmniCandy.');
    });
  }

  /** Builds the workspace. On success the program restarts into it. */
  rebuildAndRestart(): Promise<void> {
    return this.withBusy('Building your version', async () => {
      const { env, found } = await this.npmEnv();
      if (!found) throw new Error('Node.js is needed to rebuild OmniCandy and is not installed.');
      for (const step of ['npx electron-vite build', 'node scripts/build-planner-mcp.mjs']) {
        this.note(`> ${step}`);
        const code = await this.run(step, this.root, env);
        if (code !== 0) {
          this.buildError = this.log.slice(-25).join('\n');
          throw new Error('The build failed. Ask Claude to fix it: the message above says what went wrong.');
        }
      }
      await this.launchInto();
    });
  }

  /** Quits OmniCandy and starts the workspace copy; if that never reports in, the fallback starts. */
  private async launchInto(): Promise<void> {
    const electron = path.join(this.root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    if (!(await exists(electron))) throw new Error('The editable copy has no program to run yet. Press Set up editing first.');
    if (this.d.isPackaged) await fs.writeFile(path.join(this.root, USE_EDITED), 'on\n');
    await startWithFallback(this.root, electron, this.d.fallbackCommand);
    this.d.quit();
  }

  /** Puts the shipped source back and goes back to the original program at the next start. Keeps installed dependencies. */
  restoreOriginal(): Promise<void> {
    return this.withBusy('Restoring the original', async () => {
      await this.copyBundle();
      await fs.rm(path.join(this.root, USE_EDITED), { force: true });
      this.note('Restored. Restart OmniCandy to use the original.');
    });
  }

  /** Opens winget in a visible window to install Node.js (Windows). */
  installNode(): void {
    if (process.platform !== 'win32') throw new Error('Install Node.js from nodejs.org, then press Set up editing again.');
    spawn('cmd.exe', ['/d', '/c', 'start', '"Install Node.js"', 'cmd', '/k', 'winget install OpenJS.NodeJS.LTS'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  }
}

/** At the start of an installed copy: the person's edited copy's program, if it should be started instead (it was asked for and came up last time). */
export function editedCopyToStart(workspaceDir: string): string | null {
  const has = (...p: string[]) => existsSync(path.join(workspaceDir, ...p));
  if (!has(USE_EDITED) || !has(STARTED_OK) || !has('out', 'main', 'index.js')) return null;
  const electron = path.join(workspaceDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  return existsSync(electron) ? electron : null;
}
