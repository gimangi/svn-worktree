'use strict';
const vscode = require('vscode');
const path = require('path');

const STATUS_LABEL = {
  active: '진행 중',
  landed: '커밋 대기',
  committed: '커밋 완료',
  archived: '보관됨',
};
// longer wording for tooltips / review header
const STATUS_TEXT = {
  active: '진행 중 (worktree 에서 작업)',
  landed: 'SVN changelist 준비됨 · 사람의 커밋 대기',
  committed: 'SVN 커밋 완료',
  archived: '보관됨 (worktree 삭제, 커밋 기록 보관)',
};
const STATUS_ICON = {
  active: new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.blue')),
  landed: new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.yellow')),
  committed: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
  archived: new vscode.ThemeIcon('archive'),
};
const FILE_ICON = { A: 'diff-added', M: 'diff-modified', D: 'diff-removed', R: 'diff-renamed', C: 'diff-added' };

class TaskTree {
  constructor(service) {
    this.service = service;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.error = null;
  }

  refresh() { this._emitter.fire(); }

  getTreeItem(el) { return el.item; }

  async getChildren(el) {
    try {
      if (!el) {
        const scopes = this.service.listScopes();
        if (!scopes.length) return [];
        const rulesNode = () => {
          const rules = this.service.listRules();
          const fresh = rules.filter((r) => Date.now() - Date.parse(r.at) < 24 * 3600 * 1000).length;
          const it = new vscode.TreeItem('규칙', vscode.TreeItemCollapsibleState.Collapsed);
          it.description = `${rules.length}개${fresh ? ` · 오늘 추가 ${fresh}` : ''}`;
          it.tooltip = '작업 피드백 중 "앞으로 항상" 지킬 규칙. Copilot 이 svnwt_rule_add 로 저장하고, 모든 Copilot 채팅에 지침으로 들어갑니다.';
          it.iconPath = new vscode.ThemeIcon('law');
          it.contextValue = 'rules';
          it.id = 'rules';
          return { kind: 'rules', item: it };
        };
        return [...scopes.map((s) => {
          const it = new vscode.TreeItem(s.id, vscode.TreeItemCollapsibleState.Expanded);
          it.description = `SVN r${s.revision}`;
          it.tooltip = new vscode.MarkdownString(`**${s.id}**\n\n- SVN 경로: \`${s.svnPath}\`\n- URL: ${s.url}\n- 기준: r${s.revision}${s.mixedRevision ? ` / mixed ${s.mixedRevision}` : ''}\n- 저장 위치: \`${s.home}\`\n- 마지막 snapshot: ${s.lastSnapshotAt || '-'}`);
          it.iconPath = new vscode.ThemeIcon('repo');
          it.contextValue = 'scope';
          it.resourceUri = vscode.Uri.file(s.svnPath);
          return { kind: 'scope', scope: s, item: it };
        }), rulesNode()];
      }
      if (el.kind === 'rules') {
        const out = this.service.listRules().slice().reverse().map((r) => {
          const it = new vscode.TreeItem(r.text);
          const isNew = Date.now() - Date.parse(r.at) < 24 * 3600 * 1000;
          it.description = `${isNew ? '새 규칙 · ' : ''}${String(r.at).slice(0, 10)}${r.taskNo ? ` · #${r.taskNo}` : ''}`;
          it.iconPath = new vscode.ThemeIcon(isNew ? 'sparkle' : 'circle-small-filled', isNew ? new vscode.ThemeColor('charts.yellow') : undefined);
          it.tooltip = new vscode.MarkdownString(`**${r.text}**${r.why ? `\n\n이유: ${r.why}` : ''}\n\n- 추가: ${r.at.replace('T', ' ').slice(0, 16)} (${r.by})${r.taskNo ? `\n- 작업: #${r.taskNo} ${r.taskTitle || ''}` : ''}${r.updatedAt ? `\n- 수정: ${r.updatedAt.replace('T', ' ').slice(0, 16)}` : ''}`);
          it.contextValue = 'rule';
          it.id = 'rule:' + r.id;
          return { kind: 'rule', rule: r, item: it };
        });
        if (!out.length) {
          const it = new vscode.TreeItem('아직 없음 — Copilot 에 "앞으로 항상 …" 이라고 하면 여기에 저장됩니다');
          it.iconPath = new vscode.ThemeIcon('info');
          out.push({ kind: 'hint', item: it });
        }
        const files = this.instructionFiles ? this.instructionFiles() : [];
        if (files.length) {
          const it = new vscode.TreeItem('다른 지침 파일', vscode.TreeItemCollapsibleState.Collapsed);
          it.description = `${files.length}개`;
          it.tooltip = 'Copilot 이 읽는 다른 지침 파일 (svnwt 가 관리하지 않음)';
          it.iconPath = new vscode.ThemeIcon('files');
          it.id = 'instrFiles';
          out.push({ kind: 'instrFiles', files, item: it });
        }
        return out;
      }
      if (el.kind === 'commits') {
        return el.commits.map((c) => {
          const it = new vscode.TreeItem(c.subject || c.sha.slice(0, 8));
          it.description = `${c.sha.slice(0, 8)} · ${new Date(c.date).toLocaleString()}`;
          it.tooltip = `${c.sha}\n${c.author}, ${c.date}\n${c.subject}`;
          it.iconPath = new vscode.ThemeIcon('git-commit');
          it.command = { command: 'svnwt.openCommit', title: '커밋 변경 보기', arguments: [el.task.id, c.sha] };
          return { kind: 'commit', item: it };
        });
      }
      if (el.kind === 'instrFiles') {
        return el.files.map((f) => {
          const it = new vscode.TreeItem(path.basename(f.file));
          it.description = `${f.where} · ${new Date(f.mtime).toISOString().slice(0, 10)}`;
          it.tooltip = f.file;
          it.iconPath = new vscode.ThemeIcon('markdown');
          it.resourceUri = vscode.Uri.file(f.file);
          it.command = { command: 'vscode.open', title: '열기', arguments: [vscode.Uri.file(f.file), { preview: true }] };
          return { kind: 'file', item: it };
        });
      }
      if (el.kind === 'archive') {
        return this.service.listArchived({ scope: el.scope.id }).map((t) => {
          const it = new vscode.TreeItem(`#${t.no} ${t.title}`);
          const a = t.archive;
          const before = a && a.statusBefore === 'committed' ? 'SVN 커밋됨' : a ? '커밋 안 함' : '';
          it.description = [String(t.archivedAt || '').slice(0, 10), before, a ? `커밋 ${a.commits}개` : '기록 없음'].filter(Boolean).join(' · ');
          it.iconPath = new vscode.ThemeIcon(a ? 'history' : 'archive');
          const lines = [`**#${t.no} ${t.title}**`, '', t.description || '', '', `- 생성: ${t.createdAt}`, `- 보관: ${t.archivedAt || '-'}`];
          if (t.committedAt) lines.push(`- SVN 커밋: ${t.committedAt}`);
          lines.push(a ? `- 커밋 ${a.commits}개 · 파일 ${a.files}개` : '- 0.4.7 이하 버전에서 정리되어 커밋 기록이 없습니다');
          it.tooltip = new vscode.MarkdownString(lines.join('\n'));
          it.contextValue = 'task.archived';
          it.command = { command: 'svnwt.openReview', title: '기록 보기', arguments: [{ kind: 'task', task: t }, { preserveFocus: true }] };
          it.id = 'archived:' + t.id;
          return { kind: 'task', task: t, item: it };
        });
      }
      if (el.kind === 'scope') {
        const tasks = this.service.listTasks({ scope: el.scope.id });
        const archived = this.service.listArchived({ scope: el.scope.id });
        const tail = [];
        if (archived.length) {
          const it = new vscode.TreeItem('보관된 작업', vscode.TreeItemCollapsibleState.Collapsed);
          it.description = `${archived.length}개`;
          it.tooltip = '정리한 작업의 커밋 기록, 리뷰, 에이전트 대화';
          it.accessibilityInformation = { label: `보관된 작업 ${archived.length}개` };
          it.iconPath = new vscode.ThemeIcon('history');
          it.contextValue = 'archive';
          it.id = 'archive:' + el.scope.id;
          tail.push({ kind: 'archive', scope: el.scope, item: it });
        }
        if (!tasks.length) {
          const it = new vscode.TreeItem('작업 없음 — + 버튼으로 새 작업 만들기');
          it.command = { command: 'svnwt.createTask', title: '새 작업', arguments: [el] };
          it.iconPath = new vscode.ThemeIcon('info');
          return [{ kind: 'hint', item: it }, ...tail];
        }
        return [...tasks.slice().reverse().map((t) => {
          const it = new vscode.TreeItem(`#${t.no} ${t.title}`, vscode.TreeItemCollapsibleState.Collapsed);
          const nFiles = t.landed && t.landed.files ? t.landed.files.length : null;
          it.description = (STATUS_LABEL[t.status] || t.status) + (t.status === 'landed' && nFiles !== null ? ` · ${nFiles}파일` : '');
          it.iconPath = STATUS_ICON[t.status];
          it.contextValue = 'task.' + t.status;
          if (t.status === 'active' && t.readyAt) it.description = '리뷰 대기';
          if (t.status === 'active' && t.waitFor && t.waitFor.tasks.length) {
            const pending = t.waitFor.tasks.filter((w) => { const o = tasks.find((x) => x.id === w.id); return o && o.status === 'landed'; });
            it.description += pending.length ? ` · #${pending.map((w) => w.no).join(', #')} 커밋 후` : ' · rebase 후 반영';
          }
          if (t.status === 'landed' && tasks.some((o) => o.status === 'active' && o.waitFor && o.waitFor.tasks.some((w) => w.id === t.id))) it.description += ' · 먼저 커밋';
          const nLeft = t.status === 'committed' && Array.isArray(t.leftovers) ? t.leftovers.length : 0;
          if (nLeft) {
            it.description += ` · 남은 변경 ${nLeft}`;
            it.contextValue += '.leftovers';
          }
          const ag = t.agent && t.agent.state;
          if (ag === 'running') {
            it.iconPath = new vscode.ThemeIcon('loading~spin');
            it.description = '에이전트 실행 중 · ' + it.description;
            it.contextValue += '.running';
          } else if (ag === 'waiting') {
            it.iconPath = new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'));
            it.description = '승인 대기 · ' + it.description;
            it.contextValue += '.running';
          } else if (ag === 'error') {
            it.description = '에이전트 오류 · ' + it.description;
          }
          it.tooltip = new vscode.MarkdownString(`**#${t.no} ${t.title}**\n\n${t.description || ''}\n\n- 상태: ${STATUS_TEXT[t.status] || t.status}\n- 브랜치: \`${t.branch}\`\n- worktree: \`${t.workPath}\`\n- changelist: \`${t.changelist}\`\n- 생성: ${t.createdAt}`);
          it.command = { command: 'svnwt.openReview', title: '리뷰', arguments: [{ kind: 'task', task: t }, { preserveFocus: true }] };
          it.id = 'task:' + t.id + ':' + t.status;
          return { kind: 'task', task: t, item: it };
        }), ...tail];
      }
      if (el.kind === 'task') {
        const info = await this.service.taskInfo(el.task.id, { checkSvn: false });
        const out = [];
        if (info.worktree && info.worktree.dirty && info.worktree.dirty.length) {
          const it = new vscode.TreeItem(`커밋되지 않은 변경 ${info.worktree.dirty.length}개`);
          it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
          out.push({ kind: 'hint', item: it });
        }
        if ((info.commits || []).length) {
          const it = new vscode.TreeItem(`커밋 ${info.commits.length}개`, vscode.TreeItemCollapsibleState.Collapsed);
          it.tooltip = '커밋별 변경 보기';
          it.iconPath = new vscode.ThemeIcon('git-commit');
          it.id = `commits:${el.task.id}`;
          out.push({ kind: 'commits', task: el.task, commits: info.commits, item: it });
        }
        if (!info.files.length) {
          const it = new vscode.TreeItem('변경된 파일 없음');
          it.iconPath = new vscode.ThemeIcon('circle-slash');
          out.push({ kind: 'hint', item: it });
        }
        for (const f of info.files) {
          const it = new vscode.TreeItem(path.posix.basename(f.path));
          it.description = `${path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path)}  +${f.add || 0} -${f.del || 0}`;
          it.iconPath = new vscode.ThemeIcon(FILE_ICON[f.status] || 'file');
          it.tooltip = `${f.status} ${f.from ? f.from + ' → ' : ''}${f.path}`;
          it.command = { command: 'svnwt.openFileDiff', title: 'Diff', arguments: [el.task.id, f] };
          out.push({ kind: 'file', item: it });
        }
        return out;
      }
    } catch (e) {
      const it = new vscode.TreeItem(`오류: ${e.message.split('\n')[0]}`);
      it.tooltip = e.message;
      it.iconPath = new vscode.ThemeIcon('error');
      it.command = { command: 'svnwt.checkEnvironment', title: '환경 점검' };
      return [{ kind: 'hint', item: it }];
    }
    return [];
  }
}

module.exports = { TaskTree, STATUS_LABEL, STATUS_TEXT };
