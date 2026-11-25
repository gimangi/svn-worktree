'use strict';
/**
 * Extension upgrade test in an isolated VS Code profile (no CDP, no proposed-API flag):
 *   1) install OLD vsix, open a working copy, wait for activation
 *   2) install NEW vsix over it, start again
 *   -> activation without errors, settings migrated, MCP server copy updated, custom agents installed.
 *   Code.exe(node) test/ui/upgrade-ext.js <old.vsix> <new.vsix>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const [OLD, NEW] = process.argv.slice(2).map((p) => path.resolve(p));
const ROOT = path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-upgrade-ext');
const CODE_DIR = path.dirname(process.execPath);
const CODE = fs.existsSync(path.join(path.dirname(CODE_DIR), 'Code.exe')) && /^[0-9a-f]{6,}$/i.test(path.basename(CODE_DIR)) ? path.join(path.dirname(CODE_DIR), 'Code.exe') : process.execPath;
const CLI = path.join(path.dirname(CODE), 'bin', 'code.cmd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => console.log(`  ok ${++n} - ${m}`);

process.env.SVNWT_HOME = path.join(ROOT, 'home');
const ud = path.join(ROOT, 'ud');
const ext = path.join(ROOT, 'ext');

function rm(p) { spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Test-Path $env:T) { Remove-Item -LiteralPath $env:T -Recurse -Force }'], { env: { ...process.env, T: p }, stdio: 'ignore' }); }
function killIsolated() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Where-Object { $_.CommandLine -like '*svnwt-upgrade-ext*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore' });
}
function install(vsix) {
  const r = spawnSync('cmd.exe', ['/d', '/c', CLI, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8' });
  assert(/successfully installed/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
}
function logs() {
  let out = '';
  let host = '';
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/SVN Worktree\.log$/.test(e.name)) out += fs.readFileSync(p, 'utf8');
      else if (e.name === 'exthost.log') host += fs.readFileSync(p, 'utf8');
    }
  };
  walk(path.join(ud, 'logs'));
  return { out, host };
}
async function runOnce(folder, untilRe, timeoutMs = 90000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(CODE, [`--user-data-dir=${ud}`, `--extensions-dir=${ext}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', folder], { env, stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    if (untilRe.test(logs().out)) break;
  }
  await sleep(4000); // let activation finish its async steps (settings migration, deploy)
  killIsolated();
  try { p.kill(); } catch (_) { /* ignore */ }
  await sleep(1500);
  return logs();
}

async function main() {
  killIsolated();
  rm(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const demo = path.join(ROOT, 'demo');
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'make-demo.js'), demo], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert(r.status === 0, r.stdout + r.stderr);
  const wc = path.join(demo, 'wc');
  fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
  const settingsFile = path.join(ud, 'User', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    'svnwt.commitTool': 'external', // value written by 0.3.0
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'window.restoreWindows': 'none', 'extensions.ignoreRecommendations': true,
  }, null, 2));

  const oldVer = /svn-worktree-([\d.]+)\.vsix$/.exec(OLD)[1];
  const newVer = /svn-worktree-([\d.]+)\.vsix$/.exec(NEW)[1];
  install(OLD);
  const l1 = await runOnce(wc, new RegExp(`svn-worktree-${oldVer.replace(/\./g, '\\.')}.*활성화됨|활성화됨.*svn-worktree-${oldVer.replace(/\./g, '\\.')}`));
  assert(new RegExp(`svnwt\\.svn-worktree-${oldVer}`).test(l1.out), 'old version did not activate:\n' + l1.out.slice(-800));
  const v1 = fs.readFileSync(path.join(process.env.SVNWT_HOME, 'server', 'version.txt'), 'utf8').trim();
  assert.strictEqual(v1, oldVer);
  ok(`old ${oldVer} installed and activated (MCP server copy ${v1})`);

  install(NEW);
  const l2 = await runOnce(wc, new RegExp(`svnwt\\.svn-worktree-${newVer.replace(/\./g, '\\.')}`));
  assert(new RegExp(`svnwt\\.svn-worktree-${newVer}`).test(l2.out), 'new version did not activate:\n' + l2.out.slice(-800));
  const failed = l2.host.split('\n').filter((l) => /svnwt|svn-worktree/i.test(l) && /\[error\]|failed|cannot/i.test(l));
  console.log(failed.length ? `    exthost notes:\n${failed.map((l) => '      ' + l.slice(0, 220)).join('\n')}` : '    exthost: no svnwt errors');
  assert(!failed.some((l) => /Activating extension .*failed|activate.*failed/i.test(l)), 'activation failed');
  ok(`new ${newVer} installed over it and activated (without the proposed-API flag)`);

  const settings = fs.readFileSync(settingsFile, 'utf8');
  assert(/"svnwt\.commitTool":\s*"prepare"/.test(settings), settings);
  ok('setting svnwt.commitTool "external" migrated to "prepare"');

  const v2 = fs.readFileSync(path.join(process.env.SVNWT_HOME, 'server', 'version.txt'), 'utf8').trim();
  assert.strictEqual(v2, newVer);
  const prompts = fs.readdirSync(path.join(ud, 'User', 'prompts'));
  assert(prompts.includes('svnwt.instructions.md'));
  if (newVer >= '0.4.0') assert(prompts.includes('svnwt-task.agent.md') && prompts.includes('svnwt-review.agent.md'), prompts.join(','));
  ok(`MCP server copy updated to ${v2}; prompts: ${prompts.join(', ')}`);

  const scopes = JSON.parse(fs.readFileSync(path.join(process.env.SVNWT_HOME, 'registry.json'), 'utf8')).scopes;
  assert(scopes.length === 1);
  ok('existing scope / tasks untouched by the upgrade');
  console.log(`\n# all ${n} extension upgrade checks passed`);
}

main().catch((e) => { console.error('FAILED:', e && e.stack); killIsolated(); process.exitCode = 1; });
