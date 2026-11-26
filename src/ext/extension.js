'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Service, isInside } = require('../core/service');
const env = require('../core/env');
const proc = require('../core/proc');
const store = require('../core/store');
const { TaskTree } = require('./tree');
const { GitFs, SCHEME } = require('./gitfs');
const { ReviewPanel } = require('./review');
const setup = require('./setup');
const { setupAgent } = require('./agentUi');

let service;
let tree;
let output;
let mcpRegistered = false;
let agent = null; // { runner, runBackground }

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

/** Like withProgress, with a cancel button: cancelling sets token.cancelled and kills the running svn/git command. */
async function withCancel(title, fn) {
  return withSteps(title, true, fn);
}

/**
 * Progress notification that shows the current step and, when one runs over 2 s, the svn/git command it waits on
 * ("svn status … 12초째"). Steps come from service._step; commands from proc.inFlight.
 */
function withSteps(title, cancellable, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, (progress, ct) => {
    const token = { cancelled: false };
    const t0 = Date.now();
    let step = '';
    const prev = service.onProgress;
    service.onProgress = (m) => { step = String(m).replace(/^\[[^\]]+\]\s*/, '').replace(/\s*\(\+[\d.]+s\)$/, ''); show(); };
    const show = () => {
      const slow = proc.inFlight().sort((a, b) => b.ms - a.ms)[0];
      const cmd = slow && slow.ms > 2000 ? ` — ${slow.line.length > 70 ? `${slow.line.slice(0, 70)}…` : slow.line} ${Math.round(slow.ms / 1000)}초째` : '';
      progress.report({ message: `${Math.round((Date.now() - t0) / 1000)}초 · ${step || '시작'}${cmd}` });
    };
    const tick = setInterval(show, 1000);
    if (cancellable) {
      ct.onCancellationRequested(() => {
        token.cancelled = true;
        log(`${title} 취소 요청: 실행 중인 명령 ${proc.killAll()}개 중지, 원래 상태로 되돌리는 중`);
        vscode.window.showInformationMessage('취소하는 중입니다. 빼 두었던 변경을 되돌린 뒤 끝납니다.');
      });
    }
    return Promise.resolve().then(() => fn(token)).finally(() => { clearInterval(tick); service.onProgress = prev; });
  });
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
function diffUris(scope, task, base, f, tip) {
  const left = f.status === 'A' ? GitFs.uri(scope.id, 'empty', f.path) : GitFs.uri(scope.id, base, f.from || f.path);
  // archived: no worktree, the right side is the kept tip commit
  const right = f.status === 'D' ? GitFs.uri(scope.id, 'empty', f.path)
    : task.status === 'archived' ? GitFs.uri(scope.id, tip, f.path) : vscode.Uri.file(path.join(task.workPath, ...f.path.split('/')));
  return { left, right };
}

/**
 * Where a task's diff / file opens. Always in the window of the task's review panel (also when the panel was
 * moved to a new window and the click came from the sidebar of the main window):
 * - svnwt.diffPlacement "review" (default): in the review panel's own tab group, full width, so VS Code shows the
 *   two sides next to each other; one preview tab is reused, and the diff title bar has 이전/다음 파일 and 리뷰 화면
 * - "beside": next to the review panel (narrow: VS Code may switch to the inline diff)
 * - "window": in a separate window of its own (the first diff is moved there, later ones reuse it)
 * Without an open review panel: the active editor group.
 * The diff title bar buttons 새 창으로 분리 / 리뷰 화면 탭으로 switch between "window" and "review" and save the
 * choice in the setting, so the next diff opens the same way.
 */
const diffPlacement = () => vscode.workspace.getConfiguration('svnwt').get('diffPlacement', 'review');
const setDiffPlacement = (v) => vscode.workspace.getConfiguration('svnwt').update('diffPlacement', v, vscode.ConfigurationTarget.Global);
const isReviewTab = (t) => t.input instanceof vscode.TabInputWebview && /svnwt\.review/.test(t.input.viewType);
const isTaskDiffTab = (t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === SCHEME && /↔ #\d+/.test(String(t.label));
/** The tab group holding a detached task diff (no review panel in it): the separate diff window. */
function detachedDiffGroup() {
  try { return vscode.window.tabGroups.all.find((g) => g.tabs.some(isTaskDiffTab) && !g.tabs.some(isReviewTab)) || null; } catch (_) { return null; }
}
async function focusReviewOf(taskId) {
  const rp = ReviewPanel.panels.get(taskId);
  if (!rp || rp.disposed) return false;
  rp.panel.reveal(rp.panel.viewColumn, false); // makes its group (and window) the active one
  await new Promise((r) => setTimeout(r, 60));
  return true;
}
async function showOptions(taskId) {
  if (taskId && await focusReviewOf(taskId)) {
    // the review's own column by number: "active" can still be another window (a detached diff window)
    const col = ReviewPanel.panels.get(taskId).panel.viewColumn || vscode.ViewColumn.Active;
    return diffPlacement() === 'beside'
      ? { preview: true, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside }
      : { preview: true, preserveFocus: false, viewColumn: col };
  }
  return { preview: true };
}

let extCtx = null;
/**
 * In a narrow editor VS Code merges the two sides into one column (diffEditor.useInlineViewWhenSpaceIsLimited).
 * Asked once, on the first task diff: keep the two sides always. It is the user's own editor setting, so it is
 * only changed on their yes.
 */
async function offerSideBySide() {
  try {
    if (!extCtx || extCtx.globalState.get('diffSideBySideAsked')) return;
    const cfg = vscode.workspace.getConfiguration('diffEditor');
    await extCtx.globalState.update('diffSideBySideAsked', true);
    if (cfg.get('useInlineViewWhenSpaceIsLimited') === false) return;
    const a = await vscode.window.showInformationMessage('편집기 칸이 좁으면 VS Code 가 diff 를 한 줄로 합쳐 보여 줍니다. 좁아도 항상 좌우로 볼까요? (VS Code 설정 diffEditor.useInlineViewWhenSpaceIsLimited 를 끕니다)', '항상 좌우로', '그대로');
    if (a === '항상 좌우로') await cfg.update('useInlineViewWhenSpaceIsLimited', false, vscode.ConfigurationTarget.Global);
  } catch (_) { /* optional */ }
}

// the diff on screen and its place in the task's file list (이전/다음 파일)
let diffNav = null;
const activeTab = () => { try { return vscode.window.tabGroups.activeTabGroup.activeTab; } catch (_) { return null; } };
/** A task file diff tab (label "name (rN ↔ #no i/n)"): its scope, task number and the two sides. */
function taskDiffOf(tab) {
  if (!tab || !isTaskDiffTab(tab)) return null;
  const m = /↔ #(\d+)/.exec(String(tab.label));
  const parts = tab.input.original.path.replace(/^\//, '').split('/');
  return { scopeId: parts[0], no: m[1], rel: parts.slice(2).join('/'), left: tab.input.original.toString(), right: tab.input.modified.toString() };
}
function updateDiffNavContext() {
  const tab = activeTab();
  const inp = tab && tab.input;
  // any task diff tab counts, not only the last one opened (an older tab, a tab restored after a reload)
  const on = !!((diffNav && inp instanceof vscode.TabInputTextDiff && inp.modified.toString() === diffNav.right) || taskDiffOf(tab));
  vscode.commands.executeCommand('setContext', 'svnwt.diffNav', on);
}
/** Make diffNav the diff of the active tab (the user may have switched to another diff tab). */
async function syncDiffNav() {
  const k = taskDiffOf(activeTab());
  if (!k || (diffNav && diffNav.right === k.right && diffNav.left === k.left)) return !!diffNav;
  try {
    const scope = service.resolveScope(k.scopeId);
    const all = service.listTasks({ scope: scope.id, includeArchived: true }).filter((t) => String(t.no) === k.no);
    const task = all.find((t) => t.status !== 'archived') || all[0];
    if (!task) return false;
    const info = await service.taskInfo(task.id, { checkSvn: false });
    const files = info.files || [];
    let idx = files.findIndex((f) => diffUris(scope, task, info.base, f, info.tip).right.toString() === k.right);
    if (idx < 0) idx = files.findIndex((f) => (f.from || f.path) === k.rel || f.path === k.rel);
    if (idx < 0) return false;
    diffNav = { taskId: task.id, files, index: idx, right: k.right, left: k.left, fresh: false };
    return true;
  } catch (_) { return false; }
}

async function openFileDiff(taskId, f, opts = {}) {
  const { scope, task } = service.resolveTask(taskId);
  const info = await service.taskInfo(task.id, { checkSvn: false });
  const files = info.files || [];
  const idx = Math.max(0, files.findIndex((x) => x.path === f.path));
  const { left, right } = diffUris(scope, task, info.base, f, info.tip);
  diffNav = { taskId: task.id, files, index: idx, right: right.toString(), left: left.toString(), fresh: true };
  const pos = files.length > 1 ? ` ${idx + 1}/${files.length}` : '';
  let where;
  let detach = false;
  const own = diffPlacement() === 'window' ? detachedDiffGroup() : null;
  if (own) where = { preview: true, preserveFocus: false, viewColumn: own.viewColumn };
  else { where = await showOptions(task.id); detach = diffPlacement() === 'window'; }
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(f.path)} (r${scope.revision} ↔ #${task.no}${pos})`, where);
  if (detach) await moveDiffToNewWindow();
  updateDiffNavContext();
  offerSideBySide();
}

async function moveDiffToNewWindow() {
  try { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); return true; } catch (_) {
    vscode.window.showWarningMessage('이 VS Code 버전은 편집기를 새 창으로 옮기지 못합니다 (1.85 이상 필요). 리뷰 화면 탭에 엽니다.');
    await setDiffPlacement('review');
    return false;
  }
}

/** 이전/다음 파일. edge: put the cursor on that file's 'first' / 'last' change (change walking across files). */
async function stepDiff(delta, edge) {
  await syncDiffNav();
  if (!diffNav || !diffNav.files.length) return;
  const n = diffNav.files.length;
  const i = (diffNav.index + delta + n) % n;
  const f = diffNav.files[i];
  // stay in the group the current diff is in
  const { scope, task } = service.resolveTask(diffNav.taskId);
  const info = await service.taskInfo(task.id, { checkSvn: false });
  const { left, right } = diffUris(scope, task, info.base, f, info.tip);
  // stay in the tab group the current diff is in (wherever the focus is)
  const cur = diffNav.right;
  const home = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === cur));
  diffNav = { taskId: task.id, files: info.files, index: i, right: right.toString(), left: left.toString(), fresh: true };
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(f.path)} (r${scope.revision} ↔ #${task.no} ${i + 1}/${n})`,
    { preview: true, viewColumn: home ? home.viewColumn : vscode.ViewColumn.Active });
  updateDiffNavContext();
  if (n > 1 && ((delta > 0 && i === 0) || (delta < 0 && i === n - 1))) vscode.window.setStatusBarMessage(delta > 0 ? '마지막 파일 다음: 첫 파일로 돌아왔습니다.' : '첫 파일 이전: 마지막 파일로 갔습니다.', 3000);
  if (edge) await gotoChange(edge);
}

