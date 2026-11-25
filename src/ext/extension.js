'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Service, isInside } = require('../core/service');
const env = require('../core/env');
const store = require('../core/store');
const { TaskTree } = require('./tree');
const { GitFs, SCHEME } = require('./gitfs');
const { ReviewPanel } = require('./review');
const setup = require('./setup');

let service;
let tree;
let output;
let mcpRegistered = false;

function log(msg) { if (output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`); }

/** Accept tree elements, task objects, ids or worktree paths. */
function taskIdOf(arg) {
  if (!arg) return null;
  if (typeof arg === 'string') return arg;
  if (arg.task && arg.task.id) return arg.task.id;
  if (arg.id && arg.branch) return arg.id;
  if (arg instanceof vscode.Uri) return arg.fsPath;
  return null;
}

async function pickTask(arg, filter) {
  const id = taskIdOf(arg);
  if (id) return service.resolveTask(id).task;
  const tasks = service.listTasks().filter((t) => !filter || filter(t));
  // Active editor inside a worktree => that task.
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') {
    const hit = service.findByPath(ed.document.uri.fsPath);
    if (hit.task && tasks.some((t) => t.id === hit.task.id)) return hit.task;
  }
  if (!tasks.length) throw new Error('해당하는 작업이 없습니다.');
  if (tasks.length === 1) return tasks[0];
  const pick = await vscode.window.showQuickPick(tasks.map((t) => ({ label: `#${t.no} ${t.title}`, description: t.status, detail: t.workPath, t })), { placeHolder: '작업 선택' });
  if (!pick) throw new Error('취소됨');
  return pick.t;
}

async function pickScope(arg) {
  if (arg && arg.scope && arg.scope.id) return arg.scope;
  if (arg && arg.kind === 'task') return service.resolveScope(arg.task.scopeId);
  const scopes = service.listScopes();
  if (!scopes.length) throw new Error('등록된 scope가 없습니다. 먼저 "폴더를 scope로 등록"을 실행하세요.');
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') {
    const hit = service.findByPath(ed.document.uri.fsPath);
    if (hit.scope) return hit.scope;
  }
  if (scopes.length === 1) return scopes[0];
  const pick = await vscode.window.showQuickPick(scopes.map((s) => ({ label: s.id, description: `r${s.revision}`, detail: s.svnPath, s })), { placeHolder: 'scope 선택' });
  if (!pick) throw new Error('취소됨');
  return pick.s;
}

function refreshAll() {
  if (tree) tree.refresh();
  ReviewPanel.refreshAll();
}

async function withProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, fn);
}

// ------------------------------------------------------------------ workspace folders
function workspaceHas(p) {
  return (vscode.workspace.workspaceFolders || []).findIndex((f) => f.uri.fsPath.toLowerCase() === path.resolve(p).toLowerCase());
}

function addToWorkspace(task) {
  if (workspaceHas(task.workPath) >= 0) return false;
  const n = (vscode.workspace.workspaceFolders || []).length;
  return vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(task.workPath), name: `[svnwt] #${task.no} ${task.title}` });
}

async function removeFromWorkspace(task) {
  const i = workspaceHas(task.workPath);
  if (i < 0) return;
  const done = new Promise((r) => {
    const d = vscode.workspace.onDidChangeWorkspaceFolders(() => { d.dispose(); r(); });
    setTimeout(r, 3000);
  });
  vscode.workspace.updateWorkspaceFolders(i, 1);
  await done;
}

/** Drop "[svnwt] ..." workspace folders whose worktree was removed (by the agent, another window or a demo reset). */
function pruneWorkspaceFolders() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (let i = folders.length - 1; i >= 1; i--) {
    const f = folders[i];
    if (!f.name.startsWith('[svnwt]') || f.uri.scheme !== 'file') continue;
    let live = fs.existsSync(f.uri.fsPath);
    if (live) {
      const hit = service.findByPath(f.uri.fsPath);
      live = !!(hit.task && hit.task.status !== 'archived');
    }
    if (!live) {
      log(`작업 영역에서 제거 (worktree 없음): ${f.uri.fsPath}`);
      return vscode.workspace.updateWorkspaceFolders(i, 1);
    }
  }
  return false;
}

function nextFolderChange() {
  return new Promise((r) => {
    const d = vscode.workspace.onDidChangeWorkspaceFolders(() => { d.dispose(); r(); });
    setTimeout(() => { d.dispose(); r(); }, 3000);
  });
}

