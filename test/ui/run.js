'use strict';
require('../hide-windows');
/**
 * UI test of the VS Code extension in an isolated VS Code instance driven over CDP, with screenshots.
 *   scripts\run-ui-test.cmd            -> docs\ui-test\report.html + shots\*.jpg
 * Steps are recorded as { scenario, action, expect, result, note, shot }.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { Cdp } = require('./cdp');

const REPO = path.resolve(__dirname, '..', '..');
const ROOT = path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-ui');
const OUT = path.join(REPO, 'docs', 'ui-test');
const SHOTS = path.join(OUT, 'shots');
const CODE_DIR = path.dirname(process.execPath);
const CODE = fs.existsSync(path.join(path.dirname(CODE_DIR), 'Code.exe')) && /^[0-9a-f]{6,}$/i.test(path.basename(CODE_DIR)) ? path.join(path.dirname(CODE_DIR), 'Code.exe') : process.execPath;
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.SVNWT_HOME = path.join(ROOT, 'home');
const nodeEnv = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });

function sh(script, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...nodeEnv, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (r.status !== 0) throw new Error(`${path.basename(script)} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// ------------------------------------------------------------------ driver
class Driver {
  constructor(cdp) {
    this.cdp = cdp;
    this.steps = [];
    this.n = 0;
    this.sessions = new Map(); // sessionId -> targetInfo
    cdp.on((m) => {
      if (m.method === 'Target.attachedToTarget') {
        this.sessions.set(m.params.sessionId, m.params.targetInfo);
        cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId).catch(() => {});
        cdp.send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId).catch(() => {});
      }
      if (m.method === 'Target.detachedFromTarget') this.sessions.delete(m.params.sessionId);
    });
  }

  async init() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // fixed viewport => comparable screenshots regardless of the window size
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  }

  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''}`);
    return r.result.value;
  }

  async waitFor(expr, timeout = 15000, label = expr) {
    const t = Date.now();
    for (;;) {
      let v = null;
      try { v = await this.eval(expr); } catch (_) { /* retry */ }
      if (v) return v;
      if (Date.now() - t > timeout) throw new Error(`timeout waiting for ${label}`);
      await sleep(200);
    }
  }

  /** Center of the first element matching a JS predicate source, e.g. `el => el.matches(...)`. */
  async rect(selector, textPart) {
    return this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const t = ${JSON.stringify(textPart || '')};
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!t || (e.getAttribute('aria-label') || e.textContent || '').includes(t)); });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }

  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0 });
  }

  async click(selector, textPart, { button = 'left', timeout = 10000 } = {}) {
    const t = Date.now();
    let p = null;
    while (!(p = await this.rect(selector, textPart))) {
      if (Date.now() - t > timeout) throw new Error(`element not found: ${selector} ${textPart || ''}`);
      await sleep(200);
    }
    await this.mouse('mouseMoved', p.x, p.y);
    await sleep(80);
    await this.mouse('mousePressed', p.x, p.y, button);
    await this.mouse('mouseReleased', p.x, p.y, button);
    await sleep(300);
    return p;
  }

  async hover(selector, textPart) {
    const p = await this.rect(selector, textPart);
    if (!p) throw new Error(`element not found: ${selector} ${textPart || ''}`);
    await this.mouse('mouseMoved', p.x, p.y);
    await sleep(300);
    return p;
  }

  async key(key, { ctrl = false, shift = false, alt = false } = {}) {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, F1: 112, F7: 118, Backspace: 8 };
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const kc = codes[key] || key.toUpperCase().charCodeAt(0);
    const base = { modifiers, key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await this.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(250);
  }

  async type(text) {
    await this.cdp.send('Input.insertText', { text });
    await sleep(200);
  }

  async command(title) {
    await this.key('F1');
    await this.waitFor(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`, 5000, 'command palette');
    await this.type(title);
    await sleep(600);
    await this.key('Enter');
    await sleep(800);
  }

  /** Evaluate inside our review webview (outer webview frame -> #active-frame document). */
  async webview(fnSrc, timeout = 15000, prefix = '') {
    const t = Date.now();
    for (;;) {
      const sessions = [undefined, ...[...this.sessions.keys()].reverse()]; // newest first: a moved webview can leave an old, stale target behind
      for (const s of sessions) {
        let tree;
        try { tree = await this.cdp.send('Page.getFrameTree', {}, s); } catch (_) { continue; }
        const frames = [];
        const walk = (n) => { frames.push(n.frame); (n.childFrames || []).forEach(walk); };
        walk(tree.frameTree);
        for (const f of frames.filter((x) => (x.url || '').startsWith('vscode-webview://'))) {
          try {
            const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'svnwt-test' }, s);
            const r = await this.cdp.send('Runtime.evaluate', {
              contextId: executionContextId, returnByValue: true, awaitPromise: true,
              expression: `(() => { const fr = document.querySelector('iframe#active-frame'); const d = fr ? fr.contentDocument : document;
                if (!d || !d.body || !d.body.dataset.svnwtReview || !d.body.dataset.svnwtReview.startsWith(${JSON.stringify(prefix)})) return undefined; return (${fnSrc})(d); })()`,
            }, s);
            if (r.result && r.result.value !== undefined) return r.result.value;
          } catch (_) { /* next */ }
        }
      }
      if (Date.now() - t > timeout) throw new Error('review webview not found');
      await sleep(300);
    }
  }

  /** Diagnostics: every webview frame whose review document matches the prefix. */
  async webviewAll(fnSrc, prefix = '') {
    const out = [];
    for (const s of [undefined, ...this.sessions.keys()]) {
      let tree;
      try { tree = await this.cdp.send('Page.getFrameTree', {}, s); } catch (_) { continue; }
      const frames = [];
      const walk = (n, depth) => { frames.push({ ...n.frame, depth }); (n.childFrames || []).forEach((c) => walk(c, depth + 1)); };
      walk(tree.frameTree, 0);
      for (const f of frames.filter((x) => (x.url || '').startsWith('vscode-webview://'))) {
        try {
          const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'svnwt-test' }, s);
          const r = await this.cdp.send('Runtime.evaluate', {
            contextId: executionContextId, returnByValue: true, awaitPromise: true,
            expression: `(() => { const fr = document.querySelector('iframe#active-frame'); const d = fr ? fr.contentDocument : document;
              if (!d || !d.body || !d.body.dataset.svnwtReview || !d.body.dataset.svnwtReview.startsWith(${JSON.stringify(prefix)})) return undefined;
              return { via: fr ? 'outer' : 'self', iframes: [...document.querySelectorAll('iframe')].map((x) => x.id).join('+'), value: (${fnSrc})(d) }; })()`,
          }, s);
          if (r.result && r.result.value !== undefined) out.push({ session: s ? 'child' : 'page', depth: f.depth, url: (f.url || '').slice(0, 60), ...r.result.value });
        } catch (e) { /* next */ }
      }
    }
    return out;
  }

  async shot(step) {
    const n = ++this.n;
    const file = `${String(n).padStart(2, '0')}.jpg`;
    await sleep(step.delay || 500);
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
    const rec = { n, shot: 'shots/' + file, ...step };
    delete rec.delay;
    this.steps.push(rec);
    console.log(`${String(n).padStart(2)} [${rec.result}] ${rec.scenario} — ${rec.action}${rec.note ? ' :: ' + rec.note : ''}`);
    return rec;
  }

  async notifications() {
    return this.eval(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map((e) => e.textContent)`);
  }

  async tabs() {
    return this.eval(`[...document.querySelectorAll('.tabs-container .tab')].map((t) => t.getAttribute('aria-label'))`);
  }
}

