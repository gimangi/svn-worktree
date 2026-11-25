'use strict';
const { spawn } = require('child_process');

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
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, opts.timeoutMs);
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
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

module.exports = { run, decode, CmdError };
