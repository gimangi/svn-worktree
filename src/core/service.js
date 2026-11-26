'use strict';
/**
 * svnwt core service: SVN working copy sub-path <-> git repository with per-task worktrees.
 *
 * Model
 *  - scope   : one directory inside an SVN working copy that is mirrored into a bare git repo.
 *              branch `svn-base` = pristine (BASE) state of that directory, re-snapshotted on refresh.
 *  - task    : branch `task/<id>` + linked worktree outside the SVN working copy. Agents edit there.
 *  - land    : 3-way apply of the task's changes onto the SVN working copy and grouping the touched
 *              files into SVN changelist `svnwt-<id>`. The human commits that changelist.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('./proc');
const rules = require('./rules');
const { decode } = proc;
const { Git } = require('./git');
const { Svn } = require('./svn');
const env = require('./env');
const store = require('./store');

const BASE_BRANCH = 'svn-base';
const BASE_REF = 'refs/heads/' + BASE_BRANCH;
const TEST_OPEN = ['queued', 'asking', 'building', 'applied']; // test requests not finished yet
const BOT = { GIT_AUTHOR_NAME: 'svnwt', GIT_AUTHOR_EMAIL: 'svnwt@localhost', GIT_COMMITTER_NAME: 'svnwt', GIT_COMMITTER_EMAIL: 'svnwt@localhost' };
const SVN_DEFAULT_GLOBAL_IGNORES = '*.o *.lo *.la *.al .libs *.so *.so.[0-9]* *.a *.pyc *.pyo __pycache__ *.rej *~ #*# .#* .*.swp .DS_Store [Tt]humbs.db';

// ---------------------------------------------------------------- path helpers
const norm = (p) => path.resolve(p);
/** Long, case-correct path (resolves 8.3 short names such as C:\Users\GIMANG~1 that svn treats as different paths). */
function real(p) {
  const r = path.resolve(p);
  try { return fs.realpathSync.native(r); } catch (_) { /* may not exist */ }
  try { return path.join(fs.realpathSync.native(path.dirname(r)), path.basename(r)); } catch (_) { return r; }
}
const key = (p) => norm(p).toLowerCase();
function isInside(child, parent) {
  const c = key(child);
  const p = key(parent).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + path.sep);
}
const toPosix = (p) => p.split(path.sep).join('/');
const relPosix = (base, p) => toPosix(path.relative(base, p));
const fromPosix = (base, rel) => path.join(base, ...rel.split('/'));
const bufEq = (a, b) => (a === null || a === undefined ? (b === null || b === undefined) : (b !== null && b !== undefined && Buffer.compare(a, b) === 0));
const isBinary = (b) => !!b && b.subarray(0, 8000).includes(0);
const hashBuf = (b) => require('crypto').createHash('sha1').update(b).digest('hex');

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '');
}

function readFileOrNull(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return fs.readFileSync(p);
  } catch (_) {
    return null;
  }
}

function now() { return new Date().toISOString(); }

/**
 * svn reads --targets files in the ANSI code page (e.g. CP949). Non-ASCII content is written through
 * Windows PowerShell's [Text.Encoding]::Default, which is the ANSI code page.
 */
function writeNativeText(file, text) {
  if (/^[\x00-\x7f]*$/.test(text) || process.platform !== 'win32') { fs.writeFileSync(file, text, 'utf8'); return; }
  const { spawnSync } = require('child_process');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[IO.File]::WriteAllText($env:SVNWT_OUT_FILE, $env:SVNWT_OUT_TEXT, [Text.Encoding]::Default)'],
  { env: Object.assign({}, process.env, { SVNWT_OUT_FILE: file, SVNWT_OUT_TEXT: text }), windowsHide: true });
  if (r.status !== 0) fs.writeFileSync(file, text, 'utf8');
}

// ---------------------------------------------------------------- service
class Service {
  constructor() {
    this._tools = null;
  }

  async tools() {
    if (!this._tools) this._tools = await env.requireTools();
    return this._tools;
  }

  async svn() { return new Svn((await this.tools()).svn.path); }
  async git(scope) { return new Git((await this.tools()).git.path, scope ? scope.gitDir : null); }

  // ------------------------------------------------------------ environment
  async environment() {
    const t = await env.detect(true);
    const problems = [];
    if (!t.git) problems.push(env.GIT_MISSING_MESSAGE);
    if (!t.svn) problems.push(env.SVN_MISSING_MESSAGE);
    return { git: t.git, svn: t.svn, tortoiseProc: t.tortoiseProc, appHome: store.appHome(), ok: problems.length === 0, problems };
  }

  // ------------------------------------------------------------ scopes
  listScopes() {
    const reg = store.loadRegistry();
    return reg.scopes.map((s) => this._loadScope(s.home)).filter(Boolean);
  }

  _loadScope(home) {
    const s = store.readJson(path.join(home, 'scope.json'), null);
    return s;
  }

  _saveScope(scope) {
    store.writeJson(path.join(scope.home, 'scope.json'), scope);
    store.touchEvents({ scope: scope.id });
  }

  /** Resolve a scope by id, name, or any path inside its SVN directory / task worktrees. */
  resolveScope(ref) {
    const scopes = this.listScopes();
    if (!ref) {
      if (scopes.length === 1) return scopes[0];
      throw new Error(scopes.length ? `scope를 지정하세요. 등록된 scope: ${scopes.map((s) => s.id).join(', ')}` : '등록된 scope가 없습니다. svnwt_scope_init 으로 먼저 등록하세요.');
    }
    const byId = scopes.find((s) => s.id === ref || s.name === ref);
    if (byId) return byId;
    if (/[\\/:]/.test(ref)) {
      const hit = this.findByPath(ref);
      if (hit.scope) return hit.scope;
    }
    throw new Error(`scope를 찾을 수 없습니다: ${ref}`);
  }

  /** Map an arbitrary path to scope / task. */
  findByPath(p) {
    const abs = real(p);
    const scopes = this.listScopes();
    // worktree paths first (more specific)
    for (const s of scopes) {
      for (const t of this._listTaskFiles(s)) {
        if (t.status === 'archived') continue;
        if (isInside(abs, t.worktree)) {
          const inWork = isInside(abs, t.workPath);
          return { scope: s, task: t, location: inWork ? 'worktree' : 'worktree-outside-scope', rel: inWork ? relPosix(t.workPath, abs) : null };
        }
      }
    }
    // most specific SVN scope
    let best = null;
    for (const s of scopes) {
      if (isInside(abs, s.svnPath) && (!best || s.svnPath.length > best.svnPath.length)) best = s;
    }
    if (best) return { scope: best, task: null, location: 'svn', rel: relPosix(best.svnPath, abs) };
    // path that contains a scope (e.g. the WC root)
    const contained = scopes.filter((s) => isInside(s.svnPath, abs));
    return { scope: null, task: null, location: null, containedScopes: contained.map((s) => s.id) };
  }

  async initScope(svnPath, opts = {}) {
    const svn = await this.svn();
    const abs = real(svnPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`디렉터리가 아닙니다: ${abs}`);
    let info;
    try {
      info = await svn.info(abs);
    } catch (e) {
      throw new Error(`SVN working copy가 아닙니다: ${abs}\n${e.message}`);
    }
    if (!info || info.kind !== 'dir') throw new Error(`SVN 디렉터리가 아닙니다: ${abs}`);
    const existing = this.listScopes().find((s) => key(s.svnPath) === key(abs));
    if (existing) return { scope: existing, created: false, snapshot: await this.refreshScope(existing.id) };

    const overlaps = this.listScopes().filter((s) => isInside(s.svnPath, abs) || isInside(abs, s.svnPath)).map((s) => s.id);
    const wcRoot = info.wcRoot ? norm(info.wcRoot) : abs;
    const relPath = relPosix(wcRoot, abs);
    const reg = store.loadRegistry();
    let name = slugify(opts.name || path.basename(abs)) || 'scope';
    const taken = new Set(reg.scopes.map((s) => s.id));
    let id = name;
    for (let i = 2; taken.has(id); i++) id = `${name}-${i}`;

    let home = opts.home ? norm(opts.home) : null;
    if (!home) {
      const parent = path.dirname(wcRoot);
      home = parent === wcRoot
        ? path.join(store.appHome(), 'scopes', id)
        : path.join(parent, path.basename(wcRoot) + '.svnwt', id);
    }
    if (isInside(home, wcRoot)) throw new Error(`scope 저장 위치는 SVN working copy 밖이어야 합니다: ${home}`);
    store.ensureDir(home);
    const gitDir = path.join(home, 'repo.git');
    const git = new Git((await this.tools()).git.path, gitDir);
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      await git.exec(['init', '--bare', '--quiet', gitDir], {});
    }
    const cfg = [
      ['core.longpaths', 'true'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.filemode', 'false'],
      ['core.symlinks', 'false'], ['core.quotepath', 'false'], ['core.precomposeunicode', 'true'], ['gc.auto', '0'],
      ['core.fsmonitor', 'false'], ['rebase.autoStash', 'false'],
    ];
    for (const [k, v] of cfg) await git.exec(['config', k, v]);
    const hasName = (await git.raw(['config', '--get', 'user.name'])).code === 0;
    if (!hasName) {
      await git.exec(['config', 'user.name', os.userInfo().username || 'svnwt']);
      await git.exec(['config', 'user.email', `${os.userInfo().username || 'svnwt'}@localhost`]);
    }
    store.ensureDir(path.join(gitDir, 'info'));
    // Never let in-tree .gitattributes change bytes: SVN files must round-trip exactly.
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* -text -filter -ident\n', 'utf8');

    const scope = {
      id, name, svnPath: abs, wcRoot, relPath,
      url: info.url, relativeUrl: info.relativeUrl, repoRoot: info.repoRoot, uuid: info.uuid,
      revision: info.revision, home, gitDir,
      worktreeRoot: path.join(home, 'wt'),
      linkOutside: !!opts.linkOutside,
      createdAt: now(), baseCommit: null, lastSnapshotAt: null,
    };
    this._saveScope(scope);
    reg.scopes.push({ id, name, svnPath: abs, home });
    store.saveRegistry(reg);
    const snap = await this.refreshScope(id);
    return { scope: this.resolveScope(id), created: true, overlaps, snapshot: snap };
  }

  async removeScope(ref, { force = false } = {}) {
    const scope = this.resolveScope(ref);
    const live = this._listTaskFiles(scope).filter((t) => t.status !== 'archived');
    if (live.length && !force) throw new Error(`활성 작업이 있습니다: ${live.map((t) => t.id).join(', ')}. 먼저 작업을 정리하거나 force=true 를 사용하세요.`);
    for (const t of live) await this.removeTask(t.id, { force: true });
    const reg = store.loadRegistry();
    reg.scopes = reg.scopes.filter((s) => s.id !== scope.id);
    store.saveRegistry(reg);
    return { removed: scope.id, note: `저장소 데이터는 남겨두었습니다: ${scope.home}` };
  }

  /**
   * Snapshot the SVN pristine (BASE) state of the scope into branch svn-base.
   * @param {{svnUpdate?:boolean}} opts
   */
  async refreshScope(ref, opts = {}) {
    const scope = this.resolveScope(ref);
    return store.withLock(path.join(scope.home, 'lock'), () => this._snapshot(scope, opts), { op: `${scope.id}: SVN 기준 읽기 (snapshot${opts.svnUpdate ? ' + svn update' : ''})` });
  }

  async _snapshot(scope, { svnUpdate = false } = {}) {
    const svn = await this.svn();
    const git = await this.git(scope);
    const started = Date.now();
    let updateOutput = null;
    if (svnUpdate) updateOutput = (await svn.exec(['update', '--accept', 'postpone', scope.svnPath])).trim();
    const info = await svn.info(scope.svnPath);
    const T = { start: started };
    const lap = (k) => { T[k] = Date.now() - (T._last || T.start); T._last = Date.now(); };
    lap('svnUpdateAndInfoMs');
    const entries = await svn.status(scope.svnPath, { verbose: true });
    lap('svnStatusMs');

    const working = [];
    const pristine = [];
    const unknown = [];
    const revs = new Set();
    for (const e of entries) {
      if (!isInside(e.path, scope.svnPath) || key(e.path) === key(scope.svnPath)) continue;
      const rel = relPosix(scope.svnPath, e.path);
      if (rel.split('/').includes('.svn')) continue;
      switch (e.item) {
        case 'normal': {
          let st = null;
          try { st = fs.lstatSync(e.path); } catch (_) { /* gone */ }
          if (st && st.isFile()) { working.push(rel); if (e.revision) revs.add(e.revision); }
          else if (!st) unknown.push(e);
          break;
        }
        case 'modified': case 'conflicted': case 'replaced': case 'merged': {
          let st = null;
          try { st = fs.lstatSync(e.path); } catch (_) { /* gone */ }
          if (!st || st.isFile()) pristine.push(rel);
          break;
        }
        case 'deleted': case 'missing': case 'obstructed': case 'incomplete':
          unknown.push(e);
          break;
        default: // added, unversioned, ignored, external, none
          break;
      }
    }
    if (unknown.length) {
      const infos = await svn.infoMany(unknown.map((e) => e.path));
      const files = new Set(infos.filter((i) => i.kind === 'file').map((i) => key(i.path)));
      for (const e of unknown) if (files.has(key(e.path))) pristine.push(relPosix(scope.svnPath, e.path));
    }

    const indexFile = path.join(scope.home, 'snapshot.index');
    const gopts = { workTree: scope.svnPath, cwd: scope.svnPath, env: { GIT_INDEX_FILE: indexFile } };
    const current = decode(await git.buf(['ls-files', '-z'], gopts)).split('\0').filter(Boolean);
    const wanted = new Set(working);
    const pristineSet = new Set(pristine);
    const toRemove = current.filter((p) => !wanted.has(p) && !pristineSet.has(p));
    if (toRemove.length) await git.buf(['update-index', '-z', '--force-remove', '--stdin'], { ...gopts, input: toRemove.join('\0') + '\0' });
    if (working.length) await git.buf(['update-index', '-z', '--add', '--remove', '--stdin'], { ...gopts, input: working.join('\0') + '\0' });
    lap('hashFilesMs');
    const infoLines = [];
    const pristineFailed = [];
    for (const rel of pristine) {
      const content = await svn.catBase(fromPosix(scope.svnPath, rel));
      if (content === null) { pristineFailed.push(rel); continue; }
      const sha = await git.hashObject(content);
      infoLines.push(`100644 ${sha}\t${rel}`);
    }
    if (infoLines.length) await git.buf(['update-index', '-z', '--index-info'], { ...gopts, input: infoLines.join('\0') + '\0' });
    lap('pristineMs');
    const tree = (await git.exec(['write-tree'], gopts)).trim();

    const old = await git.revParse(BASE_REF);
    let commit = old;
    let changed = false;
    const minRev = revs.size ? Math.min(...revs) : info.revision;
    const maxRev = revs.size ? Math.max(...revs) : info.revision;
    if (!old || (await git.treeOf(old)) !== tree) {
      const msg = `svn r${info.revision} ${info.relativeUrl || info.url}\n\n` +
        (minRev !== maxRev ? `mixed-revision working copy: r${minRev}:r${maxRev}\n` : '') +
        `svn-url: ${info.url}\nsvn-revision: ${info.revision}\n`;
      const args = ['commit-tree', tree, '-F', '-'];
      if (old) args.splice(2, 0, '-p', old);
      commit = (await git.exec(args, { env: BOT, input: msg })).trim();
      await git.exec(['update-ref', BASE_REF, commit]);
      changed = true;
    }
    if (!(await git.raw(['symbolic-ref', 'HEAD'])).stdout.toString().includes(BASE_BRANCH)) {
      await git.raw(['symbolic-ref', 'HEAD', BASE_REF]);
    }
    lap('commitMs');
    await this._syncIgnores(scope, svn);
    lap('ignoresMs');

    scope.revision = info.revision;
    scope.url = info.url;
    scope.baseCommit = commit;
    scope.lastSnapshotAt = now();
    scope.mixedRevision = minRev !== maxRev ? `r${minRev}:r${maxRev}` : null;
    delete T._last; delete T.start;
    scope.lastSnapshot = Object.assign({ at: now(), totalMs: Date.now() - started, files: working.length + pristine.length, modifiedFiles: pristine.length }, T);
    this._saveScope(scope);
    return {
      scope: scope.id, revision: info.revision, baseCommit: commit, changed,
      files: working.length + infoLines.length, locallyModifiedUsingPristine: infoLines.length,
      pristineFailed, mixedRevision: scope.mixedRevision, elapsedMs: Date.now() - started, timings: scope.lastSnapshot, svnUpdate: updateOutput,
    };
  }