/** The diff's text editor that has the focus (either side), once the diff opened. */
async function diffEditor() {
  for (let i = 0; i < 20; i++) {
    const ed = vscode.window.activeTextEditor;
    const u = ed && ed.document.uri.toString();
    if (diffNav && (u === diffNav.right || u === diffNav.left)) return ed;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
function revealChange(ed, h) {
  const line = Math.min(ed.document.lineCount, ed.document.uri.toString() === diffNav.right ? h.new : h.old);
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  diffNav.fresh = false;
}
const changesOf = (nav) => { const f = nav.files[nav.index]; return service.changeLines(nav.taskId, f.path, f.from).catch(() => []); };
async function gotoChange(edge) {
  const ed = await diffEditor();
  const hunks = await changesOf(diffNav);
  if (ed && hunks.length) revealChange(ed, edge === 'last' ? hunks[hunks.length - 1] : hunks[0]);
}
/** 다음/이전 변경 (Alt+→ / Alt+←): past the last change of a file it continues in the next file. */
async function stepChange(delta) {
  if (!(await syncDiffNav())) return;
  const ed = await diffEditor();
  const hunks = await changesOf(diffNav);
  if (ed && hunks.length) {
    const right = ed.document.uri.toString() === diffNav.right;
    const at = (h) => Math.min(ed.document.lineCount, right ? h.new : h.old);
    const cur = ed.selection.active.line + 1;
    const target = delta > 0
      ? (diffNav.fresh && at(hunks[0]) <= cur ? hunks[0] : hunks.find((h) => at(h) > cur))
      : hunks.slice().reverse().find((h) => at(h) < cur);
    if (target) { revealChange(ed, target); return; }
    if (diffNav.files.length < 2) { revealChange(ed, delta > 0 ? hunks[0] : hunks[hunks.length - 1]); return; }
  }
  await stepDiff(delta, delta > 0 ? 'first' : 'last');
}

async function openChanges(taskId) {
  const { scope, task } = service.resolveTask(taskId);
  const info = await service.taskInfo(task.id, { checkSvn: false });
  if (!info.files.length) { vscode.window.showInformationMessage('커밋된 변경 사항이 없습니다.'); return; }
  const resources = info.files.map((f) => {
    const { left, right } = diffUris(scope, task, info.base, f, info.tip);
    return [task.status === 'archived' ? GitFs.uri(scope.id, info.tip, f.path) : vscode.Uri.file(path.join(task.workPath, ...f.path.split('/'))), left, right];
  });
  await focusReviewOf(task.id); // vscode.changes opens in the active group: the review's
  await vscode.commands.executeCommand('vscode.changes', `#${task.no} ${task.title} — 변경 사항 (${info.files.length})`, resources);
}

/** One git commit of a task as a multi-file diff (its parent ↔ the commit). */
async function openCommit(taskId, sha) {
  const { scope, task } = service.resolveTask(taskId);
  const c = await service.commitFiles(task.id, sha);
  if (!c.files.length) { vscode.window.showInformationMessage(`${c.sha.slice(0, 8)}: 바뀐 파일이 없습니다.`); return; }
  const resources = c.files.map((f) => {
    const left = f.status === 'A' ? GitFs.uri(scope.id, 'empty', f.path) : GitFs.uri(scope.id, c.parent, f.from || f.path);
    const right = f.status === 'D' ? GitFs.uri(scope.id, 'empty', f.path) : GitFs.uri(scope.id, c.sha, f.path);
    return [GitFs.uri(scope.id, c.sha, f.path), left, right];
  });
  await focusReviewOf(task.id);
  await vscode.commands.executeCommand('vscode.changes', `#${task.no} ${c.sha.slice(0, 8)} ${c.subject} (${c.files.length})`, resources);
}

// ------------------------------------------------------------------ ask about a selection (review → agent)
/** Task + path (relative to the scope) of the file in an editor: a worktree file, the SVN-side of a diff, or an SVN file. */
async function taskOfEditor(editor) {
  const uri = editor.document.uri;
  if (uri.scheme === 'file') {
    const m = service.mapPath(uri.fsPath);
    if (m.from === 'worktree') return { task: service.resolveTask(m.task).task, rel: m.rel.replace(/\\/g, '/') };
    if (m.from === 'svn') {
      const cands = m.worktrees.filter((w) => ['active', 'landed'].includes(w.status));
      if (!cands.length) return null;
      const t = cands.length === 1 ? cands[0] : await vscode.window.showQuickPick(cands.map((w) => ({ label: w.title, description: w.status, w })), { title: '어느 작업에 지시할까요?' }).then((x) => x && x.w);
      return t ? { task: service.resolveTask(t.task).task, rel: m.rel.replace(/\\/g, '/') } : null;
    }
    return null;
  }
  if (uri.scheme === SCHEME) {
    const parts = uri.path.replace(/^\//, '').split('/');
    const rel = parts.slice(2).join('/');
    const cands = service.listTasks({ scope: parts[0] }).filter((t) => ['active', 'landed'].includes(t.status));
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const label = active && active.label ? String(active.label) : '';
    const byTitle = cands.find((t) => label.includes(`#${t.no})`) || label.includes(`#${t.no} `));
    const t = byTitle || (cands.length === 1 ? cands[0] : await vscode.window.showQuickPick(cands.map((x) => ({ label: `#${x.no} ${x.title}`, x })), { title: '어느 작업에 지시할까요?' }).then((x) => x && x.x));
    return t ? { task: t, rel } : null;
  }
  return null;
}

/** The task's diff hunks of one file that touch lines [from, to] (new-file line numbers). */
async function hunksAround(taskId, rel, from, to) {
  let diff = '';
  try { diff = (await service.diffTask(taskId, { file: rel, uncommitted: true, maxChars: 200000 })).diff; } catch (_) { return ''; }
  const lines = diff.split('\n');
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.hit) out.push(...cur.lines); cur = null; };
  for (const l of lines) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      flush();
      const a = Number(h[1]);
      const b = a + Math.max(Number(h[2] === undefined ? 1 : h[2]), 1) - 1;
      cur = { lines: [l], hit: a <= to + 3 && b >= from - 3 };
    } else if (cur) cur.lines.push(l);
  }
  flush();
  return out.slice(0, 160).join('\n');
}

