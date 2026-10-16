// MOCK FreeCADCmd.exe launcher (test double, NOT FreeCAD). Compiled by freecad.test.ts with the .NET Framework
// compiler that ships with Windows. `--version` prints a clearly marked version line; any other argument is a
// Python script, run with the mock FreeCAD modules (pylib next to this exe) on the path. The Python child is put
// in a Job Object so that killing this launcher (cancel / timeout) also ends the script, like killing FreeCADCmd.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

static class MockFreeCADCmd
{
    [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length > 0 && args[0] == "--version")
        {
            string vf = Path.Combine(dir, "mockversion.txt");
            string v = File.Exists(vf) ? File.ReadAllText(vf).Trim() : "1.0.2";
            Console.WriteLine("FreeCAD " + v + ", Libs: " + v + "R0 (MOCK test double, not real FreeCAD)");
            return 0;
        }
        if (args.Length == 0) return 2;
        var psi = new ProcessStartInfo(@"__PYTHON__");
        psi.Arguments = "\"" + args[0] + "\"";
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["PYTHONPATH"] = Path.Combine(dir, "pylib");
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        IntPtr info = Marshal.AllocHGlobal(144);
        for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
        Marshal.WriteInt32(info, 16, 0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9, info, 144);
        var p = Process.Start(psi);
        AssignProcessToJobObject(job, p.Handle);
        p.WaitForExit();
        return p.ExitCode;
    }
}
