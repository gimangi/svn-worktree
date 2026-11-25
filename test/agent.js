'use strict';
/**
 * Agent loop test with a scripted fake model and a minimal fake `vscode` (no VS Code needed).
 *   Code.exe(node) test/agent.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'svnwt-agent-'));
process.env.SVNWT_HOME = path.join(ROOT, 'home');
const { Service } = require('../src/core/service');
const env = require('../src/core/env');
const { AgentRunner } = require('../src/agent/runner');
const enc = require('../src/agent/encoding');

// ---------------------------------------------------------------- fake vscode
class TextPart { constructor(v) { this.value = v; } }
class ToolCallPart { constructor(id, name, input) { this.callId = id; this.name = name; this.input = input; } }
class ToolResultPart { constructor(id, content) { this.callId = id; this.content = content; } }
class CTS {
  constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => {} }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
const vs = {
  LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart,
  LanguageModelChatMessage: { User: (c) => ({ role: 'user', content: c }), Assistant: (c) => ({ role: 'assistant', content: c }) },
  LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: CTS,
};

/** Model that plays a script: each step = { text?, calls?: [[name, input]] }; records tool results. */
function scriptedModel(script) {
  let i = 0;
  const seen = [];
  return {
    name: 'fake', id: 'fake', maxInputTokens: 100000, seen,
    async sendRequest(messages) {
      const last = messages[messages.length - 1];
      for (const p of last.content) if (p instanceof ToolResultPart) seen.push(p.content[0].value);
      const step = script[i++] || { text: '끝' };
      const parts = [];
      if (step.text) parts.push(new TextPart(step.text));
      (step.calls || []).forEach(([name, input], k) => parts.push(new ToolCallPart(`c${i}-${k}`, name, input)));
      return { stream: (async function* gen() { for (const p of parts) yield p; })() };
    },
  };
}

let n = 0;
const ok = (m) => console.log(`  ok ${++n} - ${m}`);

