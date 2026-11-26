'use strict';
/**
 * 로컬 반영: put one task (pinned to a commit) on the SVN working copy with everything else set aside, build it,
 * look at it on the local site, then 커밋 준비 (changelist) or 되돌리기. Agents ask for the same through a queue
 * (svnwt_test_request); the user is asked before their request is applied (예 / 아니요 / 항상).
 *
 * While a task is applied: status bar item, commit detection (the user may commit straight from TortoiseSVN),
 * a warning when a working copy file is saved.
 */
const path = require('path');

function createLocalApply({ vscode, service, refreshAll, log, output, withCancel, withSteps, afterCommit, startCommitWatch, explainBlocked, openChat }) {
  let item = null;
  let timer = null;
  let busy = false;
  let lastCommitCheck = 0;
  let savedWarned = null;
  const asking = new Set();

  const cfg = () => vscode.workspace.getConfiguration('svnwt');
  const states = () => {
    const out = [];
    for (const s of service.listScopes()) { try { const st = service.testState(s.id); if (st) out.push(st); } catch (_) { /* scope gone */ } }
    return out;
  };
  const stateOf = (t) => { try { return service.testState(t.scopeId); } catch (_) { return null; } };
  const short = (sha) => (sha ? sha.slice(0, 8) : '');
  const buildOut = (line) => output.appendLine(`  │ ${line}`);

  /** Build command not chosen yet for the scope: ask once (empty answer = no build). */
  async function ensureBuildChoice() { return true; } // the build is detected (MSBuild + .sln) or worked out by an agent
  async function askBuildChoiceUnused(t) {
    const scope = service.resolveScope(t.scopeId);
    if (typeof scope.localBuild === 'string') return true;
    const a = await vscode.window.showInformationMessage(
      `로컬에 반영한 뒤 빌드할 명령을 정할까요? (scope ${scope.id}, 처음 한 번만 묻습니다)`,
      { modal: true, detail: '예: dotnet build Web\\Web.csproj\n또는 msbuild 경로가 들어 있는 build-local.cmd\nscope 폴더에서 cmd.exe 로 실행합니다. 나중에 명령 "로컬 반영 빌드 명령 설정…" 으로 바꿀 수 있습니다.' },
      '빌드 명령 설정…', '빌드 없이 반영');
    if (!a) return false;
    if (a === '빌드 없이 반영') { service.setLocalBuild(scope.id, ''); return true; }
    return setBuild(scope.id);
  }

  async function setBuild(scopeId) {
    const scope = service.resolveScope(scopeId || (await pickScopeId()));
    const v = await vscode.window.showInputBox({
      title: `로컬 반영 후 빌드 명령 (${scope.id})`,
      prompt: `${scope.svnPath} 에서 cmd.exe 로 실행합니다. 비우면 빌드하지 않습니다.`,
      value: scope.localBuild || '',
      placeHolder: 'dotnet build Web\\Web.csproj',
    });
    if (v === undefined) return false;
    service.setLocalBuild(scope.id, v);
    vscode.window.setStatusBarMessage(v.trim() ? `로컬 반영 빌드 명령: ${v.trim()}` : '로컬 반영 후 빌드하지 않습니다', 5000);
    return true;
  }

  async function pickScopeId() {
    const list = service.listScopes();
    if (list.length === 1) return list[0].id;
    const p = await vscode.window.showQuickPick(list.map((s) => ({ label: s.id, description: s.svnPath })), { title: 'scope 선택' });
    if (!p) throw new Error('scope 를 고르지 않았습니다.');
    return p.label;
  }

  /** Another task holds the working copy: offer to take it back out first. */
  async function freeFor(t, st, what) {
    if (!st || st.task === t.id) return true;
    const a = await vscode.window.showWarningMessage(`#${st.no} "${st.title}" 이(가) 로컬에 반영돼 있습니다. 되돌리고 #${t.no} 을(를) ${what}할까요?`, { modal: true }, `#${st.no} 되돌리고 ${what}`);
    if (!a) return false;
    const r = await endLocal(service.resolveTask(st.task).task, { quiet: true });
    return !!r;
  }

  function showBuild(b) {
    if (!b) return '';
    if (b.missing) return `, 빌드 못 함: ${b.missing}`;
    return b.ok ? `, 빌드 성공 (${(b.ms / 1000).toFixed(0)}초)` : `, 빌드 실패 (exit ${b.code})`;
  }

  /** The agent works out how to build the working copy, saves it (svnwt_local_build_set) and builds. */
  function agentBuild(t, b) {
    const scope = service.resolveScope(t.scopeId);
    const why = b && b.missing ? b.missing : b ? `빌드 실패 (exit ${b.code}), 로그: ${b.logFile}` : '';
    return openChat(`svnwt scope ${scope.id} 의 SVN working copy (${scope.svnPath}) 를 빌드하는 방법을 찾아줘. 지금 상태: ${why}. ` +
      'Visual Studio MSBuild 위치(vswhere)와 빌드할 .sln 을 찾고, svnwt_local_build_set 으로 명령을 저장한 뒤 svnwt_local_build_run 으로 빌드해서 결과를 알려줘. ' +
      '빌드 오류가 코드 문제면 working copy 를 고치지 말고 어떤 작업(worktree)에서 고쳐야 하는지 알려줘.', true);
  }

  /** "이 작업을 로컬에 반영" (the user's own: not asked again). Already applied at an older commit: re-apply. */
  async function applyLocal(t) {
    if (!t) return undefined;
    const pending = service.pendingCommits().find((m) => m.kind === 'stash' && service.resolveTask(m.task).task.scopeId === t.scopeId);
    if (pending) { vscode.window.showWarningMessage(`#${service.resolveTask(pending.task).task.no} 의 커밋 준비가 진행 중입니다. 커밋하거나 커밋 취소한 뒤 반영하세요.`); return undefined; }
    const st = stateOf(t);
    if (st && st.task === t.id) {
      const info = await service.taskInfo(t.id, { checkSvn: false });
      if (info.tip === st.sha) {
        const a = await vscode.window.showInformationMessage(`#${t.no} 은(는) 이미 로컬에 반영돼 있습니다 (${short(st.sha)}).`, '다시 빌드', '되돌리기');
        if (a === '다시 빌드') return rebuild(t);
        if (a === '되돌리기') return endLocal(t);
        return undefined;
      }
      if (!(await endLocal(t, { quiet: true }))) return undefined;
    } else if (!(await freeFor(t, st, '반영'))) return undefined;
    if (!(await ensureBuildChoice(t))) return undefined;
    const scope = service.resolveScope(t.scopeId);
    if (scope.localBuild !== '') { output.show(true); output.appendLine(`── #${t.no} 로컬 반영 후 빌드${scope.localBuild ? `: ${scope.localBuild}` : ' (MSBuild·.sln 자동 찾기)'}`); }
    let r;
    try {
      const q = await service.testRequest(t.id, { by: 'user' });
      r = await withCancel(`#${t.no} 로컬에 반영하는 중…`, (token) => service.testApplyItem(q.id, { token, onOutput: buildOut })).finally(refreshAll);
    } catch (e) {
      if (e.cancelled) { vscode.window.showInformationMessage(e.message); return undefined; }
      output.show(true);
      throw e;
    }
    if (!r.ok) return explainBlocked(t, r, { what: '로컬 반영' });
    reportApplied(t, r).catch((e) => log(`로컬 반영 알림: ${e.message}`)); // buttons answered later: do not hold the command
    return undefined;
  }

  async function reportApplied(t, r, { byAgent = false } = {}) {
    const msg = `#${t.no} 을(를) 로컬에 반영했습니다 (파일 ${r.files.length}개${r.setAside ? `, 빼 둔 변경 ${r.setAside}개` : ''}${showBuild(r.build)}).` +
      (byAgent ? ' 에이전트가 테스트를 끝내면 되돌립니다.' : ' 확인한 뒤 커밋 준비하거나 되돌리세요.');
    const buttons = byAgent ? ['지금 되돌리기'] : ['커밋 준비', '되돌리기'];
    if (r.build && !r.build.ok) buttons.unshift('에이전트에게 빌드 맡기기');
    if (r.build && !r.build.ok && r.build.logFile) buttons.unshift('빌드 로그');
    const a = await (r.build && !r.build.ok ? vscode.window.showWarningMessage(msg, ...buttons) : vscode.window.showInformationMessage(msg, ...buttons));
    if (a === '빌드 로그') return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(r.build.logFile));
    if (a === '에이전트에게 빌드 맡기기') return agentBuild(t, r.build);
    if (a === '커밋 준비') return prepare(t);
    if (a === '되돌리기' || a === '지금 되돌리기') return endLocal(t);
    return undefined;
  }

  async function rebuild(t) {
    const st = t ? stateOf(t) : states()[0];
    if (!st) { vscode.window.showInformationMessage('로컬에 반영된 작업이 없습니다.'); return undefined; }
    const sc = service.resolveScope(st.scope);
    if (sc.localBuild === '') service.setLocalBuild(sc.id, null); // asked to build: detect again
    output.show(true);
    output.appendLine(`── #${st.no} 다시 빌드${sc.localBuild ? `: ${sc.localBuild}` : ''}`);
    const b = await withCancel(`#${st.no} 빌드 중…`, (token) => service.runLocalBuild(sc.id, { token, onOutput: buildOut }));
    const a = await (b.ok ? vscode.window.showInformationMessage(`#${st.no} 빌드 성공 (${(b.ms / 1000).toFixed(0)}초)`)
      : vscode.window.showWarningMessage(`#${st.no} ${b.missing ? `빌드 못 함: ${b.missing}` : `빌드 실패 (exit ${b.code})`}`, ...(b.logFile ? ['빌드 로그'] : []), '에이전트에게 빌드 맡기기'));
    if (a === '빌드 로그') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(b.logFile));
    if (a === '에이전트에게 빌드 맡기기') agentBuild(service.resolveTask(st.task).task, b);
    return undefined;
  }

  /** Take the applied task back out; everything set aside comes back. @returns the restore result (null: nothing done) */
  async function endLocal(t, { quiet = false } = {}) {
    const st = t ? stateOf(t) : states()[0];
    if (!st) { if (!quiet) vscode.window.showInformationMessage('로컬에 반영된 작업이 없습니다.'); refreshAll(); return null; }
    if (t && st.task !== t.id) { vscode.window.showInformationMessage(`#${t.no} 은(는) 로컬에 반영돼 있지 않습니다 (반영된 작업: #${st.no}).`); return null; }
    const task = service.resolveTask(st.task).task;
    if (!st.ready) {
      vscode.window.showInformationMessage(`#${task.no} ${st.building ? '빌드 중' : '로컬에 반영하는 중'}입니다. 진행 알림에서 취소하거나 끝난 뒤 되돌리세요.`);
      return null;
    }
    let res;
    if (st.item) res = await withSteps(`#${task.no} 로컬 반영을 되돌리는 중…`, false, () => service.testRelease(st.item, { by: 'user', summary: '사용자가 되돌림' }).then((x) => x.restore || x));
    else res = await withSteps(`#${task.no} 로컬 반영을 되돌리는 중…`, false, () => service.endTest(task.id));
    refreshAll();
    if (res && res.committed) { await afterCommit(task, res, ''); return res; }
    report(task, res, quiet);
    return res || {};
  }

  function report(task, res, quiet) {
    if (!res) return;
    const edited = res.edited || [];
    const kept = res.kept || [];
    if (edited.length || kept.length) {
      const parts = [];
      if (edited.length) parts.push(`반영 중에 고친 작업 파일 ${edited.length}개(${edited.map((e) => e.path).join(', ')})는 보관본에 복사하고 되돌렸습니다`);
      if (kept.length) parts.push(`빼 두었던 변경 ${kept.length}개(${kept.map((k) => k.path).join(', ')})는 되돌리지 못해 보관본에 있습니다`);
      vscode.window.showWarningMessage(`#${task.no}: ${parts.join('. ')}.`, '보관본 열기')
        .then((a) => { if (a && res.stash) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.stash)); });
    } else if (!quiet) {
      vscode.window.setStatusBarMessage(`#${task.no} 로컬 반영을 되돌렸습니다${res.restored ? ` (빼 둔 변경 ${res.restored}개 복구)` : ''}`, 6000);
    }
    if (res.errors && res.errors.length) log(`#${task.no} 되돌리기 중 오류:\n${res.errors.join('\n')}`);
  }

  /** 커밋 준비 of the applied task: add the changelist, watch the commit. */
  async function prepare(t) {
    const r = await withSteps(`#${t.no} 커밋 준비 중…`, false, () => service.prepareFromLocal(t.id)).finally(refreshAll);
    if (r.committed) return checkCommitted(true);
    try { await vscode.env.clipboard.writeText(require('fs').readFileSync(r.messageFile, 'utf8').trim()); } catch (_) { /* no message file */ }
    startCommitWatch(t);
    vscode.window.showInformationMessage(
      `#${t.no} 커밋 준비 완료. TortoiseSVN 커밋 창에는 이 작업 파일 ${r.files.length}개만 changelist "${service.resolveTask(t.id).task.changelist}" 로 묶여 있습니다. 커밋 메시지는 클립보드에 있습니다.` +
      (r.setAside ? ` 다른 로컬 변경 ${r.setAside}개는 커밋이 끝나면 돌아옵니다.` : ''),
      '커밋 취소').then((a) => { if (a) vscode.commands.executeCommand('svnwt.cancelCommit', t.id); });
    return undefined;
  }

  /** Committed straight from TortoiseSVN while applied: clean up like after a commit. */
  async function checkCommitted(force = false) {
    if (!force && Date.now() - lastCommitCheck < 5000) return;
    lastCommitCheck = Date.now();
    for (const st of states().filter((x) => x.phase === 'ready')) {
      let done = false;
      try { done = await service.commitDone(st.task); } catch (e) { log(`로컬 반영 커밋 확인: ${e.message}`); }
      if (!done) continue;
      const task = service.resolveTask(st.task).task;
      log(`#${task.no}: 로컬 반영 중에 SVN 커밋됨 → 정리`);
      const res = await withSteps(`#${task.no} 커밋됨: 정리하는 중…`, false, () => service.endCommit(task.id));
      refreshAll();
      await afterCommit(task, res, '');
    }
  }

  /** Agent requests: ask the user (예 / 아니요 / 항상) and apply. */
  async function pump() {
    for (const s of service.listScopes()) {
      let it = null;
      try { it = await service.testClaimNext(s.id); } catch (e) { log(`테스트 큐 (${s.id}): ${e.message}`); }
      if (!it || asking.has(it.id)) continue;
      asking.add(it.id);
      ask(it).catch((e) => { log(`테스트 요청 ${it.id}: ${e.message}`); output.show(true); }).finally(() => { asking.delete(it.id); refreshAll(); });
    }
  }

  async function ask(it) {
    const mode = cfg().get('localApply.agentRequests') || 'ask';
    let a = mode === 'always' ? '예' : mode === 'never' ? '아니요' : null;
    if (!a) {
      a = await vscode.window.showInformationMessage(
        `에이전트가 #${it.no} "${it.title}" 을(를) 로컬에 반영해 테스트하려고 합니다 (커밋 ${short(it.sha)}${it.writes ? ', DB 에 쓰는 테스트' : ''}${it.note ? `: ${it.note}` : ''}). 반영할까요? 다른 로컬 변경은 잠시 빼 두었다가 테스트가 끝나면 되돌립니다.`,
        '예', '아니요', '항상');
    }
    if (a === '항상') {
      await cfg().update('localApply.agentRequests', 'always', vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage('에이전트의 로컬 반영 요청을 묻지 않고 반영합니다 (설정 svnwt.localApply.agentRequests)', 8000);
    }
    if (a !== '예' && a !== '항상') { await service.testReject(it.id, a === '아니요' ? '사용자가 거절했습니다.' : '사용자가 답하지 않고 닫았습니다.'); return; }
    const t = service.resolveTask(it.task).task;
    if (service.testState(t.scopeId) || service.pendingCommits().some((m) => service.resolveTask(m.task).task.scopeId === t.scopeId)) {
      await service._testUpdate(it.id, { status: 'queued' }); // the working copy got busy while asking: wait again
      return;
    }
    const scope = service.resolveScope(t.scopeId);
    if (scope.localBuild) output.appendLine(`── #${t.no} 로컬 반영 (에이전트 테스트) 후 빌드: ${scope.localBuild}`);
    const r = await withCancel(`#${t.no} 로컬에 반영하는 중 (에이전트 테스트)…`, (token) => service.testApplyItem(it.id, { token, onOutput: buildOut }));
    refreshAll();
    if (!r.ok) { vscode.window.showWarningMessage(`#${t.no}: 로컬에 반영하지 못했습니다. 에이전트에게 이유를 전달했습니다. ${(r.blocked || []).map((b) => b.path).join(', ')}`); return; }
    reportApplied(t, r, { byAgent: true }).catch((e) => log(`로컬 반영 알림: ${e.message}`));
  }

  function updateItem() {
    const list = states();
    if (!list.length) { if (item) item.hide(); return; }
    const st = list[0];
    if (!item) item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    item.text = st.ready ? `$(beaker) #${st.no} 로컬 반영됨${st.by === 'agent' ? ' (에이전트 테스트)' : ''}`
      : `$(sync~spin) #${st.no} ${st.building ? '빌드 중' : '로컬에 반영하는 중'}`;
    item.tooltip = `"${st.title}" (커밋 ${short(st.sha)}) 이 SVN working copy 에 올라가 있습니다.\n${st.svnPath}\n클릭: 커밋 준비 / 다시 빌드 / 되돌리기`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.command = 'svnwt.localApplyMenu';
    item.show();
  }

  async function menu() {
    const st = states()[0];
    if (!st) { vscode.window.showInformationMessage('로컬에 반영된 작업이 없습니다.'); return undefined; }
    const t = service.resolveTask(st.task).task;
    if (!st.ready) { vscode.window.showInformationMessage(`#${t.no} ${st.building ? '빌드 중' : '로컬에 반영하는 중'}입니다. 끝난 뒤 다시 누르세요.`); return undefined; }
    const p = await vscode.window.showQuickPick([
      { label: '$(check) 커밋 준비', v: 'prepare', description: 'changelist 만들기' },
      { label: '$(tools) 다시 빌드', v: 'build' },
      { label: '$(discard) 되돌리기', v: 'end', description: '빼 둔 다른 변경을 되돌려 놓음' },
      { label: '$(preview) 리뷰 열기', v: 'review' },
    ], { title: `#${t.no} ${t.title} — 로컬 반영됨 (${short(st.sha)})` });
    if (!p) return undefined;
    if (p.v === 'prepare') return prepare(t);
    if (p.v === 'build') return rebuild(t);
    if (p.v === 'end') return endLocal(t);
    return vscode.commands.executeCommand('svnwt.openReview', t.id);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      updateItem();
      await checkCommitted();
      await pump();
    } catch (e) { log(`로컬 반영 확인: ${e.message}`); } finally { busy = false; }
  }

  function start(ctx) {
    timer = setInterval(tick, 4000);
    ctx.subscriptions.push({ dispose: () => { clearInterval(timer); if (item) item.dispose(); } });
    ctx.subscriptions.push(vscode.window.onDidChangeWindowState((w) => { if (w.focused) { lastCommitCheck = 0; tick(); } }));
    ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      for (const st of states()) {
        const inside = doc.uri.fsPath.toLowerCase().startsWith(st.svnPath.toLowerCase() + path.sep);
        if (!inside || savedWarned === st.at) continue;
        savedWarned = st.at;
        vscode.window.showWarningMessage(`#${st.no} 이(가) 로컬에 반영된 상태에서 SVN working copy 파일을 저장했습니다. 되돌릴 때 이 작업 파일의 수정은 보관본으로 옮기고, 다른 파일의 수정은 그대로 둡니다. 작업 수정은 worktree 에서 하세요.`);
      }
    }));
    service.testResetAsking().catch((e) => log(`테스트 큐: ${e.message}`)).finally(tick);
  }

  return { start, tick, applyLocal, endLocal, rebuild, prepare, setBuild, menu, stateOf };
}

module.exports = { createLocalApply };
