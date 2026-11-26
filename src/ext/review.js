'use strict';
const vscode = require('vscode');
const { STATUS_LABEL, STATUS_TEXT } = require('./tree');

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VERDICT = { approve: ['승인', 'ok'], request_changes: ['변경 요청', 'bad'], comment: ['코멘트', 'info'] };
const STATUS_CLASS = { active: 'info', landed: 'warn', committed: 'ok', archived: 'muted' };

/**
 * PR-like review panel for one task.
 * Tabs behave like editor preview tabs: opening another task reuses the preview tab; a tab becomes
 * a kept tab once you work in it (any button/link, editing the message) or via "리뷰를 새 탭으로 열기".
 */
class ReviewPanel {
  static panels = new Map();
  static preview = null;

  static show(ctx, taskId, { preserveFocus = false, newTab = false } = {}) {
    const existing = ReviewPanel.panels.get(taskId);
    if (existing) {
      if (newTab) existing.keep();
      existing.panel.reveal(undefined, preserveFocus);
      existing.update();
      return existing;
    }
    const pv = ReviewPanel.preview;
    if (!newTab && pv && !pv.disposed) {
      ReviewPanel.panels.delete(pv.taskId);
      pv.retarget(taskId);
      ReviewPanel.panels.set(taskId, pv);
      pv.panel.reveal(undefined, preserveFocus);
      return pv;
    }
    const p = new ReviewPanel(ctx, taskId, preserveFocus);
    ReviewPanel.panels.set(taskId, p);
    if (!newTab) ReviewPanel.preview = p;
    return p;
  }

  keep() {
    if (ReviewPanel.preview === this) {
      ReviewPanel.preview = null;
      this.lastKey = null;
      this.update();
    }
  }

  get isPreview() { return ReviewPanel.preview === this; }

