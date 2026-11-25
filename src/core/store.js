'use strict';
const fs = require('fs');
const path = require('path');

function appHome() {
  return process.env.SVNWT_HOME || path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'svnwt');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return def;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  // Windows: replacing a file another process (extension / MCP server) is reading at that moment fails
  // with EPERM/EBUSY/EACCES. Readers hold it only for milliseconds: retry briefly.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 80 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const os = require('os');

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

/**
 * Who holds a lock: { pid, host, op, at, heartbeatAge, alive, stale } or null when free.
 * stale = the holder process is gone, or it stopped refreshing its heartbeat.
 */
function lockInfo(lockDir, staleMs = 60000) {
  let st;
  try { st = fs.statSync(lockDir); } catch (_) { return null; }
  let info = readJson(path.join(lockDir, 'owner.json'), null);
  let hbMtime = st.mtimeMs;
  try { hbMtime = fs.statSync(path.join(lockDir, 'owner.json')).mtimeMs; } catch (_) {
    // older svnwt versions wrote a plain "owner" file with the pid
    try { info = { pid: parseInt(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'), 10) || null, op: '(이전 버전)', host: os.hostname() }; } catch (_e) { info = null; }
  }
  const heartbeatAge = Date.now() - hbMtime;
  const sameHost = !info || !info.host || info.host === os.hostname();
  const alive = info && info.pid && sameHost ? pidAlive(info.pid) : null; // null = unknown (other host)
  const stale = alive === false || heartbeatAge > staleMs;
  return Object.assign({ lockDir, op: '알 수 없음' }, info || {}, { heartbeatAge, alive, stale, since: info && info.at ? Date.now() - Date.parse(info.at) : heartbeatAge });
}

class LockTimeoutError extends Error {}

/**
 * Cross-process lock (mkdir is atomic). The holder writes owner.json {pid, host, op, at} and touches
 * it every few seconds. A waiter breaks the lock at once when the holder process is gone or its
 * heartbeat stopped (crash, VS Code reload), and otherwise waits as long as the holder is working
 * (up to timeoutMs), so a long snapshot of a big folder does not make others fail.
 */
async function withLock(lockDir, fn, { op = 'svnwt 작업', timeoutMs = 15 * 60 * 1000, staleMs = 60000, heartbeatMs = 5000 } = {}) {
  ensureDir(path.dirname(lockDir));
  const start = Date.now();
  const ownerFile = path.join(lockDir, 'owner.json');
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: os.hostname(), op, at: new Date().toISOString() })); } catch (_) { /* ignore */ }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = lockInfo(lockDir, staleMs);
      if (!info) continue; // released meanwhile
      // just created by someone else and owner.json not written yet: give it a moment
      const fresh = info.heartbeatAge < 2000;
      if (info.stale && !fresh) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* someone else did */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new LockTimeoutError(`잠금 대기 시간 초과: "${info.op}" 이(가) ${fmtDuration(info.since)}째 진행 중입니다 (pid ${info.pid || '?'}${info.host && info.host !== os.hostname() ? ` @${info.host}` : ''}). ` +
          `끝난 뒤 다시 시도하세요. 진행 중인 작업이 없는데 계속되면 "SVN Worktree: 잠금 상태 확인/해제" 를 실행하거나 폴더를 지우세요: ${lockDir}`);
      }
      await sleep(250);
    }
  }
  const hb = setInterval(() => {
    const t = new Date();
    try { fs.utimesSync(ownerFile, t, t); } catch (_) { /* ignore */ }
  }, heartbeatMs);
  if (hb.unref) hb.unref();
  try {
    return await fn();
  } finally {
    clearInterval(hb);
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

function registryFile() {
  return path.join(appHome(), 'registry.json');
}

function loadRegistry() {
  const r = readJson(registryFile(), null) || { version: 1, scopes: [] };
  if (!Array.isArray(r.scopes)) r.scopes = [];
  return r;
}

function saveRegistry(reg) {
  writeJson(registryFile(), reg);
  touchEvents();
}

/** Touch an "events" file so that UIs (VS Code extension) can refresh. */
function touchEvents(detail) {
  try {
    ensureDir(appHome());
    fs.writeFileSync(path.join(appHome(), 'events.json'), JSON.stringify({ at: Date.now(), pid: process.pid, detail: detail || null }));
  } catch (_) { /* ignore */ }
}

function eventsFile() {
  return path.join(appHome(), 'events.json');
}

module.exports = { appHome, ensureDir, readJson, writeJson, withLock, lockInfo, LockTimeoutError, fmtDuration, loadRegistry, saveRegistry, touchEvents, eventsFile, sleep };