/** New task created by the agent (MCP) for a working copy open in this window => add its worktree folder. */
async function autoAddWorktrees(ctx) {
  // updateWorkspaceFolders must not be called again before the previous change is applied
  for (let i = 0; i < 20; i++) {
    let changed = false;
    try { changed = pruneWorkspaceFolders(); } catch (e) { log(`prune: ${e.message}`); }
    if (!changed) break;
    await nextFolderChange();
  }
  const mode = vscode.workspace.getConfiguration('svnwt').get('addWorktreeToWorkspace');
  if (mode === 'never') return;
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  if (!folders.length) return;
  const seen = new Set(ctx.workspaceState.get('svnwt.seenTasks', []));
  const fresh = service.listTasks().filter((t) => !seen.has(t.id) && t.status === 'active' && Date.now() - Date.parse(t.createdAt) < 5 * 60 * 1000);
  for (const t of fresh) {
    seen.add(t.id);
    let scope;
    try { scope = service.resolveScope(t.scopeId); } catch (_) { continue; }
    const related = folders.some((f) => isInside(f, scope.svnPath) || isInside(scope.svnPath, f) || isInside(f, scope.worktreeRoot));
    if (!related || workspaceHas(t.workPath) >= 0) continue;
    if (mode === 'ask') {
      const a = await vscode.window.showInformationMessage(`새 작업 #${t.no} "${t.title}" 의 worktree를 작업 영역에 추가할까요?`, '추가', '건너뛰기');
      if (a !== '추가') continue;
    }
    if (addToWorkspace(t)) await nextFolderChange();
    log(`worktree 추가: ${t.workPath}`);
  }
  await ctx.workspaceState.update('svnwt.seenTasks', [...seen].slice(-500));
}

// ------------------------------------------------------------------ diff helpers
function diffUris(scope, task, base, f) {
  const left = f.status === 'A' ? GitFs.uri(scope.id, 'empty', f.path) : GitFs.uri(scope.id, base, f.from || f.path);
  const right = f.status === 'D' ? GitFs.uri(scope.id, 'empty', f.path) : vscode.Uri.file(path.join(task.workPath, ...f.path.split('/')));
  return { left, right };
}

async function openFileDiff(taskId, f) {
  const { scope, task } = service.resolveTask(taskId);
  const info = await service.taskInfo(task.id, { checkSvn: false });
  const { left, right } = diffUris(scope, task, info.base, f);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(f.path)} (r${scope.revision} ↔ #${task.no})`, { preview: true });
}

async function openChanges(taskId) {
  const { scope, task } = service.resolveTask(taskId);
  const info = await service.taskInfo(task.id, { checkSvn: false });
  if (!info.files.length) { vscode.window.showInformationMessage('커밋된 변경 사항이 없습니다.'); return; }
  const resources = info.files.map((f) => {
    const { left, right } = diffUris(scope, task, info.base, f);
    return [vscode.Uri.file(path.join(task.workPath, ...f.path.split('/'))), left, right];
  });
  await vscode.commands.executeCommand('vscode.changes', `#${task.no} ${task.title} — 변경 사항 (${info.files.length})`, resources);
}