  /** Translate svn:ignore / svn:global-ignores into git info/exclude so task commits skip build outputs. */
  async _syncIgnores(scope, svn) {
    const lines = ['# generated by svnwt from svn ignore properties', '.svn/',
      '# test/tool outputs that must never be landed into SVN (tracked files are not affected)',
      'node_modules/', 'test-results/', 'playwright-report/', 'blob-report/', 'playwright/.cache/'];
    const esc = (p) => p.replace(/^([#!])/, '\\$1').replace(/\s+$/, '');
    const split = (v) => v.split(/[\r\n\t ]+/).map((s) => s.trim()).filter(Boolean);
    let globalIgnores = SVN_DEFAULT_GLOBAL_IGNORES;
    try {
      const cfg = fs.readFileSync(path.join(process.env.APPDATA || '', 'Subversion', 'config'), 'utf8');
      const m = /^\s*global-ignores\s*=\s*(.+)$/m.exec(cfg);
      if (m) globalIgnores = m[1];
    } catch (_) { /* default */ }
    for (const p of split(globalIgnores)) lines.push(esc(p));
    for (const v of await svn.propgetInherited('svn:global-ignores', scope.svnPath)) for (const p of split(v)) lines.push(esc(p));
    for (const r of await svn.propgetRecursive('svn:global-ignores', scope.svnPath)) {
      const rel = relPosix(scope.svnPath, r.path);
      for (const p of split(r.value)) lines.push(rel ? `/${rel}/**/${esc(p)}` : esc(p));
    }
    for (const r of await svn.propgetRecursive('svn:ignore', scope.svnPath)) {
      const rel = relPosix(scope.svnPath, r.path);
      for (const p of split(r.value)) lines.push(rel ? `/${rel}/${esc(p)}` : `/${esc(p)}`);
    }
    const extra = path.join(scope.home, 'exclude.txt');
    if (fs.existsSync(extra)) lines.push('# from exclude.txt', fs.readFileSync(extra, 'utf8'));
    store.ensureDir(path.join(scope.gitDir, 'info'));
    fs.writeFileSync(path.join(scope.gitDir, 'info', 'exclude'), lines.join('\n') + '\n', 'utf8');
  }

  // ------------------------------------------------------------ tasks
  _taskFile(scope, id) { return path.join(scope.home, 'tasks', id + '.json'); }
  _reviewFile(scope, id) { return path.join(scope.home, 'tasks', id + '.reviews.json'); }

  _listTaskFiles(scope) {
    const dir = path.join(scope.home, 'tasks');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    // tasks/<id>.json only (not <id>.reviews.json / <id>.artifacts.json)
    return names.filter((n) => /^[^.]+\.json$/.test(n))
      .map((n) => store.readJson(path.join(dir, n), null))
      .filter((t) => t && !Array.isArray(t) && t.id && t.branch)
      .sort((a, b) => (a.no || 0) - (b.no || 0));
  }

  _saveTask(scope, task) {
    task.updatedAt = now();
    store.writeJson(this._taskFile(scope, task.id), task);
    store.touchEvents({ scope: scope.id, task: task.id });
  }

  /**
   * New name for a task. The id, branch and worktree folder stay; the SVN changelist name follows the new name
   * while nothing of the task is in the SVN working copy yet (an existing changelist keeps its name).
   */
  renameTask(ref, title) {
    const { scope, task } = this.resolveTask(ref);
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('작업 이름이 비어 있습니다.');
    const old = task.title;
    if (t === old) return { task, old, changelist: task.changelist };
    task.title = t;
    if (task.status === 'active' && !task.landed && !this.pendingCommits().some((m) => m.task === task.id)) {
      const slug = slugify(t);
      task.changelist = `svnwt-${slug ? `${task.no}-${slug}` : task.no}`;
    }
    this._saveTask(scope, task);
    return { task, old, changelist: task.changelist };
  }

  /**
   * The human says a task marked 커밋 완료 is not committed (wrong detection, or the commit was reverted): back to
   * 진행 중, so 로컬 반영 / 커밋 준비 work again. The task's git commits are untouched; nothing in SVN changes.
   * Files of its changelist still in the working copy stay there (커밋 준비 sets them aside like any local change).
   */
  async reopenTask(ref) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status !== 'committed') throw new Error(`커밋 완료 상태인 작업만 되돌릴 수 있습니다 (지금: ${task.status}).`);
    const svn = await this.svn();
    const inWc = (await svn.status(scope.svnPath)).filter((e) => e.changelist === task.changelist).map((e) => relPosix(scope.svnPath, e.path));
    const was = { committedAt: task.committedAt || null, landed: task.landed || null };
    task.status = 'active';
    task.landed = null;
    delete task.committedAt;
    delete task.leftovers;
    delete task.commitVerified;
    task.reopenedAt = now();
    task.reopened = was;
    this._saveTask(scope, task);
    return { task: task.id, status: task.status, changelistInWc: inWc };
  }

  listTasks({ scope: scopeRef, includeArchived = false } = {}) {
    const scopes = scopeRef ? [this.resolveScope(scopeRef)] : this.listScopes();
    const res = [];
    for (const s of scopes) for (const t of this._listTaskFiles(s)) if (includeArchived || t.status !== 'archived') res.push(t);
    return res;
  }

  /** Resolve a task by id, branch name, changelist name, or a path inside its worktree. */
  resolveTask(ref) {
    if (!ref) throw new Error('task 를 지정하세요 (id 또는 worktree 경로).');
    const all = [];
    for (const s of this.listScopes()) for (const t of this._listTaskFiles(s)) all.push({ s, t });
    let hit = all.filter(({ t }) => t.id === ref || t.branch === ref || t.changelist === ref || String(t.no) === String(ref));
    if (!hit.length && /[\\/:]/.test(ref)) {
      const f = this.findByPath(ref);
      if (f.task) hit = all.filter(({ t }) => t.id === f.task.id);
    }
    if (!hit.length) hit = all.filter(({ t }) => t.id.startsWith(ref + '-'));
    if (!hit.length) throw new Error(`작업을 찾을 수 없습니다: ${ref}`);
    const live = hit.filter(({ t }) => t.status !== 'archived');
    const pick = (live.length ? live : hit)[0];
    return { scope: pick.s, task: pick.t };
  }

  /** Current locks (who holds them, for how long, whether the holder is still alive). */
  locks() {
    const res = [];
    const add = (scope, name, dir) => { const i = store.lockInfo(dir); if (i) res.push(Object.assign({ scope, name }, i)); };
    add(null, 'registry', path.join(store.appHome(), 'registry.lock'));
    for (const s of this.listScopes()) {
      add(s.id, 'scope', path.join(s.home, 'lock'));
      add(s.id, 'create', path.join(s.home, 'create.lock'));
    }
    return res;
  }

  /** Remove a lock. Without force only stale locks (holder gone / no heartbeat) are removed. */
  releaseLock(lockDir, { force = false } = {}) {
    const i = store.lockInfo(lockDir);
    if (!i) return { released: false, reason: '잠금이 없습니다.' };
    if (!i.stale && !force) return { released: false, reason: `"${i.op}" 이(가) 아직 진행 중입니다 (pid ${i.pid}).` };
    fs.rmSync(lockDir, { recursive: true, force: true });
    store.touchEvents({ lock: 'released' });
    return { released: true };
  }

  /** Scope-wide lock for operations that change the SVN working copy or the svn-base branch. */
  _scopeLock(scope, op, fn) {
    return store.withLock(path.join(scope.home, 'lock'), fn, { op });
  }

  /** Make sure the svn-base snapshot exists; concurrent callers run the snapshot only once. */
  async _ensureBase(scope) {
    const git = await this.git(scope);
    if (await git.revParse(BASE_REF)) return;
    await store.withLock(path.join(scope.home, 'lock'), async () => {
      if (await git.revParse(BASE_REF)) return; // another caller did it while we waited
      await this._snapshot(scope, {});
    }, { op: `${scope.id}: 첫 SVN 기준 읽기 (snapshot)` });
  }

  /**
   * Create a task: branch + linked worktree from svn-base.
   * Only the quick registration runs under a lock; the (possibly long) checkout of the scope's files
   * runs outside it, so several agents creating tasks at the same time work in parallel.
   */
  async createTask(scopeRef, { title, description = '' } = {}) {
    if (!title || !String(title).trim()) throw new Error('title 이 필요합니다.');
    const scope = this.resolveScope(scopeRef);
    const git = await this.git(scope);
    await this._ensureBase(scope);
    const no = await store.withLock(path.join(store.appHome(), 'registry.lock'), async () => {
      const reg = store.loadRegistry();
      const n = reg.nextTaskNo || 1;
      reg.nextTaskNo = n + 1;
      store.saveRegistry(reg);
      return n;
    }, { op: '작업 번호 발급', timeoutMs: 120000 });
    const slug = slugify(title);
    const id = slug ? `${no}-${slug}` : `${no}`;
    const branch = `task/${id}`;
    const worktree = path.join(scope.worktreeRoot, id);
    if (fs.existsSync(worktree)) throw new Error(`worktree 경로가 이미 존재합니다: ${worktree}`);
    const workPath = scope.linkOutside && scope.relPath ? fromPosix(worktree, scope.relPath) : worktree;
    const links = [];
    if (scope.linkOutside && scope.relPath) {
      // Mirror the WC layout: junction every sibling directory of every ancestor so relative paths
      // such as ../common/include keep working. Linked content is the live SVN working copy (read only by convention).
      const segs = scope.relPath.split('/');
      let orig = scope.wcRoot;
      let mirror = worktree;
      for (const seg of segs) {
        store.ensureDir(mirror);
        for (const ent of fs.readdirSync(orig, { withFileTypes: true })) {
          if (ent.name === seg || ent.name === '.svn') continue;
          const src = path.join(orig, ent.name);
          const dst = path.join(mirror, ent.name);
          try {
            if (ent.isDirectory()) { fs.symlinkSync(src, dst, 'junction'); links.push({ type: 'junction', path: dst, target: src }); }
            else if (ent.isFile()) { fs.copyFileSync(src, dst); links.push({ type: 'copy', path: dst, target: src }); }
          } catch (_) { /* skip */ }
        }
        orig = path.join(orig, seg);
        mirror = path.join(mirror, seg);
      }
    }
    store.ensureDir(path.dirname(workPath));
    // 1) register worktree + branch (fast, serialized per scope)
    await store.withLock(path.join(scope.home, 'create.lock'), async () => {
      const r = await git.raw(['worktree', 'add', '--no-checkout', '-b', branch, workPath, BASE_REF]);
      if (r.code !== 0) throw new Error(`git worktree add 실패: ${decode(r.stderr)}`);
    }, { op: `작업 #${no} worktree 등록`, timeoutMs: 5 * 60 * 1000 });
    // 2) check out the files (slow for big folders; parallel across tasks)
    const co = await git.raw(['reset', '--hard', '-q'], { cwd: workPath });
    if (co.code !== 0) throw new Error(`worktree 파일 체크아웃 실패 (${workPath}): ${decode(co.stderr)}`);
    const base = decode((await git.raw(['rev-parse', 'HEAD'], { cwd: workPath })).stdout).trim();
    const task = {
      id, no, scopeId: scope.id, title: String(title).trim(), description,
      branch, worktree, workPath, links,
      changelist: `svnwt-${id}`,
      status: 'active', baseCommit: base, baseRevision: scope.revision,
      createdAt: now(), updatedAt: now(), landed: null,
    };
    this._saveTask(scope, task);
    return task;
  }

  async _worktreeState(scope, task) {
    const git = await this.git(scope);
    if (!fs.existsSync(task.workPath)) return { exists: false, dirty: [], head: null, rebasing: false };
    const st = await git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: task.workPath });
    const dirty = decode(st.stdout).split('\0').filter(Boolean).filter((l) => /^.. /.test(l)).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
    const head = decode((await git.raw(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: task.workPath })).stdout).trim() || null;
    const gd = decode((await git.raw(['rev-parse', '--git-dir'], { cwd: task.workPath })).stdout).trim();
    const gdAbs = gd ? path.resolve(task.workPath, gd) : null;
    const rebasing = !!gdAbs && (fs.existsSync(path.join(gdAbs, 'rebase-merge')) || fs.existsSync(path.join(gdAbs, 'rebase-apply')));
    const merging = !!gdAbs && fs.existsSync(path.join(gdAbs, 'MERGE_HEAD'));
    return { exists: true, dirty, head, rebasing, merging };
  }

  async _range(scope, task) {
    const git = await this.git(scope);
    if (task.status === 'archived') {
      // archived: the commits are kept under refs/svnwt/archive/<id> (0.4.7 and earlier deleted the branch)
      const tip = task.archive && task.archive.ref ? await git.revParse(task.archive.ref) : null;
      if (!tip) throw new Error(`#${task.no} 은 커밋 기록 없이 정리된 작업입니다 (0.4.7 이하 버전에서 정리).`);
      return { git, tip, base: task.archive.base || (await git.mergeBase(BASE_REF, tip)) || task.baseCommit };
    }
    const tip = await git.revParse('refs/heads/' + task.branch);
    if (!tip) throw new Error(`브랜치가 없습니다: ${task.branch}`);
    const base = (await git.mergeBase(BASE_REF, tip)) || task.baseCommit;
    return { git, tip, base };
  }

  /** Files one git commit of the task changed (against its parent). */
  async commitFiles(ref, sha) {
    const { scope, task } = this.resolveTask(ref);
    const { git, tip, base } = await this._range(scope, task);
    const full = await git.revParse(String(sha));
    if (!full) throw new Error(`커밋을 찾을 수 없습니다: ${sha}`);
    const inTask = decode(await git.buf(['rev-list', `${base}..${tip}`])).split('\n').map((l) => l.trim()).includes(full);
    if (!inTask) throw new Error(`#${task.no} 작업의 커밋이 아닙니다: ${String(sha).slice(0, 8)}`);
    const parent = (await git.revParse(`${full}^`)) || base;
    const subject = decode(await git.buf(['log', '-1', '--format=%s', full])).trim();
    const stats = await git.numstat(parent, full);
    const files = (await git.nameStatus(parent, full)).map((f) => Object.assign({}, f, stats[f.path] || {}));
    return { scope: scope.id, task: task.id, sha: full, parent, subject, files };
  }

  async taskInfo(ref, { checkSvn = true } = {}) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status === 'archived') return this._archivedInfo(scope, task);
    if (checkSvn && task.status === 'landed') await this._detectCommitted(scope, task);
    if (checkSvn && task.status === 'committed') await this._verifyCommitted(scope, task);
    const { git, tip, base } = await this._range(scope, task);
    const files = await git.nameStatus(base, tip);
    const stats = await git.numstat(base, tip);
    const log = decode(await git.buf(['log', '--format=%H%x1f%an%x1f%aI%x1f%s', `${base}..${tip}`]))
      .split('\n').filter(Boolean).map((l) => { const [sha, author, date, subject] = l.split('\x1f'); return { sha, author, date, subject }; });
    const [ahead, behind] = decode(await git.buf(['rev-list', '--left-right', '--count', `${tip}...${BASE_REF}`])).trim().split(/\s+/).map(Number);
    const wt = await this._worktreeState(scope, task);
    const reviews = this.listReviews(task.id);
    const res = {
      task, scope: this._scopeSummary(scope),
      tip, base, baseIsLatest: behind === 0, commitsAhead: ahead, svnBaseCommitsBehind: behind,
      commits: log,
      files: files.map((f) => Object.assign({}, f, stats[f.path] || {})),
      worktree: wt,
      reviews: reviews.map((r) => ({ at: r.at, reviewer: r.reviewer, verdict: r.verdict, summary: r.summary, comments: (r.comments || []).length })),
    };
    if (task.status === 'landed') res.commit = await this.commitHelp(scope, task);
    if (task.status === 'committed') {
      res.leftovers = checkSvn ? (await this.leftovers(task.id)).map((x) => x.path) : (task.leftovers || []);
      if (checkSvn && JSON.stringify(res.leftovers) !== JSON.stringify(task.leftovers || [])) { task.leftovers = res.leftovers; this._saveTask(scope, task); }
    }
    Object.assign(res, this._order(scope, task));
    if (task.status === 'active' || task.status === 'landed') res.occupants = checkSvn ? await this.wcOccupantsLive(task.id).catch(() => this.wcOccupants(task.id)) : this.wcOccupants(task.id);
    const marker = this._commitMarker(scope);
    if (marker && marker.kind === 'test') { const ts = this.testState(scope.id) || {}; res.testInProgress = { task: marker.task, at: marker.at, sha: marker.sha, mine: marker.task === task.id, phase: marker.phase, ready: !!ts.ready, building: !!ts.building }; }
    else if (marker) res.commitInProgress = { task: marker.task, at: marker.at, external: !!marker.external, mine: marker.task === task.id };
    return res;
  }

  /** History of an archived task: its kept commits, files, reviews (no worktree, no SVN state). */
  async _archivedInfo(scope, task) {
    const reviews = this.listReviews(task.id).map((r) => ({ at: r.at, reviewer: r.reviewer, verdict: r.verdict, summary: r.summary, comments: (r.comments || []).length }));
    const res = { task, scope: this._scopeSummary(scope), archived: true, commits: [], files: [], reviews, history: false };
    let range;
    try { range = await this._range(scope, task); } catch (_) { return res; }
    const { git, tip, base } = range;
    const stats = await git.numstat(base, tip);
    res.files = (await git.nameStatus(base, tip)).map((f) => Object.assign({}, f, stats[f.path] || {}));
    res.commits = decode(await git.buf(['log', '--format=%H%x1f%an%x1f%aI%x1f%s', `${base}..${tip}`]))
      .split('\n').filter(Boolean).map((l) => { const [sha, author, date, subject] = l.split('\x1f'); return { sha, author, date, subject }; });
    return Object.assign(res, { tip, base, history: true });
  }

  /** Archived tasks, most recently archived first. */
  listArchived({ scope: scopeRef } = {}) {
    const scopes = scopeRef ? [this.resolveScope(scopeRef)] : this.listScopes();
    const res = [];
    for (const s of scopes) for (const t of this._listTaskFiles(s)) if (t.status === 'archived') res.push(Object.assign({ scope: s.id }, t));
    return res.sort((a, b) => String(b.archivedAt || b.updatedAt || '').localeCompare(String(a.archivedAt || a.updatedAt || '')) || (b.no || 0) - (a.no || 0));
  }

  /** Delete an archived task for good: its kept commits, reviews, agent session, attachments. */
  async purgeTask(ref) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status !== 'archived') throw new Error('보관된 작업만 기록을 삭제할 수 있습니다.');
    const git = await this.git(scope);
    if (task.archive && task.archive.ref) await git.raw(['update-ref', '-d', task.archive.ref]);
    const dir = path.join(scope.home, 'tasks');
    for (const n of fs.readdirSync(dir)) {
      if (n === task.id + '.json' || n.startsWith(task.id + '.')) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
    store.touchEvents({ scope: scope.id, task: task.id });
    return { task: task.id, purged: true };
  }

  // ------------------------------------------------------------ what is left in the SVN working copy (scope folder)
  /**
   * Local changes in the scope folder of the SVN working copy, e.g. what is left after a commit (set-aside edits
   * put back, files left unchecked). `locked`: files of a task waiting for its SVN commit (taken back with
   * "SVN 반영 되돌리기" instead).
   */
  async scopeChanges(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    const svn = await this.svn();
    const tasks = this._listTaskFiles(scope);
    const byCl = new Map(tasks.map((t) => [t.changelist, t]));
    const CHANGED = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged', 'unversioned'];
    // files and new folders of tasks waiting for their commit (folders cannot be in a changelist; shared files may be in another one)
    const landedOwner = new Map();
    for (const t of tasks.filter((x) => x.status === 'landed' && x.landed)) {
      for (const p of [...(t.landed.files || []), ...(t.landed.dirs || [])]) if (!landedOwner.has(p.toLowerCase())) landedOwner.set(p.toLowerCase(), t);
    }
    const out = [];
    for (const e of await svn.status(scope.svnPath)) {
      if (!CHANGED.includes(e.item) && e.props !== 'modified') continue;
      if (key(e.path) === key(scope.svnPath) && e.item !== 'modified' && e.props !== 'modified') continue;
      const byList = e.changelist ? byCl.get(e.changelist) : null;
      const owner = (byList && byList.status === 'landed' ? byList : null) || landedOwner.get(relPosix(scope.svnPath, e.path).toLowerCase()) || byList || null;
      let isDir = false;
      try { isDir = fs.statSync(e.path).isDirectory(); } catch (_) { /* missing / deleted */ }
      out.push({
        path: relPosix(scope.svnPath, e.path) || '.', abs: e.path, item: CHANGED.includes(e.item) ? e.item : 'modified', isDir,
        changelist: e.changelist, task: owner ? { id: owner.id, no: owner.no, title: owner.title, status: owner.status } : null,
        locked: !!(owner && owner.status === 'landed'),
      });
    }
    // a folder holding a locked file is locked too (reverting it would take the file along)
    for (const d of out.filter((c) => c.isDir && !c.locked)) {
      const child = out.find((c) => c.locked && c.path.toLowerCase().startsWith(d.path.toLowerCase() + '/'));
      if (child) { d.locked = true; d.task = child.task; }
    }
    return { scope: scope.id, svnPath: scope.svnPath, commitInProgress: !!this._commitMarker(scope), changes: out };
  }

  /**
   * Throw away the given local changes in the scope folder (paths relative to it). Every file is copied to
   * <scope home>/discarded/<time>/ first. Versioned changes are reverted, added and unversioned files deleted,
   * changelist membership removed. Files of a task waiting for its commit are refused.
   */
  async discardScopeChanges(scopeRef, paths) {
    const scope = this.resolveScope(scopeRef);
    this._assertNoCommitInProgress(scope);
    const svn = await this.svn();
    return store.withLock(path.join(scope.home, 'lock'), async () => {
      const all = (await this.scopeChanges(scope.id)).changes;
      const want = new Set((paths || []).map((p) => String(p).replace(/\\/g, '/')));
      const pick = all.filter((c) => want.has(c.path));
      const locked = pick.filter((c) => c.locked);
      if (locked.length) throw new Error(`커밋 대기 중인 작업의 파일입니다 (작업의 "SVN 반영 되돌리기" 사용): ${locked.map((c) => c.path).join(', ')}`);
      if (!pick.length) return { scope: scope.id, discarded: [], backup: null };
      const backup = store.ensureDir(path.join(scope.home, 'discarded', now().replace(/[:.]/g, '-')));
      for (const c of pick) {
        if (!fs.existsSync(c.abs)) continue;
        const dst = fromPosix(path.join(backup, 'files'), c.path);
        try { fs.cpSync(c.abs, dst, { recursive: true }); } catch (_) { /* best effort */ }
      }
      store.writeJson(path.join(backup, 'manifest.json'), { scope: scope.id, svnPath: scope.svnPath, at: now(), files: pick.map(({ abs, ...c }) => c) });
      const versioned = pick.filter((c) => c.item !== 'unversioned');
      if (versioned.length) await svn.withTargets(['revert', '--depth', 'infinity'], versioned.map((c) => c.abs), { okCodes: [1] });
      for (const c of pick.filter((x) => x.item === 'unversioned' || x.item === 'added')) {
        try { fs.rmSync(c.abs, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
      const listed = pick.filter((c) => c.changelist && fs.existsSync(c.abs) && !c.isDir).map((c) => c.abs);
      if (listed.length) await svn.withTargets(['changelist', '--remove'], listed, { okCodes: [1] });
      // committed tasks whose leftovers were among them
      for (const t of this._listTaskFiles(scope).filter((x) => x.status === 'committed' && (x.leftovers || []).length)) {
        const left = t.leftovers.filter((p) => !want.has(p));
        if (left.length !== t.leftovers.length) { t.leftovers = left; this._saveTask(scope, t); }
      }
      const rest = (await this.scopeChanges(scope.id)).changes.filter((c) => want.has(c.path));
      store.touchEvents({ scope: scope.id });
      return { scope: scope.id, discarded: pick.map((c) => c.path), failed: rest.map((c) => c.path), backup };
    }, { op: `${scope.id}: SVN 남은 변경 버리기` });
  }

  _scopeSummary(s) {
    return { id: s.id, svnPath: s.svnPath, url: s.url, revision: s.revision, mixedRevision: s.mixedRevision || null };
  }

  async commitTask(ref, message, { all = true } = {}) {
    const { scope, task } = this.resolveTask(ref);
    this._assertActive(task);
    const git = await this.git(scope);
    if (!message || !String(message).trim()) throw new Error('commit message 가 필요합니다.');
    if (all) await git.exec(['add', '-A'], { cwd: task.workPath });
    const r = await git.raw(['commit', '-F', '-'], { cwd: task.workPath, input: String(message) });
    const out = decode(r.stdout) + decode(r.stderr);
    if (r.code !== 0) {
      if (/nothing to commit|nothing added to commit|no changes added/i.test(out)) return { committed: false, message: '커밋할 변경이 없습니다.' };
      throw new Error(`git commit 실패: ${out.trim()}`);
    }
    const sha = await git.revParse('refs/heads/' + task.branch);
    this._saveTask(scope, task);
    return { committed: true, sha, summary: out.split('\n')[0] };
  }

  /**
   * Where one file's changes start: [{ old, new }] (1-based line numbers on the SVN-base side / the task side),
   * in file order. Compared like the diff editor shows it: base ↔ worktree file (archived: base ↔ kept tip).
   */
  async changeLines(ref, file, from = null) {
    const { scope, task } = this.resolveTask(ref);
    const { git, tip, base } = await this._range(scope, task);
    const live = task.status !== 'archived' && fs.existsSync(task.workPath);
    const args = ['diff', '--no-color', '-M', '-l0', '--no-ext-diff', '-U0', base];
    if (!live) args.push(tip);
    args.push('--', file);
    if (from && from !== file) args.push(from);
    const text = decode(await git.buf(args, live ? { cwd: task.workPath } : {}));
    const out = [];
    for (const l of text.split('\n')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) continue;
      const [a, b, c, d] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      out.push({ old: Math.max(1, b === 0 ? a + 1 : a), new: Math.max(1, d === 0 ? c + 1 : c) });
    }
    return out;
  }

  async diffTask(ref, { file = null, stat = false, maxChars = 60000, uncommitted = false } = {}) {
    const { scope, task } = this.resolveTask(ref);
    const { git, tip, base } = await this._range(scope, task);
    const args = ['diff', '--no-color', '-M', '-l0', '--no-ext-diff'];
    if (stat) args.push('--stat=200');
    let opts = {};
    if (uncommitted) { args.push(base); opts = { cwd: task.workPath }; } else args.push(base, tip);
    if (file) args.push('--', file);
    let text = decode(await git.buf(args, opts));
    let truncated = false;
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    const wt = await this._worktreeState(scope, task);
    return { task: task.id, base, tip, truncated, uncommittedFiles: uncommitted ? [] : wt.dirty.map((d) => d.path), diff: text };
  }

  async syncTask(ref, { strategy = 'rebase', refresh = true, svnUpdate = false, abort = false, cont = false } = {}) {
    const { scope, task } = this.resolveTask(ref);
    this._assertActive(task, true);
    const git = await this.git(scope);
    const cwd = task.workPath;
    const wt = await this._worktreeState(scope, task);
    if (abort) {
      if (wt.rebasing) await git.exec(['rebase', '--abort'], { cwd });
      if (wt.merging) await git.exec(['merge', '--abort'], { cwd });
      return { aborted: true };
    }
    if (cont) {
      let r;
      for (let attempt = 0; ; attempt++) {
        const add = await git.raw(['add', '-A'], { cwd });
        r = add.code !== 0 ? add : wt.rebasing
          ? await git.raw(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd })
          : await git.raw(['commit', '--no-edit'], { cwd });
        const text = decode(r.stdout) + decode(r.stderr);
        // the fix made this commit empty (same as the SVN side): skip it, as `git rebase --skip` would
        if (r.code !== 0 && wt.rebasing && /No changes|nothing to commit|nothing added to commit/i.test(text)) {
          r = await git.raw(['-c', 'core.editor=true', 'rebase', '--skip'], { cwd });
        }
        if (r.code === 0 || attempt >= 4 || !/index\.lock/.test(decode(r.stdout) + decode(r.stderr))) break;
        await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
      }
      // keep a rebase that the user / agent is resolving: never undo it here
      return this._syncResult(scope, task, git, r, { keep: true });
    }
    if (wt.rebasing || wt.merging) throw new Error('이전 sync 가 진행 중입니다. 충돌을 해결한 뒤 cont=true 로 계속하거나 abort=true 로 취소하세요.');
    if (wt.dirty.length) throw new Error(`worktree 에 커밋되지 않은 변경이 있습니다 (${wt.dirty.length}개). 먼저 svnwt_task_commit 을 호출하세요.`);
    // rebasing another branch (or a detached HEAD) would leave the task branch where it was: behind for ever
    if (wt.head !== task.branch) {
      throw new Error(`worktree 가 작업 브랜치(${task.branch})가 아니라 ${wt.head ? `"${wt.head}" 브랜치` : '특정 커밋(detached HEAD)'}에 있어 rebase 하지 않았습니다. worktree 에서 git switch ${task.branch} 로 돌아간 뒤 다시 하세요.`);
    }
    let snap = null;
    if (refresh || svnUpdate) snap = await this.refreshScope(scope.id, { svnUpdate });
    const text = (x) => decode(x.stdout) + decode(x.stderr);
    if (strategy !== 'merge') {
      // clean rebase without the worktree (see _rebaseObjects); the worktree is touched once at the end
      let o = null;
      try { o = await this._rebaseObjects(git, task); } catch (e) { this._step(`#${task.no} merge-tree rebase 생략: ${e.message}`); }
      if (o && o.tip) {
        if (!o.noop) {
          let mv;
          for (let attempt = 0; ; attempt++) {
            mv = await git.raw(['reset', '-q', '--keep', o.tip], { cwd });
            if (mv.code === 0 || attempt >= 5 || !/index\.lock/.test(text(mv))) break;
            await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
          }
          if (mv.code !== 0) throw new Error(`rebase 결과를 worktree 에 반영하지 못했습니다 (작업은 그대로): ${text(mv).trim().split(/\r?\n/).slice(0, 3).join(' / ')}`);
        }
        const res = await this._syncResult(scope, task, git, { code: 0, stdout: Buffer.from(o.noop ? '이미 최신 기준' : `rebase: 커밋 ${o.count}개를 새 기준 위로`), stderr: Buffer.alloc(0) });
        res.snapshot = snap;
        return res;
      }
      // a commit does not apply cleanly (or this git is too old): git rebase in the worktree leaves the conflict there
    }
    // another git in the same worktree (VS Code's own Git extension refreshing it, it is in the workspace) holds
    // index.lock for a moment: undo and try again instead of failing (0.5.0 showed that as a 0-file conflict)
    let r;
    for (let attempt = 0; ; attempt++) {
      r = strategy === 'merge'
        ? await git.raw(['merge', '--no-edit', BASE_REF], { cwd })
        : await git.raw(['rebase', BASE_REF], { cwd });
      if (r.code === 0 || attempt >= 4 || !/index\.lock/.test(decode(r.stdout) + decode(r.stderr))) break;
      const st = await this._worktreeState(scope, task);
      if (st.rebasing) await git.raw(['rebase', '--abort'], { cwd });
      if (st.merging) await git.raw(['merge', '--abort'], { cwd });
      this._step(`#${task.no} rebase: 다른 git 이 index.lock 을 쓰는 중, 다시 시도 (${attempt + 1})`);
      await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
    const res = await this._syncResult(scope, task, git, r);
    res.snapshot = snap;
    return res;
  }

  /**
   * Rebase the task branch onto the SVN base with objects only: every task commit is merged onto the new base
   * with `git merge-tree` and recorded with `commit-tree` (author, date and message kept). Nothing touches the
   * worktree, so another git using it meanwhile (VS Code's Git extension: worktrees are in the workspace) cannot
   * break the rebase between two commits. Returns {tip, count} (noop when already on the base), {conflict: true}
   * when a commit does not apply cleanly, or null when this git cannot do it (merge-tree --merge-base: git 2.40+).
   */
  async _rebaseObjects(git, task) {
    const tip = await git.revParse('refs/heads/' + task.branch);
    const onto = await git.revParse(BASE_REF);
    const mb = tip && onto ? await git.mergeBase(onto, tip) : null;
    if (!mb) return null;
    if (mb === onto) return { tip, noop: true, count: 0 };
    const list = decode(await git.buf(['rev-list', '--reverse', '--parents', `${mb}..${tip}`])).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(' '));
    if (list.some((p) => p.length !== 2)) return null; // merge commits: leave them to git rebase
    let cur = onto;
    let count = 0;
    for (const [c, parent] of list) {
      const m = await git.raw(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${parent}`, cur, c]);
      if (m.code === 1) return { conflict: true };
      if (m.code !== 0) return null;
      const tree = decode(m.stdout).trim().split(/\r?\n/)[0];
      if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
      if (tree === (await git.treeOf(cur))) continue; // already in SVN: dropped, as git rebase does
      const [name, email, date, ...msg] = decode(await git.buf(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', c])).split('\0');
      cur = (await git.exec(['commit-tree', tree, '-p', cur, '-F', '-'], { input: msg.join('\0'), env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date } })).trim();
      count++;
    }
    return { tip: cur, count };
  }

  /** Files left in conflict by a rebase / merge in the task worktree. */
  async conflictFiles(ref) {
    const { scope, task } = this.resolveTask(ref);
    const git = await this.git(scope);
    return decode((await git.raw(['diff', '--name-only', '--diff-filter=U'], { cwd: task.workPath })).stdout).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }

  async _syncResult(scope, task, git, r, { keep = false } = {}) {
    const out = (decode(r.stdout) + decode(r.stderr)).trim();
    this._step(`#${task.no} rebase (exit ${r.code}): ${out.split(/\r?\n/).slice(-6).join(' / ')}`);
    if (r.code === 0) {
      // the task branch must now contain the SVN base; otherwise asking again would never end
      const behind = Number(decode(await git.buf(['rev-list', '--count', `refs/heads/${task.branch}..${BASE_REF}`])).trim()) || 0;
      if (behind) throw new Error(`rebase 는 끝났지만 작업 브랜치 ${task.branch} 가 아직 SVN 기준보다 ${behind}커밋 뒤에 있습니다. 출력 패널(SVN Worktree)의 rebase 로그를 확인하세요.`);
      task.baseCommit = await git.revParse(BASE_REF);
      task.baseRevision = this.resolveScope(scope.id).revision;
      this._saveTask(scope, task);
      return { ok: true, output: out.slice(-2000) };
    }
    const conflicts = decode((await git.raw(['diff', '--name-only', '--diff-filter=U'], { cwd: task.workPath })).stdout).split('\n').filter(Boolean);
    if (!conflicts.length) {
      // not a conflict (files in the way, a lock file, ...): say why instead of "충돌 0개"; a new rebase is undone,
      // one being resolved (cont) is kept so the fixes are not lost
      if (!keep) {
        const st = await this._worktreeState(scope, task);
        if (st.rebasing) await git.raw(['rebase', '--abort'], { cwd: task.workPath });
        if (st.merging) await git.raw(['merge', '--abort'], { cwd: task.workPath });
      }
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const why = lines.filter((l) => /error|fatal|overwritten|cannot|unable|lock/i.test(l)).slice(0, 4).join(' / ') || lines.slice(-3).join(' / ');
      throw new Error(keep ? `rebase 를 계속하지 못했습니다 (충돌 정리 중인 상태는 그대로): ${why}` : `rebase 하지 못했습니다 (충돌 아님): ${why}`);
    }
    return {
      ok: false, conflicts, output: out.slice(-2000),
      next: `충돌 파일을 ${task.workPath} 에서 수정한 뒤 svnwt_task_sync(cont=true) 를 호출하세요. 취소하려면 abort=true.`,
    };
  }

  _assertActive(task, allowLanded = true) {
    if (task.status === 'archived') throw new Error(`보관된 작업입니다: ${task.id}`);
    if (!allowLanded && task.status !== 'active') throw new Error(`작업 상태가 ${task.status} 입니다.`);
  }

  // ------------------------------------------------------------ land (task -> SVN changelist)
  async _merge3(scope, ours, base, theirs) {
    if (bufEq(ours, theirs)) return { action: 'none' };
    if (bufEq(ours, base)) return theirs === null ? { action: 'delete' } : { action: 'write', content: theirs };
    if (bufEq(base, theirs)) return { action: 'none' };
    if (ours === null || base === null || theirs === null) return { action: 'conflict', reason: ours === null ? 'SVN 쪽에서 파일이 삭제됨' : (theirs === null ? '작업에서 삭제했지만 SVN 쪽 파일이 변경됨' : '양쪽에서 새로 추가됨') };
    if (isBinary(ours) || isBinary(base) || isBinary(theirs)) return { action: 'conflict', reason: '바이너리 파일이 양쪽에서 변경됨' };
    const git = await this.git(scope);
    const tmp = store.ensureDir(path.join(scope.home, 'tmp'));
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const f = ['o', 'b', 't'].map((n) => path.join(tmp, `${id}.${n}`));
    fs.writeFileSync(f[0], ours); fs.writeFileSync(f[1], base); fs.writeFileSync(f[2], theirs);
    try {
      const r = await git.raw(['merge-file', '-p', '-L', 'svn', '-L', 'base', '-L', 'task', f[0], f[1], f[2]]);
      if (r.code === 0) return { action: 'write', content: r.stdout, merged: true };
      return { action: 'conflict', reason: r.code > 0 ? `SVN working copy 의 로컬 변경과 충돌 (${r.code}곳)` : 'merge-file 오류' };
    } finally {
      for (const x of f) try { fs.unlinkSync(x); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Apply the task onto the SVN working copy and put touched files into changelist svnwt-<id>.
   * @param {{dryRun?:boolean, autoCommit?:boolean, force?:boolean}} opts
   */
  /** @param {{at?: string}} [opts] at: put the task as of this commit (an earlier commit of the task; test runs) */
  async landTask(ref, { dryRun = false, autoCommit = false, force = false, overwrite = false, inStash = false, at = null } = {}) {
    const { scope, task } = this.resolveTask(ref);
    this._assertActive(task);
    const git = await this.git(scope);
    const svn = await this.svn();
    if (!inStash) this._assertNoCommitInProgress(scope);
    const wt = await this._worktreeState(scope, task);
    if (wt.rebasing || wt.merging) throw new Error('sync(rebase/merge)가 진행 중입니다. 먼저 완료하세요.');
    if (wt.dirty.length && !at) {
      if (!autoCommit) throw new Error(`worktree 에 커밋되지 않은 변경이 ${wt.dirty.length}개 있습니다. svnwt_task_commit 으로 커밋하거나 autoCommit=true 를 사용하세요.`);
      if (!dryRun) await this.commitTask(task.id, `${task.title} (auto commit before changelist)`);
    }
    return this._scopeLock(scope, `작업 #${task.no} SVN changelist 반영`, async () => {
      const range = await this._range(scope, task);
      const tip = at || range.tip;
      const base = at ? ((await git.mergeBase(BASE_REF, at)) || range.base) : range.base;
      const changes = await git.nameStatus(base, tip);
      const behind = Number(decode(await git.buf(['rev-list', '--count', `${base}..${BASE_REF}`])).trim()) || 0;
      const lastLanded = task.landed && task.landed.commit && (await git.revParse(task.landed.commit)) ? task.landed.commit : null;
      const prevFiles = new Set(task.landed ? task.landed.files : []);
      const finalFiles = new Set();
      const moves = [];
      for (const c of changes) {
        finalFiles.add(c.path);
        if (c.status === 'R') finalFiles.add(c.from);
      }
      const candidates = new Set([...finalFiles, ...prevFiles]);

      const stList = await svn.status(scope.svnPath);
      const byChangelist = new Map(this._listTaskFiles(scope).filter((o) => o.id !== task.id && o.changelist).map((o) => [o.changelist, o]));
      const st = new Map(stList.map((e) => [key(e.path), e]));
      const plan = [];
      // Case-only renames (usage.md -> USAGE.md, e.g. from `git mv`): on Windows both names are the same
      // file, so write/delete per path would destroy it. Handle them as one svn move + content merge.
      const caseRenames = changes.filter((c) => c.status === 'R' && c.from !== c.path && c.from.toLowerCase() === c.path.toLowerCase());
      const caseSkip = new Set(caseRenames.flatMap((c) => [c.from, c.path]));
      for (const c of caseRenames) {
        const absFrom = fromPosix(scope.svnPath, c.from);
        const ours = readFileOrNull(absFrom);
        const reference = await git.blob(prevFiles.has(c.from) && lastLanded ? lastLanded : base, c.from);
        const theirs = await git.blob(tip, c.path);
        const m = await this._merge3(scope, ours, reference, theirs);
        const s = st.get(key(absFrom));
        const svnStatus = s ? s.item : (ours ? 'normal' : 'none');
        const blockedReason = s && s.changelist && s.changelist !== task.changelist ? `이미 다른 changelist "${s.changelist}" 에 포함된 파일` : null;
        plan.push({ path: c.from, abs: absFrom, action: blockedReason ? 'overlap' : 'move-source', reason: blockedReason, svnStatus });
        plan.push({
          path: c.path, abs: fromPosix(scope.svnPath, c.path), moveFrom: c.from, svnStatus: 'none',
          action: m.action === 'conflict' ? 'conflict' : 'write', reason: m.reason, merged: !!m.merged,
          content: m.action === 'write' ? m.content : (ours || theirs),
        });
        if (!blockedReason && svnStatus !== 'none' && svnStatus !== 'unversioned') moves.push({ from: c.from, to: c.path });
      }
      for (const rel of [...candidates].sort()) {
        if (caseSkip.has(rel)) continue;
        const abs = fromPosix(scope.svnPath, rel);
        const ours = readFileOrNull(abs);
        const refRev = prevFiles.has(rel) && lastLanded ? lastLanded : base;
        const reference = await git.blob(refRev, rel);
        const theirs = await git.blob(tip, rel);
        const m = await this._merge3(scope, ours, reference, theirs);
        const s = st.get(key(abs));
        const item = { path: rel, abs, action: m.action, merged: !!m.merged, content: m.content, reason: m.reason, svnStatus: s ? s.item : (ours ? 'normal' : 'none') };
        if (s && s.changelist && s.changelist !== task.changelist) {
          if (!s.changelist.startsWith('svnwt-')) {
            item.action = 'overlap';
            item.reason = `사용자 changelist "${s.changelist}" 에 포함된 파일`;
          } else if (item.action === 'conflict') {
            const owner = byChangelist.get(s.changelist);
            item.reason = owner
              ? `작업 #${owner.no} "${owner.title}" 과 같은 부분을 수정함 — #${owner.no} 를 먼저 SVN 커밋한 뒤 rebase`
              : `다른 작업(${s.changelist})과 같은 부분을 수정함`;
            if (owner) item.waitFor = owner.id;
          } else {
            // shared with another task: both changes live in the working copy, each task commits only its own part
            item.sharedWith = s.changelist;
          }
        }
        if (item.action === 'write' && ours !== null) {
          try { fs.accessSync(abs, fs.constants.W_OK); } catch (_) { item.action = 'conflict'; item.reason = '읽기 전용 파일 (svn:needs-lock 이면 먼저 svn lock 필요)'; }
        }
        if (item.action === 'conflict' && !item.waitFor && (!s || s.item === 'normal' || s.changelist === task.changelist) && behind > 0 && /로컬 변경과 충돌/.test(item.reason || '')) {
          // the working copy has no local edit here: the overlap is with what was committed to SVN since the task started
          item.reason = 'SVN 에 새로 커밋된 변경과 같은 부분을 수정함 — 최신 SVN 기준으로 rebase 필요';
          item.needsRebase = true;
        }
        plan.push(item);
      }
      // svn move for renames whose source is unmodified in SVN
      for (const c of changes.filter((x) => x.status === 'R' && !caseSkip.has(x.path))) {
        const src = plan.find((p) => p.path === c.from);
        const dst = plan.find((p) => p.path === c.path);
        if (src && dst && src.action === 'delete' && dst.action === 'write' && ['normal'].includes(src.svnStatus) && dst.svnStatus === 'none') {
          moves.push({ from: c.from, to: c.path });
          src.action = 'move-source';
          dst.moveFrom = c.from;
        }
      }
      // overwrite (the human's "changelist 만들기"): the changelist is disposable and the work is in git, so a
      // file that overlaps other local content gets the task's version (SVN BASE + task change). The previous
      // working-copy content is backed up. Only an overlap with what SVN itself has since then still blocks.
      if (overwrite) {
        for (const item of plan) {
          if (!(item.action === 'conflict' || item.action === 'overlap') || item.needsRebase || item.moveFrom) continue;
          if (/읽기 전용/.test(item.reason || '')) continue;
          const ours = readFileOrNull(item.abs);
          const versioned = !['none', 'unversioned', 'added'].includes(item.svnStatus);
          const pristine = versioned ? await svn.catBase(item.abs) : null;
          const baseBlob = await git.blob(base, item.path);
          const tipBlob = await git.blob(tip, item.path);
          let target;
          if (pristine === null) target = tipBlob;
          else {
            const m2 = await this._merge3(scope, pristine, baseBlob, tipBlob);
            if (m2.action === 'conflict') {
              item.action = 'conflict';
              item.needsRebase = true;
              item.reason = 'SVN 에 새로 커밋된 변경과 같은 부분을 수정함 — 최신 SVN 기준으로 rebase 필요';
              continue;
            }
            target = m2.action === 'write' ? m2.content : (m2.action === 'delete' ? null : pristine);
          }
          item.overwrite = true;
          item.backup = ours;
          item.reason = undefined;
          delete item.waitFor;
          delete item.sharedWith;
          if (target === null) item.action = ours === null ? 'none' : 'delete';
          else if (ours !== null && bufEq(target, ours)) item.action = 'none';
          else { item.action = 'write'; item.content = target; }
        }
      }
      const blocked = plan.filter((p) => p.action === 'conflict' || p.action === 'overlap');
      const summary = plan.map(({ path: p, action, merged, reason, svnStatus, moveFrom, sharedWith, overwrite: ow }) => ({ path: p, action, merged, reason, svnStatus, moveFrom, sharedWith, overwrite: ow || undefined }));
      // commit order: which other tasks must be committed before this one can be landed
      const waitIds = [...new Set(blocked.filter((b) => b.waitFor).map((b) => b.waitFor))];
      const waitFor = waitIds.map((id) => {
        const o = [...byChangelist.values()].find((x) => x.id === id);
        return { id, no: o.no, title: o.title, status: o.status, files: blocked.filter((b) => b.waitFor === id).map((b) => b.path) };
      });
      const needsRebase = blocked.some((b) => b.needsRebase);
      if (blocked.length && !force) {
        if (waitFor.length) task.waitFor = { at: now(), tasks: waitFor.map(({ id, no, title, files }) => ({ id, no, title, files })) };
        else delete task.waitFor;
        this._saveTask(scope, task);
      }
      if (dryRun || (blocked.length && !force)) {
        return {
          ok: blocked.length === 0, dryRun, task: task.id, changelist: task.changelist, files: summary,
          blocked: blocked.map((b) => ({ path: b.path, reason: b.reason, waitFor: b.waitFor, needsRebase: b.needsRebase })),
          waitFor, needsRebase,
          next: blocked.length
            ? '충돌을 해결해야 합니다: 다른 작업과 같은 줄을 고쳤다면 그 작업을 먼저 SVN 커밋한 뒤 svnwt_task_sync 로 rebase 하고, SVN working copy 의 로컬 수정과 겹치면 사용자에게 알리세요. force=true 는 충돌 파일을 건너뜁니다.'
            : (dryRun ? 'dryRun=false 로 다시 호출하면 SVN working copy 에 반영됩니다.' : undefined),
        };
      }

      const errors = [];
      const overwritten = plan.filter((p) => p.overwrite && p.backup !== null && p.action !== 'none');
      let backupDir = null;
      if (overwritten.length) {
        backupDir = store.ensureDir(path.join(scope.home, 'backups', `${now().replace(/[:.]/g, '-')}-${task.id}`));
        for (const p of overwritten) {
          const dst = path.join(backupDir, ...p.path.split('/'));
          store.ensureDir(path.dirname(dst));
          fs.writeFileSync(dst, p.backup);
        }
      }
      for (const mv of moves) {
        const r = await svn.raw(['move', '--parents', fromPosix(scope.svnPath, mv.from), fromPosix(scope.svnPath, mv.to)]);
        if (r.code !== 0) {
          errors.push(`svn move ${mv.from} -> ${mv.to}: ${decode(r.stderr).trim()}`);
          const src = plan.find((p) => p.path === mv.from);
          if (src) src.action = 'delete';
        }
      }
      const toAdd = [];
      const toDelete = [];
      const toRevertAdd = [];
      for (const p of plan) {
        if (p.action === 'write') {
          store.ensureDir(path.dirname(p.abs));
          fs.writeFileSync(p.abs, p.content);
          if (p.svnStatus === 'none' || p.svnStatus === 'unversioned') toAdd.push(p.abs);
        } else if (p.action === 'delete') {
          // never delete a path that is the same file (case-insensitive FS) as one we just wrote
          if (plan.some((q) => q !== p && q.action === 'write' && q.path.toLowerCase() === p.path.toLowerCase())) continue;
          if (p.svnStatus === 'added') toRevertAdd.push(p.abs);
          else if (p.svnStatus === 'unversioned') { try { fs.unlinkSync(p.abs); } catch (_) { /* ignore */ } }
          else toDelete.push(p.abs);
        }
      }
      if (toRevertAdd.length) {
        await svn.withTargets(['revert'], toRevertAdd, { okCodes: [1] });
        for (const f of toRevertAdd) try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
      }
      if (toDelete.length) {
        try { await svn.withTargets(['delete', '--force'], toDelete); } catch (e) { errors.push(e.message); }
      }
      if (toAdd.length) {
        try { await svn.withTargets(['add', '--force', '--parents', '--depth', 'empty'], toAdd); } catch (e) { errors.push(e.message); }
      }
      // changelist membership = every file the task changes (minus skipped conflicts)
      const skipped = new Set(blocked.map((b) => b.path));
      const members = [...finalFiles].filter((f) => !skipped.has(f));
      // a file can be in one changelist only: shared files stay with the task that landed them first
      const shared = {};
      for (const p of plan) if (p.sharedWith && members.includes(p.path)) shared[p.path] = p.sharedWith;
      const memberAbs = members.filter((f) => !shared[f]).map((f) => fromPosix(scope.svnPath, f));
      if (memberAbs.length) {
        try { await svn.withTargets(['changelist', task.changelist], memberAbs, { okCodes: [1] }); } catch (e) { errors.push(e.message); }
      }
      const dropped = [...prevFiles].filter((f) => !finalFiles.has(f)).map((f) => fromPosix(scope.svnPath, f))
        .filter((f) => fs.existsSync(f) && (st.get(key(f)) || {}).changelist === task.changelist);
      if (dropped.length) await svn.withTargets(['changelist', '--remove'], dropped, { okCodes: [1] });

      // Newly added parent directories cannot be in a changelist but must be committed with the files.
      const after = await svn.status(scope.svnPath);
      const dirs = after.filter((e) => e.item === 'added' && (() => { try { return fs.statSync(e.path).isDirectory(); } catch (_) { return false; } })())
        .map((e) => relPosix(scope.svnPath, e.path))
        .filter((d) => members.some((m) => m.startsWith(d + '/')))
        .sort();
      const prevDirs = (task.landed && task.landed.dirs) || [];

      task.status = 'landed';
      delete task.waitFor;
      delete task.readyAt;
      task.landed = {
        at: now(), commit: tip, base, revision: this.resolveScope(scope.id).revision, files: members, shared,
        dirs: [...new Set([...dirs, ...prevDirs.filter((d) => members.some((m) => m.startsWith(d + '/')))])].sort(),
        revs: await this._lastChangedRevs(scope, members),
      };
      this._saveTask(scope, task);
      return {
        ok: errors.length === 0, task: task.id, changelist: task.changelist, files: summary, skipped: [...skipped], errors,
        overwritten: overwritten.map((p) => p.path), backupDir,
        commit: await this.commitHelp(scope, task),
      };
    });
  }

  /** Reverse a land: take the task's changes back out of the SVN working copy (keeps other local edits). */
  async unlandTask(ref) {
    const { scope, task } = this.resolveTask(ref);
    if (!task.landed) throw new Error('SVN 에 반영(land)된 적이 없는 작업입니다.');
    this._assertNoCommitInProgress(scope);
    const git = await this.git(scope);
    const svn = await this.svn();
    return this._scopeLock(scope, `작업 #${task.no} SVN 반영 되돌리기`, async () => {
      const { commit, base, files } = task.landed;
      const stList = await svn.status(scope.svnPath);
      const st = new Map(stList.map((e) => [key(e.path), e]));
      const results = [];
      const revert = [];
      const unlinkAfter = [];
      for (const rel of files) {
        const abs = fromPosix(scope.svnPath, rel);
        const ours = readFileOrNull(abs);
        const landedBlob = await git.blob(commit, rel);
        const baseBlob = await git.blob(base, rel);
        const s = st.get(key(abs));
        const svnItem = s ? s.item : (ours ? 'normal' : 'none');
        if (svnItem === 'added' && bufEq(ours, landedBlob)) { revert.push(abs); unlinkAfter.push(abs); results.push({ path: rel, action: 'revert-add' }); continue; }
        if (svnItem === 'deleted' && landedBlob === null) { revert.push(abs); results.push({ path: rel, action: 'revert-delete' }); continue; }
        const m = await this._merge3(scope, ours, landedBlob, baseBlob);
        if (m.action === 'write') { fs.writeFileSync(abs, m.content); results.push({ path: rel, action: 'restore' }); }
        else if (m.action === 'none') results.push({ path: rel, action: 'none' });
        else results.push({ path: rel, action: 'conflict', reason: m.reason });
      }
      if (revert.length) await svn.withTargets(['revert'], revert, { okCodes: [1] });
      for (const f of unlinkAfter) try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
      const existing = files.map((f) => fromPosix(scope.svnPath, f)).filter((f) => fs.existsSync(f) && (st.get(key(f)) || {}).changelist === task.changelist);
      if (existing.length) await svn.withTargets(['changelist', '--remove'], existing, { okCodes: [1] });
      // files this task owned but other landed tasks also changed -> hand them over
      await this._reassignShared(scope, task, svn);
      task.status = 'active';
      task.landed = null;
      this._saveTask(scope, task);
      return { task: task.id, files: results };
    });
  }

  /** rel -> last changed revision for versioned files (deleted/unversioned files are simply absent). */
  async _lastChangedRevs(scope, rels) {
    const svn = await this.svn();
    const abs = rels.map((r) => fromPosix(scope.svnPath, r));
    const infos = abs.length ? await svn.infoMany(abs) : [];
    const out = {};
    for (const i of infos) out[relPosix(scope.svnPath, path.resolve(scope.svnPath, i.path))] = i.lastChangedRev || 0;
    return out;
  }

  /** true when one of the files got a newer revision (or a scheduled deletion disappeared) */
  _revsAdvanced(before, after, only) {
    return Object.keys(before).filter((f) => !only || only.includes(f))
      .some((f) => !(f in after) || after[f] > (before[f] || 0)) ||
      Object.keys(after).filter((f) => !only || only.includes(f)).some((f) => !(f in before) && after[f] > 0);
  }

  /** Landed task => committed (by any SVN client) or reverted by the user? */
  async _detectCommitted(scope, task) {
    if (task.status !== 'landed' || !task.landed) return task.status;
    if (this._commitMarker(scope)) return task.status; // a split commit is running
    const svn = await this.svn();
    const files = task.landed.files;
    const sharedMap = task.landed.shared || {};
    const own = files.filter((f) => !sharedMap[f]); // shared files change when the owner commits
    // Committed = some file of the task is no longer a local change AND the task's change is in the SVN BASE.
    // A revision number alone is not proof: svn update (others' commits) moves it, and a file that disappeared
    // (deleted by hand, add reverted) has no revision at all.
    const stList = await svn.status(scope.svnPath);
    const pending = new Set(stList.filter((e) => ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'].includes(e.item))
      .map((e) => relPosix(scope.svnPath, e.path)));
    let committed = false;
    for (const f of own) {
      if (pending.has(f)) continue;
      if (await this._changeInBase(scope, task, f)) { committed = true; break; }
    }
    if (!committed && files.some((f) => pending.has(f))) return task.status; // still waiting for the human commit
    task.status = committed ? 'committed' : 'active';
    if (committed) { task.committedAt = now(); task.commitVerified = true; }
    else task.landed = null;
    this._saveTask(scope, task);
    if (committed) {
      await this._reassignShared(scope, task, svn);
      await this._recordLeftovers(scope, task);
      try { await this.refreshScope(scope.id); } catch (_) { /* best effort */ }
    }
    return task.status;
  }

  /**
   * After `task` was committed or unlanded: files that other landed tasks also changed move to the
   * changelist of one of those tasks (a file can be in one changelist only).
   */
  async _reassignShared(scope, task, svn) {
    if (!task.landed) return;
    const others = this._listTaskFiles(scope).filter((o) => o.id !== task.id && o.status === 'landed' && o.landed);
    const touched = others.filter((o) => o.landed.files.some((f) => task.landed.files.includes(f)));
    if (!touched.length) return;
    const revs = await this._lastChangedRevs(scope, task.landed.files);
    const stList = await svn.status(scope.svnPath);
    const st = new Map(stList.map((e) => [relPosix(scope.svnPath, e.path), e]));
    for (const f of task.landed.files) {
      const owners = touched.filter((o) => o.landed.files.includes(f)).sort((a, b) => (a.no || 0) - (b.no || 0));
      if (!owners.length) continue;
      const cur = (st.get(f) || {}).changelist;
      let owner = owners.find((o) => o.changelist === cur);
      if (!owner) {
        owner = owners[0];
        const abs = fromPosix(scope.svnPath, f);
        if (fs.existsSync(abs)) await svn.withTargets(['changelist', owner.changelist], [abs], { okCodes: [1] });
      }
      for (const o of owners) {
        o.landed.shared = o.landed.shared || {};
        if (o === owner) delete o.landed.shared[f]; else o.landed.shared[f] = owner.changelist;
        if (o.landed.revs && f in revs) o.landed.revs[f] = revs[f];
      }
    }
    for (const o of touched) this._saveTask(scope, o);
  }

  async checkCommitted(ref) {
    const { scope, task } = this.resolveTask(ref);
    return { task: task.id, status: await this._detectCommitted(scope, task) };
  }

  // ------------------------------------------------------------ commit order between tasks
  /**
   * waitFor: tasks that changed the same lines and hold the file in their changelist; this task can be
   * landed once they are committed (or taken back out). waitingOnMe: active tasks waiting for this one.
   */
  _order(scope, task) {
    const all = this._listTaskFiles(scope);
    const res = {};
    if (task.waitFor && task.status === 'active') {
      const list = task.waitFor.tasks.map((w) => {
        const o = all.find((x) => x.id === w.id);
        const status = o ? o.status : 'removed';
        return { id: w.id, no: w.no, title: w.title, files: w.files, status, ready: status !== 'landed' };
      });
      res.waitFor = list;
      res.waitReady = list.every((w) => w.ready);
    }
    const waiting = all.filter((o) => o.id !== task.id && o.status === 'active' && o.waitFor && o.waitFor.tasks.some((w) => w.id === task.id));
    if (waiting.length) res.waitingOnMe = waiting.map((o) => ({ id: o.id, no: o.no, title: o.title, files: o.waitFor.tasks.find((w) => w.id === task.id).files }));
    return res;
  }

  /** Active tasks that were waiting for `ref` and can now be landed (all the tasks they waited for are no longer landed). */
  unblockedBy(ref) {
    const { scope, task } = this.resolveTask(ref);
    const all = this._listTaskFiles(scope);
    return all.filter((o) => o.status === 'active' && o.waitFor && o.waitFor.tasks.some((w) => w.id === task.id))
      .filter((o) => o.waitFor.tasks.every((w) => { const x = all.find((y) => y.id === w.id); return !x || x.status !== 'landed'; }))
      .map((o) => ({ id: o.id, no: o.no, title: o.title }));
  }

  // ------------------------------------------------------------ one changelist at a time
  /**
   * Other tasks that currently have changes in the SVN working copy: their changelists, and what a committed
   * task left behind (files left out of its commit). The work itself is in git, so all of it can be dropped.
   */
  wcOccupants(ref) {
    const { scope, task } = this.resolveTask(ref);
    return this._listTaskFiles(scope)
      .filter((o) => o.id !== task.id && (o.status === 'landed' || (o.status === 'committed' && (o.leftovers || []).length)))
      .map((o) => ({
        id: o.id, no: o.no, title: o.title, status: o.status,
        files: o.status === 'landed' ? ((o.landed && o.landed.files) || []).length : o.leftovers.length,
        landedAt: (o.landed && o.landed.at) || '',
      }));
  }

  /**
   * What really is in the SVN working copy besides this task (svn status, not the task records):
   * - every other svnwt-* changelist: a landed task, a committed task's leftovers (also from 0.3.x, which did not
   *   record them), or a stale one (task removed / not landed any more)
   * - this task's files parked in TortoiseSVN's "ignore-on-commit" by an earlier "커밋 준비" (none running now)
   */
  async wcOccupantsLive(ref) {
    const { scope, task } = this.resolveTask(ref);
    const svn = await this.svn();
    const st = await svn.status(scope.svnPath);
    const tasks = this._listTaskFiles(scope);
    const byCl = new Map(tasks.filter((o) => o.changelist).map((o) => [o.changelist, o]));
    const groups = new Map();
    for (const e of st) {
      if (!e.changelist || e.changelist === task.changelist || !e.changelist.startsWith('svnwt-')) continue;
      if (!groups.has(e.changelist)) groups.set(e.changelist, []);
      groups.get(e.changelist).push(relPosix(scope.svnPath, e.path));
    }
    const out = [];
    const seen = new Set();
    for (const [cl, paths] of groups) {
      const o = byCl.get(cl);
      const status = !o ? 'stale' : o.status === 'landed' ? 'landed' : (o.status === 'committed' && o.landed ? 'committed' : 'stale');
      if (o) seen.add(o.id);
      out.push({ id: o ? o.id : null, no: o ? o.no : null, title: o ? o.title : cl, changelist: cl, status, files: paths.length, paths, landedAt: (o && o.landed && o.landed.at) || '' });
    }
    for (const o of tasks) {
      if (o.id === task.id || seen.has(o.id) || o.status !== 'landed') continue; // landed, but nothing left in the working copy
      out.push({ id: o.id, no: o.no, title: o.title, changelist: o.changelist, status: 'landed', files: 0, paths: [], landedAt: (o.landed && o.landed.at) || '' });
    }
    if (!this._commitMarker(scope)) {
      const mine = await this._taskPaths(scope, task);
      const parked = st.filter((e) => e.changelist === 'ignore-on-commit').map((e) => relPosix(scope.svnPath, e.path)).filter((x) => mine.has(x));
      if (parked.length) out.push({ id: null, no: null, title: 'ignore-on-commit', changelist: 'ignore-on-commit', status: 'parked', files: parked.length, paths: parked, landedAt: '' });
    }
    const rank = { landed: 0, committed: 1, stale: 2, parked: 3 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || String(b.landedAt).localeCompare(String(a.landedAt)));
  }

  /** Paths this task changes (base..tip, rename sources included) and the files of its current changelist. */
  async _taskPaths(scope, task) {
    const git = await this.git(scope);
    const { tip, base } = await this._range(scope, task);
    const set = new Set((task.landed && task.landed.files) || []);
    for (const c of await git.nameStatus(base, tip)) { set.add(c.path); if (c.from) set.add(c.from); }
    return set;
  }

  /**
   * Make the SVN working copy free for this task: other tasks' changelists are taken out (their branches are
   * untouched), committed tasks' leftovers discarded, stale changelists released (content kept) and this task's
   * files taken out of "ignore-on-commit".
   */
  async clearWorkingCopy(ref) {
    const { scope, task } = this.resolveTask(ref);
    this._assertNoCommitInProgress(scope);
    const svn = await this.svn();
    const cleared = [];
    for (const o of await this.wcOccupantsLive(task.id)) {
      let conflicts = [];
      if (o.status === 'landed') {
        const r = await this.unlandTask(o.id);
        conflicts = r.files.filter((f) => f.action === 'conflict').map((f) => f.path);
      } else if (o.status === 'committed') {
        const r = await this.discardLeftovers(o.id);
        conflicts = r.files.filter((f) => f.action === 'conflict').map((f) => f.path);
      }
      // stale / parked, and whatever is still in that changelist after the steps above: release the files
      const still = (await svn.status(scope.svnPath)).filter((e) => e.changelist === o.changelist && (o.status !== 'parked' || o.paths.includes(relPosix(scope.svnPath, e.path)))).map((e) => e.path);
      if (still.length) await svn.withTargets(['changelist', '--remove'], still, { okCodes: [1] });
      cleared.push({ id: o.id, no: o.no, title: o.title, changelist: o.changelist, status: o.status, conflicts, released: still.length });
    }
    return { task: task.id, cleared };
  }

  /**
   * Changelist request from an agent (MCP / @svnwt): agents never touch the SVN working copy. The task is marked
   * ready for review; the human's "커밋 준비" puts it (alone) on the working copy at commit time.
   */
  async requestChangelist(ref, opts = {}) {
    const { scope, task } = this.resolveTask(ref);
    const git = await this.git(scope);
    const wt = await this._worktreeState(scope, task);
    if (wt.dirty.length && !opts.autoCommit) throw new Error(`worktree 에 커밋되지 않은 변경이 ${wt.dirty.length}개 있습니다. svnwt_task_commit 으로 커밋하거나 autoCommit=true 를 사용하세요.`);
    if (wt.dirty.length && !opts.dryRun) await this.commitTask(task.id, `${task.title} (auto commit)`);
    const { tip, base } = await this._range(scope, task);
    const files = (await git.nameStatus(base, tip)).map((c) => ({ path: c.path, status: c.status }));
    if (!opts.dryRun) { task.readyAt = now(); this._saveTask(scope, task); }
    return {
      ok: true, ready: true, dryRun: !!opts.dryRun, task: task.id, files,
      message: opts.dryRun ? '호출하면 작업이 "리뷰 대기" 로 표시됩니다.'
        : '작업을 "리뷰 대기" 로 표시했습니다. SVN working copy 는 사용자가 "커밋 준비" 를 누를 때 이 작업만 올려 커밋합니다.',
    };
  }

  // ------------------------------------------------------------ leftovers after a partial commit
  /** Files still in this task's changelist although the task was committed (left out of the commit). */
  async leftovers(ref) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status !== 'committed') return [];
    const svn = await this.svn();
    const PENDING = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'];
    return (await svn.status(scope.svnPath))
      .filter((e) => e.changelist === task.changelist && PENDING.includes(e.item))
      .map((e) => ({ path: relPosix(scope.svnPath, e.path), item: e.item }));
  }

  async _recordLeftovers(scope, task) {
    try {
      const fresh = this.resolveTask(task.id).task;
      fresh.leftovers = (await this.leftovers(task.id)).map((x) => x.path);
      this._saveTask(scope, fresh);
      task.leftovers = fresh.leftovers;
    } catch (_) { /* informational only */ }
  }

  /**
   * Throw away what is left of a committed task in the SVN working copy: only the task's own change is
   * taken out (3-way); other changes in the same files (the user's edits, other tasks) stay. A file that
   * ends up equal to the pristine copy is reverted; files the task added are un-added and deleted.
   * The task's git branch still has the change (re-landable until the worktree is removed).
   */
  async discardLeftovers(ref) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status !== 'committed') throw new Error('SVN 커밋이 끝난 작업만 남은 변경을 버릴 수 있습니다.');
    this._assertNoCommitInProgress(scope);
    const git = await this.git(scope);
    const svn = await this.svn();
    return store.withLock(path.join(scope.home, 'lock'), async () => {
      const left = await this.leftovers(task.id);
      const results = [];
      const revert = [];
      const unlink = [];
      const unlist = [];
      for (const l of left) {
        const abs = fromPosix(scope.svnPath, l.path);
        const ours = readFileOrNull(abs);
        const landedBlob = task.landed ? await git.blob(task.landed.commit, l.path) : null;
        const baseBlob = task.landed ? await git.blob(task.landed.base, l.path) : null;
        if (l.item === 'added') {
          revert.push(abs);
          if (ours !== null && (landedBlob === null || bufEq(ours, landedBlob))) { unlink.push(abs); results.push({ path: l.path, action: '추가 취소, 파일 삭제' }); }
          else results.push({ path: l.path, action: '추가 취소 (내용이 달라 파일은 남김)' });
          continue;
        }
        if (l.item === 'deleted' || l.item === 'missing') { revert.push(abs); results.push({ path: l.path, action: '삭제 취소' }); continue; }
        const pristine = await svn.catBase(abs);
        let content = ours;
        if (landedBlob !== null && baseBlob !== null) {
          const m = await this._merge3(scope, ours, landedBlob, baseBlob);
          if (m.action === 'conflict') { results.push({ path: l.path, action: 'conflict', reason: m.reason }); continue; }
          if (m.action === 'write') content = m.content;
        } else if (pristine !== null) {
          content = pristine;
        }
        if (pristine !== null && bufEq(content, pristine)) { revert.push(abs); results.push({ path: l.path, action: '원래대로 (revert)' }); }
        else {
          if (!bufEq(content, ours)) fs.writeFileSync(abs, content);
          unlist.push(abs);
          results.push({ path: l.path, action: '작업 변경만 제거 (다른 로컬 수정은 유지)' });
        }
      }
      if (revert.length) await svn.withTargets(['revert'], revert, { okCodes: [1] });
      for (const f of unlink) try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
      // svn revert keeps changelist membership: take reverted files out too
      const off = unlist.concat(revert.filter((f) => !unlink.includes(f) && fs.existsSync(f)));
      if (off.length) await svn.withTargets(['changelist', '--remove'], off, { okCodes: [1] });
      const fresh = this.resolveTask(task.id).task;
      fresh.leftovers = results.filter((r) => r.action === 'conflict').map((r) => r.path);
      fresh.leftoversDiscardedAt = now();
      this._saveTask(scope, fresh);
      return { task: task.id, files: results };
    }, { op: `작업 ${task.id} 남은 변경 버리기` });
  }

  // ------------------------------------------------------------ commit: stash -> this task only -> restore
  /**
   * "커밋 준비" for ONE task. The work is in git, so the SVN working copy is only used for the commit:
   * 1. every local change of the working copy (other tasks, the user's own edits, old changelists) is set aside:
   *    copies + SVN BASE copies + svn state + changelists, and those files go back to SVN BASE
   * 2. this task is applied from git onto the clean BASE as changelist svnwt-<id> (nothing else is changed, so
   *    TortoiseSVN's commit dialog shows only this task)
   * 3. after the commit (or cancel) endCommit takes the task back out and puts everything that was set aside back
   * Only one thing can stop it: the task changes the same lines as something committed to SVN after the task
   * started (rebase in the worktree first).
   */
  // ---------------------------------------------------------------- rules ("앞으로 항상 …" the user told an agent)
  listRules() { return rules.list(); }

  addRule(text, { why, task, by } = {}) {
    let t = null;
    let scope = null;
    if (task) { try { ({ task: t, scope } = this.resolveTask(task)); } catch (_) { /* rule without a task */ } }
    return rules.add({ text, why, by, scope: scope && scope.id, task: t && t.id, taskNo: t && t.no, taskTitle: t && t.title });
  }

  updateRule(id, text) { return rules.update(id, text); }

  removeRule(id) { return rules.remove(id); }

  /** Progress line for the extension's output channel (no-op without one). */
  _step(msg) {
    for (const f of [this.onLog, this.onProgress]) { if (f) { try { f(msg); } catch (_) { /* ignore */ } } }
  }

  /**
   * @param {string} ref
   * @param {{token?: {cancelled: boolean}}} [opts] set token.cancelled (and kill running commands) to stop: what was
   *   set aside is put back
   */
  stashCommit(ref, opts) { return proc.trace(() => this._stashCommit(ref, opts), '[커밋 준비]'); }

  /**
   * @param {{token?: object, mode?: 'commit'|'test', at?: string}} [opts]
   *   mode 'test': the same set-aside / apply / restore for a test on the working copy (local IIS site etc.): the task
   *   as of commit `at` (default: branch tip), no commit expected; endTest puts everything back.
   */
  async _stashCommit(ref, { token, mode = 'commit', at = null } = {}) {
    const { scope, task } = this.resolveTask(ref);
    const isTest = mode === 'test';
    const label = isTest ? '로컬 반영' : '커밋 준비';
    const labelObj = isTest ? '로컬 반영을' : '커밋 준비를';
    const labelSubj = isTest ? '로컬 반영이' : '커밋 준비가';
    if (!['active', 'landed'].includes(task.status)) throw new Error(isTest ? '진행 중인 작업만 로컬에 반영할 수 있습니다.' : '진행 중인 작업만 커밋할 수 있습니다.');
    this._assertNoCommitInProgress(scope);
    const t0 = Date.now();
    const step = (msg) => this._step(`[${label} #${task.no}] ${msg} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    const cancelled = () => !!(token && token.cancelled);
    const check = () => { if (cancelled()) { const e = new Error(`${labelObj} 취소했습니다.`); e.cancelled = true; throw e; } };
    step(`시작: ${task.title} (상태 ${task.status})`);
    const svn = await this.svn();
    const git = await this.git(scope);
    const root = scope.svnPath; // only the scope: svn status of a whole large checkout is what made this slow
    const wt = await this._worktreeState(scope, task);
    if (wt.rebasing || wt.merging) throw new Error('worktree 에서 rebase 가 진행 중입니다. 먼저 끝내세요.');
    let sha = null;
    if (isTest) {
      sha = await this._taskCommit(scope, task, at); // uncommitted worktree edits are not part of a test (it is pinned to a commit)
    } else if (wt.dirty.length) { step(`worktree 의 커밋 안 된 변경 ${wt.dirty.length}개를 git 커밋`); await this.commitTask(task.id, `${task.title} (SVN 커밋 전 자동 커밋)`); }
    const range = await this._range(scope, task);
    const tip = sha || range.tip;
    const base = sha ? ((await git.mergeBase(BASE_REF, sha)) || range.base) : range.base;
    const changes = await git.nameStatus(base, tip);
    if (!changes.length) throw new Error(isTest ? '로컬에 반영할 변경이 없습니다.' : '커밋할 변경이 없습니다.');
    step(`작업 변경 파일 ${changes.length}개. working copy 상태 읽는 중: ${root}`);
    check();
    const taskAbs = new Set();
    for (const c of changes) { taskAbs.add(key(fromPosix(scope.svnPath, c.path))); if (c.from) taskAbs.add(key(fromPosix(scope.svnPath, c.from))); }

    const CHANGED = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'];
    const st = await svn.status(root);
    // svn status lists an unversioned folder as one line, not the files in it. When the task adds files inside such
    // a folder (e.g. left there by an earlier 커밋 준비/changelist, or copied by hand), every file of that folder is set
    // aside too: otherwise they collide with the task ("양쪽에서 새로 추가됨"), and taking the task back out deletes
    // the folder with the user's files in it.
    {
      const isDirSync = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
      const listed = new Set(st.map((e) => key(e.path)));
      const holds = (e) => [...taskAbs].some((t) => t.startsWith(key(e.path) + path.sep));
      let outside = st.filter((e) => e.item === 'unversioned' && isDirSync(e.path) && holds(e));
      // a file the task adds that is on disk but not listed: inside an svn:ignore'd folder or itself ignored
      const hidden = changes.filter((c) => /^[ARC]/.test(c.status)).map((c) => fromPosix(scope.svnPath, c.path))
        .filter((p) => !listed.has(key(p)) && fs.existsSync(p) && !outside.some((d) => key(p).startsWith(key(d.path) + path.sep)));
      if (hidden.length) {
        const ign = (await svn.status(root, { noIgnore: true })).filter((e) => e.item === 'ignored' || e.item === 'unversioned');
        for (const e of ign) {
          if (isDirSync(e.path)) { if (hidden.some((p) => key(p).startsWith(key(e.path) + path.sep))) outside.push(e); } else if (hidden.some((p) => key(p) === key(e.path)) && !listed.has(key(e.path))) {
            st.push({ path: e.path, item: 'unversioned', changelist: null, stray: true }); listed.add(key(e.path));
          }
        }
      }
      outside = outside.filter((d, i) => !outside.some((o, j) => j !== i && key(d.path).startsWith(key(o.path) + path.sep)));
      const walk = (d, out) => { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); if (ent.isDirectory()) walk(p, out); else if (ent.isFile()) out.push(p); } return out; };
      for (const d of outside) {
        for (const f of walk(d.path, [])) if (!listed.has(key(f))) { st.push({ path: f, item: 'unversioned', changelist: null, stray: true }); listed.add(key(f)); }
      }
    }
    const dir = store.ensureDir(path.join(scope.home, 'stash', `${now().replace(/[:.]/g, '-')}-${task.id}`));
    const toSave = st.filter((e) => CHANGED.includes(e.item) || e.changelist || (e.item === 'unversioned' && (e.stray || taskAbs.has(key(e.path)))));
    step(`svn status ${st.length}개 항목, 빼 둘 변경/changelist ${toSave.length}개. 보관본 저장: ${dir}`);
    const entries = [];
    let n = 0;
    try {
      for (const e of st) {
        if (cancelled()) break;
        const changed = CHANGED.includes(e.item);
        const strayInTaskPath = e.item === 'unversioned' && (e.stray || taskAbs.has(key(e.path))); // would collide with a file the task adds
        if (!changed && !e.changelist && !strayInTaskPath) continue;
        let isDir = false;
        try { isDir = fs.statSync(e.path).isDirectory(); } catch (_) { /* deleted */ }
        const ent = { path: e.path, item: strayInTaskPath ? 'unversioned' : e.item, changelist: e.changelist || null, isDir };
        if (e.movedFrom) ent.movedFrom = e.movedFrom;
        if (e.movedTo) ent.movedTo = e.movedTo;
        if ((changed || strayInTaskPath) && !isDir) {
          const cur = readFileOrNull(e.path);
          if (cur !== null) { ent.copy = path.join(dir, String(n++)); fs.writeFileSync(ent.copy, cur); }
          const baseContent = ['added', 'unversioned'].includes(ent.item) ? null : await svn.catBase(e.path);
          if (baseContent !== null) { ent.base = path.join(dir, String(n++)); fs.writeFileSync(ent.base, baseContent); }
        }
        entries.push(ent);
        if (entries.length % 50 === 0) step(`보관본 저장 ${entries.length}/${toSave.length}`);
      }
      check();
      step('working copy 전체 diff 저장 (추가 보관본)');
      try { const d = await svn.raw(['diff', root]); if (d.code === 0 && d.stdout.length) fs.writeFileSync(path.join(dir, 'working-copy.diff'), d.stdout); } catch (_) { /* extra copy only */ }
      check();
    } catch (e) {
      // nothing in the working copy was touched yet
      fs.rmSync(dir, { recursive: true, force: true });
      step(e.cancelled ? '취소함 (working copy 는 바뀌지 않음)' : `실패 (working copy 는 바뀌지 않음): ${e.message}`);
      throw e;
    }
    // phase "stashing" until this task is on the working copy: if VS Code stops in between, the next start puts
    // everything back (see recoverCommits / the extension's activation)
    const marker = { kind: isTest ? 'test' : 'stash', phase: 'stashing', task: task.id, at: now(), pid: process.pid, external: true, stash: dir, entries, prevStatus: task.status, prevLanded: task.landed || null };
    if (isTest) marker.sha = sha;
    store.writeJson(this._markerFile(scope), marker);
    store.touchEvents({ scope: scope.id, task: task.id, commit: isTest ? 'test' : 'begin' });
    try {
      const changed = entries.filter((e) => CHANGED.includes(e.item));
      const tops = changed.filter((e) => !changed.some((o) => o !== e && o.isDir && isInside(e.path, o.path) && key(o.path) !== key(e.path)));
      step(`다른 변경 ${tops.length}개 revert, changelist 해제`);
      if (tops.length) await svn.withTargets(['revert', '--depth', 'infinity'], tops.map((e) => e.path), { okCodes: [1] });
      for (const e of entries.filter((x) => !x.isDir && ['added', 'unversioned'].includes(x.item))) {
        if (e.movedFrom && key(e.movedFrom) === key(e.path)) { try { fs.renameSync(e.path, e.movedFrom); } catch (_) { /* gone */ } continue; } // case-only svn move
        try { fs.unlinkSync(e.path); } catch (_) { /* gone */ }
      }
      for (const e of changed.filter((x) => x.isDir && x.item === 'added').sort((a, b) => b.path.length - a.path.length)) {
        try { fs.rmSync(e.path, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
      const inCl = entries.filter((e) => e.changelist && fs.existsSync(e.path)).map((e) => e.path);
      if (inCl.length) await svn.withTargets(['changelist', '--remove'], inCl, { okCodes: [1] });

      // the status is not touched here (a status change makes the extension add/remove workspace folders, which
      // can restart VS Code's extension host in the middle of this)
      task.landed = null;
      this._saveTask(scope, task);
      check();
      step(isTest ? `이 작업 변경 (커밋 ${sha.slice(0, 8)}) 을 working copy 에 반영` : '이 작업 변경을 working copy 에 반영');
      const r = await this.landTask(task.id, { inStash: true, at: sha });
      check();
      if (!r.ok) {
        step(`반영 불가 (${(r.blocked || []).map((b) => b.path).join(', ')}): 원래 상태로 되돌리는 중`);
        await this._endStash(scope, this.resolveTask(task.id).task, marker);
        return { ok: false, task: task.id, blocked: r.blocked, needsRebase: !!r.needsRebase || (r.blocked || []).some((b) => b.needsRebase), errors: r.errors };
      }
      const fresh = this.resolveTask(task.id).task;
      if (isTest) {
        // 로컬 반영 is plain local changes; the changelist comes with 커밋 준비 (prepareFromLocal)
        const cl = (await svn.status(root)).filter((e) => e.changelist === task.changelist).map((e) => e.path);
        if (cl.length) await svn.withTargets(['changelist', '--remove'], cl, { okCodes: [1] });
        // what was put there, to tell afterwards which task files someone edited during the test
        marker.landedHash = {};
        for (const f of fresh.landed.files) { const b = readFileOrNull(fromPosix(scope.svnPath, f)); marker.landedHash[f] = b === null ? null : hashBuf(b); }
        // the user may commit it straight from TortoiseSVN without 커밋 준비: commitDone compares with these
        marker.revs = await this._lastChangedRevs(scope, fresh.landed.files);
        marker.applied = true;
        marker.phase = 'ready';
        store.writeJson(this._markerFile(scope), marker);
        store.touchEvents({ scope: scope.id, task: task.id, test: 'applied' });
        const setAside = entries.filter((e) => CHANGED.includes(e.item) || e.item === 'unversioned').length;
        step(`완료: 이 작업 파일 ${fresh.landed.files.length}개만 working copy 에 있음 (빼 둔 변경 ${setAside}개)`);
        return { ok: true, task: task.id, sha, files: fresh.landed.files, setAside, stash: dir, svnPath: scope.svnPath };
      }
      // only this task is changed in the working copy now; its files go in the task's changelist so the TortoiseSVN
      // commit dialog shows them as one group (checked by default), apart from unversioned files
      await this._ownChangelist(scope, fresh);
      check();
      step('커밋 판정용 revision 기록');
      marker.revs = await this._lastChangedRevs(scope, fresh.landed.files);
      check();
      marker.phase = 'ready';
      store.writeJson(this._markerFile(scope), marker);
      const help = await this.commitHelp(scope, fresh);
      step(`완료: 이 작업 파일 ${fresh.landed.files.length}개만 working copy 에 있음`);
      return {
        ok: true, task: task.id, files: fresh.landed.files, setAside: entries.filter((e) => CHANGED.includes(e.item) || e.item === 'unversioned').length,
        stash: dir, targets: help.targets, messageFile: help.messageFile, message: help.suggestedMessage,
      };
    } catch (e) {
      step(`${e.cancelled ? '취소함' : `실패: ${e.message}`}. 원래 상태로 되돌리는 중`);
      let restoreErr = null;
      try { await this._endStash(scope, this.resolveTask(task.id).task, marker); } catch (er) { restoreErr = er; }
      step(restoreErr ? `되돌리기 실패: ${restoreErr.message} (보관본: ${dir})` : '되돌리기 완료');
      if (restoreErr) throw new Error(`${labelSubj} 중간에 멈췄고 되돌리기도 실패했습니다. 보관본: ${dir} (${restoreErr.message})`);
      const err = new Error(e.cancelled ? `${labelObj} 취소했습니다. working copy 는 원래대로 되돌렸습니다.` : `${label} 실패 (원래 상태로 되돌렸습니다, 보관본: ${dir}): ${e.message}`);
      err.cancelled = !!e.cancelled;
      throw err;
    }
  }

  /** Take the task back out of the working copy and put everything that was set aside back. */
  /**
   * While 커밋 준비 is on, every changed file of the task goes in the task's changelist (landTask leaves a file that
   * another task's record also lists in that task's changelist; here the other tasks are set aside).
   */
  async _ownChangelist(scope, task) {
    if (!task.landed) return;
    const svn = await this.svn();
    const CHANGED = ['modified', 'added', 'deleted', 'replaced', 'merged'];
    const mine = new Set(task.landed.files.map((f) => key(fromPosix(scope.svnPath, f))));
    const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
    const add = (await svn.status(scope.svnPath))
      .filter((e) => mine.has(key(e.path)) && CHANGED.includes(e.item) && e.changelist !== task.changelist && !isDir(e.path))
      .map((e) => e.path);
    if (add.length) await svn.withTargets(['changelist', task.changelist], add, { okCodes: [1] });
  }

  /** New git commits after 커밋 준비 (an agent kept working): true when the working copy holds an older tip. */
  async prepareIsStale(ref) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.kind !== 'stash' || m.task !== task.id || m.phase !== 'ready' || !task.landed) return false;
    const git = await this.git(scope);
    const tip = await git.revParse('refs/heads/' + task.branch);
    return !!tip && tip !== task.landed.commit;
  }

  /**
   * Put the task's newest commits on the working copy while 커밋 준비 stays on: only this task's files are taken out and
   * applied again; what was set aside stays set aside.
   */
  refreshStashCommit(ref, opts) { return proc.trace(() => this._refreshStashCommit(ref, opts), '[커밋 준비 갱신]'); }

  async _refreshStashCommit(ref, { token } = {}) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.kind !== 'stash' || m.task !== task.id || m.phase !== 'ready') throw new Error('이 작업은 커밋 준비 중이 아닙니다.');
    const t0 = Date.now();
    const step = (msg) => this._step(`[커밋 준비 갱신 #${task.no}] ${msg} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    const check = () => { if (token && token.cancelled) { const e = new Error('커밋 준비 갱신을 취소했습니다.'); e.cancelled = true; throw e; } };
    const wt = await this._worktreeState(scope, task);
    if (wt.rebasing || wt.merging) throw new Error('worktree 에서 rebase 가 진행 중입니다. 먼저 끝내세요.');
    if (wt.dirty.length) { step(`worktree 의 커밋 안 된 변경 ${wt.dirty.length}개를 git 커밋`); await this.commitTask(task.id, `${task.title} (SVN 커밋 전 자동 커밋)`); }
    step('SVN 에 이미 커밋됐는지 확인');
    if (await this.commitDone(task.id)) return { ok: false, committed: true, task: task.id };
    check();
    const svn = await this.svn();
    const root = scope.svnPath;
    const CHANGED = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'];
    const cur = this.resolveTask(task.id).task;
    const saved = new Set(m.entries.map((e) => key(e.path)));
    step('이전 반영분 빼기');
    m.phase = 'stashing'; // interrupted from here on: the next start restores everything (like an interrupted 커밋 준비)
    delete m.revs;
    store.writeJson(this._markerFile(scope), m);
    const mine = new Set([...(cur.landed ? cur.landed.files : []), ...(cur.landed && cur.landed.dirs ? cur.landed.dirs : [])].map((f) => key(fromPosix(scope.svnPath, f))));
    const st = await svn.status(root);
    const pend = st.filter((e) => mine.has(key(e.path)) && CHANGED.includes(e.item));
    if (pend.length) await svn.withTargets(['revert', '--depth', 'infinity'], pend.map((e) => e.path), { okCodes: [1] });
    for (const e of pend.filter((x) => x.item === 'added' && !saved.has(key(x.path)))) { try { fs.rmSync(e.path, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
    const cl = (await svn.status(root)).filter((e) => e.changelist === task.changelist).map((e) => e.path);
    if (cl.length) await svn.withTargets(['changelist', '--remove'], cl, { okCodes: [1] });
    cur.landed = null;
    this._saveTask(scope, cur);
    try {
      check();
      step('새 커밋까지 working copy 에 반영');
      const r = await this.landTask(task.id, { inStash: true });
      if (!r.ok) {
        step('반영 불가: 커밋 준비를 모두 되돌리는 중');
        await this._endStash(scope, this.resolveTask(task.id).task, m);
        return { ok: false, task: task.id, blocked: r.blocked, needsRebase: !!r.needsRebase || (r.blocked || []).some((b) => b.needsRebase), errors: r.errors };
      }
      const fresh = this.resolveTask(task.id).task;
      await this._ownChangelist(scope, fresh);
      m.revs = await this._lastChangedRevs(scope, fresh.landed.files);
      m.phase = 'ready';
      store.writeJson(this._markerFile(scope), m);
      store.touchEvents({ scope: scope.id, task: task.id, commit: 'refreshed' });
      const help = await this.commitHelp(scope, fresh);
      step(`완료: 이 작업 파일 ${fresh.landed.files.length}개`);
      return { ok: true, task: task.id, files: fresh.landed.files, messageFile: help.messageFile, message: help.suggestedMessage };
    } catch (e) {
      step(`${e.cancelled ? '취소함' : `실패: ${e.message}`}. 커밋 준비를 모두 되돌리는 중`);
      try { await this._endStash(scope, this.resolveTask(task.id).task, m); } catch (_) { /* reported below */ }
      const err = new Error(e.cancelled ? '커밋 준비 갱신을 취소했습니다. working copy 는 커밋 준비 전으로 되돌렸습니다.' : `커밋 준비 갱신 실패 (커밋 준비 전으로 되돌렸습니다, 보관본: ${m.stash}): ${e.message}`);
      err.cancelled = !!e.cancelled;
      throw err;
    }
  }

  async _endStash(scope, task, m) {
    const svn = await this.svn();
    const root = scope.svnPath;
    const CHANGED = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'];
    let committed = false;
    const isTest = m.kind === 'test';
    const edited = [];
    const t0 = Date.now();
    const step = (msg) => this._step(`[${isTest ? '로컬 반영 되돌리기' : '커밋 정리'} #${task.no}] ${msg} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (!m.revs && !m.applied) {
      // stopped before the task was fully applied: take back whatever of it is in the working copy
      const mine = await this._taskPaths(scope, task).catch(() => new Set());
      const saved = new Set(m.entries.map((e) => key(e.path)));
      const st0 = await svn.status(root);
      const partial = st0.filter((e) => mine.has(relPosix(scope.svnPath, e.path)) && CHANGED.includes(e.item));
      if (partial.length) await svn.withTargets(['revert', '--depth', 'infinity'], partial.map((e) => e.path), { okCodes: [1] });
      for (const e of partial.filter((x) => x.item === 'added' && !saved.has(key(x.path)))) { try { fs.rmSync(e.path, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
      const cl0 = (await svn.status(root)).filter((e) => e.changelist === task.changelist && !saved.has(key(e.path))).map((e) => e.path);
      if (cl0.length) await svn.withTargets(['changelist', '--remove'], cl0, { okCodes: [1] });
    } else if (task.landed) {
      step('커밋 여부 확인');
      committed = await this.commitDone(task.id);
      step(committed ? '커밋됨: 남은 작업 변경 정리' : `커밋 안 됨: ${isTest ? '로컬에 반영한 ' : ''}작업 변경 되돌리기`);
      if (isTest && !committed) {
        // task files someone changed in the working copy during the test: keep a copy before they are reverted
        for (const f of task.landed.files) {
          const abs = fromPosix(scope.svnPath, f);
          const cur = readFileOrNull(abs);
          const was = (m.landedHash || {})[f];
          if (was === undefined || (cur === null ? was === null : was === hashBuf(cur))) continue;
          const copy = cur === null ? null : path.join(m.stash, 'edited-during-test', ...f.split('/'));
          if (copy) { store.ensureDir(path.dirname(copy)); fs.writeFileSync(copy, cur); }
          edited.push({ path: f, copy, deleted: cur === null });
        }
        if (edited.length) step(`로컬 반영 중에 고친 작업 파일 ${edited.length}개를 보관본에 복사: ${edited.map((e) => e.path).join(', ')}`);
      }
      // what is left of the task (cancelled, or files left unchecked) goes: it is all in git
      const st = await svn.status(root);
      const mine = new Set(task.landed.files.map((f) => key(fromPosix(scope.svnPath, f))));
      const dirs = new Set((task.landed.dirs || []).map((d) => key(fromPosix(scope.svnPath, d))));
      const pend = st.filter((e) => (mine.has(key(e.path)) || dirs.has(key(e.path))) && CHANGED.includes(e.item));
      if (pend.length) await svn.withTargets(['revert', '--depth', 'infinity'], pend.map((e) => e.path), { okCodes: [1] });
      for (const e of pend.filter((x) => x.item === 'added')) { try { fs.rmSync(e.path, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
      const cl = (await svn.status(root)).filter((e) => e.changelist === task.changelist).map((e) => e.path);
      if (cl.length) await svn.withTargets(['changelist', '--remove'], cl, { okCodes: [1] });
    }
    // put back what was set aside
    step(`빼 두었던 변경 ${m.entries.length}개 복구`);
    const kept = [];
    const toAdd = [];
    const toDelete = [];
    const errors = [];
    const handled = new Set();
    for (const dst of m.entries.filter((x) => !x.isDir && x.item === 'added' && x.movedFrom)) {
      const src = m.entries.find((x) => x !== dst && x.movedTo && key(x.path) === key(dst.movedFrom) && key(x.movedTo) === key(dst.path));
      if (!src || !fs.existsSync(src.path) || (committed && dst.changelist && dst.changelist === task.changelist)) continue;
      const r = await svn.raw(['move', '--parents', src.path, dst.path]);
      if (r.code !== 0) { errors.push(`svn move ${relPosix(root, src.path)} -> ${relPosix(root, dst.path)}: ${decode(r.stderr).trim()}`); continue; }
      if (dst.copy) fs.writeFileSync(dst.path, fs.readFileSync(dst.copy));
      handled.add(src);
      handled.add(dst);
    }
    for (const e of m.entries.filter((x) => x.isDir && x.item === 'added').sort((a, b) => a.path.length - b.path.length)) {
      store.ensureDir(e.path);
      toAdd.push(e.path);
    }
    for (const e of m.entries.filter((x) => !x.isDir && (CHANGED.includes(x.item) || x.item === 'unversioned'))) {
      if (handled.has(e)) continue;
      if (committed && e.changelist && e.changelist === task.changelist) continue;
      const saved = e.copy ? fs.readFileSync(e.copy) : null;
      const oldBase = e.base ? fs.readFileSync(e.base) : null;
      const cur = readFileOrNull(e.path);
      if (e.item === 'deleted' || e.item === 'missing') {
        if (cur !== null && oldBase !== null && !bufEq(cur, oldBase)) { kept.push(e); continue; } // changed by the commit: keep it
        if (e.item === 'deleted' && cur !== null) toDelete.push(e.path);
        else if (cur !== null) { try { fs.unlinkSync(e.path); } catch (_) { /* ignore */ } }
        continue;
      }
      let out;
      if (cur === null || (oldBase !== null && bufEq(cur, oldBase))) out = saved; // nothing changed there meanwhile
      else if (saved !== null && bufEq(cur, saved)) out = cur;
      else if (oldBase === null || saved === null) out = undefined; // the commit created/changed it differently
      else {
        const mm = await this._merge3(scope, cur, oldBase, saved); // the commit is the new BASE: re-apply the saved change on top
        out = mm.action === 'write' ? mm.content : (mm.action === 'none' ? cur : undefined);
      }
      if (out === undefined) { kept.push(e); continue; }
      if (out !== null) { store.ensureDir(path.dirname(e.path)); fs.writeFileSync(e.path, out); }
      if (e.item === 'added') toAdd.push(e.path);
    }
    step(`svn add ${toAdd.length}개, delete ${toDelete.length}개, changelist 복원`);
    if (toAdd.length) { try { await svn.withTargets(['add', '--force', '--parents', '--depth', 'empty'], toAdd); } catch (err) { errors.push(err.message); } }
    if (toDelete.length) { try { await svn.withTargets(['delete', '--force'], toDelete); } catch (err) { errors.push(err.message); } }
    const groups = new Map();
    for (const e of m.entries.filter((x) => x.changelist && (!committed || x.changelist !== task.changelist) && !x.isDir && fs.existsSync(x.path))) {
      if (!groups.has(e.changelist)) groups.set(e.changelist, []);
      groups.get(e.changelist).push(e.path);
    }
    for (const [cl, paths] of groups) { try { await svn.withTargets(['changelist', cl], paths, { okCodes: [1] }); } catch (err) { errors.push(err.message); } }
    // svn stops at the first target it cannot handle (exit 1 = warning): check and redo one by one
    if (groups.size) {
      const now_ = new Map((await svn.status(root)).map((e) => [key(e.path), e.changelist || null]));
      for (const [cl, paths] of groups) {
        for (const p of paths) {
          if (now_.get(key(p)) === cl) continue;
          const r = await svn.raw(['changelist', cl, p]);
          if (r.code !== 0) errors.push(`changelist ${cl} ${relPosix(root, p)}: ${decode(r.stderr).trim()}`);
        }
      }
    }

    fs.rmSync(this._markerFile(scope), { force: true });
    const keepStash = kept.length || errors.length || edited.some((e) => e.copy);
    if (!keepStash) fs.rmSync(m.stash, { recursive: true, force: true });
    const fresh = this.resolveTask(task.id).task;
    if (isTest && !committed) {
      fresh.status = m.prevStatus === 'landed' && m.prevLanded ? 'landed' : 'active';
      fresh.landed = fresh.status === 'landed' ? m.prevLanded : null;
      this._saveTask(scope, fresh);
      store.touchEvents({ scope: scope.id, task: task.id, test: 'ended' });
      return {
        task: task.id, test: true, sha: m.sha, committed: false, restored: m.entries.length - kept.length,
        kept: kept.map((e) => ({ path: relPosix(root, e.path), copy: e.copy || null })), edited, stash: keepStash ? m.stash : null, errors,
      };
    }
    if (committed) {
      fresh.status = 'committed';
      fresh.committedAt = now();
      fresh.commitVerified = true;
      fresh.leftovers = [];
    } else {
      // cancelled: back to exactly what it was (a changelist made by an earlier version stays)
      fresh.status = m.prevStatus === 'landed' && m.prevLanded ? 'landed' : 'active';
      fresh.landed = fresh.status === 'landed' ? m.prevLanded : null;
      store.touchEvents({ scope: scope.id, task: task.id, commit: 'cancelled' });
    }
    this._saveTask(scope, fresh);
    if (committed) { try { await this.refreshScope(scope.id); } catch (_) { /* best effort */ } }
    return {
      task: task.id, committed, restored: m.entries.length - kept.length,
      kept: kept.map((e) => ({ path: relPosix(root, e.path), copy: e.copy || null })), edited, test: isTest || undefined, stash: keepStash ? m.stash : null, errors,
    };
  }

  // ------------------------------------------------------------ split commit (one task at a time)
  _markerFile(scope) { return path.join(scope.home, 'commit-in-progress.json'); }
  _commitMarker(scope) { return store.readJson(this._markerFile(scope), null); }
  _assertNoCommitInProgress(scope) {
    const m = this._commitMarker(scope);
    if (m && m.kind === 'test') throw new Error(`작업 ${m.task} 이(가) 로컬(SVN working copy)에 반영돼 있습니다 (${m.at}). 먼저 되돌리거나 그 작업을 커밋 준비하세요.`);
    if (m) throw new Error(`작업 ${m.task} 의 SVN 커밋이 진행 중입니다 (${m.at}). 커밋 창을 닫은 뒤 다시 시도하세요.`);
  }

  // ---------------------------------------------------------------- test on the working copy (one at a time)
  /**
   * The working copy (the local IIS site etc.) can show one state at a time: a test puts one task, pinned to a
   * commit, on the clean SVN BASE with everything else set aside (same machinery as 커밋 준비), and endTest puts
   * everything back. Requests from agents wait in a queue per scope; the extension asks the user before applying.
   */
  /** Full sha of `at` (default: branch tip) if it is a commit of the task. */
  async _taskCommit(scope, task, at) {
    const { git, tip, base } = await this._range(scope, task);
    if (!at) return tip;
    const full = await git.revParse(String(at));
    if (!full) throw new Error(`커밋을 찾을 수 없습니다: ${at}`);
    if (full === tip) return full;
    const inTask = (await git.raw(['merge-base', '--is-ancestor', full, tip])).code === 0
      && (await git.raw(['merge-base', '--is-ancestor', base, full])).code === 0 && full !== base;
    if (!inTask) throw new Error(`#${task.no} 작업의 커밋이 아닙니다: ${String(at).slice(0, 8)}`);
    return full;
  }

  /** The test currently on the scope's working copy (null when none). */
  testState(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    const m = this._commitMarker(scope);
    if (!m || m.kind !== 'test') return null;
    let no = null;
    let title = '';
    try { const t = this.resolveTask(m.task).task; no = t.no; title = t.title; } catch (_) { /* gone */ }
    const item = this._testItems(scope).find((x) => ['building', 'applied'].includes(x.status) && x.task === m.task) || null;
    const ready = m.phase === 'ready' && !(item && item.status === 'building');
    return { scope: scope.id, task: m.task, no, title, sha: m.sha, at: m.at, phase: m.phase, ready, building: !!item && item.status === 'building', svnPath: scope.svnPath, item: item ? item.id : null, by: item ? item.by : 'user' };
  }

  /** Put the task (as of `at`) on the working copy for a test. */
  applyTest(ref, { at = null, token } = {}) { return proc.trace(() => this._stashCommit(ref, { token, mode: 'test', at }), '[로컬 반영]'); }

  /** Take the tested task back out and put everything that was set aside back. */
  async endTest(ref) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.kind !== 'test' || m.task !== task.id) return { task: task.id, test: true, restored: 0, kept: [], edited: [], errors: [], notApplied: true };
    this._step(`[로컬 반영 되돌리기 #${task.no}] 시작 (작업 변경 빼기, 빼 두었던 변경 복구)`);
    const r = await proc.trace(() => this._endStash(scope, task, m), '[로컬 반영 되돌리기]');
    // the request that held the working copy is over (also when restored after a restart, not by testRelease)
    if (this._testItems(scope).some((x) => x.task === task.id && ['building', 'applied'].includes(x.status))) {
      await this._testQueueEdit(scope, (items) => {
        for (const x of items.filter((y) => y.task === task.id && ['building', 'applied'].includes(y.status))) {
          Object.assign(x, { status: 'done', endedAt: now(), restore: { restored: r.restored, kept: r.kept, edited: r.edited, stash: r.stash, errors: r.errors } });
        }
      });
    }
    this._step(`[로컬 반영 되돌리기 #${task.no}] 완료: 복구 ${r.restored}개${r.kept.length ? `, 보관본에 남김 ${r.kept.length}개` : ''}${(r.edited || []).length ? `, 반영 중에 고친 파일 ${(r.edited || []).length}개 보관` : ''}`);
    return r;
  }

  /**
   * 로컬 반영 then build (when the scope has a build command): what "이 작업을 로컬에 반영" does.
   * A failed build leaves the task applied (to look at it); the result says so.
   */
  async localApply(ref, { at = null, token, onOutput, build = true } = {}) {
    const r = await this.applyTest(ref, { at, token });
    if (!r.ok || !build) return r;
    const { scope } = this.resolveTask(ref);
    const b = await this.runLocalBuild(scope.id, { token, onOutput });
    return Object.assign({}, r, { build: b });
  }

  /**
   * Command that builds the working copy after 로컬 반영 (run with cmd.exe in the scope folder). Set by an agent that
   * worked out how to build (svnwt_local_build_set) or detected. '' = never build; null = detect again.
   */
  setLocalBuild(scopeRef, command, { auto = false } = {}) {
    const scope = this.resolveScope(scopeRef);
    if (command === null || command === undefined) { delete scope.localBuild; delete scope.localBuildAuto; } else {
      scope.localBuild = String(command).trim();
      if (auto) scope.localBuildAuto = true; else delete scope.localBuildAuto;
    }
    this._saveScope(scope);
    store.touchEvents({ scope: scope.id });
    return { scope: scope.id, localBuild: scope.localBuild === undefined ? null : scope.localBuild, auto: !!scope.localBuildAuto };
  }

  /** MSBuild of the newest Visual Studio (or Build Tools): SVNWT_MSBUILD, vswhere, then the usual folders. */
  _findMsbuild() {
    if (process.env.SVNWT_MSBUILD) return fs.existsSync(process.env.SVNWT_MSBUILD) ? process.env.SVNWT_MSBUILD : null;
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (fs.existsSync(vswhere)) {
      try {
        const out = require('child_process').execFileSync(vswhere, ['-latest', '-prerelease', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
        const p = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l) && !/\\(amd64|arm64)\\/i.test(l));
        if (p) return p;
      } catch (_) { /* fall through */ }
    }
    for (const base of [process.env.ProgramFiles || 'C:\\Program Files', pf86]) {
      const vs = path.join(base, 'Microsoft Visual Studio');
      let vers = [];
      try { vers = fs.readdirSync(vs).sort().reverse(); } catch (_) { continue; }
      for (const v of vers) {
        let eds = [];
        try { eds = fs.readdirSync(path.join(vs, v)); } catch (_) { continue; }
        for (const e of eds) { const p = path.join(vs, v, e, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'); if (fs.existsSync(p)) return p; }
      }
    }
    return null;
  }

  /**
   * How to build the scope's working copy without asking anybody: MSBuild + the nearest .sln (the scope folder and
   * one level below, then the folders above it up to the working copy root), else a single project file.
   */
  detectLocalBuild(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    const msbuild = this._findMsbuild();
    const list = (dir, re) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => path.join(dir, e.name)).sort(); } catch (_) { return []; } };
    const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^(\.svn|\.git|bin|obj|node_modules|packages)$/i.test(e.name)).map((e) => path.join(dir, e.name)); } catch (_) { return []; } };
    let found = [];
    const look = (re) => {
      let hit = list(scope.svnPath, re);
      if (!hit.length) hit = subdirs(scope.svnPath).flatMap((d) => list(d, re));
      for (let d = path.dirname(scope.svnPath); !hit.length && isInside(d, scope.wcRoot || scope.svnPath); d = path.dirname(d)) {
        hit = list(d, re);
        if (key(d) === key(scope.wcRoot || scope.svnPath) || path.dirname(d) === d) break;
      }
      return hit;
    };
    found = look(/\.sln$/i);
    if (!found.length) { const p = look(/\.(cs|vb)proj$/i); if (p.length === 1) found = p; }
    const target = found[0] || null;
    const rel = target ? path.relative(scope.svnPath, target) : null;
    const command = msbuild && target ? `"${msbuild}" "${rel}" -p:Configuration=Debug -m -v:m -nologo` : null;
    const missing = !msbuild ? 'Visual Studio MSBuild 를 찾지 못했습니다' : !target ? '.sln / 프로젝트 파일을 찾지 못했습니다' : null;
    return { scope: scope.id, msbuild, target: rel, candidates: found.map((f) => path.relative(scope.svnPath, f)), command, missing };
  }

  /**
   * Run the scope's build command on the working copy; output goes to onOutput (lines) and a log file. No command
   * yet: detected (and remembered). Nothing to run: { ok: false, missing: reason } (an agent can work it out).
   */
  async runLocalBuild(scopeRef, { token, onOutput, timeoutMin = 30 } = {}) {
    const scope = this.resolveScope(scopeRef);
    if (typeof scope.localBuild !== 'string') {
      const d = this.detectLocalBuild(scope.id);
      if (!d.command) return { ok: false, missing: d.missing, detected: d, tail: [], code: null, ms: 0 };
      this.setLocalBuild(scope.id, d.command, { auto: true });
      this._step(`[로컬 빌드] 빌드 방법을 찾음: ${d.command}`);
      return this.runLocalBuild(scope.id, { token, onOutput, timeoutMin });
    }
    const command = scope.localBuild.trim();
    if (!command) return null; // chosen: no build
    const logFile = path.join(store.ensureDir(path.join(scope.home, 'builds')), `${now().replace(/[:.]/g, '-')}.log`);
    const t0 = Date.now();
    const { spawn, execFile } = require('child_process');
    const lines = [];
    let pending = Buffer.alloc(0);
    const out = fs.openSync(logFile, 'w');
    const emit = (buf, flush) => {
      pending = Buffer.concat([pending, buf]);
      const cut = flush ? pending.length : pending.lastIndexOf(0x0a) + 1;
      if (cut <= 0) return;
      const text = decode(pending.subarray(0, cut));
      pending = pending.subarray(cut);
      for (const l of text.split(/\r?\n/)) {
        if (!l && flush) continue;
        lines.push(l);
        if (lines.length > 200) lines.shift();
        try { fs.writeSync(out, l + '\r\n'); } catch (_) { /* log only */ }
        if (onOutput) { try { onOutput(l); } catch (_) { /* ignore */ } }
      }
    };
    const code = await new Promise((resolve) => {
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: scope.svnPath, windowsHide: true, windowsVerbatimArguments: true });
      const stop = () => { try { execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {}); } catch (_) { /* gone */ } };
      const iv = setInterval(() => {
        if ((token && token.cancelled) || Date.now() - t0 > timeoutMin * 60000) { lines.push(token && token.cancelled ? '(빌드 취소)' : `(빌드 시간 초과: ${timeoutMin}분)`); stop(); }
      }, 500);
      child.stdout.on('data', (d) => emit(d));
      child.stderr.on('data', (d) => emit(d));
      child.on('error', (e) => { lines.push(`빌드 명령 실행 실패: ${e.message}`); clearInterval(iv); resolve(-1); });
      child.on('close', (c) => { clearInterval(iv); resolve(c === null ? -1 : c); });
    });
    emit(Buffer.alloc(0), true);
    try { fs.closeSync(out); } catch (_) { /* ignore */ }
    const ms = Date.now() - t0;
    this._step(`[로컬 빌드] ${code === 0 ? '성공' : `실패 (exit ${code})`} ${(ms / 1000).toFixed(1)}s — 로그 ${logFile}`);
    return { ok: code === 0, code, ms, command, logFile, tail: lines.slice(-40) };
  }

  /**
   * 커밋 준비 on top of 로컬 반영: the working copy already holds only this task, so only the changelist is added
   * (and the commit is watched). Commits made in between are detected (committed: true).
   */
  async prepareFromLocal(ref) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.kind !== 'test' || m.task !== task.id || m.phase !== 'ready') throw new Error('이 작업은 로컬에 반영돼 있지 않습니다.');
    if (await this.commitDone(task.id)) return { ok: false, committed: true, task: task.id };
    await this._ownChangelist(scope, task);
    m.kind = 'stash';
    m.fromLocal = true;
    store.writeJson(this._markerFile(scope), m);
    if (this._testItems(scope).some((x) => x.task === task.id && ['building', 'applied'].includes(x.status))) {
      await this._testQueueEdit(scope, (items) => {
        for (const x of items.filter((y) => y.task === task.id && ['building', 'applied'].includes(y.status))) Object.assign(x, { status: 'done', endedAt: now(), endedBy: 'commit', summary: x.summary || '커밋 준비로 넘어감' });
      });
    }
    store.touchEvents({ scope: scope.id, task: task.id, commit: 'begin' });
    const fresh = this.resolveTask(task.id).task;
    const help = await this.commitHelp(scope, fresh);
    const CHANGED = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'];
    return {
      ok: true, task: task.id, files: fresh.landed.files, setAside: m.entries.filter((e) => CHANGED.includes(e.item) || e.item === 'unversioned').length,
      stash: m.stash, targets: help.targets, messageFile: help.messageFile, message: help.suggestedMessage,
    };
  }

  // queue: <scope home>/test-queue.json  { items: [{ id, task, no, title, sha, note, writes, by, status, at, ... }] }
  // status: queued -> asking -> applied -> done | rejected | cancelled | failed
  _testQueueFile(scope) { return path.join(scope.home, 'test-queue.json'); }
  _testItems(scope) { return (store.readJson(this._testQueueFile(scope), { items: [] }).items) || []; }
  async _testQueueEdit(scope, fn) {
    return store.withLock(path.join(scope.home, 'test-queue.lock'), async () => {
      const q = store.readJson(this._testQueueFile(scope), { items: [] });
      q.items = q.items || [];
      const before = JSON.stringify(q.items);
      const r = await fn(q.items);
      // keep the last 30 finished requests
      const open = q.items.filter((x) => TEST_OPEN.includes(x.status));
      const done = q.items.filter((x) => !TEST_OPEN.includes(x.status)).slice(-30);
      q.items = q.items.filter((x) => open.includes(x) || done.includes(x));
      // write (and wake the UIs) only on a change: the extension polls this, and every event makes it refresh
      if (JSON.stringify(q.items) !== before) {
        store.writeJson(this._testQueueFile(scope), q);
        store.touchEvents({ scope: scope.id, testQueue: q.items.length });
      }
      return r;
    }, { op: `${scope.id}: 테스트 큐`, timeoutMs: 60000 });
  }

  /**
   * Ask for a test of a task (default: its newest commit). A request of the same task still waiting is replaced
   * (newest commit wins). by 'user' is for the human's own "main 에 올려 테스트" (applied without asking).
   */
  async testRequest(ref, { at = null, note = '', writes = false, by = 'agent' } = {}) {
    const { scope, task } = this.resolveTask(ref);
    if (!['active', 'landed'].includes(task.status)) throw new Error('진행 중인 작업만 테스트할 수 있습니다.');
    const sha = await this._taskCommit(scope, task, at);
    return this._testQueueEdit(scope, (items) => {
      let it = items.find((x) => x.task === task.id && x.status === 'queued');
      if (it) Object.assign(it, { sha, note: note || it.note, writes: !!writes || it.writes, by, updatedAt: now() });
      else {
        it = { id: `${Date.now().toString(36)}-${task.no}`, scope: scope.id, task: task.id, no: task.no, title: task.title, sha, note, writes: !!writes, by, status: 'queued', at: now() };
        items.push(it);
      }
      const waiting = items.filter((x) => x.status === 'queued' || x.status === 'asking');
      return Object.assign({}, it, { position: waiting.indexOf(it) + 1, ahead: items.filter((x) => x.status === 'applied').length + waiting.indexOf(it) });
    });
  }

  /** Requests of one scope (or every scope): open ones first in queue order, then the latest finished. */
  testQueue(scopeRef) {
    const scopes = scopeRef ? [this.resolveScope(scopeRef)] : this.listScopes().map((s) => this.resolveScope(s.id));
    return scopes.flatMap((s) => this._testItems(s));
  }

  testItem(id) {
    for (const s of this.listScopes()) {
      const scope = this.resolveScope(s.id);
      const it = this._testItems(scope).find((x) => x.id === id);
      if (it) return { scope, item: it };
    }
    throw new Error(`테스트 요청을 찾을 수 없습니다: ${id}`);
  }

  async _testUpdate(id, patch) {
    const { scope } = this.testItem(id);
    return this._testQueueEdit(scope, (items) => { const it = items.find((x) => x.id === id); Object.assign(it, patch); return Object.assign({}, it); });
  }

  /**
   * Runner (the extension): the next request to ask the user about, marked "asking"; null while a test or a
   * commit holds the working copy, or while another request is being asked.
   */
  async testClaimNext(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    if (this._commitMarker(scope)) return null;
    if (!this._testItems(scope).some((x) => x.status === 'queued' && x.by !== 'user')) return null; // polled often: no lock, no write
    return this._testQueueEdit(scope, (items) => {
      if (items.some((x) => ['asking', 'building', 'applied'].includes(x.status))) return null;
      const it = items.find((x) => x.status === 'queued' && x.by !== 'user');
      if (!it) return null;
      it.status = 'asking';
      it.askedAt = now();
      return Object.assign({}, it);
    });
  }

  /** After a restart: requests left "asking" go back to the queue. */
  async testResetAsking() {
    for (const s of this.listScopes()) {
      const scope = this.resolveScope(s.id);
      if (!this._testItems(scope).some((x) => x.status === 'asking')) continue;
      await this._testQueueEdit(scope, (items) => { for (const x of items.filter((y) => y.status === 'asking')) x.status = 'queued'; });
    }
  }

  async testReject(id, reason = '사용자가 거절했습니다.') {
    const { item } = this.testItem(id);
    if (!['queued', 'asking'].includes(item.status)) return item;
    return this._testUpdate(id, { status: 'rejected', reason, endedAt: now() });
  }

  /** Apply a request (the user said yes). Blocked files / errors end the request as "failed" with the reason. */
  async testApplyItem(id, { token, onOutput } = {}) {
    const { item } = this.testItem(id);
    if (!['queued', 'asking'].includes(item.status)) throw new Error(`이미 처리된 테스트 요청입니다 (${item.status}).`);
    let r;
    try {
      r = await this.applyTest(item.task, { at: item.sha, token });
      if (r.ok) {
        const { scope } = this.resolveTask(item.task);
        if (scope.localBuild !== '') {
          await this._testUpdate(id, { status: 'building', appliedAt: now(), files: r.files, setAside: r.setAside, svnPath: r.svnPath });
          r.build = await this.runLocalBuild(scope.id, { token, onOutput });
        }
      }
    } catch (e) {
      await this._testUpdate(id, { status: e.cancelled ? 'cancelled' : 'failed', reason: e.message, endedAt: now() });
      throw e;
    }
    if (!r.ok) {
      const reason = `working copy 에 올릴 수 없는 파일: ${(r.blocked || []).map((b) => `${b.path}${b.reason ? ` (${b.reason})` : ''}`).join(', ')}`;
      await this._testUpdate(id, { status: 'failed', reason, needsRebase: !!r.needsRebase, endedAt: now() });
      return Object.assign({}, r, { item: id });
    }
    const build = r.build ? { ok: r.build.ok, code: r.build.code, ms: r.build.ms, logFile: r.build.logFile || null, missing: r.build.missing || null, tail: (r.build.tail || []).slice(-20) } : null;
    await this._testUpdate(id, { status: 'applied', appliedAt: now(), files: r.files, setAside: r.setAside, svnPath: r.svnPath, build });
    return Object.assign({}, r, { item: id });
  }

  /**
   * The test is over (agent or user): put the working copy back, record the result. A request still waiting is
   * just cancelled.
   */
  async testRelease(id, { result = null, summary = '', by = 'agent' } = {}) {
    const { item } = this.testItem(id);
    if (item.status === 'queued' || item.status === 'asking') return this._testUpdate(id, { status: 'cancelled', reason: summary || '테스트 전에 취소함', endedAt: now() });
    if (item.status !== 'applied') return Object.assign({}, item, { note: `이미 끝난 요청입니다 (${item.status}).` });
    const restore = await this.endTest(item.task);
    const done = await this._testUpdate(id, { status: 'done', result: result || null, summary, endedBy: by, endedAt: now() });
    return Object.assign({}, done, { restore });
  }

  /** Wait until a request is applied, refused or over (agents poll this between their steps). */
  async testWait(id, { timeoutSec = 120 } = {}) {
    const end = Date.now() + Math.max(1, Math.min(600, timeoutSec)) * 1000;
    for (;;) {
      const { scope, item } = this.testItem(id);
      if (!['queued', 'asking', 'building'].includes(item.status) || Date.now() >= end) {
        const items = this._testItems(scope);
        const waiting = items.filter((x) => x.status === 'queued' || x.status === 'asking');
        return Object.assign({}, item, { position: waiting.findIndex((x) => x.id === id) + 1 || undefined, current: this.testState(scope.id) });
      }
      await store.sleep(1500);
    }
  }

  /**
   * For each file of the task whose working-copy content contains more than this task's change
   * (another task's change on a shared file, or the user's own local edit): the content to commit,
   * i.e. SVN BASE + this task's delta.
   */
  async _isolation(scope, task) {
    const svn = await this.svn();
    const git = await this.git(scope);
    const stList = await svn.status(scope.svnPath);
    const st = new Map(stList.map((e) => [key(e.path), e]));
    const out = [];
    for (const rel of task.landed.files) {
      const abs = fromPosix(scope.svnPath, rel);
      const e = st.get(key(abs));
      const wc = readFileOrNull(abs);
      if (!wc || !e || !['modified', 'merged'].includes(e.item)) continue; // added / deleted / moved: committed as they are
      const pristine = await svn.catBase(abs);
      if (pristine === null) continue;
      const m = await this._merge3(scope, pristine, await git.blob(task.landed.base, rel), await git.blob(task.landed.commit, rel));
      let isolated;
      if (m.action === 'write') isolated = m.content;
      else if (m.action === 'none') isolated = pristine;
      else if (m.action === 'delete') continue;
      else throw new Error(`${rel}: 이 작업의 변경만 분리할 수 없습니다 (${m.reason}). 최신 SVN 기준으로 rebase 하고 changelist 를 갱신하세요.`);
      if (!bufEq(isolated, wc)) out.push({ rel, abs, wc, isolated, shared: !!(task.landed.shared || {})[rel] });
    }
    return out;
  }

  /** What a commit of this task will contain; files whose other changes are set aside during the commit. */
  async commitPlan(ref) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status !== 'landed') throw new Error('SVN changelist 를 만든(커밋 대기) 작업만 커밋할 수 있습니다.');
    const git = await this.git(scope);
    const tip = await git.revParse('refs/heads/' + task.branch);
    const iso = await this._isolation(scope, task);
    const help = await this.commitHelp(scope, task);
    return {
      task: task.id, changelist: task.changelist, targets: help.targets, files: task.landed.files, messageFile: help.messageFile,
      message: help.suggestedMessage, stale: tip !== task.landed.commit,
      setAside: iso.map((x) => ({ path: x.rel, reason: x.shared ? `다른 작업(${task.landed.shared[x.rel]})의 변경` : 'working copy 의 다른 로컬 수정' })),
    };
  }

  /**
   * Start a human commit of one task: back up and rewrite files so that only this task's change is
   * committed. Always call endCommit afterwards (committed or cancelled) to restore the files.
   */
  /**
   * @param {{external?:boolean}} opts external: "prepare only" - the user opens TortoiseSVN's commit dialog
   *   on the working copy themselves. Every other changed file in the working
   *   copy is moved to TortoiseSVN's reserved changelist "ignore-on-commit" (unchecked by default in the
   *   commit dialog), so only this task's files are checked. endCommit puts the changelists back.
   */
  async beginCommit(ref, { external = false } = {}) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status !== 'landed') throw new Error('SVN changelist 를 만든(커밋 대기) 작업만 커밋할 수 있습니다.');
    this._assertNoCommitInProgress(scope);
    const svn = await this.svn();
    const iso = await this._isolation(scope, task);
    const help = await this.commitHelp(scope, task);
    const dir = path.join(scope.home, 'tasks', task.id + '.commit-backup');
    fs.rmSync(dir, { recursive: true, force: true });
    store.ensureDir(dir);
    const files = iso.map((x, i) => {
      const backup = path.join(dir, String(i));
      fs.writeFileSync(backup, x.wc);
      return { rel: x.rel, backup };
    });
    let parked = [];
    const own = [];
    const unadded = [];
    let otherNewDirs = [];
    if (external) {
      // TortoiseSVN checks only files outside any changelist by default: this task's files leave their
      // changelist, every other change goes to the reserved (unchecked) changelist "ignore-on-commit".
      const mine = new Set(help.targets.map((t) => key(t)));
      const all = await svn.status(scope.wcRoot || scope.svnPath);
      for (const e of all) {
        if (!['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'].includes(e.item)) continue;
        let isDir = false;
        try { isDir = fs.statSync(e.path).isDirectory(); } catch (_) { /* deleted */ }
        if (mine.has(key(e.path))) { if (!isDir && e.changelist) own.push({ path: e.path, changelist: e.changelist }); continue; }
        if (isDir) { if (e.item === 'added') otherNewDirs.push(e); continue; } // directories cannot be in changelists
        parked.push({ path: e.path, changelist: e.changelist || null });
      }
      // Other tasks' newly added folders would show up checked: un-schedule them for the duration of the
      // commit (files stay on disk as unversioned = unchecked) and add them again afterwards.
      const tops = otherNewDirs.filter((d) => !d.copied && !otherNewDirs.some((o) => o !== d && isInside(d.path, o.path) && key(o.path) !== key(d.path)));
      for (const d of tops) {
        const inside = all.filter((e) => isInside(e.path, d.path) && e.item === 'added');
        if (inside.some((e) => e.copied || mine.has(key(e.path)))) continue; // moved/copied or ours: leave as is
        for (const e of inside) {
          let isDir = false;
          try { isDir = fs.statSync(e.path).isDirectory(); } catch (_) { /* ignore */ }
          unadded.push({ path: e.path, isDir, changelist: e.changelist || null });
        }
      }
      unadded.sort((a, b) => a.path.length - b.path.length);
      const unaddedKeys = new Set(unadded.map((u) => key(u.path)));
      parked = parked.filter((p) => !unaddedKeys.has(key(p.path)));
      otherNewDirs = otherNewDirs.filter((d) => !unaddedKeys.has(key(d.path)));
    }
    store.writeJson(this._markerFile(scope), {
      task: task.id, at: now(), pid: process.pid, external, files, parked, own, unadded,
      revs: await this._lastChangedRevs(scope, task.landed.files),
    });
    store.touchEvents({ scope: scope.id, task: task.id, commit: 'begin' });
    try {
      for (const x of iso) fs.writeFileSync(x.abs, x.isolated);
      if (own.length) await svn.withTargets(['changelist', '--remove'], own.map((p) => p.path), { okCodes: [1] });
      const unaddTops = unadded.filter((u) => u.isDir && !unadded.some((o) => o !== u && o.isDir && isInside(u.path, o.path) && key(o.path) !== key(u.path)));
      if (unaddTops.length) await svn.withTargets(['revert', '--depth', 'infinity'], unaddTops.map((u) => u.path));
      if (parked.length) await svn.withTargets(['changelist', 'ignore-on-commit'], parked.map((p) => p.path), { okCodes: [1] });
    } catch (e) {
      await this.endCommit(task.id);
      throw new Error(`커밋 준비 실패 (원래 상태로 되돌렸습니다): ${e.message}`);
    }
    return {
      task: task.id, setAside: iso.map((x) => x.rel), parked: parked.length, otherNewDirs: otherNewDirs.map((d) => relPosix(scope.wcRoot || scope.svnPath, d.path)),
      targets: help.targets, targetsFile: help.targetsFile, messageFile: help.messageFile, message: help.suggestedMessage,
    };
  }

  /** During a prepared commit: has the task been committed yet? (cheap: svn info of the task's files) */
  async commitDone(ref) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.task !== task.id || !task.landed) return false;
    const after = await this._lastChangedRevs(scope, task.landed.files);
    const moved = task.landed.files.filter((f) => (f in after ? after[f] > ((m.revs || {})[f] || 0) : f in (m.revs || {})));
    for (const f of moved) if (await this._changeInBase(scope, task, f)) return true;
    return false;
  }

  /**
   * A task marked "committed" by an older version (0.4.0 and earlier took a vanished file or a revision moved by
   * svn update as a commit): if none of its change is in SVN, put it back to "커밋 대기" (its changelist is still
   * in the working copy) or "진행 중". Checked once per task.
   */
  async _verifyCommitted(scope, task) {
    if (task.status !== 'committed' || task.commitVerified) return task.status;
    if (!task.landed) { task.commitVerified = true; this._saveTask(scope, task); return task.status; }
    for (const f of task.landed.files || []) {
      if (await this._changeInBase(scope, task, f)) { task.commitVerified = true; this._saveTask(scope, task); return task.status; }
    }
    const svn = await this.svn();
    const inWc = (await svn.status(scope.svnPath)).some((e) => e.changelist === task.changelist);
    task.status = inWc ? 'landed' : 'active';
    if (!inWc) task.landed = null;
    delete task.committedAt;
    delete task.leftovers;
    task.commitVerified = true;
    task.uncommittedAt = now();
    this._saveTask(scope, task);
    return task.status;
  }

  /**
   * Manual "SVN 상태 확인" (nothing checks SVN automatically): for one task, or every task waiting for a commit
   * or marked committed. Committed? (커밋 대기 -> 커밋 완료), wrongly committed? (-> 커밋 대기 / 진행 중), leftovers.
   */
  // ---------------------------------------------------------------- background SVN checks (extension: svnWatch)
  /** Cheap, no server: the scope folder's revision in the working copy against the SVN base svnwt has. */
  async wcRevision(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    const info = await (await this.svn()).info(scope.svnPath);
    return { scope: scope.id, revision: info.revision, base: scope.revision, changed: info.revision !== scope.revision };
  }

  /**
   * Commits on the server that touch the scope folder and are not in the working copy yet. The user's own
   * commits (svn commit bumps the committed files' revision) count as being there.
   */
  async serverCommits(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    const svn = await this.svn();
    const info = await svn.info(scope.svnPath);
    const entries = await svn.logAfter(info.url, info.revision);
    if (!entries.length) return { scope: scope.id, revision: info.revision, pending: [] };
    const prefix = decodeURIComponent(info.url.slice(info.repoRoot.length)).replace(/\/+$/, '');
    const local = (p) => (p === prefix ? scope.svnPath : p.startsWith(prefix + '/') ? path.join(scope.svnPath, ...p.slice(prefix.length + 1).split('/')) : null);
    const all = [...new Set(entries.flatMap((e) => e.paths.map((x) => local(x.path)).filter(Boolean)))].filter((p) => fs.existsSync(p));
    const rev = new Map((all.length ? await svn.infoMany(all) : []).map((i) => [key(i.path), i.revision]));
    const applied = (e) => {
      const mine = e.paths.map((x) => ({ x, l: local(x.path) })).filter((y) => y.l);
      return mine.length > 0 && mine.every(({ x, l }) => {
        const r = rev.get(key(l));
        return x.action === 'D' ? r === undefined || r >= e.revision : r !== undefined && r >= e.revision;
      });
    };
    const pending = entries.filter((e) => !applied(e)).map(({ revision, author, date, msg }) => ({ revision, author, date, msg }));
    return { scope: scope.id, revision: info.revision, pending };
  }

  /** Active tasks of a scope based on an older SVN base, and why one cannot be rebased right now. */
  async tasksBehind(scopeRef) {
    const scope = this.resolveScope(scopeRef);
    const git = await this.git(scope);
    const res = [];
    for (const t of this._listTaskFiles(scope).filter((x) => x.status === 'active')) {
      let behind = 0;
      try { behind = Number(decode(await git.buf(['rev-list', '--count', `refs/heads/${t.branch}..${BASE_REF}`])).trim()) || 0; } catch (_) { continue; }
      if (!behind) continue;
      let wt = null;
      try { wt = await this._worktreeState(scope, t); } catch (_) { /* none */ }
      const agent = t.agent && (t.agent.state === 'running' || t.agent.state === 'waiting');
      const blocked = !wt || !wt.exists ? 'worktree 없음' : wt.rebasing || wt.merging ? 'rebase 충돌 정리 중' : wt.dirty.length ? '커밋되지 않은 변경' : agent ? '에이전트 실행 중' : null;
      res.push({ id: t.id, no: t.no, title: t.title, behind, blocked });
    }
    return res;
  }

  async checkSvnState(ref) {
    const list = ref ? [this.resolveTask(ref).task] : this.listTasks().filter((t) => t.status === 'landed' || t.status === 'committed');
    const changed = [];
    for (const t of list) {
      const { scope, task } = this.resolveTask(t.id);
      const before = task.status;
      if (task.status === 'committed') { task.commitVerified = false; this._saveTask(scope, task); }
      try { await this.taskInfo(task.id, { checkSvn: true }); } catch (_) { continue; }
      const after = this.resolveTask(task.id).task;
      if (after.status !== before) changed.push({ id: after.id, no: after.no, title: after.title, from: before, to: after.status });
    }
    return { checked: list.length, changed };
  }

  /** Re-check every task marked committed (see _verifyCommitted). Returns the ones put back. */
  async reverifyCommitted() {
    const fixed = [];
    for (const sc of this.listScopes()) {
      let scope;
      try { scope = this.resolveScope(sc.id); } catch (_) { continue; }
      for (const t of this._listTaskFiles(scope).filter((x) => x.status === 'committed' && !x.commitVerified)) {
        try {
          const st = await this._verifyCommitted(scope, t);
          if (st !== 'committed') fixed.push({ id: t.id, no: t.no, title: t.title, status: st });
        } catch (_) { /* svn busy: next start */ }
      }
    }
    return fixed;
  }

  /** Is the task's (landed) change to `rel` contained in the SVN BASE of the working copy? */
  async _changeInBase(scope, task, rel) {
    const git = await this.git(scope);
    const svn = await this.svn();
    const abs = fromPosix(scope.svnPath, rel);
    const landedBlob = await git.blob(task.landed.commit, rel);
    const baseBlob = await git.blob(task.landed.base, rel);
    const pristine = await svn.catBase(abs);
    if (landedBlob === null) return baseBlob !== null && pristine === null && !fs.existsSync(abs); // deletion committed
    if (pristine === null) return false; // not in SVN: deleted by hand, add reverted, ...
    if (bufEq(pristine, landedBlob)) return true;
    if (baseBlob === null || bufEq(baseBlob, landedBlob)) return false;
    const m = await this._merge3(scope, pristine, baseBlob, landedBlob);
    return m.action === 'none' || (m.action === 'write' && bufEq(m.content, pristine));
  }

  /** Run `svn commit` for the task between beginCommit and endCommit (from the human UI only, never from the agent). */
  async runSvnCommit(ref) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.task !== task.id) throw new Error('beginCommit 이 먼저 필요합니다.');
    const svn = await this.svn();
    const help = await this.commitHelp(scope, task);
    const base = ['commit', '--depth', 'empty', '--encoding', 'UTF-8', '-F', help.messageFile];
    const args = help.targets.join(' ').length < 28000 ? [...base, '--', ...help.targets] : [...base, '--targets', help.targetsFile];
    const r = await svn.raw(args);
    return { ok: r.code === 0, output: (decode(r.stdout) + decode(r.stderr)).trim() };
  }

  /** Restore the set-aside content, detect whether the commit happened, hand shared files over. */
  async endCommit(ref) {
    const { scope, task } = this.resolveTask(ref);
    const m = this._commitMarker(scope);
    if (!m || m.task !== task.id) return { task: task.id, committed: task.status === 'committed', restored: 0 };
    if (m.kind === 'test') return this.endTest(task.id);
    if (m.kind === 'stash') {
      this._step(`[커밋 정리 #${task.no}] 시작 (커밋 판정, 남은 변경 정리, 빼 두었던 변경 복구)`);
      const r = await proc.trace(() => this._endStash(scope, task, m), '[커밋 정리]');
      this._step(`[커밋 정리 #${task.no}] 완료: ${r.committed ? '커밋됨' : '취소'}, 복구 ${r.restored}개${r.kept && r.kept.length ? `, 보관본에 남김 ${r.kept.length}개` : ''}`);
      return r;
    }
    const errors = [];
    let restored = 0;
    for (const f of m.files) {
      try { fs.writeFileSync(fromPosix(scope.svnPath, f.rel), fs.readFileSync(f.backup)); restored++; } catch (e) { errors.push(`${f.rel}: ${e.message}`); }
    }
    if (errors.length) throw new Error(`일부 파일을 되돌리지 못했습니다. 백업: ${path.dirname(m.files[0].backup)}\n${errors.join('\n')}`);
    // other tasks' new folders: schedule the add again, files back into their changelists
    if (m.unadded && m.unadded.length) {
      const svn = await this.svn();
      const exists = m.unadded.filter((u) => fs.existsSync(u.path));
      try { if (exists.length) await svn.withTargets(['add', '--force', '--depth', 'empty', '--parents'], exists.map((u) => u.path)); } catch (e) { errors.push(e.message); }
      const groups = new Map();
      for (const u of exists.filter((x) => !x.isDir && x.changelist)) {
        if (!groups.has(u.changelist)) groups.set(u.changelist, []);
        groups.get(u.changelist).push(u.path);
      }
      for (const [cl, paths] of groups) {
        try { await svn.withTargets(['changelist', cl], paths, { okCodes: [1] }); } catch (e) { errors.push(e.message); }
      }
    }
    // put parked files back into their own changelists (files committed by mistake simply have none now)
    if ((m.parked && m.parked.length) || (m.own && m.own.length)) {
      const svn = await this.svn();
      const now_ = new Map((await svn.status(scope.wcRoot || scope.svnPath)).map((e) => [key(e.path), e]));
      const pendingItem = (p) => ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'].includes((now_.get(key(p.path)) || {}).item);
      const still = [
        ...(m.parked || []).filter((p) => (now_.get(key(p.path)) || {}).changelist === 'ignore-on-commit'),
        // this task's files that were not committed (dialog cancelled / unchecked): back to their changelist
        ...(m.own || []).filter((p) => pendingItem(p) && !(now_.get(key(p.path)) || {}).changelist),
      ];
      const groups = new Map();
      for (const p of still) {
        const k = p.changelist || '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p.path);
      }
      for (const [cl, paths] of groups) {
        try {
          await svn.withTargets(cl ? ['changelist', cl] : ['changelist', '--remove'], paths, { okCodes: [1] });
        } catch (e) { errors.push(e.message); }
      }
    }
    const committed = task.landed ? this._revsAdvanced(m.revs, await this._lastChangedRevs(scope, task.landed.files)) : false;
    fs.rmSync(this._markerFile(scope), { force: true });
    fs.rmSync(path.join(scope.home, 'tasks', task.id + '.commit-backup'), { recursive: true, force: true });
    if (committed) {
      task.status = 'committed';
      task.committedAt = now();
      this._saveTask(scope, task);
      await this._reassignShared(scope, task, await this.svn());
      await this._recordLeftovers(scope, task);
      try { await this.refreshScope(scope.id); } catch (_) { /* best effort */ }
    } else {
      store.touchEvents({ scope: scope.id, task: task.id, commit: 'cancelled' });
    }
    return { task: task.id, committed, restored, leftovers: committed ? (task.leftovers || []) : undefined };
  }

  /** Commits prepared but not finished (marker files). */
  pendingCommits() {
    return this.listScopes().map((s) => this._commitMarker(s)).filter(Boolean);
  }

  /** Recover from a crash between beginCommit and endCommit (external commits are left running unless all=true). */
  async recoverCommits({ all = false } = {}) {
    const res = [];
    for (const m of this.pendingCommits()) {
      if (m.external && !all) continue;
      try { res.push(await this.endCommit(m.task)); } catch (e) { res.push({ task: m.task, error: e.message }); }
    }
    return res;
  }

  _msgFile(scope, task) { return path.join(scope.home, 'tasks', `${task.id}.commitmsg.txt`); }

  /** Commit message: the user's edited text if saved, otherwise generated from title/description/commits. */
  async getCommitMessage(ref) {
    const { scope, task } = this.resolveTask(ref);
    const f = this._msgFile(scope, task);
    if (task.messageEdited && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    return this.suggestCommitMessage(scope, task);
  }

  async saveCommitMessage(ref, text) {
    const { scope, task } = this.resolveTask(ref);
    fs.writeFileSync(this._msgFile(scope, task), String(text || '').replace(/\r\n/g, '\n'), 'utf8');
    task.messageEdited = !!String(text || '').trim();
    this._saveTask(scope, task);
    return { saved: true };
  }

  async commitHelp(scope, task) {
    const msgFile = this._msgFile(scope, task);
    const message = await this.getCommitMessage(task.id);
    try { fs.writeFileSync(msgFile, message, 'utf8'); } catch (_) { /* ignore */ }
    const dirs = (task.landed && task.landed.dirs) || [];
    const files = task.landed ? task.landed.files : [];
    const shared = Object.keys((task.landed && task.landed.shared) || {});
    const targets = [...dirs, ...files].map((f) => fromPosix(scope.svnPath, f));
    const targetsFile = path.join(scope.home, 'tasks', `${task.id}.targets.txt`);
    try { writeNativeText(targetsFile, targets.join('\r\n') + '\r\n'); } catch (_) { /* ignore */ }
    return {
      changelist: task.changelist,
      svnPath: scope.svnPath,
      files,
      addedDirs: dirs,
      targets,
      suggestedMessage: message,
      messageFile: msgFile,
      targetsFile,
      // Explicit targets (not --changelist) so that newly added parent directories are committed too.
      shared,
      note2: shared.length ? `다른 작업과 같이 고친 파일 ${shared.length}개가 있습니다. 이 작업의 변경만 커밋하려면 SVN Worktree 화면의 "SVN 커밋…"(TortoiseSVN 또는 VS Code 에서 커밋)을 사용하세요. 아래 명령은 파일 전체를 커밋합니다.` : undefined,
      cli: dirs.length || shared.length
        ? `svn commit --depth empty --encoding UTF-8 -F "${msgFile}" --targets "${targetsFile}"`
        : `svn commit --changelist ${task.changelist} --encoding UTF-8 -F "${msgFile}" "${scope.svnPath}"`,
      note: 'SVN 커밋은 사람이 직접 실행합니다. 에이전트는 svn commit 을 실행하지 마세요.',
    };
  }

  async suggestCommitMessage(scope, task) {
    let subjects = [];
    if (task.status !== 'archived') {
      try {
        const git = await this.git(scope);
        const range = task.landed ? `${task.landed.base}..${task.landed.commit}` : await (async () => { const r = await this._range(scope, task); return `${r.base}..${r.tip}`; })();
        const out = await git.exec(['log', '--reverse', '--format=%s', range]);
        subjects = out.split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !/auto commit before changelist/.test(s));
      } catch (_) { /* ignore */ }
    }
    const lines = [task.title];
    if (task.description) lines.push('', task.description.trim());
    if (subjects.length > 1 || (subjects.length === 1 && subjects[0] !== task.title)) {
      lines.push('');
      for (const s of subjects) lines.push(`- ${s}`);
    }
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------ remove / reviews
  /**
   * Archive a task: the worktree folder and the branch go, the commits stay (refs/svnwt/archive/<id>) together with
   * reviews and the agent session, viewable in "보관된 작업". Uncommitted worktree changes are committed first.
   * keepHistory=false: nothing is kept (as 0.4.7 and earlier).
   */
  async removeTask(ref, { force = false, keepBranch = false, keepHistory = true } = {}) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status === 'archived') return { task: task.id, archived: true, warnings: [] };
    if (task.status === 'landed' && !force) {
      throw new Error(`SVN changelist(${task.changelist})가 아직 커밋되지 않았습니다. 커밋 후 정리하거나, svnwt_task_unland 로 되돌리거나, force=true 를 사용하세요.`);
    }
    const git = await this.git(scope);
    const warnings = [];
    let archive = null;
    if (keepHistory) {
      try {
        if (fs.existsSync(task.workPath)) {
          const c = await this.commitTask(task.id, '보관 전 커밋되지 않은 변경').catch((e) => { warnings.push(`커밋되지 않은 변경을 보관하지 못했습니다: ${e.message}`); return null; });
          if (c && c.committed) warnings.push('커밋되지 않은 worktree 변경을 커밋해서 같이 보관했습니다.');
        }
        const { tip, base } = await this._range(scope, task);
        const aref = `refs/svnwt/archive/${task.id}`;
        const r = await git.raw(['update-ref', aref, tip]);
        if (r.code !== 0) throw new Error(decode(r.stderr).trim());
        const n = decode(await git.buf(['rev-list', '--count', `${base}..${tip}`])).trim();
        archive = { ref: aref, tip, base, commits: Number(n) || 0, files: (await git.nameStatus(base, tip)).length, statusBefore: task.status };
      } catch (e) { warnings.push(`커밋 기록을 보관하지 못했습니다: ${e.message}`); }
    }
    // 1) remove junctions/copies first so recursive deletes never reach the SVN working copy
    for (const l of task.links || []) {
      try {
        const st = fs.lstatSync(l.path);
        if (l.type === 'junction') { if (st.isSymbolicLink() || st.isDirectory()) fs.unlinkSync(l.path); }
        else fs.unlinkSync(l.path);
      } catch (e) { if (e.code !== 'ENOENT') warnings.push(`${l.path}: ${e.message}`); }
    }
    const r = await git.raw(['worktree', 'remove', '--force', task.workPath]);
    if (r.code !== 0 && fs.existsSync(task.workPath)) warnings.push(decode(r.stderr).trim());
    await git.raw(['worktree', 'prune']);
    if (fs.existsSync(task.worktree)) {
      const leftovers = (task.links || []).filter((l) => { try { fs.lstatSync(l.path); return true; } catch (_) { return false; } });
      if (!leftovers.length) {
        try { fs.rmSync(task.worktree, { recursive: true, force: true }); } catch (e) { warnings.push(`폴더 삭제 실패 (VS Code 등에서 열려 있으면 닫은 뒤 다시 시도): ${e.message}`); }
      } else warnings.push(`링크가 남아 있어 폴더를 지우지 않았습니다: ${task.worktree}`);
    }
    if (!keepBranch) await git.raw(['branch', '-D', task.branch]);
    const fresh = this.resolveTask(task.id).task; // commitTask above may have saved it
    fresh.status = 'archived';
    fresh.archivedAt = now();
    if (archive) fresh.archive = archive;
    this._saveTask(scope, fresh);
    return { task: task.id, archived: true, history: !!archive, warnings };
  }

  listReviews(ref) {
    const { scope, task } = this.resolveTask(ref);
    return store.readJson(this._reviewFile(scope, task.id), []);
  }

  async submitReview(ref, { verdict = 'comment', summary = '', comments = [], reviewer = 'copilot' } = {}) {
    const { scope, task } = this.resolveTask(ref);
    const git = await this.git(scope);
    const tip = await git.revParse('refs/heads/' + task.branch);
    const list = store.readJson(this._reviewFile(scope, task.id), []);
    const review = {
      id: list.length + 1, at: now(), reviewer, verdict, summary, commit: tip,
      comments: (comments || []).map((c) => ({ file: c.file || c.path || '', line: c.line ? Number(c.line) : null, severity: c.severity || 'info', body: c.body || c.comment || '' })),
    };
    list.push(review);
    store.writeJson(this._reviewFile(scope, task.id), list);
    store.touchEvents({ scope: scope.id, task: task.id, review: review.id });
    return review;
  }

  // ------------------------------------------------------------ test artifacts (Playwright screenshots etc.)
  _artifactsFile(scope, id) { return path.join(scope.home, 'tasks', id + '.artifacts.json'); }
  _artifactsDir(scope, id) { return path.join(scope.home, 'tasks', id + '.artifacts'); }

  /** Find Playwright output folders (test-results / playwright-report) inside the worktree. */
  _findTestOutputDirs(root) {
    const found = [];
    const walk = (d, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.svn') continue;
        const p = path.join(d, e.name);
        if (e.name === 'test-results' || e.name === 'playwright-report') found.push(p);
        else if (depth < 4) walk(p, depth + 1);
      }
    };
    walk(root, 0);
    return found;
  }

  /**
   * Attach test screenshots/videos to a task so they show up in the review panel.
   * Files are copied (Playwright clears test-results on every run).
   * @param {{paths?:string[], dir?:string, title?:string, status?:string, summary?:string}} opts
   *   without paths/dir: auto-collect test-results/ and playwright-report/data in the worktree.
   */
  async attachArtifacts(ref, { paths = null, dir = null, title = '', status = null, summary = '' } = {}) {
    const { scope, task } = this.resolveTask(ref);
    const git = await this.git(scope);
    const MEDIA = /\.(png|jpe?g|gif|webp|webm|mp4)$/i;
    const MAX = 60;
    const files = [];
    const seen = new Set();
    const add = (abs, base) => {
      if (files.length >= MAX || !MEDIA.test(abs)) return;
      const k = key(abs);
      if (seen.has(k)) return;
      try { const st = fs.statSync(abs); if (!st.isFile() || st.size > 25 * 1024 * 1024) return; } catch (_) { return; }
      seen.add(k);
      files.push({ abs, rel: base ? relPosix(base, abs) : path.basename(abs) });
    };
    const walkMedia = (d, base, depth = 0) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 6 && e.name !== 'trace') walkMedia(p, base, depth + 1);
        else if (e.isFile()) add(p, base);
      }
    };
    let lastRun = null;
    const resolveIn = (p) => (path.isAbsolute(p) ? p : path.join(task.workPath, p));
    if (paths && paths.length) {
      for (const p of paths) {
        const abs = resolveIn(p);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walkMedia(abs, abs); else add(abs, null);
      }
    } else {
      const dirs = dir ? [resolveIn(dir)] : this._findTestOutputDirs(task.workPath);
      // test-results has one folder per test (name = caption); playwright-report/data only as fallback
      for (const d of dirs.filter((x) => path.basename(x) !== 'playwright-report')) {
        walkMedia(d, d);
        const lr = path.join(d, '.last-run.json');
        if (fs.existsSync(lr)) { try { lastRun = JSON.parse(fs.readFileSync(lr, 'utf8')); } catch (_) { /* ignore */ } }
      }
      if (!files.length) for (const d of dirs.filter((x) => path.basename(x) === 'playwright-report')) walkMedia(d, d);
    }
    if (!files.length) {
      throw new Error('첨부할 이미지/동영상을 찾지 못했습니다. Playwright 를 worktree 에서 실행했는지 확인하세요 ' +
        '(스크린샷이 남도록 config 의 use.screenshot = "on" 또는 테스트에서 page.screenshot 사용). paths 로 파일을 직접 지정할 수도 있습니다.');
    }
    const list = store.readJson(this._artifactsFile(scope, task.id), []);
    const runId = (list.length ? Math.max(...list.map((r) => r.id)) : 0) + 1;
    const outDir = store.ensureDir(path.join(this._artifactsDir(scope, task.id), String(runId)));
    const items = files.map((f, i) => {
      const ext = path.extname(f.abs).toLowerCase();
      const name = `${String(i + 1).padStart(2, '0')}${ext}`;
      fs.copyFileSync(f.abs, path.join(outDir, name));
      const parts = f.rel.split('/');
      // test-results/<test-folder>/<file>  => caption "<test-folder> · <file>"
      const caption = parts.length > 1 ? `${parts[parts.length - 2]} · ${parts[parts.length - 1]}` : parts[0];
      return { file: path.join(outDir, name), source: f.abs, caption, kind: /\.(webm|mp4)$/.test(ext) ? 'video' : 'image' };
    });
    const run = {
      id: runId, at: now(), commit: await git.revParse('refs/heads/' + task.branch),
      title: title || (lastRun ? 'Playwright' : '테스트 화면'),
      status: status || (lastRun && lastRun.status) || null,
      failedTests: lastRun && Array.isArray(lastRun.failedTests) ? lastRun.failedTests : [],
      summary, items,
    };
    list.push(run);
    store.writeJson(this._artifactsFile(scope, task.id), list);
    store.touchEvents({ scope: scope.id, task: task.id, artifacts: runId });
    return { task: task.id, run: runId, status: run.status, count: items.length, files: items.map((x) => x.caption) };
  }

  listArtifacts(ref) {
    const { scope, task } = this.resolveTask(ref);
    return store.readJson(this._artifactsFile(scope, task.id), []);
  }

  // ------------------------------------------------------------ agent sessions (one conversation per task)
  _sessionFile(scope, id) { return path.join(scope.home, 'tasks', id + '.session.json'); }

  getSession(ref) {
    const { scope, task } = this.resolveTask(ref);
    const s = store.readJson(this._sessionFile(scope, task.id), null) || { entries: [] };
    if (!Array.isArray(s.entries)) s.entries = [];
    return s;
  }

  /** Append entries (role: user | assistant | tool | info). Returns the index of the first appended entry. */
  appendSession(ref, entries) {
    const { scope, task } = this.resolveTask(ref);
    const s = this.getSession(task.id);
    const list = [].concat(entries);
    for (const e of list) s.entries.push(Object.assign({ at: now() }, e));
    if (s.entries.length > 800) s.entries = s.entries.slice(-800);
    store.writeJson(this._sessionFile(scope, task.id), s);
    store.touchEvents({ scope: scope.id, task: task.id, session: s.entries.length });
    return s.entries.length - list.length;
  }

  updateSessionEntry(ref, index, patch) {
    const { scope, task } = this.resolveTask(ref);
    const s = this.getSession(task.id);
    if (!s.entries[index]) return;
    Object.assign(s.entries[index], patch);
    store.writeJson(this._sessionFile(scope, task.id), s);
    store.touchEvents({ scope: scope.id, task: task.id, session: s.entries.length });
  }

  /** state: idle | running | waiting | error */
  setAgentState(ref, state, extra = {}) {
    const { scope, task } = this.resolveTask(ref);
    task.agent = Object.assign({}, task.agent || {}, { state, since: now() }, extra);
    this._saveTask(scope, task);
    return task.agent;
  }

  /** Path mapping between SVN working copy and a task worktree. */
  mapPath(p, taskRef) {
    const f = this.findByPath(p);
    if (f.task && f.location === 'worktree') {
      return { from: 'worktree', task: f.task.id, svnPath: fromPosix(f.scope.svnPath, f.rel), worktreePath: norm(p), rel: f.rel };
    }
    if (f.scope && f.location === 'svn') {
      const tasks = this._listTaskFiles(f.scope).filter((t) => t.status !== 'archived' && (!taskRef || t.id === taskRef || String(t.no) === String(taskRef)));
      return {
        from: 'svn', scope: f.scope.id, rel: f.rel, svnPath: norm(p),
        worktrees: tasks.map((t) => ({ task: t.id, title: t.title, status: t.status, path: f.rel ? fromPosix(t.workPath, f.rel) : t.workPath })),
      };
    }
    return { from: null, note: '등록된 scope 나 작업 worktree 에 속하지 않은 경로입니다.', containedScopes: f.containedScopes || [] };
  }
}

module.exports = { Service, BASE_REF, BASE_BRANCH, isInside, relPosix, fromPosix };
