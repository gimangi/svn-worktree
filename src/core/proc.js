'use strict';
const path = require('path');
const { spawn } = require('child_process');

// Optional hook (set by the extension): every external command is logged with its exit code and duration, and a
// command that keeps running is reported every 15 s. `running` lets a caller kill what is in flight (cancel).
// Outside a trace (see trace()) only commands that run 15 s or longer are logged, so routine refreshes stay quiet.
let logger = null;
let tracing = 0;
const running = new Set();
function setLogger(fn) { logger = typeof fn === 'function' ? fn : null; }
// per command kind ("svn cat", "git show" …): count and total time inside the outermost trace
let stats = null;
/** Log every command while fn runs, then where the time went (per command kind). */
async function trace(fn, title = '') {
  const outer = tracing === 0;
  if (outer) stats = { start: Date.now(), kinds: new Map() };
  tracing++;
  try { return await fn(); } finally {
    tracing--;
    if (outer && logger && stats) {
      const total = Date.now() - stats.start;
      const rows = [...stats.kinds.entries()].sort((a, b) => b[1].ms - a[1].ms);
      const inCmds = rows.reduce((n, [, v]) => n + v.ms, 0);
      emit(`  ⏱ ${title ? `${title} ` : ''}총 ${(total / 1000).toFixed(1)}s, 명령 실행 ${(inCmds / 1000).toFixed(1)}s` +
        (rows.length ? ` — ${rows.slice(0, 8).map(([k, v]) => `${k} ×${v.n} ${(v.ms / 1000).toFixed(1)}s`).join(', ')}` : ''));
    }
    if (outer) stats = null;
  }
}
function count(cmd, args, ms) {
  if (!stats) return;
  let sub = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') { i++; continue; } // git -c key=value / -C dir
    if (!args[i].startsWith('-')) { sub = args[i]; break; }
  }
  const k = `${path.basename(cmd).replace(/\.exe$/i, '')} ${sub}`.trim();
  const v = stats.kinds.get(k) || { n: 0, ms: 0 };
  v.n++;
  v.ms += ms;
  stats.kinds.set(k, v);
}
function short(s, n) { s = String(s); return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s; }
function cmdLine(cmd, args) {
  const shown = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
  return `${path.basename(cmd).replace(/\.exe$/i, '')} ${short(shown, 400)}`;
}
function emit(msg) { if (logger) { try { logger(msg); } catch (_) { /* never break a command over logging */ } } }

/** Kill every command still running. @returns {number} how many were killed */
function killAll() {
  let n = 0;
  for (const r of [...running]) {
    try { r.child.kill(); n++; emit(`  ✗ 중지함: ${r.line}`); } catch (_) { /* gone */ }
  }
  return n;
}

/** Commands still running: [{line, ms}] */
function inFlight() { return [...running].map((r) => ({ line: r.line, ms: Date.now() - r.start })); }

/**
 * Run a process and collect stdout/stderr as Buffers.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, input?:Buffer|string, timeoutMs?:number}} [opts]
 * @returns {Promise<{code:number, stdout:Buffer, stderr:Buffer}>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    const line = cmdLine(cmd, args);
    const start = Date.now();
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      emit(`$ ${line}\n  ✗ 실행 실패: ${e.message}`);
      reject(e);
      return;
    }
    const rec = { child, line, start, full: !!logger && tracing > 0 };
    running.add(rec);
    if (rec.full) emit(`$ ${line}${opts.cwd ? `   (cwd ${opts.cwd})` : ''}`);
    const slow = logger ? setInterval(() => { rec.full = true; emit(`  … ${Math.round((Date.now() - start) / 1000)}초째 실행 중: ${line}`); }, 15000) : null;
    const done = () => { running.delete(rec); if (slow) clearInterval(slow); };
    const out = [];
    const err = [];
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, opts.timeoutMs);
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      done();
      emit(`  ✗ 실행 실패 (${Date.now() - start}ms): ${e.message}`);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done();
      count(cmd, args, Date.now() - start);
      if (logger && rec.full) {
        const errText = code !== 0 && err.length ? decode(Buffer.concat(err)).trim().replace(/\s+/g, ' ') : '';
        emit(`  → exit ${code === null ? 'killed' : code} (${Date.now() - start}ms)${errText ? `: ${short(errText, 300)}` : ''}`);
      }
      resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    child.stdin.on('error', () => { /* process may exit before reading stdin */ });
    if (opts.input !== undefined && opts.input !== null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

let eucKr = null;
/**
 * Decode bytes as UTF-8, falling back to CP949/EUC-KR (common in Korean SVN repos).
 * @param {Buffer|Uint8Array} buf
 */
function decode(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    try {
      if (!eucKr) eucKr = new TextDecoder('euc-kr');
      return eucKr.decode(buf);
    } catch (_e) {
      return Buffer.from(buf).toString('latin1');
    }
  }
}

class CmdError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

module.exports = { run, decode, CmdError, setLogger, trace, killAll, inFlight };
