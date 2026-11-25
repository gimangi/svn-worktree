'use strict';
/**
 * Live multi-task scenario on the demo environment (scripts\make-demo.cmd).
 * Three "agents" each talk to their OWN MCP server process (like separate Copilot sessions),
 * work concurrently, edit + commit several times, review, and produce changelists.
 * Human steps (other developer's SVN commit, svn update, svn commit of a changelist) are simulated.
 *
 *   scripts\run-scenario.cmd [demoDir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const env = require('../src/core/env');

const DEMO = path.resolve(process.argv[2] || path.join(os.homedir(), 'Desktop', 'svnwt-demo'));
const WC = path.join(DEMO, 'wc');
const TRUNK = path.join(WC, 'trunk');
const PACE = Number(process.env.SVNWT_PACE || 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
function log(who, msg) { console.log(`${ts()} [${who}] ${msg}`); }

let SVN;
const svn = (...a) => execFileSync(SVN, ['--non-interactive', ...a], { encoding: 'utf8', windowsHide: true });

// ------------------------------------------------------------------ MCP client (one server process per agent)
class Agent {
  constructor(name) {
    this.name = name;
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', SVNWT_WORKSPACE: WC }), windowsHide: true,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m); }
      }
    });
    this.proc.stderr.on('data', () => {});
  }

  rpc(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return r.result;
  }

  /** Call a tool like Copilot does. Returns parsed JSON; throws on isError unless allowError. */
  async tool(name, args, { allowError = false } = {}) {
    const m = await this.rpc('tools/call', { name, arguments: args });
    if (m.error) throw new Error(`${name}: ${m.error.message}`);
    const text = m.result.content[0].text;
    if (m.result.isError) {
      if (allowError) return { error: text };
      throw new Error(`${this.name} ${name}: ${text}`);
    }
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  close() { this.proc.stdin.end(); }
}

// ------------------------------------------------------------------ file edits (what Copilot's edit tool does)
function edit(file, from, to) {
  const s = fs.readFileSync(file, 'utf8');
  assert(s.includes(from), `edit anchor not found in ${file}: ${from}`);
  fs.writeFileSync(file, s.replace(from, to), 'utf8');
}
function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
}

// ------------------------------------------------------------------ agents
async function agentReport(a) {
  const st = await a.tool('svnwt_status', { path: path.join(TRUNK, 'app', 'src', 'report.cpp') });
  log(a.name, `svnwt_status → scope=${st.locations[0].scope}, 기존 작업 ${st.tasks.length}개`);
  const t = await a.tool('svnwt_task_create', { scope: 'demo', title: 'report mul output', description: 'report()에 곱셈 결과도 출력하고 출력 형식을 정리한다.' });
  log(a.name, `작업 #${t.no} 생성 → ${t.workPath}`);
  const f = path.join(t.workPath, 'app', 'src', 'report.cpp');
  await sleep(PACE);
  edit(f, '  std::printf("add=%d\\n", add(a, b));', '  std::printf("add=%d\\n", add(a, b));\r\n  std::printf("mul=%d\\n", mul(a, b));');
  await a.tool('svnwt_task_commit', { task: t.id, message: 'report: mul 결과 출력' });
  log(a.name, '수정 1/3 커밋: mul 출력 추가');
  await sleep(PACE * 1.5);
  edit(f, '// 계산 결과를 출력한다', '// 계산 결과를 출력한다 (add, mul)');
  await a.tool('svnwt_task_commit', { task: t.id, message: 'report: 주석 갱신' });
  log(a.name, '수정 2/3 커밋: 주석');
  await sleep(PACE);
  edit(f, 'void report(int a, int b) {', 'static void line(const char* k, int v) { std::printf("%s=%d\\n", k, v); }\r\n\r\nvoid report(int a, int b) {');
  edit(f, '  std::printf("add=%d\\n", add(a, b));\r\n  std::printf("mul=%d\\n", mul(a, b));', '  line("add", add(a, b));\r\n  line("mul", mul(a, b));');
  await a.tool('svnwt_task_commit', { task: t.id, message: 'report: 출력 함수로 정리' });
  log(a.name, '수정 3/3 커밋: line() 헬퍼로 리팩터링');
  return t;
}

