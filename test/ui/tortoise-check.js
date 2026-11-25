'use strict';
/**
 * Visual check of the "external commit" preparation: open TortoiseSVN's commit dialog on the whole
 * working copy (the way a user opens it from Explorer) and capture it.
 *   SVNWT_HOME=<home> Code.exe(node) tortoise-check.js <wc> <taskTitle> <out.png>
 */
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { Service } = require('../../src/core/service');
const env = require('../../src/core/env');

const [wc, title, out] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTURE = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
"@
Add-Type -AssemblyName System.Drawing
$p = Get-Process TortoiseProc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NOWINDOW'; exit 1 }
[W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 5000
$r = New-Object W+RECT; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$b = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size)
$b.Save($env:OUT, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output ("OK " + $p.MainWindowTitle)
`;

async function main() {
  const svc = new Service();
  const t = svc.listTasks().find((x) => x.title === title);
  const tools = await env.detect();
  const begun = await svc.beginCommit(t.id, { external: true });
  console.log('prepared', JSON.stringify({ setAside: begun.setAside, parked: begun.parked, otherNewDirs: begun.otherNewDirs }));
  const proc = spawn(tools.tortoiseProc, ['/command:commit', `/path:${wc}`], { detached: false });
  let res = 'NOWINDOW';
  for (let i = 0; i < 20 && /NOWINDOW/.test(res); i++) {
    await sleep(1500);
    res = spawnSync('powershell.exe', ['-NoProfile', '-Command', CAPTURE], { env: { ...process.env, OUT: out }, encoding: 'utf8' }).stdout.trim();
  }
  console.log('capture:', res);
  try { proc.kill(); } catch (_) { /* ignore */ }
  spawnSync('taskkill', ['/IM', 'TortoiseProc.exe', '/F'], { stdio: 'ignore' });
  const end = await svc.endCommit(t.id);
  console.log('restored', JSON.stringify(end));
}
main().catch((e) => { console.error(e); process.exit(1); });