async function openTaskFile(taskId, rel, line) {
  const { task } = service.resolveTask(taskId);
  const uri = vscode.Uri.file(path.join(task.workPath, ...String(rel).split('/')));
  const doc = await vscode.workspace.openTextDocument(uri);
  const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

// ------------------------------------------------------------------ environment
async function checkEnvironment(showOk) {
  const e = await env.detect(true);
  if (!e.git) {
    const a = await vscode.window.showErrorMessage('SVN Worktree: Git for Windows가 설치되어 있지 않습니다. 설치 후 VS Code를 다시 시작하세요.', 'Git for Windows 다운로드', 'winget 명령 복사', '경로 설정');
    if (a === 'Git for Windows 다운로드') vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/download/win'));
    if (a === 'winget 명령 복사') { await vscode.env.clipboard.writeText('winget install --id Git.Git -e'); vscode.window.showInformationMessage('복사했습니다. PowerShell에 붙여 넣어 실행하세요.'); }
    if (a === '경로 설정') vscode.commands.executeCommand('workbench.action.openSettings', 'svnwt.gitPath');
  }
  if (!e.svn) {
    const a = await vscode.window.showErrorMessage('SVN Worktree: svn.exe(명령줄 클라이언트)를 찾을 수 없습니다. TortoiseSVN 설치 시 "command line client tools"를 선택하세요.', 'TortoiseSVN 다운로드', 'winget 명령 복사', '경로 설정');
    if (a === 'TortoiseSVN 다운로드') vscode.env.openExternal(vscode.Uri.parse('https://tortoisesvn.net/downloads.html'));
    if (a === 'winget 명령 복사') { await vscode.env.clipboard.writeText('winget install --id TortoiseSVN.TortoiseSVN -e --override "/passive ADDLOCAL=ALL"'); vscode.window.showInformationMessage('복사했습니다. PowerShell에 붙여 넣어 실행하세요.'); }
    if (a === '경로 설정') vscode.commands.executeCommand('workbench.action.openSettings', 'svnwt.svnPath');
  }
  if (e.git && e.svn && showOk) {
    vscode.window.showInformationMessage(`SVN Worktree 환경 정상 — ${e.git.version} / svn ${e.svn.version}${e.tortoiseProc ? ' / TortoiseSVN' : ''}`);
  }
  service._tools = null;
  return e;
}

// ------------------------------------------------------------------ commands
function registerCommands(ctx) {
  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e && e.message === '취소됨') return undefined;
      log(`${id} 실패: ${e && e.stack}`);
      vscode.window.showErrorMessage(`SVN Worktree: ${e.message}`);
      return undefined;
    }
  }));

  reg('svnwt.refresh', () => refreshAll());
  reg('svnwt.checkEnvironment', () => checkEnvironment(true));

  reg('svnwt.initScope', async (uri) => {
    let folder = uri instanceof vscode.Uri ? uri.fsPath : null;
    if (!folder) {
      const def = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: def && def.uri, openLabel: 'scope로 등록', title: 'git으로 관리할 SVN 폴더 선택 (작업에 필요한 범위만)' });
      if (!pick || !pick.length) return;
      folder = pick[0].fsPath;
    }
    const link = await vscode.window.showQuickPick([
      { label: '기본', description: 'scope 폴더만 worktree로 복제', v: false },
      { label: '바깥 폴더 연결', description: '../common 같은 상대 경로 참조가 필요할 때: scope 밖 형제 폴더를 junction으로 연결', v: true },
    ], { placeHolder: 'worktree 구성 방식' });
    if (!link) return;
    const res = await withProgress(`scope 등록 중: ${folder}`, () => service.initScope(folder, { linkOutside: link.v }));
    refreshAll();
    vscode.window.showInformationMessage(`scope "${res.scope.id}" 등록 완료 (r${res.scope.revision}, 파일 ${res.snapshot.files}개, ${Math.round(res.snapshot.elapsedMs / 100) / 10}s)` +
      (res.overlaps && res.overlaps.length ? ` · 겹치는 scope: ${res.overlaps.join(', ')}` : ''));
  });

  reg('svnwt.refreshScope', async (arg) => {
    const s = await pickScope(arg);
    const r = await withProgress(`SVN 기준 읽는 중: ${s.id}`, () => service.refreshScope(s.id));
    refreshAll();
    vscode.window.showInformationMessage(`${s.id}: r${r.revision} ${r.changed ? '새 기준 커밋 생성' : '변경 없음'}${r.mixedRevision ? ` (mixed ${r.mixedRevision})` : ''}`);
  });

  reg('svnwt.svnUpdateScope', async (arg) => {
    const s = await pickScope(arg);
    const ok = await vscode.window.showWarningMessage(`"${s.svnPath}" 에서 svn update 를 실행합니다.`, { modal: true }, '실행');
    if (ok !== '실행') return;
    const r = await withProgress(`svn update: ${s.id}`, () => service.refreshScope(s.id, { svnUpdate: true }));
    log(r.svnUpdate || '');
    refreshAll();
    vscode.window.showInformationMessage(`${s.id}: r${r.revision} 로 갱신되었습니다. 진행 중인 작업은 "최신 SVN 기준으로 rebase"를 실행하세요.`);
  });

  reg('svnwt.removeScope', async (arg) => {
    const s = await pickScope(arg);
    const ok = await vscode.window.showWarningMessage(`scope "${s.id}" 등록을 해제할까요? 활성 작업 worktree도 삭제됩니다.`, { modal: true }, '해제');
    if (ok !== '해제') return;
    for (const t of service.listTasks({ scope: s.id })) await removeFromWorkspace(t);
    await service.removeScope(s.id, { force: true });
    refreshAll();
  });

  reg('svnwt.createTask', async (arg) => {
    const s = await pickScope(arg);
    const title = await vscode.window.showInputBox({ prompt: '작업 제목', placeHolder: '예: 로그인 실패 시 재시도 처리' });
    if (!title) return;
    const description = await vscode.window.showInputBox({ prompt: '작업 설명 (선택, 리뷰/커밋 메시지에 사용)' });
    const t = await withProgress('worktree 만드는 중…', () => service.createTask(s.id, { title, description: description || '' }));
    const seen = ctx.workspaceState.get('svnwt.seenTasks', []);
    await ctx.workspaceState.update('svnwt.seenTasks', [...seen, t.id]);
    refreshAll();
    // same rule as tasks created by Copilot: follow svnwt.addWorktreeToWorkspace
    const mode = vscode.workspace.getConfiguration('svnwt').get('addWorktreeToWorkspace');
    const added = workspaceHas(t.workPath) >= 0 || (mode !== 'never' && addToWorkspace(t));
    const actions = ['Copilot으로 진행', ...(added ? [] : ['작업 영역에 추가']), '새 창에서 열기'];
    const a = await vscode.window.showInformationMessage(
      `작업 #${t.no} "${t.title}"을(를) 만들었습니다.${added ? ' worktree 를 작업 영역에 추가했습니다.' : ''}`, ...actions);
    if (a === '작업 영역에 추가') addToWorkspace(t);
    if (a === '새 창에서 열기') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(t.workPath), { forceNewWindow: true });
    if (a === 'Copilot으로 진행') {
      if (!added) addToWorkspace(t);
      await openChat(`svnwt 작업 ${t.id} (worktree: ${t.workPath}) 를 진행해줘. 목표: ${title}${description ? ' — ' + description : ''}`);
    }
  });

  reg('svnwt.openReview', async (arg, opts) => { const t = await pickTask(arg); ReviewPanel.show(ctxApi, t.id, opts || {}); });
  reg('svnwt.openReviewNewTab', async (arg) => { const t = await pickTask(arg); ReviewPanel.show(ctxApi, t.id, { newTab: true }); });

  reg('svnwt.openWorktree', async (arg) => {
    const t = await pickTask(arg);
    const inWs = workspaceHas(t.workPath) >= 0;
    const pick = await vscode.window.showQuickPick([
      { label: inWs ? '$(go-to-file) 탐색기에서 보기' : '$(add) 현재 창의 작업 영역에 추가', description: 'Copilot 이 편집하려면 작업 영역에 있어야 합니다', v: 'ws' },
      { label: '$(empty-window) 새 창에서 열기', v: 'win' },
      { label: '$(terminal) 터미널 열기', v: 'term' },
      { label: '$(folder) 파일 탐색기에서 열기', v: 'os' },
    ], { placeHolder: `#${t.no} ${t.title} — ${t.workPath}` });
    if (!pick) return;
    if (pick.v === 'ws') await vscode.commands.executeCommand('svnwt.addToWorkspace', t.id);
    if (pick.v === 'win') await vscode.commands.executeCommand('svnwt.openInNewWindow', t.id);
    if (pick.v === 'term') await vscode.commands.executeCommand('svnwt.openTerminal', t.id);
    if (pick.v === 'os') await vscode.commands.executeCommand('svnwt.revealWorktree', t.id);
  });
  reg('svnwt.openChanges', async (arg) => { const t = await pickTask(arg); await openChanges(t.id); });
  reg('svnwt.openFileDiff', (taskId, f) => openFileDiff(taskId, f));

  reg('svnwt.askCopilotReview', async (arg) => {
    const t = await pickTask(arg);
    await openChat(`svnwt 작업 ${t.id} 를 pull request 처럼 리뷰해줘. svnwt_task_review_get 으로 변경 내용을 가져오고, 필요하면 worktree(${t.workPath})의 주변 코드도 확인한 뒤 svnwt_task_review_submit 으로 결과(verdict, 요약, 파일/라인 코멘트)를 기록해. 리뷰 중에는 파일을 수정하지 마.`, false);
  });

  reg('svnwt.syncTask', async (arg) => {
    const t = await pickTask(arg, (x) => x.status !== 'committed');
    const r = await withProgress(`#${t.no} rebase 중…`, () => service.syncTask(t.id, {}));
    refreshAll();
    if (r.ok) vscode.window.showInformationMessage(`#${t.no}: 최신 SVN 기준(r${service.resolveScope(t.scopeId).revision})으로 갱신했습니다.`);
    else {
      const a = await vscode.window.showWarningMessage(`#${t.no}: 충돌 ${r.conflicts.length}개 — ${r.conflicts.slice(0, 5).join(', ')}. worktree에서 해결한 뒤 계속하세요.`, 'Copilot에게 해결 요청', '취소(abort)');
      if (a === '취소(abort)') { await service.syncTask(t.id, { abort: true }); refreshAll(); }
      if (a === 'Copilot에게 해결 요청') await openChat(`svnwt 작업 ${t.id} 의 rebase 충돌을 worktree(${t.workPath})에서 해결하고 svnwt_task_sync(cont=true)로 계속해줘. 충돌 파일: ${r.conflicts.join(', ')}`, true);
    }
  });

  reg('svnwt.land', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'active' || x.status === 'landed');
    const info = await service.taskInfo(t.id, { checkSvn: false });
    let autoCommit = false;
    if (info.worktree.dirty.length) {
      const a = await vscode.window.showWarningMessage(`worktree에 커밋되지 않은 변경 ${info.worktree.dirty.length}개가 있습니다.`, { modal: true }, '커밋 후 진행', '커밋된 것만 반영');
      if (!a) return;
      autoCommit = a === '커밋 후 진행';
    }
    const plan = await withProgress('SVN working copy 반영 내용 확인 중…', () => service.landTask(t.id, { dryRun: true, autoCommit }));
    const count = (a) => plan.files.filter((f) => f.action === a).length;
    const summary = [
      ['수정/추가', count('write')], ['삭제', count('delete')], ['이동', count('move-source')], ['이미 같음', count('none')],
    ].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
    const lines = [
      ...plan.files.filter((f) => ['write', 'delete', 'move-source'].includes(f.action)).map((f) => `${f.action === 'delete' ? '−' : f.action === 'move-source' ? '→' : '+'} ${f.path}${f.merged ? '  (다른 변경과 자동 병합)' : ''}${f.sharedWith ? `  (${f.sharedWith.replace(/^svnwt-/, '#').replace(/^#(\d+)-.*/, '#$1')} 과 같이 고친 파일 — 커밋할 때 이 작업 변경만 분리)` : ''}`),
      ...plan.blocked.map((b) => `✗ ${b.path} — ${b.reason}`),
    ];
    let force = false;
    if (plan.blocked.length) {
      const applicable = count('write') + count('delete') + count('move-source');
      const localEdit = plan.blocked.some((b) => /로컬 변경|읽기 전용/.test(b.reason || ''));
      const overlap = plan.blocked.some((b) => /changelist/.test(b.reason || ''));
      const tips = [];
      if (localEdit) tips.push('SVN working copy 에서 같은 파일을 직접 고친 내용과 겹칩니다. 그 수정을 먼저 커밋하거나 되돌린 뒤 다시 시도하세요.');
      if (overlap) tips.push('다른 작업의 changelist 에 이미 들어 있는 파일입니다. 그 작업을 먼저 SVN 에 커밋한 뒤 "최신 SVN 기준으로 rebase" 하세요.');
      const buttons = [];
      if (applicable) buttons.push('충돌 파일 빼고 반영');
      if (overlap || !info.baseIsLatest) buttons.push('최신 SVN 기준으로 rebase');
      const a = await vscode.window.showWarningMessage(`#${t.no}: SVN working copy 에 반영할 수 없는 파일이 ${plan.blocked.length}개 있습니다.`,
        { modal: true, detail: [...lines, '', ...tips].join('\n') }, ...buttons);
      if (a === '최신 SVN 기준으로 rebase') return vscode.commands.executeCommand('svnwt.syncTask', t.id);
      if (a !== '충돌 파일 빼고 반영') return undefined;
      force = true;
    } else {
      const a = await vscode.window.showInformationMessage(`#${t.no} 변경을 SVN working copy 에 반영하고 changelist "${t.changelist}" 로 묶을까요?`,
        { modal: true, detail: `${summary}\n\n${lines.join('\n')}` }, '반영');
      if (a !== '반영') return undefined;
    }
    const r = await withProgress('SVN changelist 만드는 중…', () => service.landTask(t.id, { autoCommit, force }));
    refreshAll();
    if (r.errors && r.errors.length) vscode.window.showWarningMessage(`일부 svn 명령 실패: ${r.errors.join(' / ')}`);
    const a = await vscode.window.showInformationMessage(`changelist "${r.changelist}" 준비 완료 (파일 ${r.commit.files.length}개). SVN 커밋은 직접 진행하세요.`, 'SVN 커밋…', '명령 복사');
    if (a === 'SVN 커밋…') vscode.commands.executeCommand('svnwt.commitSvn', t.id);
    if (a === '명령 복사') vscode.commands.executeCommand('svnwt.copyCommitCommand', t.id);
    return undefined;
  });

  reg('svnwt.unland', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'landed');
    const ok = await vscode.window.showWarningMessage(`#${t.no} 변경을 SVN working copy에서 되돌릴까요? (다른 로컬 변경은 유지)`, { modal: true }, '되돌리기');
    if (ok !== '되돌리기') return;
    const r = await service.unlandTask(t.id);
    refreshAll();
    const c = r.files.filter((f) => f.action === 'conflict');
    vscode.window.showInformationMessage(`되돌림 완료${c.length ? ` (수동 확인 필요: ${c.map((x) => x.path).join(', ')})` : ''}`);
  });

  reg('svnwt.commitSvn', async (arg) => commitTaskToSvn(await pickTask(arg, (x) => x.status === 'landed')));
  reg('svnwt.commitSvnChoose', async (arg) => commitTaskToSvn(await pickTask(arg, (x) => x.status === 'landed'), 'ask'));
  reg('svnwt.cancelCommit', async (arg) => {
    const pending = service.pendingCommits();
    if (!pending.length) { vscode.window.showInformationMessage('준비된 커밋이 없습니다.'); return; }
    const id = taskIdOf(arg) || pending[0].task;
    const t = service.resolveTask(id).task;
    if (watching && watching.task === t.id) stopWatching();
    const res = await withProgress(`#${t.no} 커밋 준비를 되돌리는 중…`, () => service.endCommit(t.id));
    await afterCommit(t, res, '');
  });

  reg('svnwt.copyCommitCommand', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'landed');
    const { scope, task } = service.resolveTask(t.id);
    const help = await service.commitHelp(scope, task);
    await vscode.env.clipboard.writeText(help.cli);
    vscode.window.showInformationMessage(`복사했습니다: ${help.cli}`);
  });

  reg('svnwt.addToWorkspace', async (arg) => {
    const t = await pickTask(arg);
    if (!addToWorkspace(t)) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(t.workPath));
  });
  reg('svnwt.openInNewWindow', async (arg) => {
    const t = await pickTask(arg);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(t.workPath), { forceNewWindow: true });
  });
  reg('svnwt.revealWorktree', async (arg) => {
    const t = await pickTask(arg);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(t.workPath));
  });
  reg('svnwt.openTerminal', async (arg) => {
    const t = await pickTask(arg);
    vscode.window.createTerminal({ name: `svnwt #${t.no}`, cwd: t.workPath }).show();
  });

  reg('svnwt.removeTask', async (arg) => {
    const t = await pickTask(arg);
    let force = false;
    if (t.status === 'landed') {
      const a = await vscode.window.showWarningMessage(`#${t.no} 의 changelist가 아직 SVN에 커밋되지 않았습니다. worktree만 삭제하고 SVN working copy의 변경은 그대로 둘까요?`, { modal: true }, '삭제');
      if (a !== '삭제') return;
      force = true;
    } else {
      const a = await vscode.window.showWarningMessage(`#${t.no} "${t.title}" worktree와 브랜치를 삭제할까요?`, { modal: true }, '삭제');
      if (a !== '삭제') return;
      force = t.status !== 'committed';
    }
    for (const p of ReviewPanel.panels.values()) if (p.taskId === t.id) p.panel.dispose();
    await removeFromWorkspace(t);
    const r = await service.removeTask(t.id, { force });
    refreshAll();
    if (r.warnings.length) vscode.window.showWarningMessage(r.warnings.join('\n'));
  });

  reg('svnwt.installInstructions', async () => {
    const r = setup.installInstructions(ctx, { force: true });
    if (r.error) throw new Error(r.error);
    const a = await vscode.window.showInformationMessage(`Copilot 지침을 설치했습니다: ${r.file}`, '열기');
    if (a === '열기') vscode.window.showTextDocument(vscode.Uri.file(r.file));
  });

  reg('svnwt.exportVisualStudio', async () => {
    const r = setup.exportVisualStudio(ctx);
    const a = await vscode.window.showInformationMessage(
      `Visual Studio용 MCP 설정을 ${r.file} 에 기록했습니다. Visual Studio에서 솔루션의 .github/copilot-instructions.md 에 지침을 넣으면 Copilot이 같은 워크플로를 따릅니다.`,
      '지침 파일 열기', '설정 파일 열기');
    if (a === '지침 파일 열기') vscode.window.showTextDocument(vscode.Uri.file(r.instructions));
    if (a === '설정 파일 열기') vscode.window.showTextDocument(vscode.Uri.file(r.file));
  });
}

