#!/usr/bin/env node
'use strict';
/**
 * svnwt MCP server (stdio, newline-delimited JSON-RPC 2.0). No external dependencies.
 * Run:  node server.js            (MCP mode)
 *       node server.js cli <tool> '{"json":"args"}'   (manual / scripting)
 */
const path = require('path');
const { Service } = require('../core/service');
const { TOOLS, PROMPTS } = require('./tools');
const { AGENT_INSTRUCTIONS } = require('./instructions');

const VERSION = (() => { try { return require('../../package.json').version; } catch (_) { return '0.0.0'; } })();
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const svc = new Service();
const ctx = {
  workspaceFolders: (process.env.SVNWT_WORKSPACE || process.cwd()).split(';').filter(Boolean).map((p) => path.resolve(p)),
};

function log(...a) { process.stderr.write('[svnwt] ' + a.join(' ') + '\n'); }

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
  return tool.handler(svc, args || {}, ctx);
}

function toText(v) { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); }

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      return {
        protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'svnwt', title: 'SVN Worktree', version: VERSION },
        instructions: AGENT_INSTRUCTIONS,
      };
    }
    case 'ping': return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      try {
        const res = await callTool(params.name, params.arguments);
        return { content: [{ type: 'text', text: toText(res) }], isError: false };
      } catch (e) {
        if (e.rpc) throw e;
        log('tool error', params && params.name, e && e.stack);
        return { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true };
      }
    }
    case 'prompts/list':
      return { prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) };
    case 'prompts/get': {
      const p = PROMPTS.find((x) => x.name === params.name);
      if (!p) throw Object.assign(new Error(`Unknown prompt: ${params.name}`), { rpc: -32602 });
      return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(params.arguments || {}) } }] };
    }
    case 'resources/list': return { resources: [] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
  }
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function serve() {
  let buf = '';
  let pending = 0;
  let ended = false;
  const maybeExit = () => { if (ended && pending === 0) setImmediate(() => process.exit(0)); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const msgs = Array.isArray(msg) ? msg : [msg];
      for (const m of msgs) {
        pending++;
        Promise.resolve().then(() => handle(m)).finally(() => { pending--; maybeExit(); }).then((result) => {
          if (m.id === undefined || m.id === null || result === undefined) return;
          send({ jsonrpc: '2.0', id: m.id, result });
        }, (e) => {
          if (m.id === undefined || m.id === null) return;
          send({ jsonrpc: '2.0', id: m.id, error: { code: e.rpc || -32603, message: e.message } });
        });
      }
    }
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
  log(`MCP server ${VERSION} ready (workspace: ${ctx.workspaceFolders.join(', ')})`);
}

async function cli(argv) {
  const [name, json] = argv;
  if (!name || name === 'help') {
    process.stdout.write('usage: server.js cli <tool> [jsonArgs]\n\n' + TOOLS.map((t) => `  ${t.name}\n      ${t.description}`).join('\n') + '\n');
    return;
  }
  const toolName = name.startsWith('svnwt_') ? name : 'svnwt_' + name;
  try {
    const res = await callTool(toolName, json ? JSON.parse(json) : {});
    process.stdout.write(toText(res) + '\n');
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  if (process.argv[2] === 'cli') cli(process.argv.slice(3));
  else serve();
}

module.exports = { handle, callTool };
