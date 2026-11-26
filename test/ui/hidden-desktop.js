'use strict';
/**
 * Start a GUI program on a separate (invisible) Windows desktop, so the VS Code test window never shows up
 * on the user's screen or takes the focus. CDP (remote debugging port) works the same.
 * The helper PowerShell keeps the desktop handle open until the program exits (else the desktop is destroyed).
 * SVNWT_UI_VISIBLE=1 starts it normally instead (to watch the test).
 */
const { spawn } = require('child_process');

const CS = `
using System; using System.Runtime.InteropServices;
public static class SvnwtDesk {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct SI { public int cb; public string r; public string desk; public string title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, hin, hout, herr; }
  [StructLayout(LayoutKind.Sequential)]
  struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  public static void Run(string desk, string cmd) {
    IntPtr h = CreateDesktop(desk, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
    if (h == IntPtr.Zero) throw new Exception("CreateDesktop " + Marshal.GetLastWin32Error());
    SI si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.desk = desk;
    PI pi;
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
    Console.WriteLine("PID " + pi.pid);
    Console.Out.Flush();
    WaitForSingleObject(pi.hp, 0xFFFFFFFF);
  }
}`;

const quote = (a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));

/** @returns {Promise<{pid:number, holder:import('child_process').ChildProcess}>} */
function startHidden(exe, args, env, desktop = 'svnwt-ui-test') {
  const cmd = [exe, ...args].map(quote).join(' ');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition $env:SVNWT_CS; [SvnwtDesk]::Run($env:SVNWT_DESK, $env:SVNWT_CMD)'],
  { env: { ...env, SVNWT_CS: CS, SVNWT_DESK: desktop, SVNWT_CMD: cmd }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    holder.stdout.on('data', (b) => {
      out += b;
      const m = /PID (\d+)/.exec(out);
      if (m) resolve({ pid: Number(m[1]), holder });
    });
    holder.stderr.on('data', (b) => { err += b; });
    holder.on('exit', (code) => reject(new Error(`hidden desktop start failed (${code}): ${err.trim() || out.trim()}`)));
  });
}

module.exports = { startHidden };