// ------------------------------------------------------------------ SVN commit of one task (the human commits)
/**
 * Commit exactly one task: files that also contain other changes (another task on a shared file, the
 * user's own local edits) are set aside to "SVN BASE + this task" during the commit and restored after.
 * mode: 'tortoise' (TortoiseSVN dialog with only this task's files and the message filled in),
 *       'vscode' (one confirmation dialog), 'ask'.
 */
async function commitTaskToSvn(t, mode) {
  let plan = await service.commitPlan(t.id);
  if (plan.stale) {
    const a = await vscode.window.showWarningMessage(`#${t.no}: changelist 를 만든 뒤 새 커밋이 있습니다. changelist 를 먼저 갱신할까요?`, { modal: true }, '갱신 후 커밋', '지금 상태로 커밋');
    if (!a) return;
    if (a === '갱신 후 커밋') {
      const r = await service.landTask(t.id, {});
      if (!r.ok) { vscode.window.showWarningMessage(`changelist 갱신 실패: ${(r.blocked || []).map((b) => b.path).join(', ')} ${(r.errors || []).join(' ')}`); return; }
      refreshAll();
      plan = await service.commitPlan(t.id);
    }
  }
  const e = await env.detect();
  mode = mode || vscode.workspace.getConfiguration('svnwt').get('commitTool') || 'external';
  if (mode === 'tortoise' && !e.tortoiseProc) mode = 'vscode';
  const split = plan.setAside.length > 0;
  if (mode === 'ask') {
    const choices = [];
    choices.push({ label: '$(checklist) 커밋 준비 (사내 커밋 도구에서 커밋)', description: 'TortoiseSVN 커밋 창에 이 작업 파일만 체크되도록 준비', v: 'external' });
    if (e.tortoiseProc) choices.push({ label: '$(repo-push) TortoiseSVN 커밋 창 바로 열기', description: '이 작업의 파일과 메시지가 채워진 상태로 열림', v: 'tortoise' });
    choices.push({ label: '$(check) VS Code 에서 바로 커밋', description: '확인 창 하나로 커밋', v: 'vscode' });
    if (!split) {
      choices.push({ label: '$(terminal) 터미널에 svn commit 명령 입력', description: '실행은 직접 Enter', v: 'terminal' });
      choices.push({ label: '$(copy) svn commit 명령 복사', v: 'copy' });
    }
    const pick = await vscode.window.showQuickPick(choices, {
      placeHolder: `#${t.no} · 파일 ${plan.files.length}개${split ? ` · 다른 변경과 섞인 파일 ${plan.setAside.length}개는 이 작업 변경만 분리해서 커밋` : ''}`,
    });
    if (!pick) return;
    mode = pick.v;
  }
  if (mode === 'copy') return vscode.commands.executeCommand('svnwt.copyCommitCommand', t.id);
  if (mode === 'terminal') {
    const { scope, task } = service.resolveTask(t.id);
    const help = await service.commitHelp(scope, task);
    const term = vscode.window.createTerminal({ name: `svn commit #${t.no}`, cwd: scope.svnPath });
    term.show();
    term.sendText(help.cli, false);
    return undefined;
  }

  const setAsideText = split ? `\n\n커밋하는 동안 잠시 빼 두는 변경 (커밋 후 그대로 돌아옵니다):\n${plan.setAside.map((x) => `  ${x.path} — ${x.reason}`).join('\n')}` : '';
  if (mode === 'external') {
    const begun = await withProgress(`#${t.no} 커밋 준비 중…`, () => service.beginCommit(t.id, { external: true }));
    await vscode.env.clipboard.writeText(fs.readFileSync(begun.messageFile, 'utf8').trim());
    refreshAll();
    watchExternalCommit(t);
    const warn = begun.otherNewDirs.length ? `\n주의: 다른 작업의 새 폴더 ${begun.otherNewDirs.join(', ')} 는 체크 해제하세요.` : '';
    vscode.window.showInformationMessage(
      `#${t.no} 커밋 준비 완료. 사내 커밋 도구(TortoiseSVN 커밋 창)에서 이 작업 파일 ${plan.files.length}개만 체크돼 있습니다. 커밋 메시지는 클립보드에 복사했습니다.${warn}`,
      '커밋 취소(되돌리기)').then((a) => { if (a) vscode.commands.executeCommand('svnwt.cancelCommit', t.id); });
    return undefined;
  }
  if (mode === 'vscode') {
    const msg = fs.readFileSync(plan.messageFile, 'utf8').trim();
    const ok = await vscode.window.showInformationMessage(`#${t.no} "${t.title}" 을(를) SVN 에 커밋합니다.`, {
      modal: true,
      detail: `커밋 메시지:\n${msg}\n\n파일 ${plan.files.length}개:\n${plan.files.map((f) => `  ${f}`).join('\n')}${setAsideText}`,
    }, '커밋');
    if (ok !== '커밋') return undefined;
    let res = null;
    let output = '';
    await withProgress(`#${t.no} SVN 커밋 중…`, async () => {
      await service.beginCommit(t.id);
      try {
        const r = await service.runSvnCommit(t.id);
        output = r.output;
      } finally {
        res = await service.endCommit(t.id);
      }
    });
    return afterCommit(t, res, output);
  }

  // TortoiseSVN: only this task's paths, message filled in, progress window closes by itself when OK
  const begun = await service.beginCommit(t.id);
  const pathFile = path.join(os.tmpdir(), `svnwt-${t.id}-paths.txt`);
  fs.writeFileSync(pathFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(begun.targets.join('\r\n'), 'utf16le')]));
  if (split) vscode.window.setStatusBarMessage(`$(sync~spin) #${t.no} 커밋 중: 다른 변경 ${plan.setAside.length}개 파일을 잠시 빼 두었습니다`, 15000);
  const { spawn } = require('child_process');
  const child = spawn(e.tortoiseProc, ['/command:commit', `/pathfile:${pathFile}`, '/deletepathfile', `/logmsgfile:${plan.messageFile}`, '/closeonend:1'],
    { detached: false, windowsHide: false });
  const finish = async () => {
    let res = null;
    try { res = await service.endCommit(t.id); } catch (err) { vscode.window.showErrorMessage(`SVN Worktree: ${err.message}`); }
    await afterCommit(t, res, '');
  };
  child.on('exit', finish);
  child.on('error', (err) => { vscode.window.showErrorMessage(`TortoiseSVN 실행 실패: ${err.message}`); finish(); });
  return undefined;
}