// ------------------------------------------------------------------ setup
async function setup() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Test-Path $env:T) { Remove-Item -LiteralPath $env:T -Recurse -Force }'], { env: { ...process.env, T: ROOT }, stdio: 'inherit' });
  fs.mkdirSync(ROOT, { recursive: true });
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Test-Path $env:T) { Remove-Item -LiteralPath $env:T -Recurse -Force }'], { env: { ...process.env, T: SHOTS }, stdio: 'inherit' });
  fs.mkdirSync(SHOTS, { recursive: true });
  const demo = path.join(ROOT, 'demo');
  console.log(sh(path.join(REPO, 'scripts', 'make-demo.js'), [demo]).trim());
  console.log(sh(path.join(REPO, 'test', 'scenario.js'), [demo], { SVNWT_PACE: '30' }).split('\n').filter((l) => /검증 통과|FAILED/.test(l)).join('\n'));

  // Playwright-style results on the "report" task: a failed run, then a passed run
  const { Service } = require('../../src/core/service');
  const fake = require('./fake-playwright');
  const svc = new Service();
  const report = svc.listTasks().find((t) => t.title === 'report mul output');
  fake.run(report.workPath, 'failed', ROOT);
  await svc.attachArtifacts(report.id, { title: 'Playwright: report 화면', summary: 'mul 행이 없어 실패 (수정 전)' });
  fake.run(report.workPath, 'passed', ROOT);
  await svc.attachArtifacts(report.id, { title: 'Playwright: report 화면', summary: 'add / mul / ab 행 확인' });

  // extension into an isolated profile
  const vsix = fs.readdirSync(path.join(REPO, 'dist')).filter((f) => f.endsWith('.vsix')).sort().pop();
  const cli = path.join(path.dirname(CODE), 'bin', 'code.cmd');
  execFileSync('cmd.exe', ['/d', '/c', cli, '--extensions-dir', path.join(ROOT, 'ext'), '--install-extension', path.join(REPO, 'dist', vsix), '--force'], { stdio: 'ignore' });
  const user = path.join(ROOT, 'ud', 'User');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'workbench.tips.enabled': false, 'window.restoreWindows': 'none',
    'workbench.colorTheme': 'Default Dark Modern', 'window.titleBarStyle': 'custom', 'chat.commandCenter.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden', 'files.hotExit': 'off', 'window.dialogStyle': 'custom', 'svnwt.agent.chatSessions': true,
    'extensions.ignoreRecommendations': true, 'git.openRepositoryInParentFolders': 'never',
  }, null, 2));
  return { demo, wc: path.join(demo, 'wc'), svc, report };
}

