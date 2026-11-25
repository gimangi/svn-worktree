'use strict';
/**
 * Stage 2: @svnwt chat participant. One chat thread = one svnwt task (task id kept in the result
 * metadata), so follow-up messages in the same thread continue that task's session.
 *   @svnwt <request>            new task (or the thread's task)
 *   @svnwt /new <request>       always a new task
 *   @svnwt /continue 7 <text>   attach this thread to task #7
 *   @svnwt /tasks               list tasks
 */
const vscode = require('vscode');
const path = require('path');
const { pickModel } = require('./runner');

const STATE_LABEL = { running: '실행 중', waiting: '승인 대기', error: '오류', idle: '대기' };

function titleFrom(prompt) {
  const line = String(prompt).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '새 작업';
  return line.length > 48 ? line.slice(0, 46) + '…' : line;
}

function threadTask(service, context) {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const h = context.history[i];
    const id = h && h.result && h.result.metadata && h.result.metadata.svnwtTask;
    if (id) {
      try {
        const t = service.resolveTask(id).task;
        if (t.status !== 'archived') return t;
      } catch (_) { /* removed */ }
    }
  }
  return null;
}

/**
 * @param {vscode.ExtensionContext} ctx
 * @param {{service:object, runner:object, pickScopeFor:(p?:string)=>Promise<object|null>, afterCreate:(t:object)=>Promise<void>}} deps
 */
function createHandler(deps) {
  const { service, runner } = deps;
  /** forcedTaskId: requests coming from a chat session that belongs to one task (stage 3) */
  return async (request, context, stream, token, forcedTaskId) => {
    const cmd = request.command;
    if (cmd === 'tasks') {
      const tasks = service.listTasks();
      if (!tasks.length) { stream.markdown('작업이 없습니다. `@svnwt 할 일` 로 시작하세요.'); return {}; }
      stream.markdown(tasks.map((t) => `- **#${t.no} ${t.title}** — ${t.status}${t.agent && t.agent.state && t.agent.state !== 'idle' ? ` · 에이전트 ${STATE_LABEL[t.agent.state] || t.agent.state}` : ''}`).join('\n'));
      stream.markdown('\n\n이어서 하려면 `@svnwt /continue <번호> 지시`');
      return {};
    }

    let prompt = request.prompt || '';
    let task = null;
    if (cmd === 'continue') {
      const m = /^#?(\d+)\s*([\s\S]*)$/.exec(prompt.trim());
      if (!m) { stream.markdown('형식: `/continue <작업 번호> <지시>`'); return {}; }
      task = service.listTasks().find((t) => String(t.no) === m[1]);
      if (!task) { stream.markdown(`작업 #${m[1]} 을 찾을 수 없습니다.`); return {}; }
      prompt = m[2] || '이어서 진행해줘.';
    } else if (forcedTaskId) {
      task = service.resolveTask(forcedTaskId).task;
    } else if (cmd !== 'new') {
      task = threadTask(service, context);
    }

    if (!task) {
      const scope = await deps.pickScopeFor();
      if (!scope) {
        stream.markdown('먼저 SVN 폴더를 scope 로 등록해야 합니다.');
        stream.button({ command: 'svnwt.initScope', title: '폴더를 scope로 등록' });
        return {};
      }
      task = await service.createTask(scope.id, { title: titleFrom(prompt), description: prompt });
      await deps.afterCreate(task);
      stream.markdown(`**작업 #${task.no} ${task.title}** 을(를) 만들었습니다.\nworktree: \`${task.workPath}\`\n\n`);
    } else if (cmd === 'continue' || context.history.length === 0) {
      stream.markdown(`**작업 #${task.no} ${task.title}** 을(를) 이어서 진행합니다.\n\n`);
    }
    if (runner.isRunning(task.id)) {
      stream.markdown(`작업 #${task.no} 에이전트가 이미 실행 중입니다 (백그라운드). 끝난 뒤 다시 지시하거나 SVN Worktree 화면에서 중지하세요.`);
      return { metadata: { svnwtTask: task.id } };
    }

    const model = request.model || await pickModel(vscode, vscode.workspace.getConfiguration('svnwt').get('agent.model'));
    try {
      const res = await runner.run({
        taskId: task.id, prompt, model, token, source: 'chat',
        sink: {
          markdown: (t) => stream.markdown(t),
          progress: (t) => stream.progress(t),
          file: (rel) => { try { stream.reference(vscode.Uri.file(path.join(task.workPath, ...String(rel).split(/[\\/]/)))); } catch (_) { /* ignore */ } },
        },
      });
      stream.button({ command: 'svnwt.openReview', title: `작업 #${task.no} 리뷰 열기`, arguments: [task.id] });
      return { metadata: { svnwtTask: task.id, changed: res.changed } };
    } catch (e) {
      stream.markdown(`\n\n**오류:** ${e.message}`);
      return { metadata: { svnwtTask: task.id }, errorDetails: { message: e.message } };
    }
  };
}

function registerParticipant(ctx, deps) {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') return null;
  const handler = createHandler(deps);
  const p = vscode.chat.createChatParticipant('svnwt.agent', (req, c, s, t) => handler(req, c, s, t));
  ctx.svnwtParticipant = p;
  ctx.svnwtHandlerFor = (taskId) => (req, c, s, t) => handler(req, c, s, t, taskId);
  p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
  p.followupProvider = {
    provideFollowups(result) {
      if (!result || !result.metadata || !result.metadata.svnwtTask) return [];
      return [
        { prompt: '계속 진행해줘', label: '계속' },
        { prompt: '지금까지 변경을 스스로 리뷰하고, 문제 없으면 커밋 후 svn_changelist 로 SVN 에 반영해줘', label: '마무리 (리뷰 → changelist)' },
      ];
    },
  };
  ctx.subscriptions.push(p);
  return p;
}

module.exports = { registerParticipant, createHandler, titleFrom };