// ------------------------------------------------------------------ external commit watcher
let watching = null; // { task, timer, item }

/** Poll until the prepared task shows up as committed (by a commit tool / TortoiseSVN), then restore everything. */
function watchExternalCommit(t) {
  stopWatching();
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = `$(sync~spin) #${t.no} 커밋 준비됨`;
  item.tooltip = `"${t.title}" — 사내 커밋 도구에서 커밋하세요. 이 작업의 파일만 체크돼 있습니다.\n클릭: 커밋 취소(되돌리기)`;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.command = { command: 'svnwt.cancelCommit', title: '커밋 취소', arguments: [t.id] };
  item.show();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (!service.pendingCommits().some((m) => m.task === t.id)) { stopWatching(); refreshAll(); return; }
      if (await service.commitDone(t.id)) {
        stopWatching();
        const res = await service.endCommit(t.id);
        await afterCommit(t, res, '');
      }
    } catch (e) { log(`watch commit: ${e.message}`); } finally { busy = false; }
  }, 3000);
  watching = { task: t.id, timer, item };
}

function stopWatching() {
  if (!watching) return;
  clearInterval(watching.timer);
  watching.item.dispose();
  watching = null;
}

async function afterCommit(t, res, output) {
  refreshAll();
  if (res && res.committed) {
    const m = /Committed revision (\d+)/i.exec(output || '') || /revision (\d+)/i.exec(output || '');
    const a = await vscode.window.showInformationMessage(`#${t.no} "${t.title}" SVN 커밋 완료${m ? ` (r${m[1]})` : ''}. worktree 를 정리할까요?`, '정리', '나중에');
    if (a === '정리') vscode.commands.executeCommand('svnwt.removeTask', t.id);
  } else if (output) {
    vscode.window.showErrorMessage(`#${t.no} SVN 커밋 실패 — 파일은 원래대로 되돌렸습니다.\n${output.slice(-600)}`);
  } else {
    vscode.window.setStatusBarMessage(`#${t.no} 커밋을 취소했습니다 (파일은 원래대로).`, 5000);
  }
}

