# Window tracker for docking OmniCandy's control panel to another app's window (e.g. PhotoCraft).
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-tracker.ps1 -TargetPid <pid> -PanelHwnd <hwnd> [-Cloak]
# -Cloak hides the target's window the instant it appears (DWM cloak, else moved off-screen) until "uncloak".
# Prints one JSON line whenever the target window's bounds/state change:
#   {"found":true,"x":..,"y":..,"w":..,"h":..,"minimized":false,"alive":true}   (physical pixels)
# Reads commands from stdin, one per line:
#   move <x> <y> <w> <h>    restore + move/resize the target window (physical pixels)
#   own                     make the panel an owned window of the target (stays above it, minimizes with it)
#   disown                  undo "own"
#   embed <hostHwnd>        borderless target owned by host (stays above it, hides/minimizes with it)
#   unembed                 restore the target's frame and ownership
#   show | hide | minimize  show (without activating) / hide / minimize the target window
#   uncloak                 reveal a window hidden by -Cloak
#   target <pid>            (only with -TargetPid 0) start following <pid>
# Exits when the target process ends or stdin closes. Only touches the given pid's window and our panel.
param([Parameter(Mandatory)][int]$TargetPid, [Parameter(Mandatory)][long]$PanelHwnd, [switch]$Cloak)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class CsWindowTracker {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  const long FRAME = 0x00C00000L | 0x00040000L | 0x00020000L | 0x00010000L; // CAPTION | THICKFRAME | MINIMIZEBOX | MAXIMIZEBOX

  // allowHidden: a window OmniCandy itself put away earlier (SW_HIDE when the app was handed back) is still the app's main window.
  // A visible one always wins; a hidden one is only taken once the app has had time to show its real window.
  static IntPtr FindMain(int pid, bool allowHidden) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    IntPtr hidden = IntPtr.Zero; long hiddenArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid || GetWindowTextLength(h) == 0) return true; // owned allowed: embedded windows are owned by OmniCandy
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (IsWindowVisible(h)) { if (area > bestArea) { bestArea = area; best = h; } }
      else if (area > hiddenArea) { hiddenArea = area; hidden = h; }
      return true;
    }, IntPtr.Zero);
    return best != IntPtr.Zero ? best : (allowHidden ? hidden : IntPtr.Zero);
  }

  static bool IsCloaked(IntPtr h) { int v; return DwmGetInt(h, 14, out v, 4) == 0 && v != 0; } // DWMWA_CLOAKED

  static RECT Bounds(IntPtr h) {
    RECT r;
    // Visible frame without the invisible resize borders/shadow.
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  public static void Run(int pid, long panel, bool cloak) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: physical pixels everywhere
    var cmds = new ConcurrentQueue<string>();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) cmds.Enqueue(line);
      cmds.Enqueue("__eof");
    });
    reader.IsBackground = true; reader.Start();
    // Pre-started mode: -TargetPid 0 waits (already compiled) for "target <pid>" so it can catch a window the instant it appears.
    while (pid == 0) {
      string c;
      if (cmds.TryDequeue(out c)) { if (c == "__eof") return; if (c.StartsWith("target ")) pid = int.Parse(c.Substring(7)); }
      else Thread.Sleep(2);
    }

    IntPtr target = IntPtr.Zero; string last = null; bool owned = false; bool embedded = false; long savedStyle = 0;
    bool cloaked = false; bool offscreen = false; RECT before = new RECT(); long lastPick = 0;
    var started = Stopwatch.StartNew();
    while (true) {
      Process proc = null;
      try { proc = Process.GetProcessById(pid); } catch { }
      if (proc == null || proc.HasExited) { Console.WriteLine("{\"alive\":false}"); return; }
      // A program that opens several windows while it starts (Unreal: a splash, then the editor) must not leave us holding the first one.
      // While nothing is docked yet, look again twice a second for the program's largest visible window and follow that instead.
      bool pick = target == IntPtr.Zero || !IsWindow(target);
      if (!pick && !embedded && started.ElapsedMilliseconds - lastPick > 500) {
        lastPick = started.ElapsedMilliseconds;
        IntPtr better = FindMain(pid, false);
        if (better != IntPtr.Zero && better != target) pick = true;
      }
      if (pick) {
        // a new window starts undocked, whatever was done to the one before it
        embedded = false; savedStyle = 0; cloaked = false; offscreen = false;
        target = FindMain(pid, started.ElapsedMilliseconds > 3000); owned = false;
        if (target != IntPtr.Zero && cloak && !cloaked && !offscreen) {
          int on = 1;
          if (DwmSetWindowAttribute(target, 13, ref on, 4) == 0) cloaked = true; // DWMWA_CLOAK
          else { GetWindowRect(target, out before); SetWindowPos(target, IntPtr.Zero, -32000, -32000, 0, 0, 0x0015); offscreen = true; }
        }
      }

      // Dragging OmniCandy queues a move for every pixel; a busy program (Fusion) answers each resize slowly, so the
      // backlog made its window trail behind and chase OmniCandy. Take what is queued and run only the newest move.
      var batch = new System.Collections.Generic.List<string>();
      string cmd;
      while (cmds.TryDequeue(out cmd)) batch.Add(cmd);
      int lastMove = -1;
      for (int i = 0; i < batch.Count; i++) if (batch[i].StartsWith("move ")) lastMove = i;
      for (int i = 0; i < batch.Count; i++) {
        cmd = batch[i];
        if (cmd == "__eof") return;
        if (cmd.StartsWith("move ") && i != lastMove) continue;
        var a = cmd.Split(' ');
        if (target == IntPtr.Zero) continue;
        if (a[0] == "own") { SetWindowLongPtr(new IntPtr(panel), -8, target); owned = true; }
        else if (a[0] == "disown") { SetWindowLongPtr(new IntPtr(panel), -8, IntPtr.Zero); owned = false; }
        else if (a[0] == "embed" && a.Length == 2) {
          if (!embedded) savedStyle = GetWindowLongPtr(target, -16).ToInt64();
          if (IsZoomed(target) || IsIconic(target)) ShowWindow(target, 9);
          SetWindowLongPtr(target, -16, new IntPtr(savedStyle & ~FRAME));
          SetWindowLongPtr(target, -8, new IntPtr(long.Parse(a[1])));
          SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x0027); // NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED
          embedded = true;
        }
        else if (a[0] == "unembed") {
          if (embedded) {
            SetWindowLongPtr(target, -16, new IntPtr(savedStyle));
            SetWindowLongPtr(target, -8, IntPtr.Zero);
            SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x0027);
            embedded = false;
          }
        }
        else if (a[0] == "uncloak") {
          if (cloaked) { int off = 0; DwmSetWindowAttribute(target, 13, ref off, 4); cloaked = false; }
          if (offscreen) { SetWindowPos(target, IntPtr.Zero, before.L, before.T, 0, 0, 0x0015); offscreen = false; }
          cloak = false;
        }
        else if (a[0] == "hide") ShowWindow(target, 0);
        else if (a[0] == "minimize") ShowWindow(target, 7); // SW_SHOWMINNOACTIVE
        else if (a[0] == "show") ShowWindow(target, 8); // SW_SHOWNA
        else if (a[0] == "move" && a.Length == 5) {
          offscreen = false;
          if (IsZoomed(target) || IsIconic(target)) ShowWindow(target, 9); // SW_RESTORE
          SetWindowPos(target, IntPtr.Zero, int.Parse(a[1]), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), 0x4014); // NOZORDER|NOACTIVATE|ASYNCWINDOWPOS (don't wait for a busy program to repaint)
        }
      }

      string state;
      if (target == IntPtr.Zero) state = "{\"alive\":true,\"found\":false}";
      else {
        var r = Bounds(target);
        state = "{\"alive\":true,\"found\":true,\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T)
          + ",\"minimized\":" + (IsIconic(target) ? "true" : "false") + ",\"maximized\":" + (IsZoomed(target) ? "true" : "false")
          + ",\"owned\":" + (owned ? "true" : "false") + ",\"embedded\":" + (embedded ? "true" : "false")
          + ",\"visible\":" + (IsWindowVisible(target) ? "true" : "false") + ",\"cloaked\":" + (IsCloaked(target) ? "true" : "false") + "}";
      }
      if (state != last) { Console.WriteLine(state); Console.Out.Flush(); last = state; }
      Thread.Sleep(target == IntPtr.Zero ? 10 : (batch.Count > 0 ? 16 : 60)); // poll fast until the window appears, and while it is being moved
    }
  }
}
'@
[CsWindowTracker]::Run($TargetPid, $PanelHwnd, $Cloak.IsPresent)
