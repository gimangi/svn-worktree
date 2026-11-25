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
const { decode } = require('./proc');
const { Git } = require('./git');
const { Svn } = require('./svn');
const env = require('./env');
const store = require('./store');

const BASE_BRANCH = 'svn-base';
const BASE_REF = 'refs/heads/' + BASE_BRANCH;
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
    return store.withLock(path.join(scope.home, 'lock'), () => this._snapshot(scope, opts));
  }

  async _snapshot(scope, { svnUpdate = false } = {}) {
    const svn = await this.svn();
    const git = await this.git(scope);
    const started = Date.now();
    let updateOutput = null;
    if (svnUpdate) updateOutput = (await svn.exec(['update', '--accept', 'postpone', scope.svnPath])).trim();
    const info = await svn.info(scope.svnPath);
    const entries = await svn.status(scope.svnPath, { verbose: true });

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
    const infoLines = [];
    const pristineFailed = [];
    for (const rel of pristine) {
      const content = await svn.catBase(fromPosix(scope.svnPath, rel));
      if (content === null) { pristineFailed.push(rel); continue; }
      const sha = await git.hashObject(content);
      infoLines.push(`100644 ${sha}\t${rel}`);
    }
    if (infoLines.length) await git.buf(['update-index', '-z', '--index-info'], { ...gopts, input: infoLines.join('\0') + '\0' });
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
    await this._syncIgnores(scope, svn);

    scope.revision = info.revision;
    scope.url = info.url;
    scope.baseCommit = commit;
    scope.lastSnapshotAt = now();
    scope.mixedRevision = minRev !== maxRev ? `r${minRev}:r${maxRev}` : null;
    this._saveScope(scope);
    return {
      scope: scope.id, revision: info.revision, baseCommit: commit, changed,
      files: working.length + infoLines.length, locallyModifiedUsingPristine: infoLines.length,
      pristineFailed, mixedRevision: scope.mixedRevision, elapsedMs: Date.now() - started, svnUpdate: updateOutput,
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

  async createTask(scopeRef, { title, description = '', fromBase = true } = {}) {
    if (!title || !String(title).trim()) throw new Error('title 이 필요합니다.');
    const scope = this.resolveScope(scopeRef);
    const git = await this.git(scope);
    if (!(await git.revParse(BASE_REF))) await this.refreshScope(scope.id);
    return store.withLock(path.join(scope.home, 'lock'), async () => {
      const no = await store.withLock(path.join(store.appHome(), 'registry.lock'), async () => {
        const reg = store.loadRegistry();
        const n = reg.nextTaskNo || 1;
        reg.nextTaskNo = n + 1;
        store.saveRegistry(reg);
        return n;
      });
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
      const r = await git.raw(['worktree', 'add', '-b', branch, workPath, BASE_REF]);
      if (r.code !== 0) throw new Error(`git worktree add 실패: ${decode(r.stderr)}`);
      const base = await git.revParse(BASE_REF);
      const task = {
        id, no, scopeId: scope.id, title: String(title).trim(), description,
        branch, worktree, workPath, links,
        changelist: `svnwt-${id}`,
        status: 'active', baseCommit: base, baseRevision: scope.revision,
        createdAt: now(), updatedAt: now(), landed: null,
      };
      this._saveTask(scope, task);
      return task;
    });
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
    const tip = await git.revParse('refs/heads/' + task.branch);
    if (!tip) throw new Error(`브랜치가 없습니다: ${task.branch}`);
    const base = (await git.mergeBase(BASE_REF, tip)) || task.baseCommit;
    return { git, tip, base };
  }

  async taskInfo(ref, { checkSvn = true } = {}) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status === 'archived') return { task, scope: this._scopeSummary(scope) };
    if (checkSvn && task.status === 'landed') await this._detectCommitted(scope, task);
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
    const marker = this._commitMarker(scope);
    if (marker) res.commitInProgress = { task: marker.task, at: marker.at, external: !!marker.external, mine: marker.task === task.id };
    return res;
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
      await git.exec(['add', '-A'], { cwd });
      const r = wt.rebasing
        ? await git.raw(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd })
        : await git.raw(['commit', '--no-edit'], { cwd });
      return this._syncResult(scope, task, git, r);
    }
    if (wt.rebasing || wt.merging) throw new Error('이전 sync 가 진행 중입니다. 충돌을 해결한 뒤 cont=true 로 계속하거나 abort=true 로 취소하세요.');
    if (wt.dirty.length) throw new Error(`worktree 에 커밋되지 않은 변경이 있습니다 (${wt.dirty.length}개). 먼저 svnwt_task_commit 을 호출하세요.`);
    let snap = null;
    if (refresh || svnUpdate) snap = await this.refreshScope(scope.id, { svnUpdate });
    const r = strategy === 'merge'
      ? await git.raw(['merge', '--no-edit', BASE_REF], { cwd })
      : await git.raw(['rebase', BASE_REF], { cwd });
    const res = await this._syncResult(scope, task, git, r);
    res.snapshot = snap;
    return res;
  }

  async _syncResult(scope, task, git, r) {
    const out = (decode(r.stdout) + decode(r.stderr)).trim();
    if (r.code === 0) {
      task.baseCommit = await git.revParse(BASE_REF);
      task.baseRevision = this.resolveScope(scope.id).revision;
      this._saveTask(scope, task);
      return { ok: true, output: out.slice(-2000) };
    }
    const conflicts = decode((await git.raw(['diff', '--name-only', '--diff-filter=U'], { cwd: task.workPath })).stdout).split('\n').filter(Boolean);
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
  async landTask(ref, { dryRun = false, autoCommit = false, force = false } = {}) {
    const { scope, task } = this.resolveTask(ref);
    this._assertActive(task);
    const git = await this.git(scope);
    const svn = await this.svn();
    this._assertNoCommitInProgress(scope);
    const wt = await this._worktreeState(scope, task);
    if (wt.rebasing || wt.merging) throw new Error('sync(rebase/merge)가 진행 중입니다. 먼저 완료하세요.');
    if (wt.dirty.length) {
      if (!autoCommit) throw new Error(`worktree 에 커밋되지 않은 변경이 ${wt.dirty.length}개 있습니다. svnwt_task_commit 으로 커밋하거나 autoCommit=true 를 사용하세요.`);
      if (!dryRun) await this.commitTask(task.id, `${task.title} (auto commit before changelist)`);
    }
    return store.withLock(path.join(scope.home, 'lock'), async () => {
      const { tip, base } = await this._range(scope, task);
      const changes = await git.nameStatus(base, tip);
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
            item.reason = `다른 작업(${s.changelist})과 같은 부분을 수정함`;
          } else {
            // shared with another task: both changes live in the working copy, each task commits only its own part
            item.sharedWith = s.changelist;
          }
        }
        if (item.action === 'write' && ours !== null) {
          try { fs.accessSync(abs, fs.constants.W_OK); } catch (_) { item.action = 'conflict'; item.reason = '읽기 전용 파일 (svn:needs-lock 이면 먼저 svn lock 필요)'; }
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
      const blocked = plan.filter((p) => p.action === 'conflict' || p.action === 'overlap');
      const summary = plan.map(({ path: p, action, merged, reason, svnStatus, moveFrom, sharedWith }) => ({ path: p, action, merged, reason, svnStatus, moveFrom, sharedWith }));
      if (dryRun || (blocked.length && !force)) {
        return {
          ok: blocked.length === 0, dryRun, task: task.id, changelist: task.changelist, files: summary,
          blocked: blocked.map((b) => ({ path: b.path, reason: b.reason })),
          next: blocked.length
            ? '충돌을 해결해야 합니다: 다른 작업과 같은 줄을 고쳤다면 그 작업을 먼저 SVN 커밋한 뒤 svnwt_task_sync 로 rebase 하고, SVN working copy 의 로컬 수정과 겹치면 사용자에게 알리세요. force=true 는 충돌 파일을 건너뜁니다.'
            : (dryRun ? 'dryRun=false 로 다시 호출하면 SVN working copy 에 반영됩니다.' : undefined),
        };
      }

      const errors = [];
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
      task.landed = {
        at: now(), commit: tip, base, revision: this.resolveScope(scope.id).revision, files: members, shared,
        dirs: [...new Set([...dirs, ...prevDirs.filter((d) => members.some((m) => m.startsWith(d + '/')))])].sort(),
        revs: await this._lastChangedRevs(scope, members),
      };
      this._saveTask(scope, task);
      return {
        ok: errors.length === 0, task: task.id, changelist: task.changelist, files: summary, skipped: [...skipped], errors,
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
    return store.withLock(path.join(scope.home, 'lock'), async () => {
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
    let committed = false;
    if (task.landed.revs) {
      committed = own.length > 0 && this._revsAdvanced(task.landed.revs, await this._lastChangedRevs(scope, own), own);
    } else {
      const existing = files.map((f) => fromPosix(scope.svnPath, f)).filter((f) => fs.existsSync(f));
      const infos = existing.length ? await svn.infoMany(existing) : [];
      committed = infos.some((i) => i.lastChangedRev && i.lastChangedRev > (task.landed.revision || 0));
    }
    if (!committed) {
      const stList = await svn.status(scope.svnPath);
      const pending = new Set(stList.filter((e) => ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'merged'].includes(e.item))
        .map((e) => relPosix(scope.svnPath, e.path)));
      if (files.some((f) => pending.has(f))) return task.status; // still waiting for the human commit
    }
    task.status = committed ? 'committed' : 'active';
    if (committed) task.committedAt = now();
    else task.landed = null;
    this._saveTask(scope, task);
    if (committed) {
      await this._reassignShared(scope, task, svn);
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

  // ------------------------------------------------------------ split commit (one task at a time)
  _markerFile(scope) { return path.join(scope.home, 'commit-in-progress.json'); }
  _commitMarker(scope) { return store.readJson(this._markerFile(scope), null); }
  _assertNoCommitInProgress(scope) {
    const m = this._commitMarker(scope);
    if (m) throw new Error(`작업 ${m.task} 의 SVN 커밋이 진행 중입니다 (${m.at}). 커밋 창을 닫은 뒤 다시 시도하세요.`);
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
    return this._revsAdvanced(m.revs, await this._lastChangedRevs(scope, task.landed.files));
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
      try { await this.refreshScope(scope.id); } catch (_) { /* best effort */ }
    } else {
      store.touchEvents({ scope: scope.id, task: task.id, commit: 'cancelled' });
    }
    return { task: task.id, committed, restored };
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
  async removeTask(ref, { force = false, keepBranch = false } = {}) {
    const { scope, task } = this.resolveTask(ref);
    if (task.status === 'landed' && !force) {
      throw new Error(`SVN changelist(${task.changelist})가 아직 커밋되지 않았습니다. 커밋 후 정리하거나, svnwt_task_unland 로 되돌리거나, force=true 를 사용하세요.`);
    }
    const git = await this.git(scope);
    const warnings = [];
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
    task.status = 'archived';
    task.archivedAt = now();
    this._saveTask(scope, task);
    return { task: task.id, archived: true, warnings };
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
