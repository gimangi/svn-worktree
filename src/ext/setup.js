'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../core/store');
const { AGENT_INSTRUCTIONS } = require('../mcp/instructions');

/** Node runtime for the MCP server: the VS Code binary itself in ELECTRON_RUN_AS_NODE mode (no Node install needed). */
function nodeRuntime() {
  const exe = process.execPath;
  // Prefer the stable top-level Code.exe over a versioned sub-folder copy (survives VS Code updates).
  const parent = path.dirname(path.dirname(exe));
  const top = path.join(parent, path.basename(exe));
  if (/^[0-9a-f]{6,}$/i.test(path.basename(path.dirname(exe))) && fs.existsSync(top)) return top;
  return exe;
}

function toolEnv() {
  const cfg = vscode.workspace.getConfiguration('svnwt');
  const env = {};
  if (cfg.get('gitPath')) env.SVNWT_GIT = cfg.get('gitPath');
  if (cfg.get('svnPath')) env.SVNWT_SVN = cfg.get('svnPath');
  return env;
}

function applyToolEnv() {
  const env = toolEnv();
  delete process.env.SVNWT_GIT;
  delete process.env.SVNWT_SVN;
  Object.assign(process.env, env);
}

/** Copy the MCP server to a stable location (%LOCALAPPDATA%\svnwt\server) for Visual Studio / CLI use. */
function deployServer(ctx) {
  const dest = path.join(store.appHome(), 'server');
  const version = ctx.extension.packageJSON.version;
  const stamp = path.join(dest, 'version.txt');
  try {
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version && ctx.extensionMode !== vscode.ExtensionMode.Development) return dest;
  } catch (_) { /* redeploy */ }
  for (const sub of ['src/core', 'src/mcp']) {
    const from = path.join(ctx.extensionPath, sub);
    const to = path.join(dest, sub);
    store.ensureDir(to);
    for (const f of fs.readdirSync(from)) if (f.endsWith('.js')) fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
  fs.copyFileSync(path.join(ctx.extensionPath, 'package.json'), path.join(dest, 'package.json'));
  const node = nodeRuntime();
  fs.writeFileSync(path.join(dest, 'svnwt.cmd'),
    `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "%~dp0src\\mcp\\server.js" %*\r\n`, 'utf8');
  fs.writeFileSync(path.join(dest, 'copilot-instructions.md'), AGENT_INSTRUCTIONS, 'utf8');
  fs.writeFileSync(stamp, version, 'utf8');
  return dest;
}

function userPromptsDir(ctx) {
  // globalStorageUri = <UserData>/User/globalStorage/<ext id>  (or .../User/profiles/<id>/globalStorage/<ext id>)
  return path.join(path.dirname(path.dirname(ctx.globalStorageUri.fsPath)), 'prompts');
}

const INSTRUCTIONS_FILE = 'svnwt.instructions.md';

function instructionsContent() {
  return `---\napplyTo: '**'\ndescription: 'SVN working copy 작업은 svnwt MCP 도구로 작업 단위 worktree 에서 진행'\n---\n${AGENT_INSTRUCTIONS}`;
}

/** Install a user-level Copilot instructions file so every workspace follows the svnwt workflow. */
function installInstructions(ctx, { force = false } = {}) {
  const dir = userPromptsDir(ctx);
  const file = path.join(dir, INSTRUCTIONS_FILE);
  const content = instructionsContent();
  try {
    if (!force && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return { file, changed: false };
    store.ensureDir(dir);
    fs.writeFileSync(file, content, 'utf8');
    return { file, changed: true };
  } catch (e) {
    return { file, changed: false, error: e.message };
  }
}

/** Write/merge %USERPROFILE%\.mcp.json (global MCP config read by Visual Studio 2022 17.14+ / 2026). */
function exportVisualStudio(ctx) {
  const dest = deployServer(ctx);
  const file = path.join(os.homedir(), '.mcp.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} 을(를) 읽을 수 없습니다: ${e.message}`); }
  }
  cfg.servers = cfg.servers || {};
  cfg.servers.svnwt = {
    type: 'stdio',
    command: nodeRuntime(),
    args: [path.join(dest, 'src', 'mcp', 'server.js')],
    env: Object.assign({ ELECTRON_RUN_AS_NODE: '1' }, toolEnv()),
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  return { file, serverDir: dest, instructions: path.join(dest, 'copilot-instructions.md') };
}

module.exports = { nodeRuntime, toolEnv, applyToolEnv, deployServer, installInstructions, exportVisualStudio, userPromptsDir };
