'use strict';
require('./hide-windows');
/**
 * End-to-end test against a real local SVN repository (file://).
 *   set ELECTRON_RUN_AS_NODE=1 & "<Code.exe>" test\e2e.js      (or: node test\e2e.js)
 * Requires svn.exe + svnadmin.exe and git.exe.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-e2e-'));
process.env.SVNWT_HOME = path.join(ROOT, 'home');
const { Service } = require('../src/core/service');
const env = require('../src/core/env');

let SVN;
let SVNADMIN;
const svn = (...a) => execFileSync(SVN, ['--non-interactive', ...a], { encoding: 'utf8', windowsHide: true });
const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const R = (p) => fs.readFileSync(p, 'utf8');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const cp949Hangul = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0d, 0x0a]); // "한글\r\n" in CP949

let step = 0;
function ok(msg) { console.log(`  ok ${++step} - ${msg}`); }

async function main() {
  const t = await env.detect(true);
  assert(t.git && t.svn, 'git/svn required');
  SVN = t.svn.path;
  SVNADMIN = path.join(path.dirname(SVN), 'svnadmin.exe');
  console.log(`# ${t.git.version} / svn ${t.svn.version}\n# root ${ROOT}`);

  // ---------------------------------------------------------------- repo + WC
  const repo = path.join(ROOT, 'repo');
  execFileSync(SVNADMIN, ['create', repo]);
  const url = 'file:///' + repo.replace(/\\/g, '/');
  const wc = path.join(ROOT, 'wc');
  svn('checkout', url, wc);
  W(path.join(wc, 'trunk', 'common', 'util.h'), crlf('#pragma once\nint util();\n'));
  W(path.join(wc, 'trunk', 'app', 'main.cpp'), crlf('#include "../common/util.h"\n\nint main() {\n  // A\n  int a = 1;\n\n\n\n  // B\n  int b = 2;\n  return util();\n}\n'));
  W(path.join(wc, 'trunk', 'app', 'old.txt'), crlf('to be renamed\nline2\nline3\n'));
  W(path.join(wc, 'trunk', 'app', 'gone.txt'), 'delete me\n');
  W(path.join(wc, 'trunk', 'app', 'other.txt'), 'user edits this directly\n');
  fs.writeFileSync(path.join(wc, 'trunk', 'app', '한글.txt'), cp949Hangul);
  svn('add', path.join(wc, 'trunk'));
  svn('propset', 'svn:ignore', 'bin\nobj', path.join(wc, 'trunk', 'app'));
  svn('commit', '-m', 'initial', wc);
  svn('update', wc);
  ok('svn repository + working copy');

  const s = new Service();
  const appDir = path.join(wc, 'trunk', 'app');

  // ---------------------------------------------------------------- scope
  const init = await s.initScope(appDir, { linkOutside: true });
  assert.strictEqual(init.created, true);
  assert.strictEqual(init.snapshot.files, 5);
  const scope = init.scope;
  assert(!fs.readdirSync(appDir).includes('.git'), 'no .git inside SVN WC');
  assert(!svn('status', wc).trim(), 'SVN WC untouched by scope init');
  ok(`scope init (${init.snapshot.files} files, ${init.snapshot.elapsedMs}ms) at ${scope.home}`);

  // ---------------------------------------------------------------- tasks
  const A = await s.createTask(scope.id, { title: 'Fix A block', description: 'change block A, add feature dir, rename, delete' });
  const B = await s.createTask(scope.id, { title: 'Tune B', description: 'change block B' });
  assert(fs.existsSync(path.join(A.workPath, 'main.cpp')));
  assert.strictEqual(R(path.join(A.workPath, 'main.cpp')), R(path.join(appDir, 'main.cpp')), 'byte-identical checkout (CRLF kept)');
  assert(fs.readFileSync(path.join(A.workPath, '한글.txt')).equals(cp949Hangul), 'CP949 bytes kept');
  // linkOutside: ../common resolves through junction
  assert(fs.existsSync(path.join(A.workPath, '..', 'common', 'util.h')), 'sibling folder linked');
  ok(`tasks created: ${A.id} (${A.workPath}), ${B.id}`);

  // Task A edits
  const mainA = R(path.join(A.workPath, 'main.cpp')).replace('int a = 1;', 'int a = 100;');
  fs.writeFileSync(path.join(A.workPath, 'main.cpp'), mainA);
  W(path.join(A.workPath, 'feature', 'deep', 'new.cpp'), crlf('// new file\n'));
  fs.renameSync(path.join(A.workPath, 'old.txt'), path.join(A.workPath, 'renamed.txt'));
  fs.unlinkSync(path.join(A.workPath, 'gone.txt'));
  W(path.join(A.workPath, 'bin', 'out.exe'), 'build output - must be ignored');
  const cA = await s.commitTask(A.id, 'A: change a, add feature, rename old->renamed, delete gone');
  assert(cA.committed);
  const infoA = await s.taskInfo(A.id);
  const paths = infoA.files.map((f) => `${f.status}:${f.path}`).sort();
  assert.deepStrictEqual(paths, ['A:feature/deep/new.cpp', 'D:gone.txt', 'M:main.cpp', 'R:renamed.txt'], JSON.stringify(paths));
  ok('task A committed; svn:ignore (bin) respected; ' + paths.join(' '));

  // Task B edits the same file, other region
  const mainB = R(path.join(B.workPath, 'main.cpp')).replace('int b = 2;', 'int b = 200;');
  fs.writeFileSync(path.join(B.workPath, 'main.cpp'), mainB);
  await s.commitTask(B.id, 'B: change b');

  // The user edits the SVN WC directly meanwhile
  fs.writeFileSync(path.join(appDir, 'other.txt'), 'user edits this directly\nmore\n');

  // ---------------------------------------------------------------- land A
  const dry = await s.landTask(A.id, { dryRun: true });
  assert(dry.ok && dry.dryRun);
  assert(!svn('status', '-q', appDir).includes('main.cpp'), 'dry run wrote nothing');
  const landA = await s.landTask(A.id);
  assert(landA.ok, JSON.stringify(landA));
  const st = svn('status', appDir);
  console.log(st.replace(/^/gm, '    | '));
  assert(/--- Changelist 'svnwt-1-fix-a-block'/.test(st));
  assert(/^A  +\+ .*renamed\.txt/m.test(st), 'renamed via svn move (history kept)');
  assert(/^D .*old\.txt/m.test(st));
  assert(/^D .*gone\.txt/m.test(st));
  assert(/^A .*feature[\\/]deep[\\/]new\.cpp/m.test(st));
  assert(/^M .*other\.txt/m.test(st), 'user edit untouched');
  assert.strictEqual(R(path.join(appDir, 'main.cpp')), mainA);
  assert(landA.commit.addedDirs.includes('feature') && landA.commit.addedDirs.includes('feature/deep'));
  ok('land A -> changelist svnwt-1-fix-a-block (move/add/delete, CRLF preserved)');

  // ---------------------------------------------------------------- B touches a file in A's changelist (other region)
  const landB1 = await s.landTask(B.id, { dryRun: true });
  assert(landB1.ok && landB1.files.find((f) => f.path === 'main.cpp').sharedWith === A.changelist, JSON.stringify(landB1.files));
  ok('land B (dry run): main.cpp would be shared with A\'s changelist, not blocked');

  // ---------------------------------------------------------------- human commits A (the printed command)
  const help = landA.commit;
  console.log('    $ ' + help.cli);
  execFileSync('cmd.exe', ['/d', '/s', '/c', `"${help.cli.replace(/^svn /, `"${SVN}" `)}"`], { cwd: appDir, stdio: 'inherit', windowsVerbatimArguments: true });
  const st2 = svn('status', appDir);
  assert(!/Changelist/.test(st2), 'changelist committed');
  assert(/^M .*other\.txt/m.test(st2), 'user edit not committed');
  const logMsg = svn('log', '-l', '1', url);
  assert(/Fix A block/.test(logMsg));
  const chk = await s.checkCommitted(A.id);
  assert.strictEqual(chk.status, 'committed');
  ok('human svn commit of changelist; task A detected as committed; message: ' + logMsg.split('\n')[3]);

  // ---------------------------------------------------------------- sync B onto new base, land
  const sync = await s.syncTask(B.id);
  assert(sync.ok, JSON.stringify(sync));
  const infoB = await s.taskInfo(B.id);
  assert(infoB.baseIsLatest);
  assert(R(path.join(B.workPath, 'main.cpp')).includes('int a = 100;') && R(path.join(B.workPath, 'main.cpp')).includes('int b = 200;'));
  const landB = await s.landTask(B.id);
  assert(landB.ok, JSON.stringify(landB));
  const mainNow = R(path.join(appDir, 'main.cpp'));
  assert(mainNow.includes('int a = 100;') && mainNow.includes('int b = 200;'));
  ok('sync (rebase) B on new SVN base, land B');

  // ---------------------------------------------------------------- 3-way with local SVN edit + unland
  const unl = await s.unlandTask(B.id);
  assert(unl.files.every((f) => f.action !== 'conflict'), JSON.stringify(unl));
  assert(R(path.join(appDir, 'main.cpp')).includes('int b = 2;'));
  assert(!/Changelist/.test(svn('status', appDir)));
  // user edits main.cpp in the WC (other region), then land again -> merged
  fs.writeFileSync(path.join(appDir, 'main.cpp'), R(path.join(appDir, 'main.cpp')).replace('// A', '// A (user)'));
  const landB2 = await s.landTask(B.id);
  assert(landB2.ok && landB2.files.find((f) => f.path === 'main.cpp').merged, JSON.stringify(landB2.files));
  const merged = R(path.join(appDir, 'main.cpp'));
  assert(merged.includes('// A (user)') && merged.includes('int b = 200;') && merged.includes('\r\n'));
  ok('unland B, user edit + re-land => 3-way merged, CRLF kept');

  // ---------------------------------------------------------------- re-land after more commits
  fs.writeFileSync(path.join(B.workPath, 'main.cpp'), R(path.join(B.workPath, 'main.cpp')).replace('return util();', 'return util() + b;'));
  await s.commitTask(B.id, 'B: use b');
  const landB3 = await s.landTask(B.id);
  assert(landB3.ok);
  assert(R(path.join(appDir, 'main.cpp')).includes('return util() + b;') && R(path.join(appDir, 'main.cpp')).includes('// A (user)'));
  ok('re-land after another commit updates the working copy incrementally');

  // ---------------------------------------------------------------- review + misc
  const rv = await s.submitReview(B.id, { verdict: 'approve', summary: 'looks good', comments: [{ file: 'main.cpp', line: 10, body: 'nit' }] });
  assert.strictEqual(s.listReviews(B.id).length, 1);
  assert.strictEqual(rv.comments[0].line, 10);
  const diff = await s.diffTask(B.id);
  assert(/int b = 200;/.test(diff.diff));
  const map = s.mapPath(path.join(appDir, 'main.cpp'));
  assert(map.worktrees.some((w) => w.path === path.join(B.workPath, 'main.cpp')));
  const back = s.mapPath(path.join(B.workPath, 'main.cpp'));
  assert.strictEqual(back.svnPath, path.join(appDir, 'main.cpp'));
  ok('review stored, diff, path mapping');

  // Korean file name in task + land (command-line Unicode paths)
  const K = await s.createTask(scope.id, { title: '한글 파일 추가' });
  W(path.join(K.workPath, '문서', '설명.txt'), '내용\n');
  fs.writeFileSync(path.join(K.workPath, '한글.txt'), Buffer.concat([cp949Hangul, cp949Hangul]));
  await s.commitTask(K.id, '한글 커밋 메시지');
  assert(/^\d+$/.test(K.id), 'non-ascii title => numeric id');
  const landK = await s.landTask(K.id);
  assert(landK.ok, JSON.stringify(landK));
  const stK = svn('status', '--xml', appDir);
  assert(stK.includes('설명.txt'));
  assert(fs.readFileSync(path.join(appDir, '한글.txt')).equals(Buffer.concat([cp949Hangul, cp949Hangul])));
  execFileSync('cmd.exe', ['/d', '/s', '/c', `"${landK.commit.cli.replace(/^svn /, `"${SVN}" `)}"`], { cwd: appDir, stdio: 'inherit', windowsVerbatimArguments: true });
  assert(/한글 파일 추가/.test(svn('log', '--xml', '-l', '1', url)), 'Korean commit message');
  assert(/설명\.txt/.test(svn('list', '--xml', '-R', url + '/trunk/app')), 'Korean path committed');
  ok('Korean path/message: land + commit via targets file');

  // ---------------------------------------------------------------- two tasks on one file: land both, commit separately
  const sharedPath = path.join(appDir, 'shared.txt');
  W(sharedPath, crlf('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n'));
  svn('add', sharedPath);
  svn('commit', '-m', 'add shared', sharedPath);
  await s.refreshScope(scope.id);
  const P = await s.createTask(scope.id, { title: 'shared p' });
  const Q = await s.createTask(scope.id, { title: 'shared q' });
  const editIn = (wp, from, to) => { const f = path.join(wp, 'shared.txt'); fs.writeFileSync(f, R(f).replace(from, to)); };
  editIn(P.workPath, 'line1\r\n', 'line1 P\r\n');
  await s.commitTask(P.id, 'p');
  editIn(Q.workPath, 'line8\r\n', 'line8 Q\r\n');
  W(path.join(Q.workPath, 'q.txt'), 'q\n');
  await s.commitTask(Q.id, 'q');
  fs.writeFileSync(sharedPath, R(sharedPath).replace('line4\r\n', 'line4 USER\r\n')); // user's own local edit
  assert((await s.landTask(P.id)).ok);
  const lq = await s.landTask(Q.id);
  assert(lq.ok && lq.files.find((f) => f.path === 'shared.txt').sharedWith === P.changelist, JSON.stringify(lq.files));
  assert(/line1 P/.test(R(sharedPath)) && /line4 USER/.test(R(sharedPath)) && /line8 Q/.test(R(sharedPath)));
  const clOf = (f) => { const x = svn('status', '--xml', appDir); const m = new RegExp(`<changelist\\s+name="([^"]+)">(?:(?!</changelist>)[\\s\\S])*?${f.replace('.', '\\.')}`).exec(x); return m ? m[1] : null; };
  assert.strictEqual(clOf('shared.txt'), P.changelist);
  assert.strictEqual(clOf('q.txt'), Q.changelist);
  ok('two tasks landed on the same file (shared file stays in the first changelist)');

  const headDiff = () => svn('diff', '-c', svn('info', '--show-item', 'revision', '-r', 'HEAD', url).trim(), url);
  const planQ = await s.commitPlan(Q.id);
  assert(planQ.setAside.some((x) => x.path === 'shared.txt'), JSON.stringify(planQ));
  await s.beginCommit(Q.id);
  assert(!/line1 P|USER/.test(R(sharedPath)) && /line8 Q/.test(R(sharedPath)), 'isolated to Q only');
  assert((await s.runSvnCommit(Q.id)).ok);
  assert((await s.endCommit(Q.id)).committed);
  const dq = headDiff();
  assert(/\+line8 Q/.test(dq) && !/line1 P|USER/.test(dq) && /q\.txt/.test(dq), dq);
  assert(/line1 P/.test(R(sharedPath)) && /line4 USER/.test(R(sharedPath)), 'restored after commit');
  assert.strictEqual(clOf('shared.txt'), P.changelist);
  assert.strictEqual(s.resolveTask(Q.id).task.status, 'committed');
  ok('commit Q first: revision has only Q\'s change; P\'s change and user edit restored');

  await s.beginCommit(P.id);
  assert(!/USER/.test(R(sharedPath)));
  const cancelled = await s.endCommit(P.id); // user closed the commit dialog
  assert(!cancelled.committed && /USER/.test(R(sharedPath)) && s.resolveTask(P.id).task.status === 'landed');
  await s.beginCommit(P.id);
  assert((await s.runSvnCommit(P.id)).ok);
  assert((await s.endCommit(P.id)).committed);
  const dp = headDiff();
  assert(/\+line1 P/.test(dp) && !/USER|line8 Q/.test(dp.split('\n').filter((l) => /^[+-]/.test(l)).join('\n')), dp);
  const rest = svn('diff', sharedPath);
  assert(/\+line4 USER/.test(rest) && !/line1 P|line8 Q/.test(rest.split('\n').filter((l) => /^[+-][^+-]/.test(l)).join('\n')), rest);
  assert(!clOf('shared.txt'));
  ok('cancelled commit restores; commit P: only P\'s change; user edit stays local, outside changelists');

  // ---------------------------------------------------------------- external commit tool (user opens TortoiseSVN on the WC root)
  await s.refreshScope(scope.id);
  const X = await s.createTask(scope.id, { title: 'ext x' });
  const Y = await s.createTask(scope.id, { title: 'ext y' });
  editIn(X.workPath, 'line2\r\n', 'line2 X\r\n');
  await s.commitTask(X.id, 'x');
  editIn(Y.workPath, 'line7\r\n', 'line7 Y\r\n');
  W(path.join(Y.workPath, 'ydir', 'y.txt'), 'y\n');
  await s.commitTask(Y.id, 'y');
  assert((await s.landTask(X.id)).ok);
  assert((await s.landTask(Y.id)).ok);
  const prep = await s.beginCommit(X.id, { external: true });
  assert(prep.parked > 0 && prep.otherNewDirs.length === 0, JSON.stringify(prep));
  assert(!fs.readFileSync(sharedPath, 'utf8').includes('line7 Y'), 'Y set aside in shared file');
  const { parseStatus } = require('../src/core/svn');
  const tortoiseDefault = parseStatus(svn('status', '--xml', wc))
    .filter((e) => !e.changelist && ['modified', 'added', 'deleted'].includes(e.item)).map((e) => e.path);
  assert(tortoiseDefault.length === 1 && /shared\.txt$/.test(tortoiseDefault[0]), 'only X checked by default: ' + tortoiseDefault.join(', '));
  assert(!(await s.commitDone(X.id)));
  svn('commit', '--depth', 'empty', '-m', 'tortoise default selection', ...tortoiseDefault);
  assert(await s.commitDone(X.id), 'commit detected');
  const endX = await s.endCommit(X.id);
  assert(endX.committed, JSON.stringify(endX));
  const dx = headDiff();
  assert(/\+line2 X/.test(dx) && !/line7 Y|USER|y\.txt/.test(dx), dx);
  const sh = R(sharedPath);
  assert(/line2 X/.test(sh) && /line7 Y/.test(sh) && /line4 USER/.test(sh), 'Y and user edit restored');
  assert.strictEqual(clOf('shared.txt'), Y.changelist, 'shared file handed to Y');
  assert.strictEqual(clOf('y.txt'), Y.changelist, 'Y new folder re-added with its changelist');
  assert(/^A\s+.*ydir$/m.test(svn('status', appDir)), 'ydir scheduled for add again');
  assert(!/ignore-on-commit/.test(svn('status', wc)), 'no file left in ignore-on-commit');
  assert(/^M\s+.*other\.txt$/m.test(svn('status', appDir)) && !clOf('other.txt'), 'user local edit untouched');
  ok('external commit tool: only X checked by default, X committed alone, everything else restored');

  // ---------------------------------------------------------------- commit order: same lines in two tasks
  const ordPath = path.join(appDir, 'ord.txt');
  W(ordPath, crlf('o1\no2\no3\no4\no5\no6\n'));
  svn('add', '-q', ordPath);
  svn('commit', '-q', '-m', 'add ord', ordPath);
  await s.refreshScope(scope.id);
  const OA = await s.createTask(scope.id, { title: 'order A' });
  const OB = await s.createTask(scope.id, { title: 'order B' });
  { const f = path.join(OA.workPath, 'ord.txt'); fs.writeFileSync(f, R(f).replace('o3\r\n', 'o3 A\r\n')); }
  { const f = path.join(OB.workPath, 'ord.txt'); fs.writeFileSync(f, R(f).replace('o3\r\n', 'o3 B\r\n')); }
  await s.commitTask(OA.id, 'order A');
  await s.commitTask(OB.id, 'order B');
  assert((await s.landTask(OA.id)).ok);
  const ob1 = await s.landTask(OB.id);
  assert(!ob1.ok && ob1.waitFor.length === 1 && ob1.waitFor[0].id === OA.id, JSON.stringify(ob1));
  assert(new RegExp(`#${OA.no} "order A"`).test(ob1.blocked[0].reason), ob1.blocked[0].reason);
  let ibB = await s.taskInfo(OB.id);
  assert(ibB.waitFor[0].id === OA.id && ibB.waitReady === false, JSON.stringify(ibB.waitFor));
  assert.deepStrictEqual(((await s.taskInfo(OA.id)).waitingOnMe || []).map((x) => x.id), [OB.id]);
  assert.deepStrictEqual(s.unblockedBy(OA.id), []);
  ok('commit order: second task on the same lines waits for the first, both sides show it');
  svn('commit', '-q', '-m', 'order A', ordPath);
  assert.strictEqual((await s.checkCommitted(OA.id)).status, 'committed');
  assert.deepStrictEqual(s.unblockedBy(OA.id).map((x) => x.id), [OB.id]);
  ibB = await s.taskInfo(OB.id);
  assert(ibB.waitReady === true, JSON.stringify(ibB.waitFor));
  const ob2 = await s.landTask(OB.id, { dryRun: true });
  assert(!ob2.ok && ob2.needsRebase && !ob2.waitFor.length, JSON.stringify(ob2));
  const sy = await s.syncTask(OB.id, {});
  assert(!sy.ok && sy.conflicts.includes('ord.txt'), JSON.stringify(sy));
  fs.writeFileSync(path.join(OB.workPath, 'ord.txt'), crlf('o1\no2\no3 A B\no4\no5\no6\n'));
  assert((await s.syncTask(OB.id, { cont: true })).ok);
  const ob3 = await s.landTask(OB.id);
  assert(ob3.ok, JSON.stringify(ob3.blocked));
  assert(!s.resolveTask(OB.id).task.waitFor && /o3 A B/.test(R(ordPath)) && clOf('ord.txt') === OB.changelist);
  await s.unlandTask(OB.id);
  ok('commit order: first committed -> second unblocked, rebase (resolve) and land');

  // ---------------------------------------------------------------- partial commit -> discard what is left
  const ltPath = path.join(appDir, 'lt.txt');
  W(ltPath, crlf('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n'));
  const lt2Path = path.join(appDir, 'lt2.txt');
  W(lt2Path, crlf('only the task touches this\n'));
  svn('add', '-q', ltPath, lt2Path);
  svn('commit', '-q', '-m', 'add lt', ltPath, lt2Path);
  await s.refreshScope(scope.id);
  const LT = await s.createTask(scope.id, { title: 'leftover task' });
  { const f = path.join(LT.workPath, 'lt.txt'); fs.writeFileSync(f, R(f).replace('l2\r\n', 'l2 LT\r\n')); }
  fs.writeFileSync(path.join(LT.workPath, 'lt-new.txt'), 'new by task\r\n');
  fs.writeFileSync(path.join(LT.workPath, 'lt2.txt'), 'changed by the task\r\n');
  fs.writeFileSync(path.join(LT.workPath, 'lt-commit.txt'), 'committed part\r\n');
  await s.commitTask(LT.id, 'leftover task');
  const ll = await s.landTask(LT.id);
  assert(ll.ok, JSON.stringify(ll.blocked));
  // the user edits lt.txt elsewhere (l8), then commits ONLY lt-commit.txt (unchecked the rest in TortoiseSVN)
  fs.writeFileSync(ltPath, R(ltPath).replace('l8\r\n', 'l8 USER\r\n'));
  svn('commit', '-q', '-m', 'only lt-commit.txt', path.join(appDir, 'lt-commit.txt'));
  const cs = await s.checkCommitted(LT.id);
  assert.strictEqual(cs.status, 'committed');
  const left = (await s.leftovers(LT.id)).map((x) => x.path).sort();
  assert.deepStrictEqual(left, ['lt-new.txt', 'lt.txt', 'lt2.txt'], JSON.stringify(left));
  assert.deepStrictEqual((s.resolveTask(LT.id).task.leftovers || []).sort(), left);
  ok('partial commit: task committed, files left out of the commit listed as leftovers');
  const disc = await s.discardLeftovers(LT.id);
  assert(disc.files.every((f) => f.action !== 'conflict'), JSON.stringify(disc));
  assert(!fs.existsSync(path.join(appDir, 'lt-new.txt')), 'new file of the task removed');
  const lt2 = R(ltPath);
  assert(!/l2 LT/.test(lt2) && /l8 USER/.test(lt2), 'only the task change removed: ' + lt2);
  assert.strictEqual(R(lt2Path), 'only the task touches this\r\n');
  assert(!clOf('lt.txt') && !clOf('lt-new.txt') && !clOf('lt2.txt'), 'nothing left in the task changelist (reverted files included)');
  assert.deepStrictEqual(await s.leftovers(LT.id), []);
  ok('discard leftovers: task change removed, user edit kept, changelist empty');

  // ---------------------------------------------------------------- one changelist at a time
  const ON1 = await s.createTask(scope.id, { title: 'single one' });
  const ON2 = await s.createTask(scope.id, { title: 'single two' });
  for (const [t, v] of [[ON1, 'ONE'], [ON2, 'TWO']]) {
    const f = path.join(t.workPath, 'lt.txt');
    fs.writeFileSync(f, R(f).replace('l5\r\n', `l5 ${v}\r\n`));
    await s.commitTask(t.id, v);
  }
  assert((await s.landTask(ON1.id)).ok);
  const rq = await s.requestChangelist(ON2.id);
  assert(rq.ready && rq.ok && rq.files.some((f) => f.path === 'lt.txt'), JSON.stringify(rq));
  assert(s.resolveTask(ON2.id).task.readyAt && s.resolveTask(ON1.id).task.status === 'landed');
  assert(/l5 ONE/.test(R(ltPath)));
  ok('agent changelist request while another task holds it: marked ready, nothing replaced');
  const cw = await s.clearWorkingCopy(ON2.id);
  assert(cw.cleared.some((x) => x.id === ON1.id) && s.wcOccupants(ON2.id).length === 0, JSON.stringify(cw));
  const l2 = await s.landTask(ON2.id);
  assert(l2.ok, JSON.stringify(l2.blocked));
  const ltNow = R(ltPath);
  assert(/l5 TWO/.test(ltNow) && !/l5 ONE/.test(ltNow) && /l8 USER/.test(ltNow), ltNow);
  assert.strictEqual(clOf('lt.txt'), s.resolveTask(ON2.id).task.changelist);
  assert.strictEqual(s.resolveTask(ON1.id).task.status, 'active');
  assert(!s.resolveTask(ON2.id).task.readyAt);
  assert.deepStrictEqual(s.wcOccupants(ON1.id).map((x) => x.id), [ON2.id]);
  ok('switch changelist: other task dropped (kept in git), same-line task lands, user edit kept');
  await s.unlandTask(ON2.id);
  // dropped changelists can be made again from git at any time (later checks use them)
  for (const c of cw.cleared.filter((x) => x.status === 'landed' && x.id !== ON1.id)) {
    const r = await s.landTask(c.id);
    assert(r.ok, `re-land ${c.id}: ${JSON.stringify(r.blocked)}`);
  }

  // ---------------------------------------------------------------- not committed just because a file disappeared
  const FC = await s.createTask(scope.id, { title: 'false commit' });
  fs.writeFileSync(path.join(FC.workPath, 'fc-new.patch'), 'patch\r\n');
  fs.writeFileSync(path.join(FC.workPath, 'lt2.txt'), 'fc\r\n');
  await s.commitTask(FC.id, 'FC');
  assert((await s.landTask(FC.id)).ok);
  const fcNew = path.join(appDir, 'fc-new.patch');
  svn('revert', '-q', fcNew);
  fs.unlinkSync(fcNew);
  assert.strictEqual((await s.checkCommitted(FC.id)).status, 'landed', 'a deleted new file is not a commit');
  { // what 0.4.0 did: marked it committed. The new version puts it back.
    const f = path.join(scope.home, 'tasks', FC.id + '.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.status = 'committed';
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    const fixed = await s.reverifyCommitted();
    assert(fixed.some((x) => x.id === FC.id && x.status === 'landed'), JSON.stringify(fixed));
    assert.strictEqual(s.resolveTask(FC.id).task.status, 'landed');
    assert.deepStrictEqual(await s.reverifyCommitted(), [], 'checked once');
    const j2 = JSON.parse(fs.readFileSync(f, 'utf8'));
    j2.status = 'committed';
    j2.commitVerified = true;
    fs.writeFileSync(f, JSON.stringify(j2, null, 2));
    const man = await s.checkSvnState(FC.id);
    assert(man.checked === 1 && man.changed.some((c) => c.id === FC.id && c.to === 'landed'), JSON.stringify(man));
  }
  svn('revert', '-q', lt2Path);
  assert.strictEqual((await s.checkCommitted(FC.id)).status, 'active', 'everything reverted by hand: back to active, not committed');
  ok('commit detection: a removed/reverted file is not taken as committed');

  // ---------------------------------------------------------------- human land never refuses over local content
  const OW = await s.createTask(scope.id, { title: 'overwrite' });
  { const f = path.join(OW.workPath, 'lt.txt'); fs.writeFileSync(f, R(f).replace('l8\r\n', 'l8 OW\r\n')); }
  await s.commitTask(OW.id, 'OW');
  assert(/l8 USER/.test(R(ltPath)), 'user edit on the same line is in the working copy');
  assert(!(await s.landTask(OW.id, { dryRun: true })).ok, 'without overwrite it is a conflict');
  const ow = await s.landTask(OW.id, { overwrite: true });
  assert(ow.ok && ow.overwritten.includes('lt.txt') && ow.backupDir, JSON.stringify(ow));
  assert(/l8 OW/.test(R(ltPath)) && !/l8 USER/.test(R(ltPath)), R(ltPath));
  assert(/l8 USER/.test(fs.readFileSync(path.join(ow.backupDir, 'lt.txt'), 'utf8')), 'previous content backed up');
  assert.strictEqual(clOf('lt.txt'), s.resolveTask(OW.id).task.changelist);
  ok('changelist from the UI: overlapping local content replaced by the task version (backed up), no refusal');
  await s.unlandTask(OW.id);

  // ---------------------------------------------------------------- commit = stash everything, this task only, restore
  const spPath = path.join(appDir, 'sp.txt');
  W(spPath, crlf('s1\ns2\ns3\ns4\ns5\ns6\ns7\ns8\ns9\ns10\n'));
  svn('add', '-q', spPath);
  svn('commit', '-q', '-m', 'add sp', spPath);
  svn('update', '-q', wc);
  await s.refreshScope(scope.id);
  const edT = (t, f, from, to) => { const p = path.join(t.workPath, f); fs.writeFileSync(p, R(p).replace(from, to)); };
  const Q1 = await s.createTask(scope.id, { title: 'q1' });
  const SP = await s.createTask(scope.id, { title: 'sp' });
  const SR = await s.createTask(scope.id, { title: 'needs rebase' });
  edT(Q1, 'sp.txt', 's7\r\n', 's7 Q1\r\n'); await s.commitTask(Q1.id, 'Q1');
  edT(SP, 'sp.txt', 's2\r\n', 's2 SP\r\n'); edT(SP, 'sp.txt', 's5\r\n', 's5 SP\r\n');
  fs.writeFileSync(path.join(SP.workPath, 'stray.txt'), 'from task\r\n'); await s.commitTask(SP.id, 'SP');
  edT(SR, 'sp.txt', 's5\r\n', 's5 SR\r\n'); await s.commitTask(SR.id, 'SR');
  assert((await s.landTask(Q1.id)).ok);
  fs.writeFileSync(spPath, R(spPath).replace('s9\r\n', 's9 USER\r\n'));
  fs.writeFileSync(path.join(appDir, 'stray.txt'), 'user stray\r\n'); // unversioned file where the task adds one
  const before = R(spPath);
  const svnBefore = svn('status', appDir);
  const stSet = (t = svn('status', appDir)) => t.split(/\r?\n/).filter((l) => l.trim()).sort();

  // cancel: the working copy comes back exactly
  const SC = await s.createTask(scope.id, { title: 'cancel me' });
  edT(SC, 'sp.txt', 's3\r\n', 's3 SC\r\n'); await s.commitTask(SC.id, 'SC');
  const pc = await s.stashCommit(SC.id);
  assert(pc.ok, JSON.stringify(pc));
  assert.strictEqual(R(spPath), crlf('s1\ns2\ns3 SC\ns4\ns5\ns6\ns7\ns8\ns9\ns10\n'), 'only this task in the working copy');
  const cancel = await s.endCommit(SC.id);
  assert(!cancel.committed && !cancel.kept.length && !cancel.errors.length, JSON.stringify(cancel));
  assert.strictEqual(R(spPath), before);
  assert.deepStrictEqual(stSet(), stSet(svnBefore));
  assert.strictEqual(s.resolveTask(SC.id).task.status, 'active');
  ok('커밋 준비 → 취소: working copy (changes, changelists, unversioned file) back exactly as it was');

  { // VS Code stopped in the middle of 커밋 준비 (task partly applied, marker still "stashing"): the next start restores
    const pi = await s.stashCommit(SC.id);
    assert(pi.ok, JSON.stringify(pi));
    const mf = path.join(scope.home, 'commit-in-progress.json');
    const mk = JSON.parse(fs.readFileSync(mf, 'utf8'));
    delete mk.revs;
    mk.phase = 'stashing';
    fs.writeFileSync(mf, JSON.stringify(mk, null, 2));
    const fixedTask = path.join(scope.home, 'tasks', SC.id + '.json');
    const tj = JSON.parse(fs.readFileSync(fixedTask, 'utf8'));
    tj.status = 'active';
    tj.landed = null;
    fs.writeFileSync(fixedTask, JSON.stringify(tj, null, 2));
    const rec = await s.endCommit(SC.id);
    assert(!rec.committed && !rec.kept.length && !rec.errors.length, JSON.stringify(rec));
    assert.strictEqual(R(spPath), before);
    assert.deepStrictEqual(stSet(), stSet(svnBefore));
    assert.strictEqual(s.resolveTask(SC.id).task.status, 'active');
    ok('커밋 준비 stopped half way (VS Code restarted): task taken back out, everything set aside restored');
  }

  { // cancel button: before anything is set aside, and after the task is on the working copy; log of every command
    const proc = require('../src/core/proc');
    const logs = [];
    proc.setLogger((l) => logs.push(l));
    await s.svn().then((x) => x.status(appDir));
    assert(!logs.length, 'outside 커밋 준비 only slow commands are logged: ' + logs.join('\n'));
    for (const at of ['빼 둘 변경', '이 작업 변경을 working copy 에 반영']) {
      const token = { cancelled: false };
      const steps = [];
      s.onLog = (l) => { steps.push(l); if (l.includes(at)) token.cancelled = true; };
      let err = null;
      try { await s.stashCommit(SC.id, { token }); } catch (e) { err = e; }
      assert(err && err.cancelled, err ? err.message : 'not cancelled');
      assert.strictEqual(R(spPath), before);
      assert.deepStrictEqual(stSet(), stSet(svnBefore));
      assert.strictEqual(s.resolveTask(SC.id).task.status, 'active');
      assert(!fs.existsSync(path.join(scope.home, 'commit-in-progress.json')), 'marker left');
      assert(steps.some((l) => /\[커밋 준비 #\d+\] 시작/.test(l)), steps.join('\n'));
    }
    s.onLog = null;
    assert(logs.some((l) => /^\$ svn .*status/.test(l)) && logs.some((l) => /^ {2}→ exit 0 \(\d+ms\)/.test(l)), logs.slice(0, 5).join('\n'));
    proc.setLogger(null);
    const sum = logs.filter((l) => /⏱ \[커밋 준비\] 총 [\d.]+s, 명령 실행 [\d.]+s — .*svn status ×\d+/.test(l));
    assert(sum.length === 2, logs.filter((l) => /⏱/.test(l)).join('\n'));
    console.log(sum.map((l) => '    ' + l.trim()).join('\n'));
    ok(`커밋 준비 취소 (보관 전 / 작업 반영 후): working copy back exactly; ${logs.length} command log lines + time per command kind`);
  }

  { // lasting rules from feedback
    const r1 = s.addRule('  주석은 한국어로  쓴다 ', { why: '리뷰에서 지적', task: String(SC.no), by: 'copilot' });
    assert(r1.added && r1.rule.text === '주석은 한국어로 쓴다' && r1.rule.taskNo === SC.no, JSON.stringify(r1));
    assert(!s.addRule('주석은 한국어로 쓴다').added, 'duplicate');
    s.addRule('printf 디버그 코드는 남기지 않는다', { by: 'user' });
    assert.strictEqual(s.listRules().length, 2);
    s.updateRule(r1.rule.id, '주석은 한국어로, 짧게 쓴다');
    const md = require('../src/core/rules').instructionsMarkdown();
    assert(/applyTo: '\*\*'/.test(md) && md.includes('- 주석은 한국어로, 짧게 쓴다 (이유: 리뷰에서 지적)') && md.includes('- printf 디버그'), md);
    s.removeRule(r1.rule.id);
    assert.deepStrictEqual(s.listRules().map((r) => r.text), ['printf 디버그 코드는 남기지 않는다']);
    ok('rules: add (normalized, task linked, no duplicates), edit, remove, Copilot instructions markdown');
  }

  { // per-commit changes (review panel / tree "커밋 N개")
    edT(SC, 'sp.txt', 's4\r\n', 's4 SC2\r\n');
    fs.writeFileSync(path.join(SC.workPath, 'sc-new.txt'), 'new\r\n');
    await s.commitTask(SC.id, 'SC second');
    const info = await s.taskInfo(SC.id, { checkSvn: false });
    assert.strictEqual(info.commits.length, 2);
    const second = await s.commitFiles(SC.id, info.commits[0].sha.slice(0, 10));
    assert(second.subject === 'SC second' && second.files.map((f) => `${f.status} ${f.path}`).sort().join(',') === 'A sc-new.txt,M sp.txt', JSON.stringify(second));
    assert(second.files.find((f) => f.path === 'sp.txt').add === 1, 'stats per commit');
    const first = await s.commitFiles(SC.id, info.commits[1].sha);
    assert(first.files.length === 1 && first.parent === info.base, JSON.stringify(first));
    let threw = false;
    try { await s.commitFiles(SC.id, info.base); } catch (_) { threw = true; }
    assert(threw, 'a commit outside the task is refused');
    ok('per-commit changes: files and +/- of each task commit against its parent');
  }

  { // 커밋 준비 is on, the agent commits more: 커밋 준비 갱신 puts the new tip on the working copy, nothing else moves
    const p1 = await s.stashCommit(SC.id);
    assert(p1.ok, JSON.stringify(p1));
    assert(!(await s.prepareIsStale(SC.id)));
    edT(SC, 'sp.txt', 's8\r\n', 's8 SC3\r\n');
    await s.commitTask(SC.id, 'SC third (agent, while 커밋 준비)');
    assert(await s.prepareIsStale(SC.id), 'new commit seen');
    const rf = await s.refreshStashCommit(SC.id);
    assert(rf.ok, JSON.stringify(rf));
    assert.strictEqual(R(spPath), crlf('s1\ns2\ns3 SC\ns4 SC2\ns5\ns6\ns7\ns8 SC3\ns9\ns10\n'), 'newest task content, still only this task');
    assert(fs.existsSync(path.join(appDir, 'sc-new.txt')));
    const stq = svn('status', appDir);
    assert([...stq.matchAll(/--- Changelist '([^']+)'/g)].map((m) => m[1]).join() === s.resolveTask(SC.id).task.changelist, stq);
    assert(!(await s.prepareIsStale(SC.id)));
    const end = await s.endCommit(SC.id);
    assert(!end.committed && !end.kept.length && !end.errors.length, JSON.stringify(end));
    assert.strictEqual(R(spPath), before);
    assert.deepStrictEqual(stSet(), stSet(svnBefore));
    assert(!fs.existsSync(path.join(appDir, 'sc-new.txt')));
    ok('커밋 준비 갱신: agent commit while prepared → newest tip on the working copy; cancel still restores everything');
  }
  const pq = await s.stashCommit(Q1.id);
  assert(pq.ok, JSON.stringify(pq));
  {
    // while committing: only the task's own changelist, holding every changed file (a group in TortoiseSVN, checked)
    const stq = svn('status', appDir);
    const groups = [...stq.matchAll(/--- Changelist '([^']+)'/g)].map((m) => m[1]);
    assert(groups.length === 1 && groups[0] === s.resolveTask(Q1.id).task.changelist, stq);
    assert(!/^[MAD]/m.test(stq.split(/--- Changelist/)[0]), 'every task file is in the task changelist: ' + stq);
  }
  assert.strictEqual(R(spPath), crlf('s1\ns2\ns3\ns4\ns5\ns6\ns7 Q1\ns8\ns9\ns10\n'));
  await s.endCommit(Q1.id);
  assert.strictEqual(s.resolveTask(Q1.id).task.status, 'landed');
  assert.strictEqual(R(spPath), before);
  assert.deepStrictEqual(stSet(), stSet(svnBefore));
  ok('커밋 준비 of a task that has an old changelist → 취소: its changelist and status come back');

  // commit: same file as another changelist and the user's edit, no conflict anywhere
  const pr = await s.stashCommit(SP.id);
  assert(pr.ok, JSON.stringify(pr));
  { // sp.txt is also in Q1's (landed) changelist record: while committing it is still in SP's own changelist
    const stp = svn('status', appDir);
    assert([...stp.matchAll(/--- Changelist '([^']+)'/g)].map((m) => m[1]).join() === s.resolveTask(SP.id).task.changelist, stp);
    assert(!/^[MAD]/m.test(stp.split(/--- Changelist/)[0]), 'shared file in the task changelist: ' + stp);
  }
  assert.strictEqual(R(spPath), crlf('s1\ns2 SP\ns3\ns4\ns5 SP\ns6\ns7\ns8\ns9\ns10\n'));
  const pending = svn('status', appDir).split(/\r?\n/).filter((l) => /^[MAD?]/.test(l));
  assert(pending.length === 2 && pending.every((l) => /sp\.txt|stray\.txt/.test(l)), pending.join(' | '));
  assert(await s.stashCommit(Q1.id).then(() => false, () => true), 'one commit at a time');
  svn('commit', '-q', '-m', 'sp', wc); // like TortoiseSVN: everything modified is this task (all checked)
  assert(await s.commitDone(SP.id));
  const done = await s.endCommit(SP.id);
  assert(done.committed, JSON.stringify(done));
  assert.strictEqual(R(spPath), crlf('s1\ns2 SP\ns3\ns4\ns5 SP\ns6\ns7 Q1\ns8\ns9 USER\ns10\n'), 'set-aside changes merged back on the new BASE');
  assert.strictEqual(clOf('sp.txt'), s.resolveTask(Q1.id).task.changelist, 'changelist restored');
  assert(done.kept.length === 1 && done.kept.some((k) => /stray\.txt$/.test(k.path)) && fs.readFileSync(done.kept[0].copy, 'utf8') === 'user stray\r\n', JSON.stringify(done.kept));
  assert.strictEqual(s.resolveTask(SP.id).task.status, 'committed');
  ok('커밋 준비 → 커밋: only this task committed; other changelist and user edit come back; colliding file kept aside');

  // SVN moved on the same line: the only case that stops, and nothing changes
  const beforeR = R(spPath);
  const rr = await s.stashCommit(SR.id);
  assert(!rr.ok && rr.needsRebase, JSON.stringify(rr));
  assert.strictEqual(R(spPath), beforeR);
  assert(!s.pendingCommits().length);
  ok('same line as a newer SVN commit: needs rebase, working copy untouched');
  await s.unlandTask(Q1.id);
  svn('revert', '-q', spPath);

  // case-only rename of a versioned file via git mv (Windows: same file on disk)
  const CR = await s.createTask(scope.id, { title: 'case rename' });
  const g = new (require('../src/core/git').Git)(t.git.path, null);
  await g.exec(['mv', 'renamed.txt', 'Renamed.txt'], { cwd: CR.workPath });
  await s.commitTask(CR.id, 'rename case');
  const crInfo = await s.taskInfo(CR.id);
  assert(crInfo.files.some((f) => f.status === 'R' && f.from === 'renamed.txt' && f.path === 'Renamed.txt'), JSON.stringify(crInfo.files));
  const landCR = await s.landTask(CR.id);
  assert(landCR.ok, JSON.stringify(landCR));
  assert(fs.readdirSync(appDir).includes('Renamed.txt') && !fs.readdirSync(appDir).includes('renamed.txt'), fs.readdirSync(appDir).join(','));
  assert.strictEqual(R(path.join(appDir, 'Renamed.txt')), crlf('to be renamed\nline2\nline3\n'));
  assert(/Renamed\.txt/.test(svn('status', '--xml', appDir)));
  ok('case-only rename (git mv) -> svn move, file kept');

  // test screenshots (Playwright layout) attached to a task; outputs never committed
  const TR = path.join(CR.workPath, 'web', 'test-results', 'login-works-chromium');
  fs.mkdirSync(TR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'media', 'icon.png'), path.join(TR, 'test-finished-1.png'));
  fs.writeFileSync(path.join(CR.workPath, 'web', 'test-results', '.last-run.json'), JSON.stringify({ status: 'failed', failedTests: ['x'] }));
  W(path.join(CR.workPath, 'web', 'playwright-report', 'index.html'), '<html></html>');
  const att = await s.attachArtifacts(CR.id, { title: 'Playwright' });
  assert(att.count === 1 && att.status === 'failed', JSON.stringify(att));
  const runs = s.listArtifacts(CR.id);
  assert(runs.length === 1 && fs.existsSync(runs[0].items[0].file) && runs[0].items[0].caption.startsWith('login-works-chromium'));
  const cTr = await s.commitTask(CR.id, 'should not include test outputs');
  assert(!cTr.committed, 'test-results/playwright-report must be excluded from commits: ' + JSON.stringify(cTr));
  assert(s.listTasks().every((x) => x.id && x.branch), 'artifacts json must not be listed as a task');
  ok('test screenshots attached (copied), test outputs excluded from task commits');

  // ---------------------------------------------------------------- remove
  const rmA = await s.removeTask(A.id);
  assert(rmA.archived && !fs.existsSync(A.worktree));
  assert(fs.existsSync(path.join(wc, 'trunk', 'common', 'util.h')), 'junction removal did not touch the WC');
  let threw = false;
  try { await s.removeTask(B.id); } catch (_) { threw = true; }
  assert(threw, 'removing a landed (uncommitted) task requires force');
  ok('remove task (junction-safe), landed task protected');

  { // archive keeps the history: commits, files, per-commit view, diff; the branch is gone; listed under 보관된 작업
    const sg = await s.git(scope);
    assert(rmA.history, JSON.stringify(rmA));
    assert(!(await sg.revParse('refs/heads/' + A.branch)), 'branch deleted');
    assert(!s.listTasks().some((x) => x.id === A.id) && s.listArchived().some((x) => x.id === A.id));
    const ai = await s.taskInfo(A.id);
    assert(ai.archived && ai.history && ai.commits.length && ai.files.length, JSON.stringify(ai).slice(0, 400));
    assert.strictEqual(s.resolveTask(A.id).task.archive.statusBefore, 'committed');
    const c0 = await s.commitFiles(A.id, ai.commits[ai.commits.length - 1].sha);
    assert(c0.files.length, JSON.stringify(c0));
    assert((await s.diffTask(A.id)).diff.length > 0);
    // where the changes start (F7 in the diff): archived = base ↔ kept tip, live = base ↔ worktree file
    const clA = await s.changeLines(A.id, ai.files[0].path);
    assert(clA.length && clA.every((h) => h.old >= 1 && h.new >= 1), JSON.stringify(clA));
    const bi = await s.taskInfo(B.id, { checkSvn: false });
    const bf = bi.files.find((f) => f.status === 'M') || bi.files[0];
    const clB = await s.changeLines(B.id, bf.path, bf.from);
    assert(clB.length && clB.map((h) => h.new).join() === clB.map((h) => h.new).sort((x, y) => x - y).join(), JSON.stringify(clB));
    fs.appendFileSync(path.join(B.workPath, ...bf.path.split('/')), 'uncommitted tail\r\n');
    const clB2 = await s.changeLines(B.id, bf.path, bf.from);
    assert(clB2.length === clB.length + 1 || clB2[clB2.length - 1].new > clB[clB.length - 1].new, 'uncommitted worktree edit is a change too: ' + JSON.stringify(clB2));
    await new (require('../src/core/git').Git)(t.git.path, null).exec(['checkout', '--', bf.path], { cwd: B.workPath });
    // uncommitted worktree change is committed into the archive; purge deletes everything
    const AX = await s.createTask(scope.id, { title: 'abandon me' });
    fs.writeFileSync(path.join(AX.workPath, 'wip.txt'), 'wip\r\n');
    const rmX = await s.removeTask(AX.id, { force: true });
    assert(rmX.history && !fs.existsSync(AX.worktree), JSON.stringify(rmX));
    const xi = await s.taskInfo(AX.id);
    assert(xi.files.some((f) => f.path === 'wip.txt') && xi.commits.some((c) => /보관 전/.test(c.subject)), JSON.stringify(xi.files));
    assert.strictEqual(s.listArchived()[0].id, AX.id, 'most recent first');
    await s.purgeTask(AX.id);
    assert(!s.listArchived().some((x) => x.id === AX.id) && !(await sg.revParse(`refs/svnwt/archive/${AX.id}`)));
    assert(!fs.readdirSync(path.join(scope.home, 'tasks')).some((n) => n.startsWith(AX.id)));
    // archived by an older version (no history): still opens
    const AO = await s.createTask(scope.id, { title: 'old style' });
    await s.removeTask(AO.id, { force: true, keepHistory: false });
    const oi = await s.taskInfo(AO.id);
    assert(oi.archived && !oi.history && !oi.commits.length);
    ok('archive: worktree + branch removed, commits/files/per-commit diff kept; WIP kept; purge; pre-0.4.8 archived tasks open');
  }

  { // what is left in the scope folder after a commit: pick and throw away (copies kept); worktrees untouched
    const vf = path.join(appDir, 'sp.txt');
    const orig = R(vf);
    fs.writeFileSync(vf, orig + 'LEFT\r\n');
    W(path.join(appDir, 'left-added.txt'), 'added\r\n');
    svn('add', '-q', path.join(appDir, 'left-added.txt'));
    W(path.join(appDir, 'left-unver.txt'), 'unver\r\n');
    const sc = await s.scopeChanges(scope.id);
    const by = (p) => sc.changes.find((c) => c.path.endsWith(p));
    assert(by('sp.txt') && by('sp.txt').item === 'modified' && by('left-added.txt').item === 'added' && by('left-unver.txt').item === 'unversioned', JSON.stringify(sc.changes));
    const lockedOne = sc.changes.find((c) => c.locked && c.task.id === B.id);
    assert(lockedOne, 'landed task files are locked: ' + JSON.stringify(sc.changes));
    const newDir = sc.changes.find((c) => c.isDir && c.item === 'added' && sc.changes.some((x) => x.locked && x.path.startsWith(c.path + '/')));
    assert(!newDir || newDir.locked, 'a new folder of a landed task is locked too: ' + JSON.stringify(newDir));
    let refused = false;
    try { await s.discardScopeChanges(scope.id, [lockedOne.path]); } catch (_) { refused = true; }
    assert(refused, 'landed task file refused');
    const bWork = fs.readdirSync(B.workPath).length;
    const dr = await s.discardScopeChanges(scope.id, [by('sp.txt').path, by('left-added.txt').path]);
    assert.strictEqual(R(vf), orig);
    assert(!fs.existsSync(path.join(appDir, 'left-added.txt')) && fs.existsSync(path.join(appDir, 'left-unver.txt')));
    assert(!dr.failed.length && fs.existsSync(path.join(dr.backup, 'manifest.json')), JSON.stringify(dr));
    assert(R(path.join(dr.backup, 'files', ...by('sp.txt').path.split('/'))).endsWith('LEFT\r\n'), 'copy kept');
    assert(!(await s.scopeChanges(scope.id)).changes.some((c) => /sp\.txt|left-added/.test(c.path)));
    assert.strictEqual(fs.readdirSync(B.workPath).length, bWork, 'worktree untouched');
    fs.unlinkSync(path.join(appDir, 'left-unver.txt'));
    ok('SVN 남은 변경 정리: chosen changes reverted/deleted with copies, unversioned kept unless chosen, landed task protected');
  }

  // ---------------------------------------------------------------- MCP server over stdio
  const res = await mcpRoundTrip([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'svnwt_status', arguments: { path: path.join(appDir, 'main.cpp') } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'svnwt_task_info', arguments: { task: B.id } } },
    { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'review_task', arguments: { task: B.id } } },
  ]);
  assert(res[1].result.instructions.includes('svnwt'));
  assert(res[2].result.tools.length >= 14);
  const status = JSON.parse(res[3].result.content[0].text);
  assert(status.ok && status.locations[0].scope === scope.id, res[3].result.content[0].text);
  assert(status.rules.includes('printf 디버그 코드는 남기지 않는다') && res[2].result.tools.some((t) => t.name === 'svnwt_rule_add'), JSON.stringify(status.rules));
  const tinfo = JSON.parse(res[4].result.content[0].text);
  assert.strictEqual(tinfo.task.status, 'landed');
  assert(res[5].result.messages[0].content.text.includes('svnwt_task_review_get'));
  ok(`MCP stdio: ${res[2].result.tools.length} tools, status/info/prompt`);

  // ---------------------------------------------------------------- background SVN checks (svnWatch)
  {
    const C = await s.createTask(scope.id, { title: 'behind check' });
    const before = (await s.serverCommits(scope.id)).pending.map((p) => p.revision);
    // own commit from this working copy: already here, not "new on the server"
    W(path.join(appDir, 'own.txt'), 'mine\n');
    svn('add', path.join(appDir, 'own.txt'));
    svn('commit', '-m', 'own commit', path.join(appDir, 'own.txt'));
    // someone else's commit from another checkout
    const other = path.join(ROOT, 'other');
    svn('checkout', url + '/trunk/app', other);
    W(path.join(other, 'theirs.txt'), 'theirs\n');
    svn('add', path.join(other, 'theirs.txt'));
    svn('commit', '-m', 'their commit', other);
    const theirRev = Number(/<entry[^>]*revision="(\d+)"/.exec(svn('info', '--xml', path.join(other, 'theirs.txt')))[1]);
    const sc = await s.serverCommits(scope.id);
    const fresh = sc.pending.map((p) => p.revision).filter((r) => !before.includes(r));
    assert.deepStrictEqual(fresh, [theirRev], JSON.stringify({ before, pending: sc.pending }));
    assert(sc.pending.find((p) => p.revision === theirRev).msg === 'their commit');
    assert.strictEqual((await s.wcRevision(scope.id)).changed, false, 'working copy not updated yet');
    // the user updates (TortoiseSVN): working copy revision moves, svnwt notices without the server
    svn('update', appDir);
    assert.strictEqual((await s.wcRevision(scope.id)).changed, true);
    assert(!(await s.serverCommits(scope.id)).pending.some((p) => p.revision === theirRev), 'their commit is here now');
    await s.refreshScope(scope.id);
    assert.strictEqual((await s.wcRevision(scope.id)).changed, false);
    const behind = await s.tasksBehind(scope.id);
    const c = behind.find((x) => x.id === C.id);
    assert(c && c.behind > 0 && c.blocked === null, JSON.stringify(behind));
    W(path.join(C.workPath, 'wip.txt'), 'not committed\n');
    assert.strictEqual((await s.tasksBehind(scope.id)).find((x) => x.id === C.id).blocked, '커밋되지 않은 변경');
    fs.rmSync(path.join(C.workPath, 'wip.txt'));
    assert((await s.syncTask(C.id, { refresh: false })).ok);
    assert(fs.existsSync(path.join(C.workPath, 'theirs.txt')) && !(await s.tasksBehind(scope.id)).some((x) => x.id === C.id));
    ok(`svnWatch: server commits (own r excluded, theirs r${theirRev}), working copy revision, tasks behind / blocked, rebase`);

    // rename: title and (not in the working copy yet) changelist follow; id, branch, worktree stay
    const r1 = s.renameTask(C.id, '  뒤처짐   확인 작업 ');
    assert.strictEqual(r1.task.title, '뒤처짐 확인 작업');
    assert.strictEqual(r1.task.id, C.id);
    assert.strictEqual(r1.task.branch, C.branch);
    assert.strictEqual(r1.task.workPath, C.workPath);
    assert(r1.changelist !== C.changelist && r1.changelist.startsWith(`svnwt-${C.no}`), r1.changelist);
    assert.throws(() => s.renameTask(C.id, '   '), /비어/);
    const landed = s.listTasks({ scope: scope.id }).find((x) => x.status === 'landed' || x.status === 'committed');
    if (landed) assert.strictEqual(s.renameTask(landed.id, landed.title + ' (이름 변경)').changelist, landed.changelist, 'changelist in the working copy keeps its name');
    ok(`rename task: title, changelist ${r1.changelist}${landed ? `; ${landed.status} task keeps its changelist` : ''}`);
  }

  console.log(`\n# all ${step} checks passed`);
  if (process.env.SVNWT_KEEP) console.log(`KEEP_ROOT=${ROOT}\nKEEP_WC=${wc}`);
  else {
    // git objects / .svn pristine files are read-only => PowerShell Remove-Item -Force
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath $env:T -Recurse -Force'], { env: { ...process.env, T: ROOT }, stdio: 'ignore' });
    } catch (e) { console.log(`# cleanup failed: ${ROOT}`); }
  }
}

function mcpRoundTrip(msgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => {
      const byId = {};
      for (const l of out.split('\n').filter(Boolean)) { const m = JSON.parse(l); byId[m.id] = m; }
      resolve(byId);
    });
    p.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  });
}

main().catch((e) => { console.error('FAILED:', e && e.stack); console.error('# root', ROOT); process.exit(1); });
