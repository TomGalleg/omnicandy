# Window tracker for docking CreateCraft's control panel to another app's window (e.g. PhotoCraft).
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-tracker.ps1 -TargetPid <pid> -PanelHwnd <hwnd>
# Prints one JSON line whenever the target window's bounds/state change:
#   {"found":true,"x":..,"y":..,"w":..,"h":..,"minimized":false,"alive":true}   (physical pixels)
# Reads commands from stdin, one per line:
#   move <x> <y> <w> <h>    restore + move/resize the target window (physical pixels)
#   own                     make the panel an owned window of the target (stays above it, minimizes with it)
#   disown                  undo "own"
# Exits when the target process ends or stdin closes. Only touches the given pid's window and our panel.
param([Parameter(Mandatory)][int]$TargetPid, [Parameter(Mandatory)][long]$PanelHwnd)

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
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

  static IntPtr FindMain(int pid) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  static RECT Bounds(IntPtr h) {
    RECT r;
    // Visible frame without the invisible resize borders/shadow.
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  public static void Run(int pid, long panel) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: physical pixels everywhere
    var cmds = new ConcurrentQueue<string>();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) cmds.Enqueue(line);
      cmds.Enqueue("__eof");
    });
    reader.IsBackground = true; reader.Start();

    IntPtr target = IntPtr.Zero; string last = null; bool owned = false;
    while (true) {
      Process proc = null;
      try { proc = Process.GetProcessById(pid); } catch { }
      if (proc == null || proc.HasExited) { Console.WriteLine("{\"alive\":false}"); return; }
      if (target == IntPtr.Zero || !IsWindow(target)) { target = FindMain(pid); owned = false; }

      string cmd;
      while (cmds.TryDequeue(out cmd)) {
        if (cmd == "__eof") return;
        var a = cmd.Split(' ');
        if (target == IntPtr.Zero) continue;
        if (a[0] == "own") { SetWindowLongPtr(new IntPtr(panel), -8, target); owned = true; }
        else if (a[0] == "disown") { SetWindowLongPtr(new IntPtr(panel), -8, IntPtr.Zero); owned = false; }
        else if (a[0] == "move" && a.Length == 5) {
          if (IsZoomed(target) || IsIconic(target)) ShowWindow(target, 9); // SW_RESTORE
          SetWindowPos(target, IntPtr.Zero, int.Parse(a[1]), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), 0x0014); // NOZORDER|NOACTIVATE
        }
      }

      string state;
      if (target == IntPtr.Zero) state = "{\"alive\":true,\"found\":false}";
      else {
        var r = Bounds(target);
        state = "{\"alive\":true,\"found\":true,\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T)
          + ",\"minimized\":" + (IsIconic(target) ? "true" : "false") + ",\"maximized\":" + (IsZoomed(target) ? "true" : "false")
          + ",\"owned\":" + (owned ? "true" : "false") + "}";
      }
      if (state != last) { Console.WriteLine(state); Console.Out.Flush(); last = state; }
      Thread.Sleep(80);
    }
  }
}
'@
[CsWindowTracker]::Run($TargetPid, $PanelHwnd)