async function openChat(query) {
  try {
    // agent mode: svnwt MCP tools are only available to the agent.
    await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
  } catch (_) {
    await vscode.env.clipboard.writeText(query);
    vscode.window.showInformationMessage('Copilot Chat을 열 수 없어 요청 문구를 클립보드에 복사했습니다.');
  }
}

const ctxApi = { get service() { return service; }, openTaskFile };

// ------------------------------------------------------------------ MCP
function registerMcp(ctx) {
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    log('이 VS Code 버전은 MCP 서버 등록 API를 지원하지 않습니다 (1.101 이상 필요).');
    return;
  }
  const changed = new vscode.EventEmitter();
  ctx.subscriptions.push(changed);
  const serverJs = path.join(ctx.extensionPath, 'src', 'mcp', 'server.js');
  ctx.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('svnwt', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: async () => {
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      const def = new vscode.McpStdioServerDefinition('SVN Worktree', setup.nodeRuntime(), [serverJs],
        Object.assign({ ELECTRON_RUN_AS_NODE: '1', SVNWT_WORKSPACE: folders.join(';'), SVNWT_CLIENT: 'vscode' }, setup.toolEnv()),
        ctx.extension.packageJSON.version);
      if (folders[0]) def.cwd = vscode.Uri.file(folders[0]);
      return [def];
    },
  }));
  mcpRegistered = true;
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('svnwt.gitPath') || e.affectsConfiguration('svnwt.svnPath')) {
      setup.applyToolEnv();
      service._tools = null;
      changed.fire();
    }
  }));
}