async function agentSub(a) {
  await sleep(PACE * 0.5);
  await a.tool('svnwt_status', { path: path.join(TRUNK, 'common', 'mathutil.h') });
  const t = await a.tool('svnwt_task_create', { scope: 'demo', title: 'add sub function', description: 'mathutil에 sub()를 추가하고 main에서 사용한다.' });
  log(a.name, `작업 #${t.no} 생성 → ${t.workPath}`);
  const h = path.join(t.workPath, 'common', 'mathutil.h');
  const c = path.join(t.workPath, 'common', 'mathutil.cpp');
  const m = path.join(t.workPath, 'app', 'src', 'main.cpp');
  await sleep(PACE);
  edit(h, 'int mul(int a, int b);', 'int mul(int a, int b);\r\nint sub(int a, int b);');
  edit(c, 'int mul(int a, int b) { return a * b; }', 'int mul(int a, int b) { return a * b; }\r\nint sub(int a, int b) { return a + b; }');
  await a.tool('svnwt_task_commit', { task: t.id, message: 'mathutil: sub 추가' });
  log(a.name, '수정 1/3 커밋: sub() 추가 (일부러 버그: a + b)');
  await sleep(PACE * 1.5);
  edit(m, '  report(4, 5);', '  std::printf("sub=%d\\n", sub(9, 4));\r\n  report(4, 5);');
  await a.tool('svnwt_task_commit', { task: t.id, message: 'main: sub 사용' });
  log(a.name, '수정 2/3 커밋: main.cpp 에서 sub 사용 (예제 작업과 같은 파일)');
  await sleep(PACE);
  const d = await a.tool('svnwt_task_diff', { task: t.id, stat: true });
  log(a.name, `diff --stat 확인: ${d.diff.trim().split('\n').pop().trim()}`);
  return t;
}

async function agentDocs(a) {
  await sleep(PACE);
  await a.tool('svnwt_status', {});
  const t = await a.tool('svnwt_task_create', { scope: 'demo', title: 'docs usage', description: '사용법 문서를 추가한다.' });
  log(a.name, `작업 #${t.no} 생성 → ${t.workPath}`);
  await sleep(PACE);
  write(path.join(t.workPath, 'app', 'docs', 'usage.md'), ['# 사용법', '', '`app.exe` 를 실행하면 계산 결과를 출력합니다.']);
  await a.tool('svnwt_task_commit', { task: t.id, message: 'docs: usage.md 추가' });
  log(a.name, '수정 1/3 커밋: app/docs/usage.md (새 폴더)');
  await sleep(PACE * 1.5);
  fs.renameSync(path.join(t.workPath, 'app', 'docs', 'usage.md'), path.join(t.workPath, 'app', 'docs', 'guide.md'));
  edit(path.join(t.workPath, 'app', 'README.md'), 'SVN Worktree 데모용 프로젝트입니다.', 'SVN Worktree 데모용 프로젝트입니다.\r\n\r\n자세한 사용법: docs/guide.md');
  await a.tool('svnwt_task_commit', { task: t.id, message: 'docs: 파일명 변경, README 링크' });
  log(a.name, '수정 2/3 커밋: usage.md → guide.md 이름 변경 + README 링크');
  await sleep(PACE);
  fs.writeFileSync(path.join(t.workPath, 'app', 'notes.tmp'), 'scratch');
  edit(path.join(t.workPath, 'app', 'docs', 'guide.md'), '출력합니다.', '출력합니다.\r\n\r\n빌드: `tools\\build.cmd`');
  log(a.name, '수정 3/3: 커밋하지 않은 상태로 둠 (changelist 단계에서 autoCommit 확인용)');
  return t;
}

