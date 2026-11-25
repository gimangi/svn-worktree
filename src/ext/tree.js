'use strict';
const vscode = require('vscode');
const path = require('path');

const STATUS_LABEL = {
  active: '진행 중',
  landed: '커밋 대기',
  committed: '커밋 완료',
  archived: '삭제됨',
};
// longer wording for tooltips / review header
const STATUS_TEXT = {
  active: '진행 중 (worktree 에서 작업)',
  landed: 'SVN changelist 준비됨 · 사람의 커밋 대기',
  committed: 'SVN 커밋 완료',
  archived: '삭제됨',
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
        return scopes.map((s) => {
          const it = new vscode.TreeItem(s.id, vscode.TreeItemCollapsibleState.Expanded);
          it.description = `SVN r${s.revision}`;
          it.tooltip = new vscode.MarkdownString(`**${s.id}**\n\n- SVN 경로: \`${s.svnPath}\`\n- URL: ${s.url}\n- 기준: r${s.revision}${s.mixedRevision ? ` / mixed ${s.mixedRevision}` : ''}\n- 저장 위치: \`${s.home}\`\n- 마지막 snapshot: ${s.lastSnapshotAt || '-'}`);
          it.iconPath = new vscode.ThemeIcon('repo');
          it.contextValue = 'scope';
          it.resourceUri = vscode.Uri.file(s.svnPath);
          return { kind: 'scope', scope: s, item: it };
        });
      }
      if (el.kind === 'scope') {
        const tasks = this.service.listTasks({ scope: el.scope.id });
        if (!tasks.length) {
          const it = new vscode.TreeItem('작업 없음 — + 버튼으로 새 작업 만들기');
          it.command = { command: 'svnwt.createTask', title: '새 작업', arguments: [el] };
          it.iconPath = new vscode.ThemeIcon('info');
          return [{ kind: 'hint', item: it }];
        }
        return tasks.slice().reverse().map((t) => {
          const it = new vscode.TreeItem(`#${t.no} ${t.title}`, vscode.TreeItemCollapsibleState.Collapsed);
          const nFiles = t.landed && t.landed.files ? t.landed.files.length : null;
          it.description = (STATUS_LABEL[t.status] || t.status) + (t.status === 'landed' && nFiles !== null ? ` · ${nFiles}파일` : '');
          it.iconPath = STATUS_ICON[t.status];
          it.contextValue = 'task.' + t.status;
          it.tooltip = new vscode.MarkdownString(`**#${t.no} ${t.title}**\n\n${t.description || ''}\n\n- 상태: ${STATUS_TEXT[t.status] || t.status}\n- 브랜치: \`${t.branch}\`\n- worktree: \`${t.workPath}\`\n- changelist: \`${t.changelist}\`\n- 생성: ${t.createdAt}`);
          it.command = { command: 'svnwt.openReview', title: '리뷰', arguments: [{ kind: 'task', task: t }, { preserveFocus: true }] };
          it.id = 'task:' + t.id + ':' + t.status;
          return { kind: 'task', task: t, item: it };
        });
      }
      if (el.kind === 'task') {
        const info = await this.service.taskInfo(el.task.id, { checkSvn: false });
        const out = [];
        if (info.worktree && info.worktree.dirty && info.worktree.dirty.length) {
          const it = new vscode.TreeItem(`커밋되지 않은 변경 ${info.worktree.dirty.length}개`);
          it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
          out.push({ kind: 'hint', item: it });
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