// ------------------------------------------------------------------ activation
function watchEvents(ctx) {
  let timer = null;
  let lastMtime = 0;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      refreshAll();
      try { await autoAddWorktrees(ctx); } catch (e) { log(`autoAdd: ${e.message}`); }
    }, 250);
  };
  const file = store.eventsFile();
  store.ensureDir(path.dirname(file));
  try {
    const w = fs.watch(path.dirname(file), (ev, name) => { if (!name || name === path.basename(file)) fire(); });
    ctx.subscriptions.push({ dispose: () => w.close() });
  } catch (e) { log(`fs.watch 실패, polling 사용: ${e.message}`); }
  const iv = setInterval(() => {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m !== lastMtime) { if (lastMtime) fire(); lastMtime = m; }
    } catch (_) { /* no file yet */ }
  }, 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(iv) });

  // A changelist committed outside VS Code (TortoiseSVN, CLI) => mark the task committed.
  let checking = false;
  const iv2 = setInterval(async () => {
    if (checking || !vscode.window.state.focused) return;
    checking = true;
    try {
      for (const t of service.listTasks().filter((x) => x.status === 'landed')) {
        try { await service.checkCommitted(t.id); } catch (_) { /* svn busy etc. */ }
      }
    } finally { checking = false; }
  }, 60000);
  ctx.subscriptions.push({ dispose: () => clearInterval(iv2) });
}

