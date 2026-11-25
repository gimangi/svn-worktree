'use strict';
/**
 * svnwt agent loop: a language model (Copilot via vscode.lm) + svnwt tools, one session per task.
 * Used by the @svnwt chat participant (output streamed into chat) and by background runs (output
 * stored in the task session and shown in the review panel).
 *
 * `vs` is the vscode module (injected so the loop can be tested with a fake model outside VS Code).
 */
const fs = require('fs');
const { TOOLS, runTool, describe } = require('./tools');

const MAX_STEPS = 40;

function systemPrompt(scope, task) {
  return [
    'You are "svnwt", a coding agent that works on exactly ONE task in an isolated git worktree that mirrors a folder of an SVN working copy.',
    `Task #${task.no}: ${task.title}`,
    task.description ? `Goal: ${task.description}` : '',
    `Worktree (your project root; every path is relative to it): ${task.workPath}`,
    `It mirrors the SVN folder (you cannot access it): ${scope.svnPath}`,
    '',
    'How to work:',
    '- Use the tools. You cannot read or write anything outside the worktree.',
    '- Explore first (find_files, search, read_file), then make focused changes with edit_file. Keep the existing style, encoding and line endings; do not reformat unrelated code.',
    '- Build / run tests with run_command when the project has them. For UI tests (e.g. Playwright) call attach_screenshots afterwards.',
    '- Commit with git_commit after each logical step (clear message).',
    '- When the task is complete: git_commit, then svn_changelist with dry_run=true, then svn_changelist (marks the task ready for review; the user presses "커밋 준비" to put it on SVN). Never commit to SVN — the user commits from the SVN Worktree panel.',
    '- If something is unclear or risky, stop and ask the user instead of guessing.',
    '- End with a short summary: what changed (files), how it was verified, what is left.',
    "- Reply in the user's language (Korean if the user writes Korean).",
  ].filter((l) => l !== null).join('\n');
}

/** Pick a Copilot chat model for background runs (setting svnwt.agent.model = id/family substring). */
async function pickModel(vs, preferred) {
  if (process.env.SVNWT_FAKE_LM) return scriptedModel(vs, JSON.parse(fs.readFileSync(process.env.SVNWT_FAKE_LM, 'utf8')));
  const all = await vs.lm.selectChatModels({ vendor: 'copilot' });
  if (!all.length) throw new Error('Copilot 언어 모델을 찾을 수 없습니다. GitHub Copilot Chat 이 설치·로그인돼 있는지 확인하세요.');
  const has = (m, k) => [m.id, m.family, m.name].some((x) => String(x || '').toLowerCase().includes(k.toLowerCase()));
  if (preferred) { const m = all.find((x) => has(x, preferred)); if (m) return m; }
  for (const k of ['claude-sonnet', 'claude', 'gpt-5', 'gpt-4.1', 'gpt-4o']) { const m = all.find((x) => has(x, k)); if (m) return m; }
  return all[0];
}

/**
 * Test model (env SVNWT_FAKE_LM = JSON file): plays [{ text?, calls?: [[tool, input]], delayMs? }, ...]
 * one step per request, continuing across runs.
 */
let fakeStep = 0;
function scriptedModel(vs, script) {
  return {
    id: 'svnwt-fake', name: 'svnwt test model', family: 'fake', vendor: 'svnwt', maxInputTokens: 100000,
    async sendRequest() {
      const step = script[fakeStep++] || { text: '완료했습니다.' };
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const parts = [];
      if (step.text) parts.push(new vs.LanguageModelTextPart(step.text));
      (step.calls || []).forEach(([name, input], k) => parts.push(new vs.LanguageModelToolCallPart(`f${fakeStep}-${k}`, name, input)));
      return { stream: (async function* g() { for (const p of parts) yield p; })() };
    },
  };
}

/** Tasks with a running loop: taskId -> { cts, startedAt } */
const running = new Map();

