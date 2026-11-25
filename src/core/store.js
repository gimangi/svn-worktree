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
  fs.renameSync(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process lock using mkdir atomicity. Stale locks (> staleMs) are broken.
 */
async function withLock(lockDir, fn, { timeoutMs = 120000, staleMs = 10 * 60 * 1000 } = {}) {
  ensureDir(path.dirname(lockDir));
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid)); } catch (_) { /* ignore */ }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (_) { continue; }
      if (Date.now() - start > timeoutMs) throw new Error(`잠금 대기 시간 초과: ${lockDir} (다른 svnwt 작업이 실행 중일 수 있습니다)`);
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
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

module.exports = { appHome, ensureDir, readJson, writeJson, withLock, loadRegistry, saveRegistry, touchEvents, eventsFile, sleep };
