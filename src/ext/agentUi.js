'use strict';
/**
 * Wires the svnwt agent into VS Code: background runs, command approval, commands, chat participant
 * (stage 2) and the optional chat session list (stage 3).
 */
const vscode = require('vscode');
const { AgentRunner, pickModel } = require('../agent/runner');
const { registerParticipant, titleFrom } = require('../agent/participant');
const { registerChatSessions } = require('../agent/chatSessions');
const env = require('../core/env');

/**
 * @param {vscode.ExtensionContext} ctx
 * @param {{service:object, log:(m:string)=>void, refreshAll:()=>void, addToWorkspace:(t:object)=>any,
 *          pickTask:(arg:any, filter?:Function)=>Promise<object>, pickScopeFor:()=>Promise<object|null>, openReview:(id:string)=>void}} d
 */
async function setupAgent(ctx, d) {
  const { service, log } = d;
  const cfg = () => vscode.workspace.getConfiguration('svnwt');
  const tools = await env.detect();
  const alwaysAllow = new Set(); // task ids whose commands are auto-approved for this VS Code session

  const approveCommand = async (task, cmd) => {
    if (cfg().get('agent.commandApproval') === 'auto' || alwaysAllow.has(task.id)) return true;
    const a = await vscode.window.showWarningMessage(`작업 #${task.no} 에이전트가 명령을 실행하려고 합니다.`,
      { modal: true, detail: `${cmd}\n\n실행 위치: ${task.workPath}` }, '실행', '이 작업에서 항상 허용');
    if (a === '이 작업에서 항상 허용') alwaysAllow.add(task.id);
    return !!a;
  };

  const runner = new AgentRunner(vscode, service, {
    gitExe: tools.git ? tools.git.path : 'git',
    approveCommand,
    newFileEol: cfg().get('agent.newFileEol') === 'lf' ? '\n' : '\r\n',
  });

  // a reload/crash leaves "running" states behind
  for (const t of service.listTasks()) {
    if (t.agent && (t.agent.state === 'running' || t.agent.state === 'waiting')) {
      service.setAgentState(t.id, 'idle', { waitingFor: null });
      service.appendSession(t.id, { role: 'info', text: 'VS Code 가 다시 시작되어 에이전트 실행이 중단됐습니다.' });
    }
  }

  const afterCreate = async (t) => {
    const mode = cfg().get('addWorktreeToWorkspace');
    if (mode !== 'never') d.addToWorkspace(t);
    d.refreshAll();
  };

  /** Run the agent in the background; progress is visible in the tree and the task's review panel. */
  async function runBackground(taskId, prompt) {
    const t = service.resolveTask(taskId).task;
    let model;
    try {
      model = await pickModel(vscode, cfg().get('agent.model'));
    } catch (e) {
      vscode.window.showErrorMessage(`SVN Worktree: ${e.message}`);
      return;
    }
    d.refreshAll();
    runner.run({ taskId, prompt, model, source: 'background' }).then(async (res) => {
      d.refreshAll();
      const first = (res.text || '').split('\n').map((l) => l.trim()).find(Boolean) || '완료';
      const a = await vscode.window.showInformationMessage(`작업 #${t.no} 에이전트 ${res.cancelled ? '중지됨' : '완료'}: ${first.slice(0, 120)}`, '리뷰 열기');
      if (a) d.openReview(taskId);
    }, (e) => {
      d.refreshAll();
      vscode.window.showErrorMessage(`작업 #${t.no} 에이전트 오류: ${e.message}`);
    });
  }

  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await fn(...args); } catch (e) {
      if (e && e.message === '취소됨') return undefined;
      log(`${id}: ${e && e.stack}`);
      vscode.window.showErrorMessage(`SVN Worktree: ${e.message}`);
      return undefined;
    }
  }));

  reg('svnwt.agent.newTask', async (arg) => {
    const scope = arg && arg.scope ? arg.scope : await d.pickScopeFor();
    if (!scope) { vscode.window.showWarningMessage('먼저 SVN 폴더를 scope 로 등록하세요.'); return; }
    const prompt = await vscode.window.showInputBox({
      title: `새 작업 (${scope.id}) — 에이전트에게 맡길 일`, prompt: '무엇을 할까요? 에이전트가 작업 worktree 에서 진행합니다.',
      placeHolder: '예: 로그인 실패 시 3번까지 재시도하도록 수정하고 테스트 추가', ignoreFocusOut: true,
    });
    if (!prompt) return;
    const t = await service.createTask(scope.id, { title: titleFrom(prompt), description: prompt });
    await afterCreate(t);
    d.openReview(t.id);
    await runBackground(t.id, prompt);
  });

  reg('svnwt.agent.instruct', async (arg, text) => {
    const t = await d.pickTask(arg, (x) => x.status === 'active' || x.status === 'landed');
    if (runner.isRunning(t.id)) { vscode.window.showInformationMessage(`작업 #${t.no} 에이전트가 이미 실행 중입니다.`); return; }
    const prompt = text || await vscode.window.showInputBox({ title: `작업 #${t.no} ${t.title} — 에이전트에게 지시`, prompt: '이어서 할 일', ignoreFocusOut: true });
    if (!prompt) return;
    await runBackground(t.id, prompt);
  });

  reg('svnwt.agent.stop', async (arg) => {
    const t = await d.pickTask(arg, (x) => runner.isRunning(x.id));
    if (!runner.stop(t.id)) vscode.window.showInformationMessage(`작업 #${t.no} 에이전트는 실행 중이 아닙니다.`);
  });

  reg('svnwt.agent.openChat', async (arg) => {
    const t = await d.pickTask(arg);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@svnwt /continue ${t.no} `, isPartialQuery: true });
    } catch (_) {
      await vscode.env.clipboard.writeText(`@svnwt /continue ${t.no} `);
      vscode.window.showInformationMessage('채팅 입력란에 붙여 넣으세요 (클립보드에 복사함).');
    }
  });

  // stage 2: chat participant
  try {
    registerParticipant(ctx, { service, runner, pickScopeFor: d.pickScopeFor, afterCreate });
  } catch (e) { log(`chat participant: ${e.message}`); }

  // stage 3 (opt-in, proposed API): tasks in the Chat sessions list
  try {
    if (cfg().get('agent.chatSessions')) registerChatSessions(ctx, { service, runner, log, handlerFor: ctx.svnwtHandlerFor });
  } catch (e) { log(`chat sessions: ${e.message}`); }

  return { runner, runBackground };
}

module.exports = { setupAgent };
