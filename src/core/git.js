'use strict';
const { run, decode, CmdError } = require('./proc');

const BASE_CFG = [
  '-c', 'core.quotepath=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.longpaths=true',
  '-c', 'safe.directory=*',
  '-c', 'color.ui=false',
];

class Git {
  /**
   * @param {string} exe git.exe path
   * @param {string} gitDir the shared (bare) repository directory
   */
  constructor(exe, gitDir) {
    this.exe = exe;
    this.gitDir = gitDir;
  }

  /**
   * Run git. `opts.cwd` set => run inside that worktree (no --git-dir). Otherwise --git-dir=<repo>.
   * @returns {Promise<{code:number, stdout:Buffer, stderr:Buffer}>}
   */
  async raw(args, opts = {}) {
    const full = [...BASE_CFG];
    // cwd without workTree => run inside a linked worktree (git finds the repo itself).
    if (this.gitDir && (!opts.cwd || opts.workTree)) full.push('--git-dir=' + this.gitDir);
    if (opts.workTree) full.push('--work-tree=' + opts.workTree);
    full.push(...args);
    const env = Object.assign({ GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat', LC_ALL: 'C' }, opts.env || {});
    return run(this.exe, full, { cwd: opts.cwd, env, input: opts.input });
  }

  /** Run git and return stdout as string; throws on non-zero exit unless listed in opts.okCodes. */
  async exec(args, opts = {}) {
    const r = await this.buf(args, opts);
    return decode(r);
  }

  async buf(args, opts = {}) {
    const r = await this.raw(args, opts);
    const ok = opts.okCodes || [0];
    if (!ok.includes(r.code)) {
      throw new CmdError(`git ${args[0]} 실패 (exit ${r.code}): ${decode(r.stderr).trim() || decode(r.stdout).trim()}`,
        { args, code: r.code, stderr: decode(r.stderr) });
    }
    return r.stdout;
  }

  async revParse(ref) {
    const r = await this.raw(['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
    if (r.code !== 0) return null;
    return decode(r.stdout).trim();
  }

  async treeOf(ref) {
    const r = await this.raw(['rev-parse', '--verify', '--quiet', ref + '^{tree}']);
    if (r.code !== 0) return null;
    return decode(r.stdout).trim();
  }

  /** Read a blob at rev:path. Returns null when missing. */
  async blob(rev, relPath) {
    const r = await this.raw(['cat-file', 'blob', `${rev}:${relPath}`]);
    if (r.code !== 0) return null;
    return r.stdout;
  }

  async hashObject(content) {
    return (await this.exec(['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).trim();
  }

  async mergeBase(a, b) {
    const r = await this.raw(['merge-base', a, b]);
    if (r.code !== 0) return null;
    return decode(r.stdout).trim();
  }

  /**
   * name-status between two commits (rename detection on).
   * @returns {Promise<Array<{status:string, path:string, from?:string}>>}
   */
  async nameStatus(from, to, extra = []) {
    const out = await this.buf(['diff', '--name-status', '-z', '-M', '-l0', from, to, ...extra]);
    const parts = decode(out).split('\0').filter((s, i, a) => !(s === '' && i === a.length - 1));
    const res = [];
    for (let i = 0; i < parts.length;) {
      const st = parts[i++];
      if (!st) continue;
      const code = st[0];
      if (code === 'R' || code === 'C') {
        const src = parts[i++];
        const dst = parts[i++];
        res.push({ status: code, score: parseInt(st.slice(1), 10) || 0, from: src, path: dst });
      } else {
        res.push({ status: code, path: parts[i++] });
      }
    }
    return res;
  }

  /** numstat map path -> {add, del, binary} */
  async numstat(from, to) {
    const out = decode(await this.buf(['diff', '--numstat', '-z', '-M', '-l0', from, to]));
    const parts = out.split('\0');
    const map = {};
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
      if (!m) continue;
      let file = m[3];
      if (file === '') {
        // rename: next two entries are src, dst
        i++; // src
        file = parts[++i];
      }
      map[file] = { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' };
    }
    return map;
  }
}

module.exports = { Git };
