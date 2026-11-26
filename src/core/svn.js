'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, decode, CmdError } = require('./proc');

function xmlUnescape(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e[1] === 'x') return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(parseInt(e.slice(1), 10));
  });
}

function attrs(s) {
  const o = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = xmlUnescape(m[2]);
  return o;
}

function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlUnescape(m[1]) : null;
}

class Svn {
  constructor(exe) {
    this.exe = exe;
  }

  async raw(args, opts = {}) {
    return run(this.exe, ['--non-interactive', ...args], { cwd: opts.cwd, input: opts.input, env: { LC_MESSAGES: 'C' } });
  }

  async exec(args, opts = {}) {
    const r = await this.raw(args, opts);
    if (r.code !== 0 && !(opts.okCodes || []).includes(r.code)) {
      throw new CmdError(`svn ${args[0]} 실패 (exit ${r.code}): ${decode(r.stderr).trim()}`, { args, stderr: decode(r.stderr) });
    }
    return opts.buffer ? r.stdout : decode(r.stdout);
  }

  /**
   * Run a command over many paths, split into batches that fit the Windows command line limit.
   * (Paths go on the command line — Unicode safe — instead of a --targets file, which svn decodes
   *  with the ANSI code page.)
   */
  async withTargets(args, targets, opts = {}) {
    if (!targets.length) return '';
    const out = [];
    let batch = [];
    let len = 0;
    const flush = async () => {
      if (!batch.length) return;
      out.push(await this.exec([...args, '--', ...batch], opts));
      batch = [];
      len = 0;
    };
    for (const t of targets) {
      if (len + t.length + 3 > 24000) await flush();
      batch.push(t);
      len += t.length + 3;
    }
    await flush();
    return out.join('');
  }

  /** @returns {Promise<{kind:string, path:string, url:string, relativeUrl:string, revision:number, repoRoot:string, uuid:string, wcRoot:string}>} */
  async info(target) {
    const xml = await this.exec(['info', '--xml', target]);
    return parseInfo(xml)[0];
  }

  async infoMany(targets) {
    if (!targets.length) return [];
    const xml = await this.withTargets(['info', '--xml'], targets, { okCodes: [1] });
    return parseInfo(xml);
  }

  /**
   * svn status --xml. verbose => all versioned items.
   * @returns {Promise<Array<{path:string, item:string, props:string, revision:number|null, copied:boolean, changelist:string|null, treeConflicted:boolean}>>}
   */
  async status(target, { verbose = false, noIgnore = false } = {}) {
    const args = ['status', '--xml', '--ignore-externals'];
    if (verbose) args.push('-v');
    if (noIgnore) args.push('--no-ignore');
    args.push(target);
    const xml = await this.exec(args);
    return parseStatus(xml);
  }

  /**
   * Commits on the server after `fromRev` that touch `url` (newest last), with their changed paths.
   * Talks to the server; returns [] when there is nothing after fromRev.
   * @returns {Promise<Array<{revision:number, author:string, date:string, msg:string, paths:Array<{action:string, kind:string, path:string}>}>>}
   */
  async logAfter(url, fromRev, { limit = 50 } = {}) {
    const r = await this.raw(['log', '--xml', '-v', '--limit', String(limit), '-r', `${fromRev + 1}:HEAD`, url]);
    const out = decode(r.stdout);
    // "No such revision" when fromRev is already HEAD
    if (r.code !== 0) { if (/E160006|No such revision|E195012/i.test(decode(r.stderr))) return []; throw new CmdError(`svn log 실패 (exit ${r.code}): ${decode(r.stderr).trim()}`, { args: ['log'], stderr: decode(r.stderr) }); }
    return parseLog(out);
  }

  /** Pristine (BASE) content in working-copy form (keywords expanded, native eol). */
  async catBase(file) {
    const r = await this.raw(['cat', '-r', 'BASE', file]);
    if (r.code !== 0) return null;
    return r.stdout;
  }