async function askAboutSelection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showInformationMessage('질문할 코드를 편집기나 diff 에서 선택하세요.'); return; }
  const where = await taskOfEditor(ed);
  if (!where) { vscode.window.showInformationMessage('SVN Worktree 작업의 파일이 아닙니다. 리뷰 화면에서 파일 diff 를 연 뒤 선택하세요.'); return; }
  const { task, rel } = where;
  const sel = ed.selection;
  const from = sel.start.line + 1;
  const to = sel.isEmpty ? from : sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
  const code = sel.isEmpty ? ed.document.lineAt(sel.start.line).text : ed.document.getText(sel);
  const side = ed.document.uri.scheme === SCHEME ? ' (SVN 기준 쪽)' : '';
  const text = await vscode.window.showInputBox({
    title: `#${task.no} ${rel}:${from}${to !== from ? `-${to}` : ''}${side} — 질문하거나 고칠 내용`,
    placeHolder: '예: 이 조건이 왜 필요해? / 여기 null 체크 추가하고 커밋해줘',
    ignoreFocusOut: true,
  });
  if (!text || !text.trim()) return;
  const hunks = ed.document.uri.scheme === 'file' ? await hunksAround(task.id, rel, from, to) : '';
  const lang = ed.document.languageId || '';
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (생략)` : s);
  const prompt = [
    `[리뷰 중 요청] 파일 \`${rel}\` ${from}${to !== from ? `-${to}` : ''}행${side} (worktree: ${path.join(task.workPath, ...rel.split('/'))})`,
    '',
    '선택한 코드:',
    '\`\`\`' + lang,
    clip(code, 6000),
    '\`\`\`',
    ...(hunks ? ['', '이 부분의 작업 변경 (SVN 기준 대비):', '\`\`\`diff', clip(hunks, 8000), '\`\`\`'] : []),
    '',
    `요청: ${text.trim()}`,
    '(질문이면 코드를 고치지 말고 답만. 고치라는 요청이면 이 작업 worktree 에서 고치고 커밋)',
  ].join('\n');
  const target = vscode.workspace.getConfiguration('svnwt').get('reviewAskTarget') || 'chat';
  if (target === 'background') {
    await vscode.commands.executeCommand('svnwt.agent.instruct', task.id, prompt);
    vscode.commands.executeCommand('svnwt.openReview', task.id);
    return;
  }
  const query = target === 'copilot'
    ? `SVN Worktree 작업 #${task.no} "${task.title}" (worktree: ${task.workPath}) 에 대한 요청입니다. svnwt 규칙대로 이 worktree 에서만 작업하세요.\n\n${prompt}`
    : `@svnwt /continue ${task.no} ${prompt}`;
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: false });
  } catch (_) {
    await vscode.env.clipboard.writeText(query);
    vscode.window.showInformationMessage('채팅을 열 수 없어 요청을 클립보드에 복사했습니다. 채팅 입력란에 붙여 넣으세요.');
  }
}

/** Context key for the editor menu: the active editor shows a task file (worktree, SVN-side of a task diff). */
function updateInTaskContext() {
  const ed = vscode.window.activeTextEditor;
  let v = false;
  try {
    if (ed && ed.document.uri.scheme === SCHEME) v = true;
    else if (ed && ed.document.uri.scheme === 'file') {
      const m = service.mapPath(ed.document.uri.fsPath);
      v = m.from === 'worktree' || (m.from === 'svn' && m.worktrees.some((w) => ['active', 'landed'].includes(w.status)));
    }
  } catch (_) { v = false; }
  vscode.commands.executeCommand('setContext', 'svnwt.inTask', v);
}

