'use strict';
/**
 * Upgrade test: state created by an OLD svnwt (git ref, default the 0.3.0 commit) must keep working
 * with the CURRENT code.
 *   Code.exe(node) test/upgrade.js [oldRef]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OLD_REF = process.argv[2] || '0f3cbe7';
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-upgrade-'));
process.env.SVNWT_HOME = path.join(ROOT, 'home');

let n = 0;
const ok = (m) => console.log(`  ok ${++n} - ${m}`);

function git(...a) { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }); }

async function main() {
  // old code in its own worktree
  const oldDir = path.join(ROOT, 'old');
  git('worktree', 'add', '--detach', oldDir, OLD_REF);
  try {
    const OldService = require(path.join(oldDir, 'src', 'core', 'service.js')).Service;
    const oldEnv = require(path.join(oldDir, 'src', 'core', 'env.js'));
    const t = await oldEnv.requireTools();
    const svnExe = t.svn.path;
    const svn = (...a) => execFileSync(svnExe, ['--non-interactive', ...a], { encoding: 'utf8' });
    execFileSync(path.join(path.dirname(svnExe), 'svnadmin.exe'), ['create', path.join(ROOT, 'repo')]);
    const wc = path.join(ROOT, 'wc');
    svn('checkout', '-q', 'file:///' + path.join(ROOT, 'repo').replace(/\\/g, '/'), wc);
    fs.mkdirSync(path.join(wc, 'app'));
    fs.writeFileSync(path.join(wc, 'app', 'a.txt'), 'a1\r\na2\r\na3\r\na4\r\na5\r\na6\r\n');
    fs.writeFileSync(path.join(wc, 'app', 'b.txt'), 'b\r\n');
    svn('add', '-q', path.join(wc, 'app'));
    svn('commit', '-q', '-m', 'init', wc);
    svn('update', '-q', wc);

    // ------------------------------------------------ state made by the old version
    const old = new OldService();
    const { scope } = await old.initScope(path.join(wc, 'app'), { name: 'app' });
    const A = await old.createTask(scope.id, { title: 'old A' });
    const B = await old.createTask(scope.id, { title: 'old B' });
    const C = await old.createTask(scope.id, { title: 'old C' });
    const editIn = (task, from, to) => { const f = path.join(task.workPath, 'a.txt'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to)); };
    editIn(A, 'a1\r\n', 'a1 A\r\n'); await old.commitTask(A.id, 'A');
    editIn(B, 'a6\r\n', 'a6 B\r\n'); fs.writeFileSync(path.join(B.workPath, 'b.txt'), 'b B\r\n'); await old.commitTask(B.id, 'B');
    editIn(C, 'a3\r\n', 'a3 C\r\n'); await old.commitTask(C.id, 'C');
    assert((await old.landTask(A.id)).ok);
    assert((await old.landTask(B.id)).ok); // shared a.txt
    await old.submitReview(A.id, { verdict: 'approve', summary: 'old review' });
    // user upgrades while a commit is prepared ("커밋 준비" of 0.3.0)
    await old.beginCommit(A.id, { external: true });
    assert(/ignore-on-commit/.test(svn('status', wc)));
    // and the old version crashed while holding the scope lock (plain "owner" file with a dead pid)
    fs.mkdirSync(path.join(scope.home, 'lock'));
    fs.writeFileSync(path.join(scope.home, 'lock', 'owner'), '999999');
    const past = new Date(Date.now() - 120000);
    fs.utimesSync(path.join(scope.home, 'lock'), past, past);
    ok(`state created with ${OLD_REF}: 3 tasks, 2 landed (shared file), review, prepared commit, stale lock`);

    // ------------------------------------------------ current code takes over
    for (const k of Object.keys(require.cache)) if (k.startsWith(oldDir)) delete require.cache[k];
    const { Service } = require('../src/core/service');
    const s = new Service();
    const tasks = s.listTasks();
    assert.strictEqual(tasks.length, 3);
    for (const x of tasks) {
      const info = await s.taskInfo(x.id, { checkSvn: false });
      assert(info.task.id === x.id);
    }
    assert.strictEqual(s.listReviews(A.id).length, 1);
    assert.deepStrictEqual(s.getSession(A.id).entries, []);
    ok('current code reads old scope / tasks / reviews (no session yet)');

    const end = await s.endCommit(A.id); // VS Code restarted with the new version: undo the prepared commit
    assert(!end.committed);
    const st = svn('status', wc);
    assert(!/ignore-on-commit/.test(st) && new RegExp(A.changelist).test(st) && new RegExp(B.changelist).test(st), st);
    ok('prepared commit from the old version is restored (changelists back)');

    const lc = await s.landTask(C.id);
    assert(lc.ok, JSON.stringify(lc));
    assert(fs.readFileSync(path.join(wc, 'app', 'a.txt'), 'utf8').includes('a3 C'));
    ok('stale lock of the old version is broken; new land works (third task on the shared file)');

    // split commit of an old-landed task with the new code
    await s.beginCommit(A.id);
    const r = await s.runSvnCommit(A.id);
    assert(r.ok, r.output);
    assert((await s.endCommit(A.id)).committed);
    const url = svn('info', '--show-item', 'url', wc).trim();
    const d = svn('diff', '-c', svn('info', '--show-item', 'revision', '-r', 'HEAD', url).trim(), url);
    assert(/\+a1 A/.test(d) && !/a6 B|a3 C/.test(d), d);
    const a = fs.readFileSync(path.join(wc, 'app', 'a.txt'), 'utf8');
    assert(/a6 B/.test(a) && /a3 C/.test(a));
    ok('old-landed task commits only its own change with the new code');

    s.setAgentState(B.id, 'idle');
    s.appendSession(B.id, { role: 'user', text: 'hello' });
    assert.strictEqual(s.getSession(B.id).entries.length, 1);
    assert.strictEqual(s.resolveTask(B.id).task.agent.state, 'idle');
    ok('agent session/state can be added to an old task');

    console.log(`\n# all ${n} upgrade checks passed`);
  } finally {
    try { git('worktree', 'remove', '--force', oldDir); } catch (_) { /* ignore */ }
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath $env:T -Recurse -Force -ErrorAction SilentlyContinue'], { env: { ...process.env, T: ROOT }, stdio: 'ignore' });
  }
}

main().catch((e) => { console.error('FAILED:', e && e.stack); process.exitCode = 1; });