// The person makes changelists in VS Code. Agents cannot replace another task's changelist (one at a time:
// they only mark the task ready), so the demo builds its several changelists the way a 0.3.x working copy has them.
const { Service } = require('../src/core/service');
let HUMAN;
async function humanLand(args, { allowError = false } = {}) {
  HUMAN = HUMAN || new Service();
  try { return JSON.parse(JSON.stringify(await HUMAN.landTask(args.task, { autoCommit: !!args.autoCommit }))); } catch (e) {
    if (allowError) return { error: e.message };
    throw e;
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const tools = await env.requireTools();
  SVN = tools.svn.path;
  assert(fs.existsSync(path.join(WC, '.svn')), `데모가 없습니다. scripts\\make-demo.cmd 먼저 실행: ${WC}`);

  const A = new Agent('agent-A');
  const B = new Agent('agent-B');
  const C = new Agent('agent-C');
  const H = new Agent('사람(대행)');
  await Promise.all([A.init(), B.init(), C.init(), H.init()]);
  const sample = (await H.tool('svnwt_task_list', { scope: 'demo' })).find((t) => t.title === 'main에서 mul 사용' && t.status !== 'committed');
  assert(sample, '예제 작업이 없습니다. scripts\\make-demo.cmd 로 데모를 다시 만드세요.');
  const S = sample.id;
  const SN = '#' + S.split('-')[0];
  log('시나리오', '에이전트 3개(각자 MCP 서버 프로세스)가 동시에 작업을 시작합니다');

  // phase 1: three agents in parallel
  const [tA, tB, tC] = await Promise.all([agentReport(A), agentSub(B), agentDocs(C)]);
  const nums = [tA.no, tB.no, tC.no];
  assert.strictEqual(new Set(nums).size, 3, '동시 생성된 작업 번호가 겹치면 안 됨');
  log('시나리오', `동시 작업 완료: #${tA.no}, #${tB.no}, #${tC.no}`);

  // phase 2: meanwhile another developer commits report.cpp upstream; the human runs svn update
  await sleep(PACE);
  const other = path.join(DEMO, 'other-dev');
  if (!fs.existsSync(other)) svn('checkout', '-q', svn('info', '--show-item', 'url', WC).trim(), other);
  else svn('update', '-q', other);
  edit(path.join(other, 'trunk', 'app', 'src', 'report.cpp'), '#include <cstdio>', '#include <cstdio>  // stdio');
  svn('commit', '-q', '-m', '다른 개발자: report.cpp include 주석', other);
  log('다른 개발자', 'report.cpp 상단을 수정해서 SVN에 커밋 (r' + svn('info', '--show-item', 'last-changed-revision', path.join(other, 'trunk', 'app', 'src', 'report.cpp')).trim() + ')');
  // the user edits an unrelated file directly in the working copy
  fs.appendFileSync(path.join(TRUNK, 'tools', 'build.cmd'), 'echo local tweak\r\n');
  log('사용자', 'tools/build.cmd 를 working copy 에서 직접 수정 (어느 작업에도 속하지 않음)');
  const up = await H.tool('svnwt_scope_refresh', { scope: 'demo', svnUpdate: true });
  log('사용자', `svn update + 기준 갱신 → r${up.revision}`);

  // phase 3: reviews (parallel)
  await sleep(PACE);
  const reviews = await Promise.all([
    (async () => {
      const r = await A.tool('svnwt_task_review_get', { task: tA.id });
      assert(r.diff.includes('line("mul", mul(a, b));'));
      await A.tool('svnwt_task_review_submit', { task: tA.id, verdict: 'approve', summary: 'mul 출력 추가와 line() 정리 확인. 동작 변화 없음.', comments: [{ file: 'app/src/report.cpp', line: 4, severity: 'info', body: 'line()은 static 이라 다른 파일과 충돌 없음' }] });
      return `#${tA.no} approve`;
    })(),
    (async () => {
      const r = await B.tool('svnwt_task_review_get', { task: tB.id });
      assert(r.diff.includes('return a + b;'));
      await B.tool('svnwt_task_review_submit', { task: tB.id, verdict: 'request_changes', summary: 'sub()가 a + b 를 반환합니다.', comments: [{ file: 'common/mathutil.cpp', line: 5, severity: 'blocker', body: 'a - b 여야 합니다.' }] });
      return `#${tB.no} request_changes`;
    })(),
    (async () => {
      const r = await C.tool('svnwt_task_review_get', { task: tC.id });
      assert(r.uncommitted.length >= 1, 'uncommitted files reported');
      await C.tool('svnwt_task_review_submit', { task: tC.id, verdict: 'comment', summary: '커밋 안 된 변경이 있습니다. notes.tmp 는 넣지 마세요.', comments: [{ file: 'app/notes.tmp', severity: 'major', body: '임시 파일' }] });
      return `#${tC.no} comment`;
    })(),
  ]);
  log('리뷰', reviews.join(', '));

  // phase 4: fixes after review
  await sleep(PACE);
  edit(path.join(tB.workPath, 'common', 'mathutil.cpp'), 'int sub(int a, int b) { return a + b; }', 'int sub(int a, int b) { return a - b; }');
  await B.tool('svnwt_task_commit', { task: tB.id, message: 'mathutil: sub 버그 수정 (리뷰 반영)' });
  log('agent-B', '리뷰 반영 커밋: sub() a - b');
  fs.unlinkSync(path.join(tC.workPath, 'app', 'notes.tmp'));
  log('agent-C', 'notes.tmp 삭제 (리뷰 반영), guide.md 수정은 커밋 안 한 상태 유지');

  // phase 5: changelists
  await sleep(PACE);
  const l1 = await humanLand({ task: S });
  assert(l1.ok, JSON.stringify(l1));
  log('사람(대행)', `작업 ${SN} changelist ${l1.changelist} (${l1.commit.files.join(', ')})`);
  await sleep(PACE);
  const rqA = await A.tool('svnwt_task_changelist', { task: tA.id });
  assert(rqA.ready, 'agent only marks the task ready: ' + JSON.stringify(rqA));
  const lA = await humanLand({ task: tA.id });
  assert(lA.ok, JSON.stringify(lA));
  const rep = lA.files.find((f) => f.path === 'app/src/report.cpp');
  assert(rep.merged, 'report.cpp 는 다른 개발자 커밋과 3-way 병합되어야 함');
  log('agent-A', `changelist ${lA.changelist}: report.cpp 3-way 병합 (다른 개발자 변경 유지)`);
  await sleep(PACE);
  const lCfail = await humanLand({ task: tC.id }, { allowError: true });
  assert(lCfail.error && /커밋되지 않은/.test(lCfail.error));
  log('agent-C', 'changelist 거부됨: 커밋 안 된 변경 → autoCommit=true 로 재시도');
  const lC = await humanLand({ task: tC.id, autoCommit: true });
  assert(lC.ok, JSON.stringify(lC));
  assert(lC.commit.addedDirs.includes('app/docs'));
  log('agent-C', `changelist ${lC.changelist}: 새 폴더 app/docs 포함 → 커밋 명령은 --targets 방식`);
  await sleep(PACE);
  const lB = await humanLand({ task: tB.id });
  assert(lB.ok && lB.files.find((f) => f.path === 'app/src/main.cpp').sharedWith === sample.changelist, JSON.stringify(lB));
  log('agent-B', `changelist ${lB.changelist}: main.cpp 는 ${SN} 과 같이 고친 공유 파일 (두 변경 모두 working copy 에 반영)`);

  // phase 6: human commits sample task with a split commit: only its own change goes into the revision
  await sleep(PACE * 1.5);
  const { Service } = require('../src/core/service');
  const human = new Service();
  const plan1 = await human.commitPlan(S);
  await human.beginCommit(S);
  const run1 = await human.runSvnCommit(S);
  assert(run1.ok, run1.output);
  const end1 = await human.endCommit(S);
  assert(end1.committed);
  const rev1 = svn('info', '--show-item', 'last-changed-revision', path.join(TRUNK, 'app', 'src', 'main.cpp')).trim();
  const diff1 = svn('diff', '-c', rev1, svn('info', '--show-item', 'url', TRUNK).trim());
  assert(/\+\s+int x = mul\(2, 3\);/.test(diff1) && !/sub\(9, 4\)/.test(diff1), diff1);
  log('사람(대행)', `작업 ${SN} 분리 커밋 r${rev1}: main.cpp 에서 ${SN} 변경만 커밋 (잠시 빼 둔 파일: ${plan1.setAside.map((x) => x.path).join(', ') || '없음'})`);
  const i1 = await H.tool('svnwt_task_info', { task: S });
  assert.strictEqual(i1.task.status, 'committed');
  await sleep(PACE);
  const sB = await B.tool('svnwt_task_sync', { task: tB.id });
  assert(sB.ok, JSON.stringify(sB));
  log('agent-B', `최신 SVN 기준으로 rebase 성공 (작업 ${SN} 변경 위로)`);
  const lB2 = await humanLand({ task: tB.id });
  assert(lB2.ok, JSON.stringify(lB2));
  log('agent-B', `changelist ${lB2.changelist}: ${lB2.commit.files.join(', ')}`);

  // phase 7: A keeps working after its changelist exists -> re-land updates it
  await sleep(PACE);
  edit(path.join(tA.workPath, 'app', 'src', 'report.cpp'), '  line("mul", mul(a, b));', '  line("mul", mul(a, b));\r\n  line("ab", a * 10 + b);');
  await A.tool('svnwt_task_commit', { task: tA.id, message: 'report: ab 출력' });
  const iA = await A.tool('svnwt_task_info', { task: tA.id });
  log('agent-A', `changelist 이후 추가 커밋 (상태 ${iA.task.status}) → changelist 갱신`);
  const lA2 = await humanLand({ task: tA.id });
  assert(lA2.ok, JSON.stringify(lA2));

  // ------------------------------------------------------------------ verification
  const xml = svn('status', '--xml', TRUNK);
  const cl = {};
  for (const m of xml.matchAll(/<changelist\s+name="([^"]+)">([\s\S]*?)<\/changelist>/g)) {
    cl[m[1]] = [...m[2].matchAll(/<entry\s+path="([^"]+)"/g)].map((e) => path.relative(TRUNK, e[1]).split(path.sep).join('/')).sort();
  }
  console.log('\n--- svn changelists ---');
  for (const [k, v] of Object.entries(cl)) console.log(`${k}: ${v.join(', ')}`);
  assert.deepStrictEqual(cl[tA.changelist], ['app/src/report.cpp']);
  assert.deepStrictEqual(cl[tB.changelist], ['app/src/main.cpp', 'common/mathutil.cpp', 'common/mathutil.h']);
  assert.deepStrictEqual(cl[tC.changelist], ['app/README.md', 'app/docs/guide.md']);
  assert(!cl[sample.changelist], 'sample committed');
  const report = fs.readFileSync(path.join(TRUNK, 'app', 'src', 'report.cpp'), 'utf8');
  assert(report.includes('// stdio') && report.includes('line("ab", a * 10 + b);') && report.includes('\r\n'));
  const main = fs.readFileSync(path.join(TRUNK, 'app', 'src', 'main.cpp'), 'utf8');
  assert(main.includes('mul(2, 3)') && main.includes('sub(9, 4)'));
  assert(fs.readFileSync(path.join(TRUNK, 'common', 'mathutil.cpp'), 'utf8').includes('return a - b;'));
  assert(!fs.existsSync(path.join(TRUNK, 'app', 'notes.tmp')));
  assert(!fs.readdirSync(path.join(TRUNK, 'app', 'docs')).includes('usage.md'));
  assert(fs.readFileSync(path.join(TRUNK, 'app', 'docs', 'guide.md'), 'utf8').includes('tools\\build.cmd'));
  assert(/<entry\s+path="[^"]*build\.cmd">/.test(xml.split('<changelist')[0]), 'build.cmd 는 changelist 밖');
  console.log('\n' + svn('status', TRUNK).replace(/\r/g, ''));
  log('시나리오', '검증 통과. 작업 3개가 각각의 changelist 로 커밋 대기 중입니다.');
  for (const a of [A, B, C, H]) a.close();
}

main().catch((e) => { console.error('\nFAILED:', e && e.stack); process.exit(1); });