function statusBar(ctx) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  ctx.subscriptions.push(item);
  const update = () => {
    const ed = vscode.window.activeTextEditor;
    let hit = null;
    try { if (ed && ed.document.uri.scheme === 'file') hit = service.findByPath(ed.document.uri.fsPath); } catch (_) { /* ignore */ }
    if (hit && hit.task) {
      item.text = `$(git-branch) svnwt #${hit.task.no}`;
      item.tooltip = `${hit.task.title} — 리뷰 열기`;
      item.command = { command: 'svnwt.openReview', title: '리뷰', arguments: [hit.task.id] };
      item.backgroundColor = undefined;
      item.show();
    } else if (hit && hit.scope && hit.location === 'svn') {
      item.text = '$(warning) SVN 원본';
      item.tooltip = `이 파일은 SVN working copy 원본입니다 (scope ${hit.scope.id}). 작업은 worktree에서 진행하세요.`;
      item.command = 'svnwt.createTask';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
    } else item.hide();
  };
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(update));
  update();
}

async function activate(ctx) {
  output = vscode.window.createOutputChannel('SVN Worktree');
  ctx.subscriptions.push(output);
  setup.applyToolEnv();
  service = new Service();

  tree = new TaskTree(service);
  ctx.subscriptions.push(vscode.window.createTreeView('svnwt.tasks', { treeDataProvider: tree, showCollapseAll: true }));
  ctx.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, new GitFs(service), { isReadonly: true, isCaseSensitive: true }));
  registerCommands(ctx);
  registerMcp(ctx);
  watchEvents(ctx);
  statusBar(ctx);

  checkEnvironment(false).then(async () => {
    // a split commit interrupted by a crash: put the set-aside changes back
    try {
      // prepared external commit (the commit dialog may still be open): keep watching instead of undoing
      for (const m of service.pendingCommits().filter((x) => x.external)) {
        try { watchExternalCommit(service.resolveTask(m.task).task); } catch (_) { /* task gone */ }
      }
      const rec = await service.recoverCommits();
      for (const r of rec) {
        if (r.error) vscode.window.showErrorMessage(`SVN Worktree: 중단된 커밋 복구 실패 (${r.task}): ${r.error}`);
        else vscode.window.showInformationMessage(`SVN Worktree: 중단된 커밋(${r.task})에서 잠시 빼 둔 변경 ${r.restored}개 파일을 되돌렸습니다.${r.committed ? ' 커밋은 완료된 상태입니다.' : ''}`);
      }
    } catch (e) { log(`recover: ${e.message}`); }
    refreshAll();
  }, (e) => log(e.message));
  try { setup.deployServer(ctx); } catch (e) { log(`server deploy: ${e.message}`); }
  if (vscode.workspace.getConfiguration('svnwt').get('installCopilotInstructions')) {
    const r = setup.installInstructions(ctx);
    if (r.changed) log(`Copilot 지침 설치: ${r.file}`);
    if (r.error) log(`Copilot 지침 설치 실패: ${r.error}`);
  }
  log(`활성화됨 (MCP: ${path.join(ctx.extensionPath, 'src', 'mcp', 'server.js')})`);
  return { service, tree, mcpRegistered };
}

function deactivate() {}

module.exports = { activate, deactivate };
