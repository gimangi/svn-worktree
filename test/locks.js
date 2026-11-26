'use strict';
require('./hide-windows');
/**
 * Lock / concurrency test: several agents creating tasks at the same time, long operations holding the
 * scope lock, and locks left behind by dead processes.
 *   Code.exe(node) test/locks.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-locks-'));
process.env.SVNWT_HOME = path.join(ROOT, 'home');
const store = require('../src/core/store');
const { Service } = require('../src/core/service');
const env = require('../src/core/env');

const NODE = process.execPath;
const SERVER = path.join(__dirname, '..', 'src', 'mcp', 'server.js');
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
let n = 0;
const ok = (m) => console.log(`  ok ${++n} - ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `server.js cli <tool> <json>` in its own process (= one agent's MCP server). */
function agentCall(tool, args) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [SERVER, 'cli', tool, JSON.stringify(args)], { env: nodeEnv, windowsHide: true });
    let out = '';
    let err = '';
    const t0 = Date.now();
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}

/** Child process that takes a lock and holds it (optionally forever, to be killed). */
function holdLock(lockDir, ms, op) {
  const code = `const s=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'store.js'))});
    s.withLock(${JSON.stringify(lockDir)}, () => { process.stdout.write('held\\n'); return new Promise((r) => setTimeout(r, ${ms})); }, { op: ${JSON.stringify(op)} }).then(() => process.exit(0));`;
  const p = spawn(NODE, ['-e', code], { env: nodeEnv, windowsHide: true });
  return new Promise((resolve) => p.stdout.once('data', () => resolve(p)));
}

