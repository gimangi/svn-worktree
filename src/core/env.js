'use strict';
const fs = require('fs');
const path = require('path');
const { run, decode } = require('./proc');

const GIT_CANDIDATES = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
];

const SVN_CANDIDATES = [
  'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
  'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
  'C:\\Program Files (x86)\\SlikSvn\\bin\\svn.exe',
  'C:\\Program Files\\VisualSVN\\bin\\svn.exe',
  'C:\\Program Files\\VisualSVN Server\\bin\\svn.exe',
  'C:\\Program Files\\CollabNet\\Subversion Client\\svn.exe',
  'C:\\Program Files (x86)\\Subversion\\bin\\svn.exe',
];

const TORTOISE_CANDIDATES = [
  'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe',
  'C:\\Program Files (x86)\\TortoiseSVN\\bin\\TortoiseProc.exe',
];

const GIT_MISSING_MESSAGE =
  'Git for Windows가 설치되어 있지 않습니다. SVN Worktree는 Git for Windows가 필요합니다.\n' +
  '설치: https://git-scm.com/download/win  또는 PowerShell에서 `winget install --id Git.Git -e`\n' +
  '설치 후 VS Code를 다시 시작하세요. (다른 위치에 설치했다면 설정 svnwt.gitPath 지정)';

const SVN_MISSING_MESSAGE =
  'SVN 명령줄 클라이언트(svn.exe)를 찾을 수 없습니다.\n' +
  'TortoiseSVN 설치 시 "command line client tools" 항목을 선택하거나, `winget install --id Slik.Subversion -e` 로 설치하세요.\n' +
  '설치 후 VS Code를 다시 시작하세요. (다른 위치에 설치했다면 설정 svnwt.svnPath 지정)';

function findOnPath(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d.replace(/^"|"$/g, ''), exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) { /* not here */ }
  }
  return null;
}

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.statSync(p).isFile()) return p;
    } catch (_) { /* skip */ }
  }
  return null;
}

async function version(exe) {
  try {
    const r = await run(exe, ['--version'], { timeoutMs: 15000 });
    if (r.code !== 0) return null;
    return decode(r.stdout).split(/\r?\n/)[0].trim();
  } catch (_) {
    return null;
  }
}

let cached = null;

/**
 * Locate git.exe / svn.exe. Explicit paths come from env SVNWT_GIT / SVNWT_SVN (set by the VS Code extension
 * from settings) and take precedence.
 */
async function detect(force) {
  if (cached && !force) return cached;
  const gitPath = (process.env.SVNWT_GIT && firstExisting([process.env.SVNWT_GIT])) ||
    findOnPath('git.exe') || firstExisting(GIT_CANDIDATES);
  const svnPath = (process.env.SVNWT_SVN && firstExisting([process.env.SVNWT_SVN])) ||
    findOnPath('svn.exe') || firstExisting(SVN_CANDIDATES);
  const tortoise = firstExisting(TORTOISE_CANDIDATES) || findOnPath('TortoiseProc.exe');
  const res = {
    git: gitPath ? { path: gitPath, version: await version(gitPath) } : null,
    svn: svnPath ? { path: svnPath, version: await version(svnPath) } : null,
    tortoiseProc: tortoise,
  };
  if (res.git && !res.git.version) res.git = null;
  if (res.svn && !res.svn.version) res.svn = null;
  cached = res;
  return res;
}

async function requireTools() {
  const t = await detect();
  if (!t.git) throw new Error(GIT_MISSING_MESSAGE);
  if (!t.svn) throw new Error(SVN_MISSING_MESSAGE);
  return t;
}

module.exports = { detect, requireTools, GIT_MISSING_MESSAGE, SVN_MISSING_MESSAGE };
