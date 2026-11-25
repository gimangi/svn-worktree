'use strict';
/**
 * Tools of the svnwt agent. Every file path is confined to the task worktree (real path check, so
 * junctions that point into the SVN working copy are rejected as well).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { decode } = require('../core/proc');
const enc = require('./encoding');

const MAX_READ_LINES = 2000;
const MAX_OUT = 16000;

function realOrNearest(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch (_) { /* go up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = parent;
  }
}
const inside = (child, parent) => {
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + path.sep);
};

function clip(s, max = MAX_OUT) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n… (${s.length - max}자 생략) …\n${s.slice(-half)}`;
}

function resolvePath(ctx, p) {
  const abs = path.resolve(ctx.task.workPath, p || '.');
  const real = realOrNearest(abs);
  if (!inside(real, ctx.realWork)) {
    throw new Error(`작업 worktree 밖의 경로라 사용할 수 없습니다: ${p}\n이 작업의 파일은 ${ctx.task.workPath} 아래에 있습니다 (SVN working copy 원본·연결 폴더는 읽기/수정 불가).`);
  }
  const rel = path.relative(ctx.task.workPath, abs);
  if (rel.split(/[\\/]/)[0] === '.git') throw new Error('.git 내부는 다룰 수 없습니다.');
  return abs;
}

const relOf = (ctx, abs) => path.relative(ctx.task.workPath, abs).split(path.sep).join('/') || '.';

function runProcess(cmd, args, { cwd, timeoutMs, input }) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE; // child tools (Edge, Electron apps) must not inherit it
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    const out = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) { child.kill(); } }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: e.message, killed }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: decode(Buffer.concat(out)), killed }); });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

const S = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a text file in the task worktree. Returns numbered lines. Use offset/limit for big files.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: S('Path relative to the worktree root.'), offset: { type: 'number', description: '1-based first line' }, limit: { type: 'number', description: 'number of lines (max 2000)' } } },
    async run(ctx, a) {
      const abs = resolvePath(ctx, a.path);
      if (!fs.existsSync(abs)) throw new Error(`파일이 없습니다: ${a.path}`);
      if (fs.statSync(abs).isDirectory()) throw new Error(`폴더입니다. list_dir 를 쓰세요: ${a.path}`);
      const f = enc.readText(abs);
      if (f.binary) return `${a.path}: 바이너리 파일 (${fs.statSync(abs).size} bytes)`;
      const lines = f.text.replace(/\r\n/g, '\n').split('\n');
      const start = Math.max(1, a.offset || 1);
      const count = Math.min(a.limit || MAX_READ_LINES, MAX_READ_LINES);
      const body = lines.slice(start - 1, start - 1 + count).map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
      const more = start - 1 + count < lines.length ? `\n… (전체 ${lines.length}줄, offset=${start + count} 로 이어 읽기)` : '';
      return `${relOf(ctx, abs)} [${f.encoding}, ${f.eol === '\r\n' ? 'CRLF' : 'LF'}]\n${body}${more}`;
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders of a directory in the task worktree.',
    inputSchema: { type: 'object', properties: { path: S('Directory relative to the worktree root (default ".").') } },
    async run(ctx, a) {
      const abs = resolvePath(ctx, a.path || '.');
      const ents = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== '.git');
      return ents.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort().join('\n') || '(비어 있음)';
    },
  },
  {
    name: 'find_files',
    description: 'Find files by glob in the task worktree (tracked and new files, ignores build outputs). Example: "**/*.cpp".',
    inputSchema: { type: 'object', required: ['glob'], properties: { glob: S('Glob, e.g. "src/**/*.h"') } },
    async run(ctx, a) {
      const r = await runProcess(ctx.gitExe, ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '--', `:(glob)${a.glob}`], { cwd: ctx.task.workPath, timeoutMs: 30000 });
      const lines = r.output.split(/\r?\n/).filter(Boolean);
      return lines.length ? clip(lines.slice(0, 500).join('\n') + (lines.length > 500 ? `\n… 외 ${lines.length - 500}개` : '')) : '일치하는 파일 없음';
    },
  },
  {
    name: 'search',
    description: 'Search file contents in the task worktree with a regular expression (git grep). Returns file:line:text.',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: S('Extended regular expression'), path: S('Limit to a folder or glob (optional)'), ignore_case: { type: 'boolean' } } },
    async run(ctx, a) {
      const args = ['-c', 'core.quotepath=false', 'grep', '-n', '-I', '-E', '--untracked'];
      if (a.ignore_case) args.push('-i');
      args.push('-e', a.pattern, '--');
      if (a.path) args.push(a.path.includes('*') ? `:(glob)${a.path}` : a.path);
      const r = await runProcess(ctx.gitExe, args, { cwd: ctx.task.workPath, timeoutMs: 60000 });
      if (r.code === 1) return '일치하는 내용 없음';
      const lines = r.output.split(/\r?\n/).filter(Boolean);
      return clip(lines.slice(0, 300).join('\n') + (lines.length > 300 ? `\n… 외 ${lines.length - 300}줄` : ''));
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the task worktree. Existing files keep their encoding (UTF-8/CP949) and line endings. Prefer edit_file for small changes.',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: S('Path relative to the worktree root'), content: S('Full file content') } },
    async run(ctx, a) {
      const abs = resolvePath(ctx, a.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      const style = enc.writeText(abs, a.content, { defaultEol: ctx.newFileEol });
      ctx.changed.add(relOf(ctx, abs));
      return `${existed ? '덮어씀' : '새 파일'}: ${relOf(ctx, abs)} (${style.encoding}, ${style.eol === '\r\n' ? 'CRLF' : 'LF'})`;
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact text in a file of the task worktree. old_string must match exactly once unless replace_all. Line endings are handled for you (write "\\n").',
    inputSchema: { type: 'object', required: ['path', 'old_string', 'new_string'], properties: { path: S('Path relative to the worktree root'), old_string: S('Exact text to replace (include enough context to be unique)'), new_string: S('Replacement text'), replace_all: { type: 'boolean' } } },
    async run(ctx, a) {
      const abs = resolvePath(ctx, a.path);
      if (!fs.existsSync(abs)) throw new Error(`파일이 없습니다: ${a.path}`);
      const f = enc.readText(abs);
      if (f.binary) throw new Error('바이너리 파일은 수정할 수 없습니다.');
      const text = f.text.replace(/\r\n/g, '\n');
      const oldS = String(a.old_string).replace(/\r\n/g, '\n');
      const newS = String(a.new_string).replace(/\r\n/g, '\n');
      if (!oldS) throw new Error('old_string 이 비어 있습니다.');
      const n = text.split(oldS).length - 1;
      if (n === 0) throw new Error('old_string 과 정확히 일치하는 부분이 없습니다. read_file 로 현재 내용을 확인하세요.');
      if (n > 1 && !a.replace_all) throw new Error(`old_string 이 ${n}곳과 일치합니다. 앞뒤 문맥을 더 넣거나 replace_all=true 를 쓰세요.`);
      const out = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      fs.writeFileSync(abs, enc.encodeText(enc.toEol(out, f.eol), f.encoding));
      ctx.changed.add(relOf(ctx, abs));
      return `수정: ${relOf(ctx, abs)} (${n}곳)`;
    },
  },
  {
    name: 'run_command',
    description: 'Run a PowerShell command in the task worktree (build, tests, git status…). Needs the user\'s approval unless auto-approved. Never use it to modify the SVN working copy or run svn commit.',
    inputSchema: { type: 'object', required: ['command'], properties: { command: S('PowerShell command'), timeout_sec: { type: 'number', description: 'default 300' } } },
    async run(ctx, a) {
      if (/\bsvn(\.exe)?\s+(commit|ci|revert|update|up|switch|sw|delete|del|rm|remove|move|mv|add|lock|cleanup)\b/i.test(a.command)) {
        throw new Error('svn 의 쓰기 명령은 쓸 수 없습니다. SVN 반영은 svn_changelist 도구, 커밋은 사람이 합니다.');
      }
      const ok = await ctx.approveCommand(a.command);
      if (!ok) return '사용자가 명령 실행을 거부했습니다. 다른 방법을 쓰거나 사용자에게 물어보세요.';
      const shell = ctx.shell || 'powershell.exe';
      const r = await runProcess(shell, ['-NoProfile', '-NonInteractive', '-Command', a.command], { cwd: ctx.task.workPath, timeoutMs: (a.timeout_sec || 300) * 1000 });
      return `exit ${r.code}${r.killed ? ' (시간 초과로 중단)' : ''}\n${clip(r.output.trim())}`;
    },
  },
  {
    name: 'git_commit',
    description: 'Commit all current changes of the task worktree (git add -A + commit). Commit after each logical step.',
    inputSchema: { type: 'object', required: ['message'], properties: { message: S('Commit message (first line = summary)') } },
    async run(ctx, a) {
      const r = await ctx.service.commitTask(ctx.task.id, a.message);
      return r.committed ? `커밋 ${String(r.sha).slice(0, 8)}: ${a.message.split('\n')[0]}` : r.message;
    },
  },
  {
    name: 'task_status',
    description: 'State of the task: changed files vs. the SVN base, commits, uncommitted files, changelist state.',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const i = await ctx.service.taskInfo(ctx.task.id, { checkSvn: false });
      return JSON.stringify({
        status: i.task.status, baseIsLatest: i.baseIsLatest, commits: i.commits.map((c) => c.subject),
        files: i.files.map((f) => `${f.status} ${f.path} +${f.add || 0} -${f.del || 0}`), uncommitted: i.worktree.dirty.map((d) => `${d.code} ${d.path}`),
      }, null, 1);
    },
  },
  {
    name: 'task_diff',
    description: 'Unified diff of the task against its SVN base (uncommitted=true includes uncommitted edits).',
    inputSchema: { type: 'object', properties: { file: S('Optional single file'), uncommitted: { type: 'boolean' } } },
    async run(ctx, a) {
      const d = await ctx.service.diffTask(ctx.task.id, { file: a.file, uncommitted: !!a.uncommitted, maxChars: 30000 });
      return d.diff || '(변경 없음)';
    },
  },
  {
    name: 'svn_changelist',
    description: 'When the work is finished and committed: apply the task to the SVN working copy as its changelist (dry_run first to preview). The human then commits from the SVN Worktree panel.',
    inputSchema: { type: 'object', properties: { dry_run: { type: 'boolean' } } },
    async run(ctx, a) {
      const r = await ctx.service.requestChangelist(ctx.task.id, { dryRun: !!a.dry_run });
      if (r.ready) return JSON.stringify({ ok: true, ready: true, files: r.files.map((f) => `${f.status} ${f.path}`), message: r.message }, null, 1);
      return JSON.stringify({ ok: r.ok, changelist: r.changelist, files: r.files.map((f) => `${f.action} ${f.path}${f.sharedWith ? ' (shared)' : ''}`), blocked: r.blocked, next: r.next }, null, 1);
    },
  },
  {
    name: 'sync_svn',
    description: 'Rebase the task on the latest SVN state (after other people committed). On conflicts fix the files and call again with cont=true.',
    inputSchema: { type: 'object', properties: { cont: { type: 'boolean' }, abort: { type: 'boolean' } } },
    async run(ctx, a) { return JSON.stringify(await ctx.service.syncTask(ctx.task.id, { cont: !!a.cont, abort: !!a.abort }), null, 1); },
  },
  {
    name: 'attach_screenshots',
    description: 'After running UI tests (e.g. Playwright) attach screenshots so the user sees them in the review panel. Without paths it collects test-results/ automatically.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, title: S('Label'), summary: S('What was tested') } },
    async run(ctx, a) { return JSON.stringify(await ctx.service.attachArtifacts(ctx.task.id, { paths: a.paths, title: a.title, summary: a.summary })); },
  },
];

/** Short human label for progress / logs. */
function describe(name, a) {
  switch (name) {
    case 'read_file': return `읽기 ${a.path}`;
    case 'list_dir': return `목록 ${a.path || '.'}`;
    case 'find_files': return `파일 찾기 ${a.glob}`;
    case 'search': return `검색 "${a.pattern}"${a.path ? ` in ${a.path}` : ''}`;
    case 'write_file': return `작성 ${a.path}`;
    case 'edit_file': return `수정 ${a.path}`;
    case 'run_command': return `실행 ${a.command}`;
    case 'git_commit': return `커밋 "${String(a.message || '').split('\n')[0]}"`;
    case 'svn_changelist': return a.dry_run ? 'SVN 반영 미리보기' : 'SVN changelist 만들기';
    default: return name;
  }
}

async function runTool(ctx, name, input) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`알 수 없는 도구: ${name}`);
  return t.run(ctx, input || {});
}

module.exports = { TOOLS, runTool, describe, resolvePath, realOrNearest };