class AgentRunner {
  /**
   * @param {object} vs vscode module
   * @param {import('../core/service').Service} service
   * @param {{gitExe:string, approveCommand:(task:object, cmd:string)=>Promise<boolean>, newFileEol?:string, log?:(m:string)=>void}} opts
   */
  constructor(vs, service, opts) {
    this.vs = vs;
    this.service = service;
    this.opts = opts;
  }

  isRunning(taskId) { return running.has(taskId); }
  runningTasks() { return [...running.keys()]; }

  stop(taskId) {
    const r = running.get(taskId);
    if (r) r.cts.cancel();
    return !!r;
  }

  /** Conversation of previous runs (user requests + agent answers) to continue the session. */
  history(taskId, limit = 24) {
    const entries = this.service.getSession(taskId).entries.filter((e) => (e.role === 'user' || e.role === 'assistant') && e.text);
    return entries.slice(-limit);
  }

  /**
   * Run one user request on a task.
   * @param {{taskId:string, prompt:string, model:object, sink?:object, token?:object, source?:string}} p
   *   sink: { markdown(text), progress(text), file(relPath) } (all optional)
   */
  async run({ taskId, prompt, model, sink = {}, token, source = 'background' }) {
    const vs = this.vs;
    const { scope, task } = this.service.resolveTask(taskId);
    if (running.has(task.id)) throw new Error(`작업 #${task.no} 에이전트가 이미 실행 중입니다.`);
    const cts = new vs.CancellationTokenSource();
    if (token && token.onCancellationRequested) token.onCancellationRequested(() => cts.cancel());
    running.set(task.id, { cts, startedAt: Date.now() });

    const prior = this.history(task.id);
    this.service.appendSession(task.id, { role: 'user', text: prompt, source, model: model && (model.name || model.id) });
    this.service.setAgentState(task.id, 'running', { model: model && (model.name || model.id), source, lastError: null });

    const changed = new Set();
    const ctx = {
      service: this.service, scope, task, changed,
      realWork: fs.realpathSync.native(task.workPath),
      gitExe: this.opts.gitExe,
      newFileEol: this.opts.newFileEol || '\r\n',
      approveCommand: async (cmd) => {
        this.service.setAgentState(task.id, 'waiting', { waitingFor: cmd });
        try { return await this.opts.approveCommand(task, cmd); } finally { this.service.setAgentState(task.id, 'running', { waitingFor: null }); }
      },
    };

    // our own message records -> vscode messages on every request (lets us compact old tool output)
    const records = [
      { role: 'user', parts: [{ text: systemPrompt(scope, task) }] },
      { role: 'assistant', parts: [{ text: '알겠습니다. 이 작업의 worktree 안에서만 작업하겠습니다.' }] },
      ...prior.map((e) => ({ role: e.role, parts: [{ text: e.text }] })),
      { role: 'user', parts: [{ text: prompt }] },
    ];
    const toolDefs = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const budget = Math.max(60000, Math.floor(((model && model.maxInputTokens) || 64000) * 2.5));
    let finalText = '';
    let steps = 0;
    try {
      for (; steps < MAX_STEPS; steps++) {
        if (cts.token.isCancellationRequested) break;
        compact(records, budget);
        const messages = records.map((r) => toVs(vs, r));
        const options = { tools: toolDefs, justification: `svnwt 작업 #${task.no} 에이전트` };
        if (vs.LanguageModelChatToolMode) options.toolMode = vs.LanguageModelChatToolMode.Auto;
        const resp = await model.sendRequest(messages, options, cts.token);
        let text = '';
        const calls = [];
        for await (const part of resp.stream) {
          if (part instanceof vs.LanguageModelTextPart) {
            text += part.value;
            if (sink.markdown) sink.markdown(part.value);
          } else if (part instanceof vs.LanguageModelToolCallPart) {
            calls.push(part);
          }
        }
        records.push({ role: 'assistant', parts: [...(text ? [{ text }] : []), ...calls.map((c) => ({ call: { callId: c.callId, name: c.name, input: c.input } }))] });
        if (text.trim()) {
          finalText = text;
          this.service.appendSession(task.id, { role: 'assistant', text });
          if (sink.markdown && calls.length) sink.markdown('\n\n');
        }
        if (!calls.length) break;
        const results = [];
        for (const c of calls) {
          if (cts.token.isCancellationRequested) break;
          const label = describe(c.name, c.input || {});
          if (sink.progress) sink.progress(label);
          const idx = this.service.appendSession(task.id, { role: 'tool', name: c.name, label, input: summarizeInput(c.name, c.input) });
          let out;
          let ok = true;
          try {
            out = String(await runTool(ctx, c.name, c.input || {}));
          } catch (e) {
            ok = false;
            out = `ERROR: ${e.message}`;
          }
          this.service.updateSessionEntry(task.id, idx, { ok, result: out.slice(0, 600) });
          if (ok && (c.name === 'write_file' || c.name === 'edit_file') && sink.file) sink.file(c.input.path);
          results.push({ result: { callId: c.callId, text: out } });
        }
        records.push({ role: 'user', parts: results });
      }
      if (steps >= MAX_STEPS) {
        const msg = `\n\n(도구 호출이 ${MAX_STEPS}번을 넘어 멈췄습니다. 이어서 하려면 "계속" 이라고 지시하세요.)`;
        if (sink.markdown) sink.markdown(msg);
        this.service.appendSession(task.id, { role: 'info', text: msg.trim() });
      }
      const cancelled = cts.token.isCancellationRequested;
      if (cancelled) this.service.appendSession(task.id, { role: 'info', text: '사용자가 중지했습니다.' });
      this.service.setAgentState(task.id, 'idle', { lastRunAt: new Date().toISOString(), lastSteps: steps, lastChanged: [...changed] });
      return { taskId: task.id, text: finalText, changed: [...changed], steps, cancelled };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this.service.appendSession(task.id, { role: 'info', text: `오류: ${msg}` });
      this.service.setAgentState(task.id, 'error', { lastError: msg });
      throw e;
    } finally {
      running.delete(task.id);
      cts.dispose();
    }
  }
}

