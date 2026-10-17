// Shows an ArtCraft app's real window inside CreateCraft's Edit area.
//
// The app window is not reparented (fragile across processes); instead it is made borderless and
// *owned* by the CreateCraft window, then kept exactly over the Edit area's viewport rectangle
// (reported by the renderer) as CreateCraft moves or resizes. Owned windows stay above their owner
// and hide/minimize with it; because it is still the app's own top-level window, mouse, keyboard,
// menus and dialogs work natively. "Open in its own window" restores the frame and ownership.

import { screen, type BrowserWindow } from 'electron';
import { WindowTracker, type TrackedWindowState } from './windowTracker';
import { currentOs, type OsId } from '@shared/platform';

export interface Viewport { x: number; y: number; width: number; height: number; visible: boolean }
export type EmbedMode = 'embedded' | 'window';

export class EmbeddedApp {
  private tracker: WindowTracker | null = null;
  private pid: number | null = null;
  private found = false;
  private embeddedOnce = false;
  /**
   * The adopted window was caught (cloaked / parked off-screen) the moment it appeared and has not been
   * placed yet. Such a window is already out of sight, and hiding it as well while the app is still
   * starting can wedge its control channel (verified with WordCraft: ShowWindow(SW_HIDE) before the
   * first frame leaves the next tool call unanswered), so it is left alone until it is embedded.
   */
  private unplaced = false;
  private viewport: Viewport | null = null;
  mode: EmbedMode = 'embedded';
  /** A tracker already compiled and waiting, so a new app window can be caught the instant it appears. */
  private spare: WindowTracker | null = null;

  /**
   * Whether this system can place another program's window inside ours. Only Windows can today (Win32 owned windows through the
   * tracker script). Elsewhere every method below does nothing: the Craft app simply keeps its own independent window and the
   * Edit area says so. A Linux window manager (X11 reparenting, a Wayland portal) can be added later behind this same class.
   */
  readonly supported: boolean;

  constructor(
    private readonly host: () => BrowserWindow | null,
    private readonly script: string,
    private readonly onGone: () => void,
    os: OsId = currentOs(),
  ) { this.supported = os === 'win32'; }

  /** Starts a waiting tracker (call once the app is up; again after each use). */
  prewarm() {
    if (!this.supported) return;
    if (!this.spare) this.spare = new WindowTracker(this.script, 0, 0n, true);
  }

  /**
   * Call right after launching an app: its window is moved off-screen the moment it appears and
   * only revealed once it is placed inside the Edit area (no flash of the app on its own).
   */
  prepare(pid: number) {
    if (!this.supported) return;
    const t = this.spare ?? new WindowTracker(this.script, 0, 0n, true);
    this.spare = null;
    t.target(pid);
    this.adopt(pid, t);
    this.unplaced = true;
    setTimeout(() => this.prewarm(), 2000);
  }

  get attachedPid(): number | null { return this.pid; }

  private hostHandle(): bigint | null {
    const w = this.host();
    if (!w || w.isDestroyed()) return null;
    const b = w.getNativeWindowHandle();
    return b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
  }

  /** Follows the app window of `pid`. A previously attached app is handed back as a normal window and put away hidden. */
  attach(pid: number) {
    if (!this.supported) return;
    if (this.pid === pid && this.tracker) { this.apply(); return; }
    this.adopt(pid, new WindowTracker(this.script, pid, 0n));
  }

  private adopt(pid: number, t: WindowTracker) {
    this.release(true);
    this.pid = pid;
    this.found = false;
    this.embeddedOnce = false;
    this.unplaced = false;
    this.tracker = t;
    t.on('state', (s: TrackedWindowState) => {
      if (this.tracker !== t) return;
      if (!s.alive) { this.release(false); this.onGone(); return; }
      if (s.found && !this.found) { this.found = true; this.apply(); }
    });
    t.on('exit', () => { if (this.tracker === t) { this.tracker = null; this.pid = null; } });
  }

  setViewport(v: Viewport | null) {
    if (!this.supported) return;
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
    if (!v || !v.visible || v.width < 40 || v.height < 40 || host.isMinimized()) {
      if (!this.unplaced) t.hide();
      return;
    }
    if (!this.embeddedOnce) { t.embed(hwnd); this.embeddedOnce = true; this.unplaced = false; }
    const content = host.getContentBounds();
    const dip = { x: content.x + v.x, y: content.y + v.y, width: v.width, height: v.height };
    t.move(screen.dipToScreenRect(host, dip));
    t.uncloak();
    t.show();
  }

  /** Gives the app back its own window (frame, taskbar), placed where it was. */
  popOut() {
    if (!this.supported) return;
    this.mode = 'window';
    const t = this.tracker;
    if (!t) return;
    t.unembed();
    t.uncloak();
    this.embeddedOnce = false;
    this.unplaced = false;
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
    if (!this.supported) return;
    this.mode = 'embedded';
    this.apply();
  }

  /** Stops following; restores the app window to normal so no work is lost. */
  release(minimize: boolean) {
    if (!this.supported) return;
    const t = this.tracker;
    this.tracker = null;
    this.pid = null;
    this.found = false;
    if (!t) return;
    if (minimize) {
      // Put away invisibly. Minimizing here and restoring the window later for the next embed left FigCraft's
      // control channel unanswered (its next open_file never returned; verified by turning only the minimize
      // off: 0 of 4 runs hung instead of 5 of 5). Hidden once it has its frame back.
      t.unembed();
      t.uncloak();
      t.hide();
    } else {
      t.unembed();
      t.uncloak();
      t.show();
    }
    setTimeout(() => t.stop(), 300);
  }
}
