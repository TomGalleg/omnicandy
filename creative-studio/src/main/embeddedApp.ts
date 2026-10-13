// Shows an ArtCraft app's real window inside CreateCraft's Edit area.
//
// The app window is not reparented (fragile across processes); instead it is made borderless and
// *owned* by the CreateCraft window, then kept exactly over the Edit area's viewport rectangle
// (reported by the renderer) as CreateCraft moves or resizes. Owned windows stay above their owner
// and hide/minimize with it; because it is still the app's own top-level window, mouse, keyboard,
// menus and dialogs work natively. "Open in its own window" restores the frame and ownership.

import { screen, type BrowserWindow } from 'electron';
import { WindowTracker, type TrackedWindowState } from './windowTracker';

export interface Viewport { x: number; y: number; width: number; height: number; visible: boolean }
export type EmbedMode = 'embedded' | 'window';

export class EmbeddedApp {
  private tracker: WindowTracker | null = null;
  private pid: number | null = null;
  private found = false;
  private embeddedOnce = false;
  private viewport: Viewport | null = null;
  mode: EmbedMode = 'embedded';

  constructor(
    private readonly host: () => BrowserWindow | null,
    private readonly script: string,
    private readonly onGone: () => void,
  ) {}

  get attachedPid(): number | null { return this.pid; }

  private hostHandle(): bigint | null {
    const w = this.host();
    if (!w || w.isDestroyed()) return null;
    const b = w.getNativeWindowHandle();
    return b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
  }

  /** Follows the app window of `pid`. A previously attached app is handed back as a normal, minimized window. */
  attach(pid: number) {
    if (this.pid === pid && this.tracker) { this.apply(); return; }
    this.release(true);
    this.pid = pid;
    this.found = false;
    this.embeddedOnce = false;
    const t = new WindowTracker(this.script, pid, 0n);
    this.tracker = t;
    t.on('state', (s: TrackedWindowState) => {
      if (this.tracker !== t) return;
      if (!s.alive) { this.release(false); this.onGone(); return; }
      if (s.found && !this.found) { this.found = true; this.apply(); }
    });
    t.on('exit', () => { if (this.tracker === t) { this.tracker = null; this.pid = null; } });
  }

  setViewport(v: Viewport | null) {
    this.viewport = v;
    this.apply();
  }

  /** Re-applies placement (call on host move/resize). */
  apply() {
    const t = this.tracker;
    if (!t || !this.found || this.mode !== 'embedded') return;
    const host = this.host();
    const hwnd = this.hostHandle();
    if (!host || !hwnd) return;
    const v = this.viewport;
    if (!v || !v.visible || v.width < 40 || v.height < 40 || host.isMinimized()) { t.hide(); return; }
    if (!this.embeddedOnce) { t.embed(hwnd); this.embeddedOnce = true; }
    const content = host.getContentBounds();
    const dip = { x: content.x + v.x, y: content.y + v.y, width: v.width, height: v.height };
    t.move(screen.dipToScreenRect(host, dip));
    t.show();
  }

  /** Gives the app back its own window (frame, taskbar), placed where it was. */
  popOut() {
    this.mode = 'window';
    const t = this.tracker;
    if (!t) return;
    t.unembed();
    this.embeddedOnce = false;
    const host = this.host();
    if (host && this.viewport) {
      const c = host.getContentBounds();
      const r = { x: c.x + this.viewport.x + 40, y: c.y + Math.max(0, this.viewport.y - 30), width: Math.max(900, this.viewport.width), height: Math.max(640, this.viewport.height + 30) };
      t.move(screen.dipToScreenRect(host, r));
    }
    t.show();
  }

  /** Puts the app back inside the Edit area. */
  popIn() {
    this.mode = 'embedded';
    this.apply();
  }

  /** Stops following; restores the app window to normal so no work is lost. */
  release(minimize: boolean) {
    const t = this.tracker;
    this.tracker = null;
    this.pid = null;
    this.found = false;
    if (!t) return;
    t.unembed();
    if (minimize) t.minimize(); else t.show();
    setTimeout(() => t.stop(), 300);
  }
}
