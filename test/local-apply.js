'use strict';
require('./hide-windows');
/**
 * 로컬 반영 only (fast, ~1 min): the cases that broke on a real working copy.
 *   set ELECTRON_RUN_AS_NODE=1 & "<Code.exe>" test\local-apply.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-la-'));
process.env.SVNWT_HOME = path.join(ROOT, 'home');
const { Service } = require('../src/core/service');
const env = require('../src/core/env');

const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const R = (p) => fs.readFileSync(p, 'utf8');
let n = 0;
const ok = (m) => console.log(`  ok ${++n} - ${m}`);

async function main() {
  const t = await env.detect(true);
  const SVN = t.svn.path;
  const svn = (...a) => execFileSync(SVN, ['--non-interactive', ...a], { encoding: 'utf8', windowsHide: true });
  const repo = path.join(ROOT, 'repo');
  execFileSync(path.join(path.dirname(SVN), 'svnadmin.exe'), ['create', repo]);
  const wc = path.join(ROOT, 'wc');
  svn('checkout', 'file:///' + repo.replace(/\\/g, '/'), wc);
  const app = path.join(wc, 'trunk', 'Web');
  W(path.join(app, 'Views', 'Home', 'Index.cshtml'), 'home\r\n');
  W(path.join(app, 'Web.config'), '<configuration/>\r\n');
  svn('add', path.join(wc, 'trunk'));
  svn('commit', '-m', 'init', wc);
  svn('update', wc);
  const s = new Service();
  const scope = (await s.initScope(path.join(wc, 'trunk'))).scope;
  const st = () => svn('status', path.join(wc, 'trunk')).split(/\r?\n/).filter(Boolean).sort();

  // the task adds a new view folder
  const T = await s.createTask(scope.id, { title: 'reports view' });
  W(path.join(T.workPath, 'Web', 'Views', 'Reports', 'Index.cshtml'), 'index (task)\r\n');
  W(path.join(T.workPath, 'Web', 'Views', 'Reports', 'List.cshtml'), 'list (task)\r\n');
  W(path.join(T.workPath, 'Web', 'Views', 'Home', 'Index.cshtml'), 'home (task)\r\n');
  await s.commitTask(T.id, 'reports view');

  // 1) the same folder is already in the working copy, unversioned, with the task's files and a file of the user's
  const rc = path.join(app, 'Views', 'Reports');
  W(path.join(rc, 'Index.cshtml'), 'index (old copy)\r\n');
  W(path.join(rc, 'List.cshtml'), 'list (old copy)\r\n');
  W(path.join(rc, 'Mine.txt'), 'user note\r\n');
  W(path.join(app, 'Web.config'), '<configuration debug="true"/>\r\n'); // a local edit of the user
  const before = st();
  const r = await s.localApply(T.id, { build: false });
  assert(r.ok, '로컬 반영 blocked: ' + JSON.stringify(r.blocked || r));
  assert.strictEqual(R(path.join(rc, 'Index.cshtml')), 'index (task)\r\n');
  assert.strictEqual(R(path.join(app, 'Views', 'Home', 'Index.cshtml')), 'home (task)\r\n');
  assert(!fs.existsSync(path.join(rc, 'Mine.txt')), 'other files of the folder set aside while applied');
  assert.strictEqual(R(path.join(app, 'Web.config')), '<configuration/>\r\n', 'user edit set aside');
  ok('task files inside an unversioned folder already in the working copy: 로컬 반영 works');
  const e = await s.endTest(T.id);
  assert(!e.errors.length && !e.kept.length, JSON.stringify(e));
  assert.deepStrictEqual(st(), before);
  assert.strictEqual(R(path.join(rc, 'Index.cshtml')), 'index (old copy)\r\n');
  assert.strictEqual(R(path.join(rc, 'Mine.txt')), 'user note\r\n');
  assert.strictEqual(R(path.join(app, 'Web.config')), '<configuration debug="true"/>\r\n');
  ok('되돌리기: the folder and its files, and the user edit, back exactly');

  // 2) 로컬 반영 → 커밋 준비 → 취소, same state
  assert((await s.localApply(T.id, { build: false })).ok);
  assert((await s.prepareFromLocal(T.id)).ok);
  await s.endCommit(T.id);
  assert.deepStrictEqual(st(), before);
  assert.strictEqual(R(path.join(rc, 'Mine.txt')), 'user note\r\n');
  ok('로컬 반영 → 커밋 준비 → 취소: everything back');

  // 3) build detection: fake MSBuild + the .sln above the scope
  W(path.join(wc, 'trunk', 'App.sln'), '');
  const fake = path.join(ROOT, 'msbuild.cmd');
  fs.writeFileSync(fake, '@echo fake msbuild %*\r\n@exit /b 0\r\n');
  process.env.SVNWT_MSBUILD = fake;
  const d = s.detectLocalBuild(scope.id);
  assert(d.command && d.target === 'App.sln', JSON.stringify(d));
  const lb = await s.localApply(T.id);
  assert(lb.ok && lb.build && lb.build.ok && lb.build.tail.some((l) => /fake msbuild "?App\.sln/.test(l)), JSON.stringify(lb.build));
  await s.endTest(T.id);
  fs.rmSync(path.join(wc, 'trunk', 'App.sln'));
  s.setLocalBuild(scope.id, null);
  delete process.env.SVNWT_MSBUILD;
  process.env.SVNWT_MSBUILD = path.join(ROOT, 'none.exe');
  const nb = await s.localApply(T.id);
  assert(nb.ok && nb.build && !nb.build.ok && nb.build.missing, JSON.stringify(nb.build));
  await s.endTest(T.id);
  ok('build: MSBuild + .sln found without asking; nothing found -> applied, build.missing (agent can take over)');

  console.log(`# all ${n} passed`);
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath $env:T -Recurse -Force'], { env: { ...process.env, T: ROOT }, stdio: 'ignore' }); } catch (_) { /* ignore */ }
}

main().catch((e) => { console.error('FAILED:', e && e.stack); console.error('# root', ROOT); process.exit(1); });