  retarget(taskId) {
    this.taskId = taskId;
    this.lastKey = null;
    try {
      const home = this.ctx.service.resolveTask(taskId).scope.home;
      this.panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(home)] };
    } catch (_) { /* ignore */ }
    this.update();
  }

  static refreshAll() { for (const p of ReviewPanel.panels.values()) p.update(); }

  constructor(ctx, taskId, preserveFocus = false) {
    this.ctx = ctx;
    this.taskId = taskId;
    let roots = [];
    try { roots = [vscode.Uri.file(ctx.service.resolveTask(taskId).scope.home)]; } catch (_) { /* resolved later */ }
    this.panel = vscode.window.createWebviewPanel('svnwt.review', `Review #${taskId}`, { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots });
    this.panel.iconPath = new vscode.ThemeIcon('git-pull-request');
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (ReviewPanel.panels.get(this.taskId) === this) ReviewPanel.panels.delete(this.taskId);
      if (ReviewPanel.preview === this) ReviewPanel.preview = null;
    });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.update();
  }

  async onMessage(m) {
    const c = this.ctx;
    if (m.cmd !== 'scrolled') this.keep();
    if (typeof m.cmd === 'string' && m.cmd.startsWith('openTask:')) m = { cmd: 'openTask', task: m.cmd.slice('openTask:'.length) };
    try {
      switch (m.cmd) {
        case 'keep': return undefined;
        case 'agentSend': return m.text && m.text.trim() ? vscode.commands.executeCommand('svnwt.agent.instruct', this.taskId, m.text.trim()) : undefined;
        case 'agentStop': return vscode.commands.executeCommand('svnwt.agent.stop', this.taskId);
        case 'agentChat': return vscode.commands.executeCommand('svnwt.agent.openChat', this.taskId);
        case 'commitChoose': return vscode.commands.executeCommand('svnwt.commitSvnChoose', this.taskId);
        case 'cancelCommit': return vscode.commands.executeCommand('svnwt.cancelCommit', this.taskId);
        case 'refreshPrepare': return vscode.commands.executeCommand('svnwt.refreshPrepare', this.taskId);
        case 'openChanges': return vscode.commands.executeCommand('svnwt.openChanges', this.taskId);
        case 'openDiff': return vscode.commands.executeCommand('svnwt.openFileDiff', this.taskId, m.file, { beside: true });
        case 'openCommit': return vscode.commands.executeCommand('svnwt.openCommit', this.taskId, m.sha);
        case 'openFile': return c.openTaskFile(this.taskId, m.file, m.line, { beside: true });
        case 'askCopilot': return vscode.commands.executeCommand('svnwt.askCopilotReview', this.taskId);
        case 'land': return vscode.commands.executeCommand('svnwt.land', this.taskId);
        case 'unland': return vscode.commands.executeCommand('svnwt.unland', this.taskId);
        case 'commitSvn': return vscode.commands.executeCommand('svnwt.commitSvn', this.taskId);
        case 'copyCmd': return vscode.commands.executeCommand('svnwt.copyCommitCommand', this.taskId);
        case 'sync': return vscode.commands.executeCommand('svnwt.syncTask', this.taskId);
        case 'worktree': return vscode.commands.executeCommand('svnwt.openWorktree', this.taskId);
        case 'terminal': return vscode.commands.executeCommand('svnwt.openTerminal', this.taskId);
        case 'remove': return vscode.commands.executeCommand('svnwt.removeTask', this.taskId);
        case 'discardLeftovers': return vscode.commands.executeCommand('svnwt.discardLeftovers', this.taskId);
        case 'discardScope': return vscode.commands.executeCommand('svnwt.discardScopeChanges', this.taskId);
        case 'purge': return vscode.commands.executeCommand('svnwt.purgeTask', this.taskId);
        case 'rebaseLand': return vscode.commands.executeCommand('svnwt.rebaseAndLand', this.taskId);
        case 'openTask': return vscode.commands.executeCommand('svnwt.openReview', m.task);
        case 'refresh': return this.update();
        case 'checkSvn': return vscode.commands.executeCommand('svnwt.checkSvn', this.taskId);
        case 'openArtifact': return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        case 'saveMessage':
          await c.service.saveCommitMessage(this.taskId, m.text);
          return undefined;
        default: return undefined;
      }
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
      return undefined;
    }
  }

  async update(checkSvn = false) {
    // Updates overlap while an agent works (every tool step fires one). Only the most recently started
    // update may render; an older, slower one finishing later would show stale data (e.g. before a commit).
    const gen = (this.gen = (this.gen || 0) + 1);
    let html;
    try {
      const info = await this.ctx.service.taskInfo(this.taskId, { checkSvn });
      const message = await this.ctx.service.getCommitMessage(this.taskId);
      if (gen !== this.gen) return;
      const reviews = this.ctx.service.listReviews(this.taskId);
      const runs = this.ctx.service.listArtifacts(this.taskId);
      this.session = this.ctx.service.getSession(this.taskId).entries.slice(-80);
      this.agentRunning = this.ctx.isAgentRunning ? this.ctx.isAgentRunning(this.taskId) : false;
      this.panel.title = `#${info.task.no} ${info.task.title}`;
      html = this.render(info, reviews, message, runs);
    } catch (e) {
      if (gen !== this.gen) return;
      html = this.shell(`<div class="error">${esc(e.message)}</div>`);
    }
    if (this.disposed) return;
    // re-render only when something changed (keeps scroll position / textarea focus while agents work)
    const key = html.replace(/nonce-[a-z0-9]+|nonce="[a-z0-9]+"/g, '');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.panel.webview.html = html;
  }

  renderRuns(runs, tip) {
    if (!runs.length) {
      return '<p class="muted">첨부된 테스트 화면이 없습니다. UI 테스트(Playwright 등)를 실행한 에이전트가 <code>svnwt_task_attach_screenshots</code> 로 첨부하면 여기에 표시됩니다.</p>';
    }
    const wv = this.panel.webview;
    const pretty = (caption) => {
      // "report-shows-add-and-mul-chromium · test-failed-1.png" -> name "report shows add and mul", browser, failed?
      const [folder, file = ''] = caption.split(' · ');
      const m = /^(.*?)-(chromium|firefox|webkit|msedge|chrome)(?:-\w+)?$/.exec(folder);
      return { name: (m ? m[1] : folder).replace(/[-_]+/g, ' '), browser: m ? m[2] : '', failed: /failed/i.test(file), file };
    };
    return runs.slice().reverse().map((r, idx) => {
      const st = r.status === 'passed' ? '<span class="badge ok">통과</span>' : r.status === 'failed' ? '<span class="badge bad">실패</span>' : '';
      const stale = r.commit && r.commit !== tip ? '<span class="muted">(이전 커밋 기준)</span>' : '';
      const failed = (r.failedTests || []).length ? `<div class="muted">실패한 테스트: ${esc(r.failedTests.join(', '))}</div>` : '';
      const items = r.items.map((it) => {
        const src = wv.asWebviewUri(vscode.Uri.file(it.file));
        const c = pretty(it.caption);
        const media = it.kind === 'video'
          ? `<video src="${src}" controls preload="metadata"></video>`
          : `<img src="${src}" loading="lazy" alt="${esc(c.name)}">`;
        return `<figure class="shot${c.failed ? ' failed' : ''}" data-file="${esc(it.file)}" title="${esc(it.caption)}">${media}
          <figcaption>${c.failed ? '<span class="minus">✗</span> ' : ''}${esc(c.name)}${c.browser ? ` <span class="muted">${esc(c.browser)}</span>` : ''}</figcaption></figure>`;
      }).join('');
      return `<details class="run" ${idx === 0 ? 'open' : ''}><summary><b>${esc(r.title)}</b> ${st} <span class="muted">${esc(new Date(r.at).toLocaleString())} · ${r.items.length}개</span> ${stale}</summary>
        ${r.summary ? `<div class="body">${esc(r.summary)}</div>` : ''}${failed}<div class="gallery">${items}</div></details>`;
    }).join('');
  }

  /** "Merge box": what happens next for this task, with the one primary action for its state. */
  renderNext(info, files) {
    const t = info.task;
    const dirty = (info.worktree && info.worktree.dirty) || [];
    const notes = [];
    if (info.worktree && (info.worktree.rebasing || info.worktree.merging)) notes.push(['warn', 'rebase 충돌을 해결하는 중입니다. worktree 에서 충돌을 정리한 뒤 다시 시도하세요.']);
    if (dirty.length && t.status !== 'committed') notes.push(['warn', `worktree 에 커밋되지 않은 변경 ${dirty.length}개가 있습니다. changelist 에는 커밋된 내용만 들어갑니다.`]);
    let title = '';
    let text = '';
    let buttons = [];
    if (t.status === 'active') {
      if (!files.length) {
        title = '작업 중';
        text = '아직 커밋된 변경이 없습니다. Copilot 이 worktree 에서 작업하고 커밋하면 여기에 표시됩니다.';
      } else {
        title = t.readyAt ? '리뷰 대기' : '리뷰 후 커밋 준비';
        text = '커밋 준비를 누르면 SVN working copy 에 이 작업만 올립니다. 다른 로컬 변경은 커밋이 끝날 때까지 잠시 빼 두었다가 되돌립니다.';
        buttons = [['commitSvn', '커밋 준비', 'primary'], ['openChanges', '모든 변경 사항 보기'], ['askCopilot', 'Copilot 리뷰 요청']];
      }
      const waitFor = info.waitFor || [];
      if (files.length && waitFor.length && !info.waitReady) {
        const pending = waitFor.filter((w) => !w.ready);
        title = `#${pending.map((w) => w.no).join(', #')} 커밋 후 진행`;
        text = `${pending.map((w) => `#${w.no} "${w.title}"`).join(', ')} 와 같은 부분(${[...new Set(pending.flatMap((w) => w.files))].join(', ')})을 고쳤습니다. 그 작업을 먼저 SVN 커밋하면, 이 작업을 rebase 해서 changelist 를 만들 수 있습니다.`;
        buttons = [...pending.slice(0, 2).map((w) => [`openTask:${w.id}`, `#${w.no} 리뷰 열기`, 'primary']), ['land', 'SVN changelist 만들기'], ['openChanges', '모든 변경 사항 보기']];
      } else if (files.length && waitFor.length) {
        title = 'rebase 후 SVN changelist 만들기';
        text = `기다리던 작업(${waitFor.map((w) => `#${w.no}`).join(', ')})이 ${waitFor.every((w) => w.status === 'committed') ? '커밋되었습니다' : '정리되었습니다'}. 최신 SVN 기준으로 rebase 한 뒤 changelist 를 만듭니다. 같은 줄을 고친 부분은 rebase 할 때 worktree 에서 정리해야 할 수 있습니다.`;
        buttons = [['rebaseLand', 'rebase 후 changelist 만들기', 'primary'], ['openChanges', '모든 변경 사항 보기']];
      }
      if (!info.baseIsLatest && !waitFor.length) {
        notes.push(['info', `이 작업을 시작한 뒤 SVN 기준이 ${info.svnBaseCommitsBehind}번 갱신되었습니다. 충돌이 걱정되면 먼저 최신 기준으로 rebase 하세요.`]);
        buttons.push(['sync', '최신 SVN 기준으로 rebase']);
      }
    } else if (t.status === 'landed' && info.commitInProgress && info.commitInProgress.mine) {
      title = '커밋 준비됨';
      text = info.commitInProgress.external
        ? 'TortoiseSVN 커밋 창을 열어 커밋하세요. 이 작업의 파일만 있고, 커밋 메시지는 클립보드에 있습니다. 빼 둔 다른 변경은 커밋이 끝나면 돌아옵니다.'
        : '커밋 진행 중입니다.';
      buttons = [['cancelCommit', '커밋 취소 (되돌리기)']];
      if (t.landed && info.tip !== t.landed.commit) {
        notes.push(['warn', '커밋 준비 후 새 git 커밋이 생겼습니다. working copy 에는 아직 이전 내용입니다.']);
        buttons = [['refreshPrepare', '커밋 준비 갱신', 'primary'], ['cancelCommit', '커밋 취소 (되돌리기)']];
      }
    } else if (t.status === 'landed') {
      const external = ['prepare', 'external', undefined, ''].includes(vscode.workspace.getConfiguration('svnwt').get('commitTool'));
      const shared = Object.keys((t.landed && t.landed.shared) || {});
      title = 'SVN 커밋 대기';
      text = `changelist ${t.changelist} · 파일 ${(t.landed && t.landed.files.length) || 0}개가 SVN working copy 에 반영되어 있습니다.`;
      if (shared.length) notes.push(['info', `다른 작업과 같이 고친 파일 ${shared.length}개 (${shared.join(', ')}) — 커밋할 때 이 작업의 변경만 들어갑니다.`]);
      if (info.commitInProgress && !info.commitInProgress.mine) notes.push(['warn', `다른 작업(${info.commitInProgress.task})의 커밋이 준비 중입니다. 그 커밋이 끝난 뒤 진행하세요.`]);
      if ((info.waitingOnMe || []).length) notes.push(['info', `${info.waitingOnMe.map((w) => `#${w.no} "${w.title}"`).join(', ')} 가 이 작업의 커밋을 기다립니다 (같은 부분 수정). 이 작업을 먼저 커밋하세요.`]);
      buttons = [['commitSvn', external ? '커밋 준비' : 'SVN 커밋…', 'primary'], ['openChanges', '모든 변경 사항 보기'], ['askCopilot', 'Copilot 리뷰 요청']];
      if (t.landed && info.tip !== t.landed.commit) {
        notes.push(['warn', 'changelist 를 만든 뒤 새 커밋이 생겼습니다. 갱신해야 SVN working copy 에 반영됩니다.']);
        buttons = [['land', 'changelist 갱신', 'primary'], ['commitSvn', 'SVN 커밋…'], ['openChanges', '모든 변경 사항 보기']];
      }
    } else if (t.status === 'committed') {
      const left = info.leftovers || [];
      title = 'SVN 커밋 완료';
      text = '이 작업은 SVN 에 커밋되었습니다. 보관하면 worktree 를 지우고 커밋 기록·리뷰·대화는 "보관된 작업"에 남깁니다.';
      buttons = [['remove', '보관 (worktree 정리)', 'primary'], ['discardScope', 'SVN 남은 변경 정리…'], ['openChanges', '변경 사항 보기']];
      if (left.length) {
        notes.push(['warn', `커밋에서 빠진 파일 ${left.length}개가 남아 있습니다: ${left.join(', ')}`]);
        buttons = [['discardLeftovers', '남은 변경 버리기', 'primary'], ['remove', '보관 (worktree 정리)'], ['discardScope', 'SVN 남은 변경 정리…'], ['openChanges', '변경 사항 보기']];
      }
    }
    if (['landed', 'committed'].includes(t.status) && !(info.commitInProgress && info.commitInProgress.mine)) buttons.push(['checkSvn', 'SVN 상태 확인']);
    const cmd = t.status === 'landed' && info.commit && !(info.commitInProgress && info.commitInProgress.mine)
      ? `<div class="sub"><a href="#" data-cmd="commitChoose">다른 방법으로 커밋…</a></div>` : '';
    return `<div class="next next-${esc(t.status)}"><div class="next-title">${esc(title)}</div><div class="next-text">${esc(text)}</div>
      ${notes.map(([k, n]) => `<div class="note note-${k}">${esc(n)}</div>`).join('')}
      <div class="actions">${buttons.map(([c, l, k]) => `<button data-cmd="${c}" class="${k || ''}">${esc(l)}</button>`).join('')}</div>${cmd}</div>`;
  }

  renderAgent(t) {
    const st = (t.agent && t.agent.state) || 'idle';
    const running = st === 'running' || st === 'waiting' || (!t.agent && this.agentRunning);
    const badge = running
      ? `<span class="badge warn">${st === 'waiting' ? '승인 대기' : '실행 중'}</span>`
      : st === 'error' ? '<span class="badge bad">오류</span>' : '';
    const items = (this.session || []).map((e) => {
      const time = esc(new Date(e.at).toLocaleTimeString());
      if (e.role === 'user') return `<div class="msg user"><div class="who">요청 <span class="muted">${time}${e.source === 'chat' ? ' · 채팅' : ''}</span></div><div class="body">${esc(e.text)}</div></div>`;
      if (e.role === 'assistant') return `<div class="msg bot"><div class="body">${esc(e.text)}</div></div>`;
      if (e.role === 'tool') return `<div class="tool ${e.ok === false ? 'fail' : ''}" title="${esc(e.result || '')}">${e.ok === undefined ? '…' : e.ok ? '✓' : '✗'} ${esc(e.label)}</div>`;
      return `<div class="info muted">${esc(e.text)}</div>`;
    }).join('');
    const canTalk = t.status === 'active' || t.status === 'landed';
    return `<section class="agent"><h2>에이전트 세션 ${badge}</h2>
      ${items ? `<div class="transcript" id="transcript">${items}</div>` : '<p class="muted">아직 에이전트 대화가 없습니다. 아래에 지시를 쓰거나 채팅에서 <code>@svnwt</code> 로 시작하세요.</p>'}
      ${t.agent && t.agent.state === 'waiting' && t.agent.waitingFor ? `<div class="note note-warn">명령 실행 승인 대기: <code>${esc(t.agent.waitingFor)}</code></div>` : ''}
      ${canTalk ? `<textarea id="agentInput" rows="3" placeholder="에이전트에게 지시 (Ctrl+Enter 로 보내기)"${running ? ' disabled' : ''}></textarea>
      <div class="actions">${running ? '<button data-cmd="agentStop">중지</button>' : '<button id="agentSend" class="primary">지시 보내기</button>'}<button data-cmd="agentChat">채팅에서 이어가기</button></div>` : ''}
    </section>`;
  }

  /** Read-only history of an archived task. */
  renderArchived(info, { files, add, del, fileRows, commitRows, reviewHtml, runs, message }) {
    const t = info.task;
    const d = (s) => (s ? esc(new Date(s).toLocaleString()) : '-');
    const a = t.archive || null;
    const svn = a && a.statusBefore === 'committed' ? `SVN 커밋 ${d(t.committedAt)}` : 'SVN 커밋 안 함';
    return `
      ${this.isPreview ? '<div class="pv muted">미리보기 탭 — 다른 작업을 열면 이 탭에 표시됩니다 · <a href="#" data-cmd="keep">탭 유지</a></div>' : ''}
      <header>
        <h1>#${t.no} ${esc(t.title)} <span class="badge muted" title="${esc(STATUS_TEXT.archived)}">보관됨</span></h1>
        <div class="meta">생성 ${d(t.createdAt)} · ${svn} · 보관 ${d(t.archivedAt)}</div>
        <div class="meta">${info.history ? `커밋 ${info.commits.length}개 · 파일 ${files.length}개 <span class="plus">+${add}</span> <span class="minus">-${del}</span>` : '<span class="muted">0.4.7 이하 버전에서 정리되어 git 커밋 기록이 없습니다. 리뷰와 에이전트 대화만 남아 있습니다.</span>'}</div>
        <div class="meta muted">worktree 는 삭제되었습니다 · <a href="#" data-cmd="purge" class="danger">기록 삭제</a></div>
      </header>
      ${t.description ? `<section><h2>설명</h2><div class="body">${esc(t.description)}</div></section>` : ''}
      ${info.history ? `<section><h2>커밋 <span class="muted">(${info.commits.length})</span></h2>${commitRows ? `<ol class="commits">${commitRows}</ol>` : '<p class="muted">없음</p>'}</section>
      <section><h2>변경된 파일 <span class="muted">(${files.length})</span></h2>${files.length ? `<div class="muted keys">↑↓ 이동 · Enter 열기 · diff 에서 F7 / Shift+F7 다음·이전 변경 (파일을 넘어감) · Alt+→ / Alt+← 파일 · Esc 리뷰 화면</div><table class="files">${fileRows}</table>` : '<p class="muted">없음</p>'}</section>` : ''}
      ${(this.session || []).length ? this.renderAgent(t) : ''}
      <section><h2>리뷰</h2>${reviewHtml}</section>
      ${runs.length ? `<section><h2>테스트 화면 <span class="muted">(${runs.length}회)</span></h2>${this.renderRuns(runs, info.tip)}</section>` : ''}
      ${message && message.trim() ? `<section><h2>SVN 커밋 메시지</h2><pre class="cmd">${esc(message)}</pre></section>` : ''}`;
  }

  render(info, reviews, message, runs = []) {
    const t = info.task;
    const files = info.files || [];
    const add = files.reduce((a, f) => a + (f.add || 0), 0);
    const del = files.reduce((a, f) => a + (f.del || 0), 0);
    const latest = reviews[reviews.length - 1];
    const lastRun = runs[runs.length - 1];

    const fileRows = files.map((f) => `
      <tr class="file nav" tabindex="0" data-file='${esc(JSON.stringify(f))}'>
        <td><span class="st st-${esc(f.status)}">${esc(f.status)}</span></td>
        <td class="path">${f.from ? `<span class="muted">${esc(f.from)} → </span>` : ''}${esc(f.path)}${t.landed && t.landed.shared && t.landed.shared[f.path] ? ` <span class="badge info" title="${esc(t.landed.shared[f.path])} 과 같이 고친 파일">공유</span>` : ''}</td>
        <td class="num"><span class="plus">+${f.add || 0}</span> <span class="minus">-${f.del || 0}</span>${f.binary ? ' <span class="muted">binary</span>' : ''}</td>
      </tr>`).join('');

    const commitRows = (info.commits || []).map((c) => `
      <li class="commit nav" tabindex="0" data-sha="${esc(c.sha)}" title="이 커밋의 변경 보기"><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)} <span class="muted">— ${esc(c.author)}, ${esc(new Date(c.date).toLocaleString())}</span></li>`).join('');

    const reviewHtml = reviews.slice().reverse().map((r) => {
      const [label, cls] = VERDICT[r.verdict] || [r.verdict, 'info'];
      const stale = r.commit && r.commit !== info.tip ? '<span class="muted">(이전 커밋 기준)</span>' : '';
      const cm = (r.comments || []).map((c) => `
        <li class="sev-${esc(c.severity)}"><a href="#" class="loc" data-file="${esc(c.file)}" data-line="${esc(c.line || '')}">${esc(c.file)}${c.line ? ':' + esc(c.line) : ''}</a>
        <span class="badge ${c.severity === 'blocker' || c.severity === 'major' ? 'bad' : 'muted'}">${esc(c.severity)}</span>
        <div class="body">${esc(c.body)}</div></li>`).join('');
      return `<div class="review"><div class="rh"><span class="badge ${cls}">${esc(label)}</span> <b>${esc(r.reviewer)}</b> <span class="muted">${esc(new Date(r.at).toLocaleString())}</span> ${stale}</div>
        <div class="body">${esc(r.summary)}</div>${cm ? `<ul class="comments">${cm}</ul>` : ''}</div>`;
    }).join('') || '<p class="muted">아직 리뷰가 없습니다. "Copilot 리뷰 요청"으로 에이전트 리뷰를 받을 수 있습니다.</p>';

    if (t.status === 'archived') return this.shell(this.renderArchived(info, { files, add, del, fileRows, commitRows, reviewHtml, runs, message }));

    const body = `
      ${this.isPreview ? '<div class="pv muted">미리보기 탭 — 다른 작업을 열면 이 탭에 표시됩니다 · <a href="#" data-cmd="keep">탭 유지</a></div>' : ''}
      <header>
        <h1>#${t.no} ${esc(t.title)} <span class="badge ${STATUS_CLASS[t.status]}" title="${esc(STATUS_TEXT[t.status] || '')}">${esc(t.status === 'active' && t.readyAt ? '리뷰 대기' : (STATUS_LABEL[t.status] || t.status))}</span>
          ${lastRun && lastRun.status ? `<span class="badge ${lastRun.status === 'passed' ? 'ok' : 'bad'}">테스트 ${lastRun.status === 'passed' ? '통과' : '실패'}</span>` : ''}
          ${latest ? `<span class="badge ${(VERDICT[latest.verdict] || [])[1] || 'info'}">리뷰: ${esc((VERDICT[latest.verdict] || [latest.verdict])[0])}</span>` : ''}</h1>
        <div class="meta">SVN r${esc(info.scope.revision)} 기준 · 커밋 ${info.commits.length}개 · 파일 ${files.length}개 <span class="plus">+${add}</span> <span class="minus">-${del}</span></div>
        <div class="meta muted" title="${esc(t.workPath)}">worktree <code>${esc(t.branch)}</code> · <a href="#" data-cmd="worktree">열기</a> · <a href="#" data-cmd="terminal">터미널</a>${t.status === 'landed' ? ' · <a href="#" data-cmd="unland" class="danger">SVN 반영 되돌리기</a>' : ''}</div>
      </header>
      ${this.renderNext(info, files)}
      ${this.renderAgent(t)}
      ${t.description ? `<section><h2>설명</h2><div class="body">${esc(t.description)}</div></section>` : ''}
      <section><h2>변경된 파일 <span class="muted">(${files.length})</span></h2>${files.length ? `<div class="muted keys">↑↓ 이동 · Enter 열기 · diff 에서 F7 / Shift+F7 다음·이전 변경 (파일을 넘어감) · Alt+→ / Alt+← 파일 · Esc 리뷰 화면</div><table class="files">${fileRows}</table>` : '<p class="muted">아직 커밋된 변경이 없습니다.</p>'}</section>
      <section><h2>테스트 화면${runs.length ? ` <span class="muted">(${runs.length}회)</span>` : ''}</h2>${this.renderRuns(runs, info.tip)}</section>
      <section><h2>리뷰</h2>${reviewHtml}</section>
      <section><h2>커밋 <span class="muted">(${info.commits.length})</span></h2>${commitRows ? `<ol class="commits">${commitRows}</ol>` : '<p class="muted">없음</p>'}</section>
      <section><h2>SVN 커밋 메시지</h2>
        <textarea id="msg" rows="7">${esc(message)}</textarea>
        <div class="muted" id="msgState">SVN 커밋 시 이 메시지를 사용합니다. 수정하면 자동 저장됩니다.</div>
      </section>`;
    return this.shell(body);
  }

  shell(body) {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${this.panel.webview.cspSource} data:; media-src ${this.panel.webview.cspSource};">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 20px 40px; max-width: 1100px; }
  h1 { font-size: 1.5em; font-weight: 600; margin: 18px 0 6px; }
  h2 { font-size: 1.1em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 26px; }
  .meta { margin: 3px 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .badge { display: inline-block; font-size: 0.72em; padding: 2px 8px; border-radius: 10px; vertical-align: middle; margin-left: 4px; font-weight: 500; }
  .badge.ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
  .badge.bad { background: var(--vscode-errorForeground, #d73a49); color: #fff; }
  .badge.warn { background: var(--vscode-editorWarning-foreground, #bf8700); color: #000; }
  .badge.info { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.muted { background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 2px; align-items: center; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; } a:hover { text-decoration: underline; }
  a.danger { color: var(--vscode-errorForeground); }
  .next { border: 1px solid var(--vscode-panel-border); border-left: 4px solid var(--vscode-focusBorder); border-radius: 4px; padding: 10px 14px; margin: 16px 0 8px; }
  .next-landed { border-left-color: var(--vscode-editorWarning-foreground); } .next-committed { border-left-color: var(--vscode-testing-iconPassed, #2ea043); }
  .next-title { font-weight: 600; font-size: 1.05em; margin-bottom: 3px; }
  .note { margin: 6px 0; padding: 4px 8px; border-radius: 3px; }
  .note-warn { background: var(--vscode-inputValidation-warningBackground); } .note-info { background: var(--vscode-textCodeBlock-background); }
  .transcript { max-height: 420px; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin: 6px 0 8px; }
  .msg { margin: 8px 0; } .msg .who { font-size: 0.85em; font-weight: 600; }
  .msg.user .body { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 6px 8px; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 0.88em; color: var(--vscode-descriptionForeground); margin: 2px 0 2px 6px; }
  .tool.fail { color: var(--vscode-errorForeground); } .info { font-style: italic; margin: 6px 0; }
  #agentInput { margin-top: 4px; }
  .pv { font-size: 0.85em; margin-top: 8px; } .sub { margin-top: 6px; font-size: 0.92em; }
  details.cmd summary { cursor: pointer; color: var(--vscode-textLink-foreground); margin-top: 6px; }
  figure.shot.failed { border-color: var(--vscode-errorForeground); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 5px 11px; border-radius: 2px; cursor: pointer; font-family: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .warnbox { border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground); padding: 6px 10px; margin: 6px 0; }
  .error { color: var(--vscode-errorForeground); margin-top: 20px; white-space: pre-wrap; }
  table.files { width: 100%; border-collapse: collapse; }
  table.files td { padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  tr.file { cursor: pointer; }
  tr.file:hover { background: var(--vscode-list-hoverBackground); }
  .nav:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .keys { font-size: 0.88em; margin: 2px 0 6px; }
  td.path { font-family: var(--vscode-editor-font-family); }
  td.num { text-align: right; white-space: nowrap; }
  .plus { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
  .minus { color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49); }
  .st { display: inline-block; width: 18px; text-align: center; font-weight: bold; border-radius: 3px; }
  .st-A { color: var(--vscode-gitDecoration-addedResourceForeground); } .st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground); } .st-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  ol.commits li { margin: 3px 0; }
  ol.commits li.commit { cursor: pointer; }
  ol.commits li.commit:hover { background: var(--vscode-list-hoverBackground); }
  .review { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; margin: 10px 0; }
  .rh { margin-bottom: 6px; }
  .body { white-space: pre-wrap; line-height: 1.45; }
  ul.comments { padding-left: 18px; } ul.comments li { margin: 8px 0; }
  a.loc { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
  textarea { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px; margin-bottom: 6px; }
  details.run { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 12px; margin: 8px 0; }
  details.run summary { cursor: pointer; padding: 2px 0; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin: 10px 0 4px; }
  figure.shot { margin: 0; cursor: zoom-in; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; background: var(--vscode-editor-background); }
  figure.shot img, figure.shot video { display: block; width: 100%; max-height: 220px; object-fit: contain; background: #fff; }
  figure.shot figcaption { font-size: 0.85em; padding: 4px 6px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  pre.cmd { background: var(--vscode-textCodeBlock-background); padding: 8px; white-space: pre-wrap; word-break: break-all; }
</style></head><body data-svnwt-review="${esc(this.taskId)}">${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('button[data-cmd]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ cmd: b.dataset.cmd })));
  document.querySelectorAll('tr.file').forEach((r) => r.addEventListener('click', () => vscode.postMessage({ cmd: 'openDiff', file: JSON.parse(r.dataset.file) })));
  document.querySelectorAll('li.commit').forEach((li) => li.addEventListener('click', () => vscode.postMessage({ cmd: 'openCommit', sha: li.dataset.sha })));
  document.querySelectorAll('a.loc').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ cmd: 'openFile', file: a.dataset.file, line: Number(a.dataset.line) || 0 }); }));
  document.querySelectorAll('figure.shot').forEach((f) => f.addEventListener('click', (e) => { if (e.target.tagName === 'VIDEO') return; vscode.postMessage({ cmd: 'openArtifact', file: f.dataset.file }); }));
  document.querySelectorAll('a[data-cmd]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ cmd: a.dataset.cmd }); }));
  const msg = document.getElementById('msg');
  if (msg) {
    let timer;
    msg.addEventListener('input', () => {
      clearTimeout(timer);
      document.getElementById('msgState').textContent = '저장 중…';
      timer = setTimeout(() => { vscode.postMessage({ cmd: 'saveMessage', text: msg.value }); document.getElementById('msgState').textContent = '저장됨'; }, 600);
    });
  }
  // keep the scroll position across re-renders
  const task = document.body.dataset.svnwtReview;
  const tr = document.getElementById('transcript');
  if (tr) tr.scrollTop = tr.scrollHeight;
  const ai = document.getElementById('agentInput');
  const send = () => { if (ai && ai.value.trim()) { vscode.postMessage({ cmd: 'agentSend', text: ai.value }); ai.value = ''; vscode.setState(Object.assign({}, vscode.getState() || {}, { draft: '' })); } };
  if (ai) {
    const d = (vscode.getState() || {}).draft;
    if (d && (vscode.getState() || {}).task === task) ai.value = d;
    ai.addEventListener('input', () => vscode.setState(Object.assign({}, vscode.getState() || {}, { task, draft: ai.value })));
    ai.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  }
  const sb = document.getElementById('agentSend');
  if (sb) sb.addEventListener('click', send);
  const st = vscode.getState() || {};
  if (st.task === task && st.scroll) window.scrollTo(0, st.scroll);
  window.addEventListener('scroll', () => vscode.setState(Object.assign({}, vscode.getState() || {}, { task, scroll: window.scrollY })));
  // keyboard: up/down (j/k) over the file and commit rows, Enter opens. The row is remembered, so coming back
  // from a diff (Esc) continues where you were
  const navs = [...document.querySelectorAll('.nav')];
  const save = (o) => vscode.setState(Object.assign({}, vscode.getState() || {}, { task }, o));
  const focusNav = (i) => { const el = navs[Math.max(0, Math.min(navs.length - 1, i))]; if (el) el.focus(); };
  navs.forEach((el, i) => {
    el.addEventListener('focus', () => save({ nav: i, navOn: true }));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  });
  document.addEventListener('focusin', (e) => { if (!e.target.classList || !e.target.classList.contains('nav')) save({ navOn: false }); });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if ((t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) || e.ctrlKey || e.altKey || e.metaKey || !navs.length) return;
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const up = e.key === 'ArrowUp' || e.key === 'k';
    if (!down && !up) return;
    e.preventDefault();
    const cur = navs.indexOf(document.activeElement);
    const s = vscode.getState() || {};
    focusNav(cur < 0 ? (s.task === task && typeof s.nav === 'number' ? s.nav : 0) : cur + (down ? 1 : -1));
  });
  const restoreNav = () => { const s = vscode.getState() || {}; if (s.task === task && s.navOn && typeof s.nav === 'number' && !navs.includes(document.activeElement)) focusNav(s.nav); };
  window.addEventListener('focus', restoreNav);
  if (document.hasFocus()) restoreNav();
</script></body></html>`;
  }
}

module.exports = { ReviewPanel };
