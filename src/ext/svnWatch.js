'use strict';
/**
 * Background SVN checks, so nobody has to look for "SVN 기준 다시 읽기" / "rebase" by hand:
 * - working copy (every minute and when the VS Code window gets the focus again): `svn info` of each scope
 *   folder only. When the revision moved (the user ran svn update in TortoiseSVN), the SVN base is read again
 *   silently, and if active tasks are now on an older base the user is asked once whether to rebase them.
 * - server (every svnwt.svnServerCheckMinutes): commits that touch the scope folder and are not in the working
 *   copy yet (the user's own commits do not count). The user is asked once per new revision whether to run
 *   svn update (then the working copy check above follows).
 * Nothing is shown while there is nothing to ask. A scope is skipped while a commit is prepared in it or
 * another svnwt operation holds its lock. Failures (server not reachable, svn busy) are only logged.
 */
const fs = require('fs');
const path = require('path');
const store = require('../core/store');

function createSvnWatch({ vscode, service, refreshAll, log }) {
  const cfg = () => vscode.workspace.getConfiguration('svnwt');
  const enabled = () => cfg().get('svnWatch', true) !== false;
  const serverMinutes = () => Math.max(0, Number(cfg().get('svnServerCheckMinutes', 10)) || 0);

  let busy = false;
  let lastLocal = 0;
  let lastServer = 0;
  const askedBase = new Map(); // scope id -> base commit we asked about (ask once per new base)
  const askedServer = new Map(); // scope id -> newest server revision we asked about
  const timers = [];
  const wcDbSeen = new Map(); // wc root -> wc.db mtime at the last commit check

  const scopes = () => { try { return service.listScopes().map((s) => service.resolveScope(s.id)); } catch (_) { return []; } };
  const scopeBusy = (scope) => {
    try { if (service._commitMarker(scope)) return true; } catch (_) { /* none */ }
    const l = store.lockInfo(path.join(scope.home, 'lock'));
    return !!(l && !l.stale);
  };
  const quiet = (msg) => vscode.window.setStatusBarMessage(msg, 5000);

  /** Rebase the given tasks one after another; a conflict is undone at once and reported (nothing left half done). */
  async function rebaseTasks(scope, list) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    const done = [];
    const conflicted = [];
    const failed = [];
    try {
      for (const t of list) {
        item.text = `$(sync~spin) #${t.no} rebase…`;
        item.show();
        try {
          const r = await service.syncTask(t.id, { refresh: false });
          if (r.ok) done.push(t);
          else {
            conflicted.push(Object.assign({ files: r.conflicts || [] }, t));
            try { await service.syncTask(t.id, { abort: true }); } catch (e) { log(`rebase abort #${t.no}: ${e.message}`); }
          }
        } catch (e) { failed.push(Object.assign({ error: e.message }, t)); }
      }
    } finally { item.dispose(); refreshAll(); }
    const rev = service.resolveScope(scope.id).revision;
    if (done.length) quiet(`$(check) r${rev} 기준으로 rebase: ${done.map((t) => `#${t.no}`).join(', ')}`);
    for (const f of failed) vscode.window.showWarningMessage(`#${f.no} rebase 실패: ${f.error}`);
    if (conflicted.length) {
      const c = conflicted[0];
      const a = await vscode.window.showWarningMessage(
        `${conflicted.map((t) => `#${t.no} "${t.title}"`).join(', ')}: SVN 에 새로 들어온 내용과 같은 줄을 고쳐서 rebase 하지 않았습니다 (작업은 그대로). 충돌 파일: ${[...new Set(conflicted.flatMap((t) => t.files))].slice(0, 5).join(', ')}`,
        conflicted.length === 1 ? '충돌 해결하기' : `#${c.no} 충돌 해결하기`, '리뷰 열기');
      if (a === '리뷰 열기') vscode.commands.executeCommand('svnwt.openReview', c.id);
      else if (a) vscode.commands.executeCommand('svnwt.syncTask', c.id);
    }
  }

  /** After the SVN base of a scope moved: ask once whether to rebase the active tasks on the old base. */
  async function offerRebase(scope, fromRev, { always = false } = {}) {
    const list = await service.tasksBehind(scope.id);
    if (!list.length) return false;
    const base = service.resolveScope(scope.id);
    if (!always && askedBase.get(scope.id) === base.baseCommit) return false;
    askedBase.set(scope.id, base.baseCommit);
    const ready = list.filter((t) => !t.blocked);
    const later = list.filter((t) => t.blocked);
    const names = (l) => l.slice(0, 4).map((t) => `#${t.no} "${t.title}"`).join(', ') + (l.length > 4 ? ` 외 ${l.length - 4}개` : '');
    const moved = fromRev && fromRev !== base.revision ? `r${fromRev} → r${base.revision}` : `r${base.revision}`;
    if (!ready.length) {
      quiet(`SVN 기준 ${moved}: ${names(later)} 는 나중에 rebase (${later[0].blocked})`);
      return false;
    }
    const a = await vscode.window.showInformationMessage(
      `${scope.name || scope.id}: SVN 이 ${moved} 로 갱신됐습니다. 진행 중인 작업 ${names(ready)} 를 새 기준으로 rebase 할까요?` +
        (later.length ? ` (${names(later)} 는 ${later.map((t) => t.blocked).filter((x, i, s) => s.indexOf(x) === i).join('/')}이라 제외)` : ''),
      'rebase', '나중에');
    if (a !== 'rebase') return false;
    await rebaseTasks(scope, ready);
    return true;
  }

  /** Tasks with a changelist in the working copy (not prepared): committed by hand? Only when svn wrote to wc.db. */
  async function checkLanded(scope, { verbose = false } = {}) {
    const landed = service.listTasks({ scope: scope.id }).filter((t) => t.status === 'landed');
    if (!landed.length) return;
    let m = 0;
    try { m = fs.statSync(path.join(scope.wcRoot || scope.svnPath, '.svn', 'wc.db')).mtimeMs; } catch (_) { /* not found */ }
    const k = scope.wcRoot || scope.svnPath;
    if (!verbose && wcDbSeen.get(k) === m) return;
    wcDbSeen.set(k, m);
    for (const t of landed) {
      const r = await service.checkSvnState(t.id);
      for (const c of r.changed) {
        refreshAll();
        if (c.to === 'committed') {
          vscode.window.showInformationMessage(`#${c.no} "${c.title}" 이 SVN 에 커밋된 것을 확인했습니다.`, '리뷰 열기')
            .then((a) => { if (a) vscode.commands.executeCommand('svnwt.openReview', c.id); });
        }
      }
    }
  }

  /** Working copy check of one scope: re-read the SVN base when the revision moved. */
  async function checkLocal(scope, { verbose = false } = {}) {
    try { await checkLanded(scope, { verbose }); } catch (e) { log(`svnWatch 커밋 확인 ${scope.id}: ${e.message}`); }
    const r = await service.wcRevision(scope.id);
    if (!r.changed) return verbose ? offerRebase(scope, null, { always: true }) : false;
    log(`svnWatch: ${scope.id} working copy r${r.base} → r${r.revision}, SVN 기준 다시 읽기`);
    await service.refreshScope(scope.id);
    refreshAll();
    await offerRebase(scope, r.base, { always: verbose });
    return true;
  }

  /** Server check of one scope: ask once per new revision whether to run svn update. */
  async function checkServer(scope, { verbose = false } = {}) {
    const r = await service.serverCommits(scope.id);
    if (!r.pending.length) return false;
    const newest = r.pending[r.pending.length - 1].revision;
    if (!verbose && askedServer.get(scope.id) >= newest) return false;
    askedServer.set(scope.id, newest);
    const first = r.pending[0].revision;
    const who = [...new Set(r.pending.map((p) => p.author).filter(Boolean))];
    const a = await vscode.window.showInformationMessage(
      `${scope.name || scope.id}: SVN 서버에 새 커밋 ${r.pending.length}개가 있습니다 (r${first}${newest !== first ? `–r${newest}` : ''}${who.length ? ` · ${who.slice(0, 3).join(', ')}${who.length > 3 ? ' 외' : ''}` : ''}). 이 폴더를 svn update 할까요?`,
      { detail: r.pending.slice(-5).map((p) => `r${p.revision} ${p.author}: ${p.msg.split('\n')[0]}`).join('\n') },
      'svn update', '나중에');
    if (a !== 'svn update') return false;
    if (scopeBusy(scope)) { vscode.window.showWarningMessage('커밋 준비 중이거나 다른 svnwt 작업이 진행 중이라 지금은 update 할 수 없습니다. 끝난 뒤 다시 물어봅니다.'); askedServer.delete(scope.id); return false; }
    const from = scope.revision;
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    item.text = `$(sync~spin) svn update ${scope.name || scope.id}…`;
    item.show();
    let res;
    try { res = await service.refreshScope(scope.id, { svnUpdate: true }); } catch (e) { item.dispose(); vscode.window.showErrorMessage(`svn update 실패: ${e.message}`); return false; }
    item.dispose();
    log(res.svnUpdate || '');
    refreshAll();
    const conflicts = String(res.svnUpdate || '').split(/\r?\n/).filter((l) => /^\s*C\s/.test(l) || /^C/.test(l));
    if (conflicts.length) vscode.window.showWarningMessage(`svn update: 로컬 변경과 충돌 ${conflicts.length}개. TortoiseSVN 에서 해결하세요.`, { detail: conflicts.slice(0, 10).join('\n') });
    else quiet(`$(check) svn update: r${res.revision}`);
    await offerRebase(service.resolveScope(scope.id), from, { always: true });
    return true;
  }

  /** One round. verbose (the command): also says when nothing changed and asks again about what was declined. */
  async function tick({ local = true, server = false, verbose = false } = {}) {
    if (busy) return;
    if (!enabled() && !verbose) return;
    busy = true;
    let found = false;
    try {
      for (const scope of scopes()) {
        if (scopeBusy(scope)) continue;
        // server first: after an svn update it already asked about the rebase
        let updated = false;
        if (server) { try { updated = await checkServer(scope, { verbose }); } catch (e) { log(`svnWatch 서버 ${scope.id}: ${e.message}`); if (verbose) vscode.window.showWarningMessage(`SVN 서버 확인 실패: ${e.message}`); } }
        found = updated || found;
        if (local && !updated) { try { found = (await checkLocal(service.resolveScope(scope.id), { verbose })) || found; } catch (e) { log(`svnWatch ${scope.id}: ${e.message}`); } }
      }
    } finally { busy = false; }
    if (verbose && !found) quiet('$(check) SVN: 새 커밋 없음, 모든 작업이 최신 기준');
  }

  const due = (minLocalMs = 55 * 1000) => {
    const now = Date.now();
    const local = now - lastLocal >= minLocalMs;
    const m = serverMinutes();
    const server = m > 0 && now - lastServer >= m * 60 * 1000;
    if (local) lastLocal = now;
    if (server) lastServer = now;
    if (local || server) tick({ local, server });
  };

  function start(ctx) {
    // first round a little after start-up (activation already reads a lot), then every minute
    timers.push(setTimeout(() => { lastServer = 0; due(); }, 20 * 1000));
    timers.push(setInterval(due, 60 * 1000));
    // back from TortoiseSVN (update, commit): look again soon
    ctx.subscriptions.push(vscode.window.onDidChangeWindowState((w) => { if (w.focused) setTimeout(() => due(10 * 1000), 1500); }));
    ctx.subscriptions.push({ dispose: () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); }) });
  }

  return { start, checkNow: () => tick({ local: true, server: true, verbose: true }), offerRebase };
}

module.exports = { createSvnWatch };