/** Scripted "language model" for the agent scenario (no Copilot in the isolated profile). */
function writeFakeModel() {
  const f = path.join(ROOT, 'fake-lm.json');
  fs.writeFileSync(f, JSON.stringify([
    { text: 'README 를 살펴보겠습니다.', calls: [['list_dir', { path: 'app' }], ['read_file', { path: 'app/README.md' }]], delayMs: 1500 },
    { calls: [['edit_file', { path: 'app/README.md', old_string: 'SVN Worktree 데모용 프로젝트입니다.', new_string: 'SVN Worktree 데모용 프로젝트입니다.\n\n에이전트가 작업별 worktree 에서 수정했습니다.' }]], delayMs: 1500 },
    { calls: [['run_command', { command: 'Write-Output build-ok' }]], delayMs: 500 },
    { calls: [['git_commit', { message: 'README: 에이전트 설명 추가' }]], delayMs: 800 },
    { text: '완료: app/README.md 에 설명을 추가하고 커밋했습니다. (빌드 확인: build-ok)', delayMs: 500 },
    { text: '추가 지시 확인: 남은 작업은 없습니다.', delayMs: 500 },
    { text: '선택한 줄 확인: 제목 줄입니다. 고칠 것은 없습니다.', delayMs: 500 },
  ], null, 1));
  return f;
}

async function launch(folder) {
  const env = { ...process.env, SVNWT_FAKE_LM: writeFakeModel() };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${path.join(ROOT, 'ud')}`, `--extensions-dir=${path.join(ROOT, 'ext')}`, `--remote-debugging-port=${PORT}`,
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--enable-proposed-api', 'svnwt.svn-worktree', '--new-window', folder];
  if (process.env.SVNWT_UI_VISIBLE) return spawn(CODE, args, { env, detached: false, stdio: 'ignore' });
  // default: on a separate desktop, so the test window never pops up or takes the user's focus
  const { pid, holder } = await require("./hidden-desktop").startHidden(CODE, args, env);
  return { pid, kill: () => { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); try { holder.kill(); } catch (_) { /* ignore */ } } };
}

// ------------------------------------------------------------------ scenarios (test/ui/scenarios.js)
const { scenarios } = require('./scenarios');

function killIsolated() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Where-Object { $_.CommandLine -like '*svnwt-ui*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore' });
}

async function main() {
  killIsolated();
  console.log('setup...');
  const ctx = await setup();
  const proc = await launch(ctx.wc);
  const cdp = await Cdp.connect(PORT, (t) => /workbench/.test(t.url));
  const d = new Driver(cdp);
  try {
    await d.init();
    await scenarios(d, ctx);
  } finally {
    fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(d.steps, null, 2), 'utf8');
    try { await Promise.race([cdp.send('Browser.close'), sleep(5000)]); } catch (_) { /* ignore */ }
    cdp.close();
    setTimeout(() => { try { proc.kill(); } catch (_) { /* ignore */ } killIsolated(); }, 3000);
  }
  console.log(`\n${d.steps.filter((s) => s.result === 'pass').length}/${d.steps.length} steps passed → ${require('./report').build()}`);
}

module.exports = { Driver, sleep, ROOT };

if (require.main === module) main().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
