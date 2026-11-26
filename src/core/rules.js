'use strict';
/**
 * Lasting rules the user gave an agent ("앞으로 항상 …"). Kept outside every worktree (so they never end up in an SVN
 * commit) in <app home>/rules.json; the extension turns them into a Copilot instructions file and shows them in the
 * sidebar.
 */
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

function file() { return path.join(store.appHome(), 'rules.json'); }

/** @returns {Array<{id:string, text:string, why?:string, scope?:string, task?:string, taskNo?:number, taskTitle?:string, by:string, at:string, updatedAt?:string}>} */
function list() {
  const d = store.readJson(file(), null);
  return d && Array.isArray(d.rules) ? d.rules : [];
}

function save(rules) {
  store.ensureDir(store.appHome());
  store.writeJson(file(), { version: 1, rules });
  store.touchEvents({ rules: rules.length });
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function add({ text, why, scope, task, taskNo, taskTitle, by }) {
  const t = norm(text);
  if (!t) throw new Error('규칙 내용이 비어 있습니다.');
  const rules = list();
  const same = rules.find((r) => norm(r.text).toLowerCase() === t.toLowerCase());
  if (same) return { rule: same, added: false, total: rules.length };
  const rule = { id: crypto.randomBytes(4).toString('hex'), text: t, by: by || 'agent', at: new Date().toISOString() };
  if (norm(why)) rule.why = norm(why);
  if (scope) rule.scope = scope;
  if (task) Object.assign(rule, { task, taskNo, taskTitle });
  rules.push(rule);
  save(rules);
  return { rule, added: true, total: rules.length };
}

function update(id, text) {
  const t = norm(text);
  if (!t) throw new Error('규칙 내용이 비어 있습니다.');
  const rules = list();
  const r = rules.find((x) => x.id === id);
  if (!r) throw new Error(`규칙을 찾을 수 없습니다: ${id}`);
  r.text = t;
  r.updatedAt = new Date().toISOString();
  save(rules);
  return r;
}

function remove(id) {
  const rules = list();
  const left = rules.filter((r) => r.id !== id);
  if (left.length === rules.length) throw new Error(`규칙을 찾을 수 없습니다: ${id}`);
  save(left);
  return { removed: id, total: left.length };
}

/** Copilot instructions file content (applies to every chat). */
function instructionsMarkdown(rules = list()) {
  const lines = rules.map((r) => `- ${r.text}${r.why ? ` (이유: ${r.why})` : ''}`);
  return [
    '---',
    "applyTo: '**'",
    "description: 'svnwt: 사용자가 정한 작업 규칙'",
    '---',
    '<!-- SVN Worktree 확장이 자동으로 만드는 파일입니다. 직접 고치지 말고 사이드바의 "규칙" 에서 관리하세요. -->',
    '# 사용자가 정한 작업 규칙',
    '',
    '작업할 때 항상 지킨다.',
    '',
    ...(lines.length ? lines : ['(아직 없음)']),
    '',
  ].join('\n');
}

module.exports = { file, list, add, update, remove, instructionsMarkdown };
