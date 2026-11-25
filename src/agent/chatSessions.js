'use strict';
/**
 * Stage 3 (opt-in): show svnwt tasks in VS Code's chat sessions list (proposed API "chatSessionsProvider").
 * Needs: setting svnwt.agent.chatSessions = true and VS Code started with the proposal enabled
 * (argv.json "enable-proposed-api": ["svnwt.svn-worktree"]). Every call is feature-detected because the
 * proposed API changes between VS Code versions.
 */
const vscode = require('vscode');

const TYPE = 'svnwt-session';

function statusOf(t) {
  const S = vscode.ChatSessionStatus || {};
  const st = t.agent && t.agent.state;
  if (st === 'running' || st === 'waiting') return S.InProgress !== undefined ? S.InProgress : 2;
  if (st === 'error') return S.Failed !== undefined ? S.Failed : 0;
  return S.Completed !== undefined ? S.Completed : 1;
}

const LABEL = { active: '진행 중', landed: '커밋 대기', committed: '커밋 완료' };

function itemOf(t) {
  const resource = vscode.Uri.from({ scheme: TYPE, path: '/' + t.id });
  const last = t.agent && t.agent.since ? Date.parse(t.agent.since) : undefined;
  return {
    id: t.id, // older API versions
    resource,
    label: `#${t.no} ${t.title}`,
    description: `${LABEL[t.status] || t.status}${t.agent && t.agent.state === 'waiting' ? ' · 승인 대기' : ''}`,
    tooltip: `${t.title}\nworktree: ${t.workPath}`,
    status: statusOf(t),
    iconPath: new vscode.ThemeIcon('git-branch'),
    timing: { startTime: Date.parse(t.createdAt), created: Date.parse(t.createdAt), lastRequestEnded: last },
  };
}

/** Rebuild a task's conversation as chat history turns (when the constructors exist). */
function historyOf(service, taskId) {
  const Req = vscode.ChatRequestTurn;
  const Res = vscode.ChatResponseTurn2 || vscode.ChatResponseTurn;
  const MdPart = vscode.ChatResponseMarkdownPart;
  if (typeof Req !== 'function' || typeof Res !== 'function' || typeof MdPart !== 'function') return [];
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    try { out.push(new Res([new MdPart(new vscode.MarkdownString(buf.join('\n\n')))], {}, 'svnwt.agent')); } catch (_) { /* shape changed */ }
    buf = [];
  };
  for (const e of service.getSession(taskId).entries) {
    if (e.role === 'user') {
      flush();
      try { out.push(new Req(e.text, undefined, [], 'svnwt.agent', [])); } catch (_) { /* shape changed */ }
    } else if (e.role === 'assistant') buf.push(e.text);
    else if (e.role === 'tool') buf.push(`- ${e.ok === false ? '✗' : '✓'} ${e.label}`);
    else if (e.role === 'info') buf.push(`_${e.text}_`);
  }
  flush();
  return out;
}

function registerChatSessions(ctx, { service, log, handlerFor }) {
  const chat = vscode.chat;
  if (!chat || typeof chat.registerChatSessionItemProvider !== 'function') {
    log('chat sessions: 이 VS Code 에서는 chatSessionsProvider 제안 API 를 쓸 수 없습니다 (argv.json enable-proposed-api 필요).');
    return false;
  }
  const changed = new vscode.EventEmitter();
  ctx.subscriptions.push(changed);
  ctx.subscriptions.push(chat.registerChatSessionItemProvider(TYPE, {
    onDidChangeChatSessionItems: changed.event,
    provideChatSessionItems: async () => service.listTasks().map(itemOf),
  }));
  if (typeof chat.registerChatSessionContentProvider === 'function' && handlerFor) {
    const provider = {
      provideChatSessionContent: async (resource) => {
        const id = String(resource.path || '').replace(/^\//, '');
        return { history: historyOf(service, id), requestHandler: handlerFor(id) };
      },
    };
    try {
      ctx.subscriptions.push(chat.registerChatSessionContentProvider(TYPE, provider, ctx.svnwtParticipant));
    } catch (e) { log(`chat session content: ${e.message}`); }
  }
  log('chat sessions: 작업 목록을 Chat 세션 목록에 등록했습니다.');
  return { refresh: () => changed.fire() };
}

module.exports = { registerChatSessions, TYPE };
