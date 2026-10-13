// The pop-out control panel that sits against the left edge of the live app window (PhotoCraft).
//
// It is a frameless window of our own app (same page, `#panel` route, same sandboxed preload), made
// an *owned* window of PhotoCraft through Win32, so Windows keeps it above PhotoCraft and minimizes
// it with PhotoCraft. Its position follows PhotoCraft's window as you move or resize it. If there is
// no room to the left of PhotoCraft on that screen, PhotoCraft is nudged right once to make room.

import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { WindowTracker, type TrackedWindowState } from './windowTracker';

export const PANEL_WIDTH = 340;

export interface DockedPanelOptions {
  preload: string;
  load: (win: BrowserWindow) => Promise<void>;
  trackerScript: string;
  backgroundColor: string;
  onClosed: () => void;
}

export class DockedPanel {
  private win: BrowserWindow | null = null;
  private tracker: WindowTracker | null = null;
  private madeRoom = false;

  constructor(private readonly o: DockedPanelOptions) {}

  get isOpen(): boolean { return !!this.win && !this.win.isDestroyed(); }

  async open(targetPid: number): Promise<void> {
    if (this.isOpen) { this.win!.showInactive(); return; }
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: 700,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: 'Creative Studio · PhotoCraft controls',
      backgroundColor: this.o.backgroundColor,
      webPreferences: { preload: this.o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    this.win = win;
    this.madeRoom = false;
    win.on('closed', () => {
      this.win = null;
      this.tracker?.stop();
      this.tracker = null;
      this.o.onClosed();
    });
    await this.o.load(win);

    const hwnd = win.getNativeWindowHandle();
    const handle = hwnd.length >= 8 ? hwnd.readBigUInt64LE(0) : BigInt(hwnd.readUInt32LE(0));
    const t = new WindowTracker(this.o.trackerScript, targetPid, handle);
    this.tracker = t;
    let ownedOnce = false;
    t.on('state', (s) => {
      if (!this.isOpen) return;
      if (!s.alive) { this.close(); return; }
      if (!s.found) return;
      if (!ownedOnce) { t.own(); ownedOnce = true; }
      this.follow(s);
    });
    t.on('exit', () => { if (this.isOpen && this.tracker === t) this.close(); });
  }

  private follow(s: TrackedWindowState) {
    const win = this.win!;
    if (s.minimized) { win.hide(); return; }
    const target = screen.screenToDipRect(null, { x: s.x!, y: s.y!, width: s.w!, height: s.h! });
    const work = screen.getDisplayMatching(target).workArea;

    if (!this.madeRoom && target.x - PANEL_WIDTH < work.x) {
      // Not enough room to the left: move PhotoCraft right (and narrow it) once so the panel fits.
      this.madeRoom = true;
      const x = work.x + PANEL_WIDTH;
      const width = Math.min(Math.max(target.width, 900), work.x + work.width - x);
      const height = Math.min(target.height, work.height);
      const y = Math.max(work.y, Math.min(target.y, work.y + work.height - height));
      this.tracker?.move(screen.dipToScreenRect(null, { x, y, width, height }));
      return; // the next state report repositions the panel
    }
    this.madeRoom = true;
    const x = Math.max(work.x, target.x - PANEL_WIDTH);
    win.setBounds({ x, y: target.y, width: PANEL_WIDTH, height: Math.max(420, target.height) });
    if (!win.isVisible()) win.showInactive();
  }

  close() {
    if (this.isOpen) this.win!.close();
  }
}

export const trackerScriptPath = (appPath: string) => path.join(appPath, 'resources', 'window-tracker.ps1');