async function main() {
  const t = await env.requireTools();
  const svn = (...a) => execFileSync(t.svn.path, ['--non-interactive', ...a], { encoding: 'utf8' });
  execFileSync(path.join(path.dirname(t.svn.path), 'svnadmin.exe'), ['create', path.join(ROOT, 'repo')]);
  const wc = path.join(ROOT, 'wc');
  svn('checkout', '-q', 'file:///' + path.join(ROOT, 'repo').replace(/\\/g, '/'), wc);
  const app = path.join(wc, 'app');
  // a few thousand files so that checking out a worktree takes a noticeable time
  for (let d = 0; d < 40; d++) {
    fs.mkdirSync(path.join(app, `m${d}`), { recursive: true });
    for (let f = 0; f < 60; f++) fs.writeFileSync(path.join(app, `m${d}`, `f${f}.cpp`), `// ${d}/${f}\r\n${'int x = 0;\r\n'.repeat(40)}`);
  }
  svn('add', '-q', app);
  svn('commit', '-q', '-m', 'init', wc);
  svn('update', '-q', wc);
  const s = new Service();
  const { scope } = await s.initScope(app, { name: 'app' });
  const git = await s.git(scope);
  console.log(`# scope ${scope.id}: ${scope.lastSnapshot.files} files, first snapshot ${scope.lastSnapshot.totalMs}ms`);

  // ---------------------------------------------------------------- 1) 3 agents at once, no snapshot yet
  await git.exec(['update-ref', '-d', 'refs/heads/svn-base']);
  const t0 = Date.now();
  const res = await Promise.all([1, 2, 3].map((i) => agentCall('task_create', { scope: 'app', title: `agent ${i}` })));
  for (const r of res) assert.strictEqual(r.code, 0, r.err || r.out);
  const created = res.map((r) => JSON.parse(r.out));
  const nos = created.map((c) => c.no).sort();
  assert.strictEqual(new Set(nos).size, 3, nos.join(','));
  const baseCommits = (await git.exec(['rev-list', '--count', 'refs/heads/svn-base'])).trim();
  assert.strictEqual(baseCommits, '1', 'snapshot must run once, got ' + baseCommits);
  for (const c of created) {
    assert(fs.existsSync(path.join(c.workPath, 'm39', 'f59.cpp')), 'checked out: ' + c.workPath);
    assert.strictEqual((await git.exec(['status', '--porcelain'], { cwd: c.workPath })).trim(), '', 'clean worktree');
  }
  ok(`3 agents created tasks at once (${nos.join(', ')}) in ${Date.now() - t0}ms; first snapshot ran once; all worktrees complete and clean`);

  // ---------------------------------------------------------------- 2) a long operation holds the scope lock
  const holder = await holdLock(path.join(scope.home, 'lock'), 25000, 'app: SVN 기준 읽기 (snapshot) [test]');
  const t1 = Date.now();
  const res2 = await Promise.all([4, 5, 6].map((i) => agentCall('task_create', { scope: 'app', title: `during snapshot ${i}` })));
  const took = Date.now() - t1;
  for (const r of res2) assert.strictEqual(r.code, 0, r.err || r.out);
  assert(took < 20000, `task creation waited for the scope lock (${took}ms)`);
  ok(`while another process held the scope lock (long snapshot), 3 more tasks were created in ${took}ms without waiting`);

  // a waiter on the scope lock gets a clear message naming the operation
  await assert.rejects(store.withLock(path.join(scope.home, 'lock'), async () => {}, { timeoutMs: 1500, op: 'test waiter' }), (e) => /SVN 기준 읽기 \(snapshot\) \[test\].*진행 중/.test(e.message) && e.message.includes(scope.home));
  const info = s.locks().find((l) => l.name === 'scope');
  assert(info && info.alive === true && !info.stale && /snapshot/.test(info.op), JSON.stringify(info));
  ok('timeout message names the running operation; locks() shows holder alive');

  // ---------------------------------------------------------------- 3) holder killed while holding
  holder.kill();
  const t2 = Date.now();
  await store.withLock(path.join(scope.home, 'lock'), async () => {}, { op: 'after kill' });
  assert(Date.now() - t2 < 5000, 'waited ' + (Date.now() - t2));
  ok(`lock of a killed process is broken at once (${Date.now() - t2}ms)`);

  // ---------------------------------------------------------------- 4) leftovers: dead pid / old format
  const L = path.join(scope.home, 'lock');
  fs.mkdirSync(L);
  fs.writeFileSync(path.join(L, 'owner.json'), JSON.stringify({ pid: 999999, host: os.hostname(), op: 'crashed', at: new Date().toISOString() }));
  await new Promise((r) => setTimeout(r, 2100)); // past the "just created" grace period
  let t3 = Date.now();
  await s.refreshScope(scope.id);
  assert(Date.now() - t3 < 15000);
  fs.mkdirSync(L);
  fs.writeFileSync(path.join(L, 'owner'), '999999'); // svnwt <= 0.3.x
  await new Promise((r) => setTimeout(r, 2100));
  t3 = Date.now();
  await store.withLock(L, async () => {}, {});
  assert(Date.now() - t3 < 3000);
  ok('locks left by dead processes (new and old format) are removed immediately');

  // ---------------------------------------------------------------- 5) live holder: wait, then continue
  const h2 = await holdLock(L, 3000, 'short op');
  const t4 = Date.now();
  await store.withLock(L, async () => {}, { op: 'waiter' });
  const waited = Date.now() - t4;
  assert(waited >= 2000 && waited < 10000, 'waited ' + waited);
  h2.kill();
  ok(`a live holder is waited for (${waited}ms), not broken`);

  // releaseLock: stale only unless forced
  fs.mkdirSync(L);
  fs.writeFileSync(path.join(L, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), op: 'me', at: new Date().toISOString() }));
  assert(!s.releaseLock(L).released);
  assert(s.releaseLock(L, { force: true }).released && !fs.existsSync(L));
  ok('releaseLock keeps live locks unless forced');

  console.log(`\n# all ${n} lock checks passed`);
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath $env:T -Recurse -Force'], { env: { ...process.env, T: ROOT }, stdio: 'ignore' }); } catch (_) { /* ignore */ }
}

main().catch((e) => { console.error('FAILED:', e && e.stack); console.error('# root', ROOT); process.exit(1); });
