'use strict';
require('./hide-windows');
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

    // what 0.3.x leaves behind: a committed task whose left-out file is still in its changelist (0.3.x did not
    // record leftovers) and a file parked in ignore-on-commit by an old "커밋 준비"
    const xPath = path.join(wc, 'app', 'x.txt');
    const wPath = path.join(wc, 'app', 'w.txt');
    fs.writeFileSync(xPath, 'x1\r\nx2\r\nx3\r\nx4\r\n');
    fs.writeFileSync(wPath, 'w1\r\n');
    svn('add', '-q', xPath, wPath);
    svn('commit', '-q', '-m', 'x w', xPath, wPath);
    await s.refreshScope(scope.id);
    const D = await s.createTask(scope.id, { title: 'left over' });
    const E = await s.createTask(scope.id, { title: 'next' });
    const ed = (t, f, from, to) => { const p = path.join(t.workPath, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to)); };
    ed(D, 'x.txt', 'x2\r\n', 'x2 D\r\n'); fs.writeFileSync(path.join(D.workPath, 'd.txt'), 'd\r\n'); await s.commitTask(D.id, 'D');
    ed(E, 'x.txt', 'x3\r\n', 'x3 E\r\n'); ed(E, 'w.txt', 'w1\r\n', 'w1 E\r\n'); await s.commitTask(E.id, 'E');
    assert((await s.landTask(D.id)).ok);
    svn('commit', '-q', '-m', 'only d', path.join(wc, 'app', 'd.txt'));
    assert.strictEqual((await s.checkCommitted(D.id)).status, 'committed');
    const dFile = path.join(scope.home, 'tasks', D.id + '.json');
    const dj = JSON.parse(fs.readFileSync(dFile, 'utf8'));
    delete dj.leftovers;
    fs.writeFileSync(dFile, JSON.stringify(dj, null, 2));
    svn('changelist', '-q', 'ignore-on-commit', wPath);
    // an UNMODIFIED file still in a changelist of a task that no longer exists (TortoiseSVN does not show it)
    const vPath = path.join(wc, 'app', 'v.txt');
    fs.writeFileSync(vPath, 'v1\r\n');
    svn('add', '-q', vPath);
    svn('commit', '-q', '-m', 'v', vPath);
    svn('changelist', '-q', 'svnwt-99-gone', vPath);
    const dry = await s.landTask(E.id, { dryRun: true });
    assert(!dry.ok && dry.blocked.length === 2, JSON.stringify(dry.blocked));
    const rq = await s.requestChangelist(E.id, { dryRun: true });
    assert(rq.ready && !rq.blocked, JSON.stringify(rq));
    const live = await s.wcOccupantsLive(E.id);
    assert(live.some((o) => o.id === D.id && o.status === 'committed') && live.some((o) => o.status === 'parked') && live.some((o) => o.changelist === 'svnwt-99-gone' && o.status === 'stale'), JSON.stringify(live));
    ok('0.3.x leftovers (committed task, ignore-on-commit) are found from the working copy; agent dry run is not a conflict');

    await s.clearWorkingCopy(E.id);
    const le = await s.landTask(E.id);
    assert(le.ok, JSON.stringify(le.blocked));
    const cls = [...new Set([...svn('status', '--xml', wc).matchAll(/<changelist\s+name="([^"]+)"/g)].map((m) => m[1]))];
    assert.deepStrictEqual(cls, [E.changelist], cls.join(', '));
    const x = fs.readFileSync(xPath, 'utf8');
    assert(/x3 E/.test(x) && !/x2 D/.test(x), x);
    ok('switch clears all of it; the next task lands as the only changelist');

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