async function main() {
  const t = await env.requireTools();
  const svnExe = t.svn.path;
  const svn = (...a) => execFileSync(svnExe, ['--non-interactive', ...a], { encoding: 'utf8' });
  execFileSync(path.join(path.dirname(svnExe), 'svnadmin.exe'), ['create', path.join(ROOT, 'repo')]);
  const wc = path.join(ROOT, 'wc');
  svn('checkout', '-q', 'file:///' + path.join(ROOT, 'repo').replace(/\\/g, '/'), wc);
  fs.mkdirSync(path.join(wc, 'app'));
  fs.writeFileSync(path.join(wc, 'app', 'main.cpp'), 'int main() {\r\n  return 0;\r\n}\r\n');
  fs.writeFileSync(path.join(wc, 'app', 'msg.txt'), enc.encodeCp949('안녕하세요\r\n'));
  fs.writeFileSync(path.join(wc, 'secret.txt'), 'outside scope\n');
  svn('add', '-q', path.join(wc, 'app'), path.join(wc, 'secret.txt'));
  svn('commit', '-q', '-m', 'init', wc);
  svn('update', '-q', wc);

  const s = new Service();
  const { scope } = await s.initScope(path.join(wc, 'app'), { name: 'app', linkOutside: true });
  const task = await s.createTask(scope.id, { title: 'agent test', description: 'main 이 1 을 반환' });
  // a junction to the WC root's sibling lives next to the worktree (linkOutside): must not be reachable
  const outsideViaJunction = path.relative(task.workPath, path.join(task.worktree, 'secret.txt'));

  const approvals = [];
  const runner = new AgentRunner(vs, s, { gitExe: t.git.path, approveCommand: async (_t, cmd) => { approvals.push(cmd); return !/deny-me/.test(cmd); } });
  const model = scriptedModel([
    { text: '파일을 살펴보겠습니다.', calls: [['list_dir', {}], ['read_file', { path: 'main.cpp' }]] },
    { calls: [['edit_file', { path: 'main.cpp', old_string: '  return 0;\n', new_string: '  return 1;\n' }], ['edit_file', { path: 'msg.txt', old_string: '안녕하세요', new_string: '안녕하세요, 반갑습니다' }]] },
    { calls: [['read_file', { path: '../../../../secret.txt' }], ['read_file', { path: outsideViaJunction }], ['write_file', { path: '.git/hooks/x', content: 'x' }]] },
    { calls: [['run_command', { command: 'svn commit -m x' }], ['run_command', { command: 'echo deny-me' }], ['run_command', { command: 'Write-Output "built ok"' }]] },
    { calls: [['search', { pattern: 'return 1' }], ['write_file', { path: 'docs/new.md', content: 'line1\nline2\n' }]] },
    { calls: [['git_commit', { message: 'main returns 1' }], ['svn_changelist', { dry_run: true }]] },
    { text: '완료: main.cpp 와 msg.txt 를 수정했습니다.' },
  ]);
  const progress = [];
  let streamed = '';
  const res = await runner.run({ taskId: task.id, prompt: 'main 이 1 을 반환하게 해줘', model, sink: { markdown: (x) => { streamed += x; }, progress: (x) => progress.push(x) } });

  const R = model.seen;
  assert(/main\.cpp/.test(R[0]) && /msg\.txt/.test(R[0]), 'list_dir: ' + R[0]);
  assert(/CRLF/.test(R[1]) && /return 0;/.test(R[1]), 'read_file shows encoding/eol: ' + R[1]);
  ok('list_dir / read_file (encoding and line ending reported)');

  const main = fs.readFileSync(path.join(task.workPath, 'main.cpp'), 'utf8');
  assert.strictEqual(main, 'int main() {\r\n  return 1;\r\n}\r\n');
  const msg = fs.readFileSync(path.join(task.workPath, 'msg.txt'));
  assert(msg.equals(enc.encodeCp949('안녕하세요, 반갑습니다\r\n')), 'CP949 kept: ' + msg.toString('hex'));
  ok('edit_file keeps CRLF and CP949 bytes');

  assert(/^ERROR: 작업 worktree 밖/.test(R[4]), R[4]);
  assert(/^ERROR: 작업 worktree 밖/.test(R[5]), 'junction escape: ' + R[5]);
  assert(/^ERROR: \.git/.test(R[6]), R[6]);
  ok('paths outside the worktree, through junctions and into .git are rejected');

  assert(/^ERROR: svn 의 쓰기 명령/.test(R[7]), R[7]);
  assert(/거부/.test(R[8]) && /built ok/.test(R[9]) && approvals.length === 2, JSON.stringify({ r8: R[8], r9: R[9], approvals }));
  ok('svn write commands blocked; other commands need approval (denied one not run)');

  assert(/main\.cpp:\d+:\s+return 1;/.test(R[10]), R[10]);
  assert.strictEqual(fs.readFileSync(path.join(task.workPath, 'docs', 'new.md'), 'utf8'), 'line1\r\nline2\r\n');
  ok('search, new file with CRLF default');

  assert(/커밋 [0-9a-f]{8}: main returns 1/.test(R[12]), R[12]);
  const dry = JSON.parse(R[13]);
  assert(dry.ok && dry.files.some((f) => /main\.cpp/.test(f)), R[13]);
  assert(!svn('status', path.join(wc, 'app')).trim(), 'dry run changed nothing in SVN');
  ok('git_commit and svn_changelist dry run');

  assert.strictEqual(res.text, '완료: main.cpp 와 msg.txt 를 수정했습니다.');
  assert(streamed.includes('파일을 살펴보겠습니다.') && progress.includes('수정 main.cpp'));
  const sess = s.getSession(task.id).entries;
  assert.strictEqual(sess[0].role, 'user');
  assert(sess.filter((e) => e.role === 'tool').length === 14 && sess.some((e) => e.role === 'tool' && e.ok === false));
  assert.strictEqual(s.resolveTask(task.id).task.agent.state, 'idle');
  ok(`session recorded (${sess.length} entries), streamed text/progress, state idle`);

  // second run continues the conversation (history includes the previous request/answer)
  const model2 = scriptedModel([{ text: '이어서 확인했습니다.' }]);
  let firstMessages = null;
  const orig = model2.sendRequest;
  model2.sendRequest = async (messages, o, tk) => { firstMessages = firstMessages || messages; return orig(messages, o, tk); };
  await runner.run({ taskId: task.id, prompt: '확인만 해줘', model: model2 });
  const texts = firstMessages.map((m) => m.content.map((p) => p.value || '').join(''));
  assert(texts.some((x) => x.includes('main 이 1 을 반환하게 해줘')) && texts.some((x) => x.includes('완료: main.cpp')));
  ok('next run continues the same task session');

  // concurrent run on the same task is refused; stop() cancels
  const slow = { name: 'slow', async sendRequest() { await new Promise((r) => setTimeout(r, 400)); return { stream: (async function* g() { yield new TextPart('늦은 답'); })() }; } };
  const p1 = runner.run({ taskId: task.id, prompt: '느린 작업', model: slow });
  await assert.rejects(runner.run({ taskId: task.id, prompt: '동시', model: slow }), /이미 실행 중/);
  assert(runner.isRunning(task.id));
  await p1;
  assert(!runner.isRunning(task.id));
  ok('one run per task at a time');

  console.log(`\n# all ${n} agent checks passed`);
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath $env:T -Recurse -Force'], { env: { ...process.env, T: ROOT }, stdio: 'ignore' }); } catch (_) { /* ignore */ }
}

main().catch((e) => { console.error('FAILED:', e && e.stack); console.error('# root', ROOT); process.exit(1); });