function summarizeInput(name, a = {}) {
  if (name === 'write_file') return { path: a.path, chars: String(a.content || '').length };
  if (name === 'edit_file') return { path: a.path, old: String(a.old_string || '').slice(0, 160), new: String(a.new_string || '').slice(0, 160) };
  return a;
}

function toVs(vs, r) {
  const parts = r.parts.map((p) => {
    if (p.text !== undefined) return new vs.LanguageModelTextPart(p.text);
    if (p.call) return new vs.LanguageModelToolCallPart(p.call.callId, p.call.name, p.call.input || {});
    return new vs.LanguageModelToolResultPart(p.result.callId, [new vs.LanguageModelTextPart(p.result.text)]);
  });
  return r.role === 'user' ? vs.LanguageModelChatMessage.User(parts) : vs.LanguageModelChatMessage.Assistant(parts);
}

/** Keep the conversation under the budget: shorten the oldest tool results first. */
function compact(records, budget) {
  const size = () => records.reduce((n, r) => n + r.parts.reduce((m, p) => m + (p.text ? p.text.length : p.result ? p.result.text.length : JSON.stringify(p.call.input || {}).length), 0), 0);
  if (size() <= budget) return;
  for (let i = 2; i < records.length - 2 && size() > budget; i++) {
    for (const p of records[i].parts) {
      if (p.result && p.result.text.length > 400) p.result.text = p.result.text.slice(0, 300) + '\n… (이전 결과 생략: 필요하면 다시 읽으세요)';
    }
  }
}

module.exports = { AgentRunner, pickModel, systemPrompt };