async function openTaskFile(taskId, rel, line, opts = {}) {
  const { scope, task } = service.resolveTask(taskId);
  const uri = task.status === 'archived'
    ? GitFs.uri(scope.id, (await service.taskInfo(task.id, { checkSvn: false })).tip || 'empty', String(rel))
    : vscode.Uri.file(path.join(task.workPath, ...String(rel).split('/')));
  const doc = await vscode.workspace.openTextDocument(uri);
  const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  await vscode.window.showTextDocument(doc, { ...(await showOptions(task.id)), selection: new vscode.Range(pos, pos) });
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
  reg('svnwt.checkSvn', async (arg) => {
    const id = taskIdOf(arg);
    const r = await withProgress(id ? 'SVN 상태 확인 중…' : '모든 작업의 SVN 상태 확인 중…', () => service.checkSvnState(id || undefined));
    refreshAll();
    const label = { active: '진행 중', landed: '커밋 대기', committed: '커밋 완료' };
    vscode.window.showInformationMessage(r.changed.length
      ? `SVN 상태 확인: ${r.changed.map((c) => `#${c.no} ${label[c.from] || c.from} → ${label[c.to] || c.to}`).join(', ')}`
      : `SVN 상태 확인: 바뀐 작업 없음 (${r.checked}개 확인)`);
  });
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
  reg('svnwt.openFileDiff', (taskId, f, opts) => openFileDiff(taskId, f, opts));
  reg('svnwt.openCommit', (taskId, sha) => openCommit(taskId, sha));
  reg('svnwt.askAboutSelection', () => askAboutSelection());
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { updateInTaskContext(); updateDiffNavContext(); }));
  ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => updateDiffNavContext()));
  updateInTaskContext();
  reg('svnwt.nextFile', () => stepDiff(1));
  reg('svnwt.prevFile', () => stepDiff(-1));
  reg('svnwt.nextChange', () => stepChange(1));
  reg('svnwt.prevChange', () => stepChange(-1));
  reg('svnwt.backToReview', async () => { if (await syncDiffNav()) ReviewPanel.show(ctxApi, diffNav.taskId, {}); });
  // Keyboard Shortcuts filtered to this extension: shows the keys as the user has them (bound ones first) and lets them change one
  reg('svnwt.showShortcuts', () => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@ext:${ctx.extension.id}`));
  // the choice is saved in the setting: the next diff opens the same way
  reg('svnwt.diffToWindow', async () => {
    await setDiffPlacement('window');
    await moveDiffToNewWindow();
    updateDiffNavContext();
  });
  reg('svnwt.diffToReview', async () => {
    await setDiffPlacement('review');
    if (!(await syncDiffNav())) return;
    const { taskId, files, index } = diffNav;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await openFileDiff(taskId, files[index]);
  });

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

  reg('svnwt.land', async (arg) => prepareCommit(await pickTask(arg, (x) => x.status === 'active' || x.status === 'landed')));
  reg('svnwt.landInPlace', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'active' || x.status === 'landed');
    const info = await service.taskInfo(t.id, { checkSvn: false });
    let autoCommit = false;
    if (info.worktree.dirty.length) {
      const a = await vscode.window.showWarningMessage(`worktree에 커밋되지 않은 변경 ${info.worktree.dirty.length}개가 있습니다.`, { modal: true }, '커밋 후 진행', '커밋된 것만 반영');
      if (!a) return;
      autoCommit = a === '커밋 후 진행';
    }
    // One changelist at a time: drop what other tasks have in the SVN working copy (their work stays in git).
    const occ = await service.wcOccupantsLive(t.id);
    let switched = false;
    if (occ.length) {
      const a = await vscode.window.showWarningMessage(`changelist 를 #${t.no} "${t.title}" 로 바꿀까요?`, {
        modal: true,
        detail: `SVN working copy 에서 아래 변경을 버립니다.\n\n${
          occ.map((o) => ({
            landed: `· #${o.no} "${o.title}" — 파일 ${o.files}개`,
            committed: `· #${o.no} "${o.title}" — 커밋 후 남은 파일 ${o.files}개`,
            stale: `· ${o.changelist} — 파일 ${o.files}개 (changelist 만 해제, 내용 유지)`,
            parked: `· ignore-on-commit 의 이 작업 파일 ${o.files}개 (changelist 에서 빼기)`,
          }[o.status])).join('\n')
        }\n\n작업 내용은 git 에 남아 있어 다시 만들 수 있습니다. 직접 고친 내용은 그대로 둡니다.`,
      }, '바꾸기');
      if (a !== '바꾸기') return undefined;
      const c = await withProgress('기존 changelist 버리는 중…', () => service.clearWorkingCopy(t.id));
      refreshAll();
      const kept = c.cleared.filter((x) => x.conflicts.length);
      if (kept.length) vscode.window.showWarningMessage(`직접 고친 내용과 겹쳐 남겨 둔 파일: ${kept.map((x) => `${x.no ? `#${x.no}` : x.changelist} ${x.conflicts.join(', ')}`).join(' / ')}`);
      switched = true;
    }
    const plan = await withProgress('SVN working copy 반영 내용 확인 중…', () => service.landTask(t.id, { dryRun: true, autoCommit, overwrite: true }));
    const count = (a) => plan.files.filter((f) => f.action === a).length;
    const summary = [
      ['수정/추가', count('write')], ['삭제', count('delete')], ['이동', count('move-source')], ['이미 같음', count('none')],
    ].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
    const lines = plan.files.filter((f) => ['write', 'delete', 'move-source'].includes(f.action))
      .map((f) => `${f.action === 'delete' ? '−' : f.action === 'move-source' ? '→' : '+'} ${f.path}${f.overwrite ? '  (working copy 내용 대신 작업 내용, 원래 내용은 백업)' : ''}`);
    const overwrites = plan.files.filter((f) => f.overwrite && f.action !== 'none');
    let force = false;
    if (plan.blocked.length) {
      // only what SVN itself got since the task started (rebase) or a read-only file can block now
      const applicable = count('write') + count('delete') + count('move-source');
      const buttons = [];
      if (plan.needsRebase) buttons.push('rebase 후 다시 만들기');
      if (applicable) buttons.push('그 파일 빼고 만들기');
      refreshAll();
      const a = await vscode.window.showWarningMessage(`#${t.no}: 파일 ${plan.blocked.length}개는 지금 만들 수 없습니다.`, {
        modal: true,
        detail: [...plan.blocked.map((b) => `✗ ${b.path} — ${b.reason}`), '', plan.needsRebase ? 'SVN 에 새로 커밋된 내용과 같은 줄입니다. rebase 하면 worktree 에서 정리한 뒤 이어서 만듭니다.' : ''].join('\n').trim(),
      }, ...buttons);
      if (a === 'rebase 후 다시 만들기') return vscode.commands.executeCommand('svnwt.rebaseAndLand', t.id);
      if (a !== '그 파일 빼고 만들기') return undefined;
      force = true;
    } else if (!switched || overwrites.length) {
      const a = await vscode.window.showInformationMessage(`#${t.no} changelist 를 만들까요?`, {
        modal: true,
        detail: `${summary}\n\n${lines.join('\n')}${overwrites.length ? `\n\n${overwrites.length}개 파일은 working copy 에 있던 다른 내용을 작업 내용으로 바꿉니다. 원래 내용은 백업합니다.` : ''}`,
      }, '만들기');
      if (a !== '만들기') return undefined;
    }
    const r = await withProgress('SVN changelist 만드는 중…', () => service.landTask(t.id, { autoCommit, force, overwrite: true }));
    refreshAll();
    if (r.errors && r.errors.length) vscode.window.showWarningMessage(`일부 svn 명령 실패: ${r.errors.join(' / ')}`);
    if (r.backupDir) vscode.window.showInformationMessage(`바꾸기 전 내용 백업: ${r.backupDir}`, '폴더 열기').then((x) => { if (x) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.backupDir)); });
    const a = await vscode.window.showInformationMessage(`changelist "${r.changelist}" 준비 완료 (파일 ${r.commit.files.length}개). SVN 커밋은 직접 진행하세요.`, 'SVN 커밋…', '명령 복사');
    if (a === 'SVN 커밋…') vscode.commands.executeCommand('svnwt.commitSvn', t.id);
    if (a === '명령 복사') vscode.commands.executeCommand('svnwt.copyCommitCommand', t.id);
    return undefined;
  });

  reg('svnwt.rebaseAndLand', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'active');
    if (!t) return undefined;
    const r = await withProgress(`#${t.no} 최신 SVN 기준으로 rebase 중…`, () => service.syncTask(t.id, {}));
    refreshAll();
    if (!r.ok) {
      const a = await vscode.window.showWarningMessage(`#${t.no}: rebase 중 같은 줄 충돌 ${r.conflicts.length}개 — ${r.conflicts.slice(0, 5).join(', ')}. worktree 에서 정리한 뒤 다시 "changelist 만들기" 를 누르세요.`,
        'Copilot에게 해결 요청', 'worktree 열기', '취소(abort)');
      if (a === '취소(abort)') { await service.syncTask(t.id, { abort: true }); refreshAll(); }
      if (a === 'worktree 열기') vscode.commands.executeCommand('svnwt.openWorktree', t.id);
      if (a === 'Copilot에게 해결 요청') await openChat(`svnwt 작업 ${t.id} 의 rebase 충돌을 worktree(${t.workPath})에서 해결하고 svnwt_task_sync(cont=true)로 계속해줘. 충돌 파일: ${r.conflicts.join(', ')}`, true);
      return undefined;
    }
    return vscode.commands.executeCommand('svnwt.land', t.id);
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

  reg('svnwt.commitSvn', async (arg) => prepareCommit(await pickTask(arg, (x) => x.status === 'active' || x.status === 'landed')));
  reg('svnwt.commitSvnChoose', async (arg) => commitTaskToSvn(await pickTask(arg, (x) => x.status === 'landed'), 'ask'));
  reg('svnwt.refreshPrepare', async (arg) => refreshPrepare(await pickTask(arg, (x) => service.pendingCommits().some((m) => m.task === x.id))));
  reg('svnwt.cancelCommit', async (arg) => {
    const pending = service.pendingCommits();
    if (!pending.length) { vscode.window.showInformationMessage('준비된 커밋이 없습니다.'); return; }
    const id = taskIdOf(arg) || pending[0].task;
    const t = service.resolveTask(id).task;
    if (watching && watching.task === t.id) stopWatching();
    const res = await withSteps(`#${t.no} 커밋 준비를 되돌리는 중…`, false, () => service.endCommit(t.id));
    await afterCommit(t, res, '');
  });

  reg('svnwt.discardLeftovers', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'committed');
    if (!t) return;
    const left = await service.leftovers(t.id);
    if (!left.length) {
      vscode.window.showInformationMessage(`#${t.no} 의 changelist 에 남은 변경이 없습니다.`);
      refreshAll();
      return;
    }
    const list = left.slice(0, 15).map((x) => `· ${x.path}${x.item === 'added' ? ' (새 파일)' : x.item === 'deleted' || x.item === 'missing' ? ' (삭제)' : ''}`).join('\n');
    const a = await vscode.window.showWarningMessage(
      `커밋에서 빠진 변경 ${left.length}개를 버릴까요?`,
      { modal: true, detail: `${list}${left.length > 15 ? `\n… 외 ${left.length - 15}개` : ''}\n\n이 작업의 변경만 되돌립니다. 같은 파일의 다른 수정과 git 브랜치는 그대로입니다.` },
      '버리기');
    if (a !== '버리기') return;
    const r = await withProgress(`#${t.no} 남은 변경을 버리는 중…`, () => service.discardLeftovers(t.id));
    refreshAll();
    const c = r.files.filter((f) => f.action === 'conflict');
    if (c.length) vscode.window.showWarningMessage(`남은 변경을 버렸습니다. 다른 수정과 겹쳐 직접 확인해야 하는 파일: ${c.map((x) => x.path).join(', ')}`);
    else vscode.window.showInformationMessage(`#${t.no} 남은 변경 ${r.files.length}개를 버렸습니다.`);
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
    const t = await pickTask(arg, (x) => x.status !== 'archived');
    if (t.status === 'archived') return;
    let force = false;
    const keep = '커밋 기록·리뷰·에이전트 대화는 사이드바 "보관된 작업"에 남습니다. worktree 에 커밋되지 않은 변경이 있으면 커밋해서 같이 보관합니다.';
    if (t.status === 'landed') {
      const a = await vscode.window.showWarningMessage(`#${t.no} 의 changelist가 아직 SVN에 커밋되지 않았습니다. worktree만 정리(보관)하고 SVN working copy의 변경은 그대로 둘까요?`, { modal: true, detail: keep }, '보관');
      if (a !== '보관') return;
      force = true;
    } else if (t.status === 'committed' && (await service.leftovers(t.id).catch(() => [])).length) {
      const n = (await service.leftovers(t.id)).length;
      const a = await vscode.window.showWarningMessage(`커밋에서 빠진 변경 ${n}개가 남아 있습니다. 같이 버릴까요?`,
        { modal: true, detail: `버리면 이 작업의 변경만 SVN working copy 에서 되돌립니다.\n\n${keep}` },
        '버리고 보관', '그대로 두고 보관');
      if (!a) return;
      if (a === '버리고 보관') {
        const r = await withProgress(`#${t.no} 남은 변경을 버리는 중…`, () => service.discardLeftovers(t.id));
        const c = r.files.filter((f) => f.action === 'conflict');
        if (c.length) vscode.window.showWarningMessage(`직접 확인해야 하는 파일: ${c.map((x) => x.path).join(', ')}`);
      }
    } else {
      const a = await vscode.window.showWarningMessage(`#${t.no} "${t.title}" 을 보관할까요? worktree 폴더와 브랜치를 지웁니다.`, { modal: true, detail: keep }, '보관');
      if (a !== '보관') return;
      force = t.status !== 'committed';
    }
    await removeFromWorkspace(t);
    const r = await withProgress(`#${t.no} 보관하는 중…`, () => service.removeTask(t.id, { force }));
    refreshAll();
    ReviewPanel.refreshAll();
    if (r.warnings.length) vscode.window.showWarningMessage(r.warnings.join('\n'));
    else vscode.window.setStatusBarMessage(`#${t.no} 을 보관했습니다 (보관된 작업에서 조회).`, 5000);
  });

  reg('svnwt.purgeTask', async (arg) => {
    const t = await pickTask(arg, (x) => x.status === 'archived');
    if (t.status !== 'archived') return;
    const a = await vscode.window.showWarningMessage(`#${t.no} "${t.title}" 의 보관 기록을 완전히 삭제할까요?`,
      { modal: true, detail: '커밋 기록, 리뷰, 에이전트 대화, 첨부한 테스트 화면이 지워지며 되돌릴 수 없습니다.' }, '삭제');
    if (a !== '삭제') return;
    for (const p of ReviewPanel.panels.values()) if (p.taskId === t.id) p.panel.dispose();
    await service.purgeTask(t.id);
    refreshAll();
  });

  reg('svnwt.showArchived', async (arg) => {
    const scopeId = arg && arg.scope ? arg.scope.id : undefined;
    const list = service.listArchived({ scope: scopeId });
    if (!list.length) { vscode.window.showInformationMessage('보관된 작업이 없습니다.'); return; }
    const pick = await vscode.window.showQuickPick(list.map((t) => ({
      label: `#${t.no} ${t.title}`,
      description: [String(t.archivedAt || '').slice(0, 10), t.archive ? `커밋 ${t.archive.commits}개` : '기록 없음'].join(' · '),
      detail: t.description ? t.description.split('\n')[0] : undefined, t,
    })), { title: '보관된 작업', placeHolder: '제목·설명으로 검색', matchOnDescription: true, matchOnDetail: true });
    if (pick) ReviewPanel.show(ctxApi, pick.t.id, {});
  });

  reg('svnwt.discardScopeChanges', async (arg) => {
    let scopeId = arg && arg.scope ? arg.scope.id : null;
    if (!scopeId && taskIdOf(arg)) scopeId = service.resolveTask(taskIdOf(arg)).scope.id;
    if (!scopeId) {
      const scopes = service.listScopes();
      if (!scopes.length) return;
      scopeId = scopes.length === 1 ? scopes[0].id
        : await vscode.window.showQuickPick(scopes.map((s) => ({ label: s.id, description: s.svnPath })), { title: '어느 scope 폴더를 정리할까요?' }).then((x) => x && x.label);
      if (!scopeId) return;
    }
    const sc = await withProgress('SVN 남은 변경을 확인하는 중…', () => service.scopeChanges(scopeId));
    if (sc.commitInProgress) { vscode.window.showWarningMessage('커밋 준비 중에는 정리할 수 없습니다. 커밋을 끝내거나 취소한 뒤 다시 시도하세요.'); return; }
    const free = sc.changes.filter((c) => !c.locked);
    const locked = sc.changes.filter((c) => c.locked);
    if (!free.length) {
      vscode.window.showInformationMessage(`${sc.svnPath} 에 남은 SVN 변경이 없습니다.${locked.length ? ` (커밋 대기 작업 파일 ${locked.length}개 제외)` : ''}`);
      return;
    }
    const ITEM = { modified: '수정', added: '추가', deleted: '삭제', missing: '없음', replaced: '교체', conflicted: '충돌', merged: '병합', unversioned: '버전 관리 안 됨' };
    const picks = await vscode.window.showQuickPick(free.map((c) => ({
      label: c.path + (c.isDir ? '/' : ''),
      description: [ITEM[c.item] || c.item, c.task ? `#${c.task.no} ${c.task.title}` : c.changelist].filter(Boolean).join(' · '),
      picked: c.item !== 'unversioned', c,
    })), {
      canPickMany: true, ignoreFocusOut: true, title: `SVN 남은 변경 정리 — ${sc.svnPath}`,
      placeHolder: `버릴 변경 선택 (버전 관리 안 되는 파일은 기본 해제${locked.length ? `, 커밋 대기 작업 파일 ${locked.length}개 제외` : ''}). worktree 와 git 커밋은 그대로입니다.`,
    });
    if (!picks || !picks.length) return;
    const a = await vscode.window.showWarningMessage(`SVN working copy 에서 ${picks.length}개 변경을 버릴까요?`,
      { modal: true, detail: '수정은 revert, 추가·버전 관리 안 되는 파일은 삭제합니다. 버리기 전에 파일을 svnwt 저장 폴더(discarded)에 복사해 둡니다. worktree 와 git 커밋은 건드리지 않습니다.' }, '버리기');
    if (a !== '버리기') return;
    const r = await withProgress(`SVN 변경 ${picks.length}개를 버리는 중…`, () => service.discardScopeChanges(scopeId, picks.map((p) => p.c.path)));
    refreshAll();
    ReviewPanel.refreshAll();
    const msg = `SVN 변경 ${r.discarded.length - r.failed.length}개를 버렸습니다.${r.failed.length ? ` 남은 것: ${r.failed.join(', ')}` : ''}`;
    const b = await (r.failed.length ? vscode.window.showWarningMessage(msg, '복사본 폴더 열기') : vscode.window.showInformationMessage(msg, '복사본 폴더 열기'));
    if (b && r.backup) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.backup));
  });

  reg('svnwt.addRule', async () => {
    const text = await vscode.window.showInputBox({ title: '규칙 추가', prompt: '모든 작업에서 Copilot 이 지킬 규칙 (한 문장)', ignoreFocusOut: true });
    if (!text || !text.trim()) return;
    const r = service.addRule(text, { by: 'user' });
    syncRules(ctx);
    if (!r.added) vscode.window.showInformationMessage('같은 규칙이 이미 있습니다.');
  });
  reg('svnwt.editRule', async (el) => {
    const r = el && el.rule;
    if (!r) return;
    const text = await vscode.window.showInputBox({ title: '규칙 수정', value: r.text, ignoreFocusOut: true });
    if (!text || !text.trim() || text.trim() === r.text) return;
    service.updateRule(r.id, text);
    syncRules(ctx);
  });
  reg('svnwt.removeRule', async (el) => {
    const r = el && el.rule;
    if (!r) return;
    const a = await vscode.window.showWarningMessage(`규칙을 삭제할까요?\n\n${r.text}`, { modal: true }, '삭제');
    if (a !== '삭제') return;
    service.removeRule(r.id);
    syncRules(ctx);
  });
  reg('svnwt.openRulesFile', async () => {
    const r = setup.installRules(ctx);
    if (r.error) throw new Error(r.error);
    await vscode.window.showTextDocument(vscode.Uri.file(r.file), { preview: true });
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
  mode = mode || vscode.workspace.getConfiguration('svnwt').get('commitTool') || 'prepare';
  if (mode === 'external') mode = 'prepare'; // value used by 0.3.0
  if (mode === 'tortoise' && !e.tortoiseProc) mode = 'vscode';
  const split = plan.setAside.length > 0;
  if (mode === 'ask') {
    const choices = [];
    choices.push({ label: '$(checklist) 커밋 준비', description: 'TortoiseSVN 커밋 창을 직접 열면 이 작업 파일만 체크돼 있도록 준비', v: 'prepare' });
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
  if (mode === 'prepare') return prepareCommit(t);
  if (mode === 'prepareLegacy') {
    const begun = await withProgress(`#${t.no} 커밋 준비 중…`, () => service.beginCommit(t.id, { external: true }));
    await vscode.env.clipboard.writeText(fs.readFileSync(begun.messageFile, 'utf8').trim());
    refreshAll();
    watchExternalCommit(t);
    const warn = begun.otherNewDirs.length ? `\n주의: 다른 작업의 새 폴더 ${begun.otherNewDirs.join(', ')} 는 체크 해제하세요.` : '';
    vscode.window.showInformationMessage(
      `#${t.no} 커밋 준비 완료. TortoiseSVN 커밋 창을 열면 이 작업 파일 ${plan.files.length}개만 체크돼 있습니다. 커밋 메시지는 클립보드에 복사했습니다.${warn}`,
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
let staleNotified = null;
function watchExternalCommit(t) {
  stopWatching();
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = `$(sync~spin) #${t.no} 커밋 준비됨`;
  item.tooltip = `"${t.title}" — TortoiseSVN 커밋 창을 열어 커밋하세요. 이 작업의 파일만 체크돼 있습니다.\n클릭: 커밋 취소(되돌리기)`;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.command = { command: 'svnwt.cancelCommit', title: '커밋 취소', arguments: [t.id] };
  item.show();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (!service.pendingCommits().some((m) => m.task === t.id)) { stopWatching(); refreshAll(); return; }
      if (await service.prepareIsStale(t.id)) {
        const tip = service.resolveTask(t.id).task;
        const k = `${t.id}:${tip.landed && tip.landed.commit}`;
        if (staleNotified !== k) {
          staleNotified = k;
          refreshAll();
          vscode.window.showWarningMessage(`#${t.no} 에 커밋 준비 후 새 git 커밋이 생겼습니다. working copy 에는 아직 이전 내용입니다.`, '커밋 준비 갱신')
            .then((a) => { if (a) vscode.commands.executeCommand('svnwt.refreshPrepare', t.id); });
        }
      }
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

/** After `t` was committed: tasks that waited for it (same lines) can now be rebased and landed. */
async function offerUnblocked(t) {
  let list = [];
  try { list = service.unblockedBy(t.id); } catch (_) { return; }
  if (!list.length) return;
  const names = list.map((x) => `#${x.no} "${x.title}"`).join(', ');
  const a = await vscode.window.showInformationMessage(`#${t.no} 가 커밋되어 ${names} 를 이어서 진행할 수 있습니다 (rebase 후 changelist 만들기).`,
    list.length === 1 ? `#${list[0].no} rebase 후 changelist 만들기` : '리뷰 열기');
  if (!a) return;
  if (list.length === 1) vscode.commands.executeCommand('svnwt.rebaseAndLand', list[0].id);
  else vscode.commands.executeCommand('svnwt.openReview', list[0].id);
}

/**
 * 커밋 준비: set every local change of the SVN working copy aside, put only this task (from git) on the clean
 * SVN BASE, wait for the commit (TortoiseSVN), then put everything back (watchExternalCommit -> endCommit).
 */
/** 커밋 준비 is on and the agent committed more: put the newest commits on the working copy. */
async function refreshPrepare(t) {
  if (!t) return undefined;
  let r;
  try {
    r = await withCancel(`#${t.no} 커밋 준비 갱신 중…`, (token) => service.refreshStashCommit(t.id, { token })).finally(refreshAll);
  } catch (e) {
    if (e.cancelled) { vscode.window.showInformationMessage(e.message); return undefined; }
    output.show(true);
    throw e;
  }
  if (r.committed) { vscode.window.showInformationMessage(`#${t.no} 은 이미 SVN 에 커밋됐습니다. 정리를 기다립니다.`); return undefined; }
  if (!r.ok) {
    const a = await vscode.window.showWarningMessage(`#${t.no}: SVN 에 새로 커밋된 내용과 같은 줄을 고쳤습니다. 커밋 준비는 되돌렸습니다.`, { modal: true, detail: (r.blocked || []).map((b) => `✗ ${b.path}`).join('\n') }, 'rebase 후 커밋 준비');
    if (a) return vscode.commands.executeCommand('svnwt.rebaseAndLand', t.id);
    return undefined;
  }
  try { await vscode.env.clipboard.writeText(fs.readFileSync(r.messageFile, 'utf8').trim()); } catch (_) { /* no message file */ }
  watchExternalCommit(t);
  vscode.window.showInformationMessage(`#${t.no} 커밋 준비 갱신: 새 커밋까지 반영했습니다 (파일 ${r.files.length}개). TortoiseSVN 커밋 창이 열려 있으면 새로 고침(F5) 하세요.`);
  return undefined;
}

async function prepareCommit(t) {
  if (!t) return undefined;
  if (service.pendingCommits().some((m) => m.task === t.id && m.kind === 'stash' && m.phase === 'ready')) {
    if (await service.prepareIsStale(t.id)) return refreshPrepare(t);
    vscode.window.showInformationMessage(`#${t.no} 은 이미 커밋 준비됨 상태입니다. TortoiseSVN 으로 커밋하거나 커밋 취소하세요.`);
    return undefined;
  }
  const info = await service.taskInfo(t.id, { checkSvn: false });
  if (info.worktree && info.worktree.dirty.length) {
    const a = await vscode.window.showWarningMessage(`#${t.no}: worktree 에 git 커밋되지 않은 변경 ${info.worktree.dirty.length}개가 있습니다. 같이 올릴까요?`, { modal: true }, '같이 올리기');
    if (!a) return undefined;
  }
  let r;
  try {
    r = await withCancel(`#${t.no} 커밋 준비 중…`, (token) => service.stashCommit(t.id, { token })).finally(refreshAll);
  } catch (e) {
    if (e.cancelled) { vscode.window.showInformationMessage(e.message); return undefined; }
    output.show(true);
    throw e;
  }
  if (!r.ok) {
    const a = await vscode.window.showWarningMessage(`#${t.no}: SVN 에 새로 커밋된 내용과 같은 줄을 고쳤습니다.`, {
      modal: true,
      detail: `${(r.blocked || []).map((b) => `✗ ${b.path}`).join('\n')}\n\n최신 SVN 기준으로 rebase 한 뒤 다시 커밋 준비합니다. working copy 는 바뀌지 않았습니다.`,
    }, 'rebase 후 커밋 준비');
    if (a) return vscode.commands.executeCommand('svnwt.rebaseAndLand', t.id);
    return undefined;
  }
  try { await vscode.env.clipboard.writeText(fs.readFileSync(r.messageFile, 'utf8').trim()); } catch (_) { /* no message file */ }
  watchExternalCommit(t);
  vscode.window.showInformationMessage(
    `#${t.no} 커밋 준비 완료. TortoiseSVN 커밋 창에는 이 작업 파일 ${r.files.length}개만 changelist "${t.changelist}" 로 묶여 있습니다. 커밋 메시지는 클립보드에 있습니다.` +
    (r.setAside ? ` 다른 로컬 변경 ${r.setAside}개는 커밋이 끝나면 돌아옵니다.` : ''),
    '커밋 취소').then((a) => { if (a) vscode.commands.executeCommand('svnwt.cancelCommit', t.id); });
  return undefined;
}

async function afterCommit(t, res, output) {
  if (res && res.kept && res.kept.length) {
    vscode.window.showWarningMessage(`커밋 전에 빼 두었던 변경 중 ${res.kept.length}개는 커밋된 내용과 겹쳐 되돌리지 않았습니다: ${res.kept.map((k) => k.path).join(', ')}`, '보관본 열기')
      .then((a) => { if (a && res.stash) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.stash)); });
  }
  refreshAll();
  if (res && res.committed) offerUnblocked(t);
  if (res && res.committed) {
    const m = /Committed revision (\d+)/i.exec(output || '') || /revision (\d+)/i.exec(output || '');
    const left = (res.leftovers || []).length;
    if (left) {
      const a = await vscode.window.showInformationMessage(`#${t.no} "${t.title}" SVN 커밋 완료${m ? ` (r${m[1]})` : ''}. 커밋에서 빠진 변경 ${left}개가 changelist 에 남아 있습니다.`, '남은 변경 버리기', '나중에');
      if (a === '남은 변경 버리기') vscode.commands.executeCommand('svnwt.discardLeftovers', t.id);
      return;
    }
    // what else is still modified in the scope folder (set-aside edits put back, other changelists)
    const rest = await service.scopeChanges(service.resolveTask(t.id).scope.id).then((x) => x.changes.filter((c) => !c.locked && c.item !== 'unversioned').length).catch(() => 0);
    const a = await vscode.window.showInformationMessage(
      `#${t.no} "${t.title}" SVN 커밋 완료${m ? ` (r${m[1]})` : ''}.${rest ? ` scope 폴더에 다른 SVN 변경 ${rest}개가 남아 있습니다.` : ''} 작업을 보관할까요? (커밋 기록은 남습니다)`,
      ...(rest ? ['남은 SVN 변경 정리…'] : []), '보관', '나중에');
    if (a === '보관') vscode.commands.executeCommand('svnwt.removeTask', t.id);
    if (a === '남은 SVN 변경 정리…') vscode.commands.executeCommand('svnwt.discardScopeChanges', t.id);
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

const ctxApi = {
  get service() { return service; },
  openTaskFile,
  isAgentRunning: (id) => !!(agent && agent.runner.isRunning(id)),
};

// ------------------------------------------------------------------ agent extras
/** Stage 3 needs the proposed chat sessions API: turn it on in argv.json (backup kept). */
function registerAgentCommands(ctx) {
  ctx.subscriptions.push(vscode.commands.registerCommand('svnwt.locks', async () => {
    const locks = service.locks();
    const snaps = service.listScopes().filter((s) => s.lastSnapshot)
      .map((s) => `${s.id}: 마지막 SVN 기준 읽기 ${Math.round(s.lastSnapshot.totalMs / 1000)}초 (파일 ${s.lastSnapshot.files}개, svn status ${Math.round((s.lastSnapshot.svnStatusMs || 0) / 1000)}초, 해시 ${Math.round((s.lastSnapshot.hashFilesMs || 0) / 1000)}초)`);
    if (!locks.length) {
      vscode.window.showInformationMessage(`걸려 있는 잠금이 없습니다.${snaps.length ? '\n' + snaps.join('\n') : ''}`);
      return;
    }
    const pick = await vscode.window.showQuickPick(locks.map((l) => ({
      label: `${l.stale ? '$(warning) 남은 잠금' : '$(sync~spin) 진행 중'} · ${l.op}`,
      description: `${l.scope || '전체'} · ${store.fmtDuration(l.since)}째 · pid ${l.pid || '?'}${l.alive === false ? ' (종료됨)' : ''}`,
      detail: l.lockDir, l,
    })), { placeHolder: '해제할 잠금 선택 (남은 잠금은 바로 해제, 진행 중인 작업은 확인 후 강제 해제)' });
    if (!pick) return;
    let force = false;
    if (!pick.l.stale) {
      const a = await vscode.window.showWarningMessage(`"${pick.l.op}" 이(가) 아직 진행 중입니다 (pid ${pick.l.pid}). 강제로 해제하면 동시에 실행되어 결과가 꼬일 수 있습니다.`, { modal: true }, '강제 해제');
      if (a !== '강제 해제') return;
      force = true;
    }
    const r = service.releaseLock(pick.l.lockDir, { force });
    vscode.window.showInformationMessage(r.released ? '잠금을 해제했습니다.' : r.reason);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('svnwt.agent.enableChatSessions', async () => {
    const argv = path.join(os.homedir(), '.vscode', 'argv.json');
    const id = ctx.extension.id;
    const ok = await vscode.window.showWarningMessage('Chat 세션 목록에 svnwt 작업을 표시합니다 (실험 기능).', {
      modal: true,
      detail: `VS Code 제안 API(chatSessionsProvider)를 이 확장에 허용하도록 ${argv} 에 "enable-proposed-api": ["${id}"] 를 추가하고, 설정 svnwt.agent.chatSessions 를 켭니다. 기존 파일은 argv.json.svnwt-backup 으로 보관합니다. 적용하려면 VS Code 를 완전히 종료 후 다시 시작해야 합니다. VS Code 버전에 따라 동작하지 않을 수 있습니다.`,
    }, '켜기');
    if (ok !== '켜기') return;
    let text = fs.existsSync(argv) ? fs.readFileSync(argv, 'utf8') : '{\n}\n';
    if (fs.existsSync(argv)) fs.copyFileSync(argv, argv + '.svnwt-backup');
    if (!text.includes(`"${id}"`)) {
      const m = /"enable-proposed-api"\s*:\s*\[/.exec(text);
      if (m) {
        const at = m.index + m[0].length;
        const empty = /^\s*\]/.test(text.slice(at));
        text = text.slice(0, at) + `"${id}"` + (empty ? '' : ', ') + text.slice(at);
      } else {
        const end = text.lastIndexOf('}');
        if (end < 0) throw new Error(`${argv} 형식을 알 수 없습니다.`);
        const body = text.slice(0, end).replace(/\s+$/, '');
        const needsComma = /[^{,\s]$/.test(body.replace(/\/\/[^\n]*$/gm, '').replace(/\s+$/, ''));
        text = `${body}${needsComma ? ',' : ''}\n\t"enable-proposed-api": ["${id}"]\n}\n`;
      }
      fs.mkdirSync(path.dirname(argv), { recursive: true });
      fs.writeFileSync(argv, text, 'utf8');
    }
    await vscode.workspace.getConfiguration('svnwt').update('agent.chatSessions', true, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('적용하려면 VS Code 를 모두 닫고 다시 실행하세요.', '파일 열기').then((a) => { if (a) vscode.window.showTextDocument(vscode.Uri.file(argv)); });
  }));
}

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

// ------------------------------------------------------------------ rules
let knownRules = null;
/** Rewrite the Copilot rules file and tell the user about rules an agent just added. */
function syncRules(ctx) {
  let list = [];
  try { list = service.listRules(); } catch (e) { log(`rules: ${e.message}`); return; }
  const r = setup.installRules(ctx);
  if (r.changed) log(`규칙 지침 파일 갱신 (${list.length}개): ${r.file}`);
  if (r.error) log(`규칙 지침 파일 쓰기 실패: ${r.error}`);
  const ids = new Set(list.map((x) => x.id));
  if (knownRules) {
    const added = list.filter((x) => !knownRules.has(x.id) && x.by !== 'user');
    for (const x of added) {
      log(`새 규칙 (${x.by}${x.taskNo ? `, #${x.taskNo}` : ''}): ${x.text}`);
      vscode.window.showInformationMessage(`새 규칙 저장됨${x.taskNo ? ` (#${x.taskNo})` : ''}: ${x.text}`, '규칙 보기').then((a) => {
        if (a) vscode.commands.executeCommand('svnwt.tasks.focus');
      });
    }
  }
  knownRules = ids;
  if (tree) tree.refresh();
}

// ------------------------------------------------------------------ activation
function watchEvents(ctx) {
  let timer = null;
  let lastMtime = 0;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      refreshAll();
      syncRules(ctx);
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

  // SVN is not checked automatically: "SVN 상태 확인" (svnwt.checkSvn) does it on request.
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

/** Settings written by older versions -> current names (upgrade without user action). */
async function migrateSettings() {
  const cfg = vscode.workspace.getConfiguration('svnwt');
  const i = cfg.inspect('commitTool') || {};
  // user settings only: workspace settings may live inside the SVN working copy (.vscode/settings.json)
  // and must not be modified; the old value there is still understood by the code.
  const targets = [['globalValue', vscode.ConfigurationTarget.Global]];
  for (const [k, target] of targets) {
    if (i[k] === 'external') {
      try { await cfg.update('commitTool', 'prepare', target); log(`설정 svnwt.commitTool: external -> prepare (${k})`); } catch (e) { log(`설정 변환 실패: ${e.message}`); }
    }
  }
}

async function activate(ctx) {
  extCtx = ctx;
  output = vscode.window.createOutputChannel('SVN Worktree');
  ctx.subscriptions.push(output);
  setup.applyToolEnv();
  migrateSettings().catch((e) => log(`migrate: ${e.message}`));
  service = new Service();
  service.onLog = log;
  proc.setLogger(log);

  tree = new TaskTree(service);
  tree.instructionFiles = () => {
    const roots = (vscode.workspace.workspaceFolders || []).filter((f) => !/^\[svnwt\]/.test(f.name)).map((f) => ({ path: f.uri.fsPath, label: `작업 영역 ${f.name}` }));
    const worktrees = [];
    for (const s of service.listScopes()) {
      roots.push({ path: s.svnPath, label: `SVN ${s.id}` });
      if (s.wcRoot && s.wcRoot !== s.svnPath) roots.push({ path: s.wcRoot, label: `SVN ${path.basename(s.wcRoot)}` });
      for (const t of service.listTasks({ scope: s.id }).filter((x) => x.status === 'active')) worktrees.push({ path: t.workPath, svnPath: s.svnPath, label: `#${t.no}` });
    }
    return setup.instructionFiles(ctx, { roots, worktrees });
  };
  syncRules(ctx);
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
        try {
          const t = service.resolveTask(m.task).task;
          if (m.kind === 'stash' && m.phase !== 'ready') {
            // VS Code stopped in the middle of "커밋 준비": put everything back
            const r = await service.endCommit(t.id);
            vscode.window.showInformationMessage(`SVN Worktree: 중간에 멈춘 #${t.no} 커밋 준비를 되돌렸습니다 (빼 두었던 변경 ${r.restored}개 복구).${r.kept && r.kept.length ? ` 되돌리지 못한 파일은 보관본에 있습니다: ${r.stash}` : ''}`);
          } else watchExternalCommit(t);
        } catch (e) { log(`resume commit: ${e.message}`); }
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
    for (const a of setup.installAgents(ctx)) {
      if (a.changed) log(`커스텀 에이전트 설치: ${a.file}`);
      if (a.error) log(`커스텀 에이전트 설치 실패: ${a.error}`);
    }
  }

  // svnwt agent: background runs, @svnwt chat participant, optional chat sessions list
  const agentReady = setupAgent(ctx, {
    service, log, refreshAll,
    addToWorkspace: (t) => (workspaceHas(t.workPath) >= 0 ? false : addToWorkspace(t)),
    pickTask,
    pickScopeFor: async () => {
      const scopes = service.listScopes();
      if (!scopes.length) return null;
      try { return await pickScope(); } catch (_) { return null; }
    },
    openReview: (id) => ReviewPanel.show(ctxApi, id),
  }).then((a) => { agent = a; return a; }, (e) => { log(`agent: ${e && e.stack}`); return null; });
  registerAgentCommands(ctx);

  log(`활성화됨 (MCP: ${path.join(ctx.extensionPath, 'src', 'mcp', 'server.js')})`);
  return { service, tree, mcpRegistered, agentReady };
}

function deactivate() {}

module.exports = { activate, deactivate };