  /** @returns {Promise<Array<{path:string, name:string, value:string}>>} */
  async propgetRecursive(prop, target) {
    const r = await this.raw(['propget', prop, '-R', '--xml', target]);
    if (r.code !== 0) return [];
    const xml = decode(r.stdout);
    const res = [];
    const re = /<target\s+path="([^"]*)"\s*>([\s\S]*?)<\/target>/g;
    let m;
    while ((m = re.exec(xml))) {
      const p = xmlUnescape(m[1]);
      const pr = /<property\s+name="([^"]*)"\s*>([\s\S]*?)<\/property>/g;
      let q;
      while ((q = pr.exec(m[2]))) res.push({ path: p, name: xmlUnescape(q[1]), value: xmlUnescape(q[2]) });
    }
    return res;
  }

  /** Inherited value of a property (from ancestors), e.g. svn:global-ignores. */
  async propgetInherited(prop, target) {
    const r = await this.raw(['propget', prop, '--show-inherited-props', '--xml', target]);
    if (r.code !== 0) return [];
    const xml = decode(r.stdout);
    const vals = [];
    const re = /<property\s+name="[^"]*"\s*>([\s\S]*?)<\/property>/g;
    let m;
    while ((m = re.exec(xml))) vals.push(xmlUnescape(m[1]));
    return vals;
  }
}

function parseInfo(xml) {
  const res = [];
  const re = /<entry\s([^>]*)>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = attrs(m[1]);
    const body = m[2];
    const wcRoot = tagText(body, 'wcroot-abspath');
    res.push({
      kind: a.kind,
      path: a.path,
      revision: a.revision ? parseInt(a.revision, 10) : null,
      url: tagText(body, 'url'),
      relativeUrl: tagText(body, 'relative-url'),
      repoRoot: tagText(body, 'root'),
      uuid: tagText(body, 'uuid'),
      wcRoot: wcRoot ? path.normalize(wcRoot) : null,
      changelist: tagText(body, 'changelist'),
      lastChangedRev: (() => { const c = /<commit\s+revision="(\d+)"/.exec(body); return c ? parseInt(c[1], 10) : null; })(),
    });
  }
  return res;
}

function parseStatus(xml) {
  // Entries inside <changelist name="x"> ... </changelist> belong to that changelist.
  const ranges = [];
  const clRe = /<changelist\s+name="([^"]*)"\s*>([\s\S]*?)<\/changelist>/g;
  let c;
  while ((c = clRe.exec(xml))) ranges.push({ start: c.index, end: c.index + c[0].length, name: xmlUnescape(c[1]) });
  const res = [];
  const re = /<entry\s+path="([^"]*)"\s*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const wm = /<wc-status\s([^>]*?)\/?>/.exec(m[2]);
    const a = wm ? attrs(wm[1]) : {};
    const cl = ranges.find((r) => m.index >= r.start && m.index < r.end);
    res.push({
      path: path.normalize(xmlUnescape(m[1])),
      item: a.item || 'none',
      props: a.props || 'none',
      revision: a.revision ? parseInt(a.revision, 10) : null,
      copied: a.copied === 'true',
      treeConflicted: a['tree-conflicted'] === 'true',
      changelist: cl ? cl.name : null,
      movedFrom: a['moved-from'] ? path.resolve(xmlUnescape(a['moved-from'])) : null,
      movedTo: a['moved-to'] ? path.resolve(xmlUnescape(a['moved-to'])) : null,
    });
  }
  return res;
}

function parseLog(xml) {
  const res = [];
  const re = /<logentry\s([^>]*)>([\s\S]*?)<\/logentry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const paths = [];
    const pr = /<path\s([^>]*)>([^<]*)<\/path>/g;
    let p;
    while ((p = pr.exec(body))) { const a = attrs(p[1]); paths.push({ action: a.action, kind: a.kind || '', path: xmlUnescape(p[2]) }); }
    res.push({ revision: parseInt(attrs(m[1]).revision, 10), author: tagText(body, 'author') || '', date: tagText(body, 'date') || '', msg: (tagText(body, 'msg') || '').trim(), paths });
  }
  return res;
}

module.exports = { Svn, parseStatus, parseInfo, parseLog };
