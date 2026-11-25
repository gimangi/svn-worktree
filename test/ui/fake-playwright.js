'use strict';
/**
 * Produce real browser screenshots in Playwright's output layout using headless Edge
 * (stand-in for `npx playwright test` where Node/Playwright are not installed).
 *   <workPath>/web/test-results/<test>-chromium/test-finished-1.png + .last-run.json
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

function page({ title, rows, ok }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:Segoe UI,Malgun Gothic,sans-serif;margin:0;background:#f5f7fb;color:#1d2433}
  header{background:#2060a0;color:#fff;padding:18px 32px;font-size:22px;font-weight:600}
  main{padding:28px 32px} .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px #0002;padding:22px;max-width:640px}
  table{border-collapse:collapse;width:100%;font-size:18px} td{padding:10px;border-bottom:1px solid #e4e8f0}
  td.v{text-align:right;font-weight:600} .st{margin-top:18px;padding:10px 14px;border-radius:6px;font-weight:600}
  .ok{background:#e3f6e8;color:#17692f}.bad{background:#fde7e7;color:#a32020}</style></head><body>
  <header>Demo Calculator — ${title}</header><main><div class="card"><table>
  ${rows.map(([k, v]) => `<tr><td>${k}</td><td class="v">${v}</td></tr>`).join('')}
  </table><div class="st ${ok ? 'ok' : 'bad'}">${ok ? '✓ expect(report).toContainText("mul=20")' : '✗ expected "mul=20" but row is missing'}</div></div></main></body></html>`;
}

function shoot(html, out, tmp) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const f = path.join(tmp, `page-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(f, html, 'utf8');
  execFileSync(EDGE, ['--headless', '--no-first-run', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'edge-profile')}`,
    '--window-size=1100,560', `--screenshot=${out}`, 'file:///' + f.replace(/\\/g, '/')],
  // ELECTRON_RUN_AS_NODE (set when running under Code.exe) makes Edge exit immediately as well
  { stdio: 'ignore', timeout: 60000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) });
  // msedge.exe hands the job to a background process and returns at once: wait for the file
  const until = Date.now() + 30000;
  let last = -1;
  while (Date.now() < until) {
    const size = fs.existsSync(out) ? fs.statSync(out).size : -1;
    if (size > 0 && size === last) return;
    last = size;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  throw new Error('edge screenshot failed: ' + out);
}

/** state: 'failed' | 'passed' */
function run(workPath, state, tmp) {
  if (!EDGE) throw new Error('Microsoft Edge not found');
  const tr = path.join(workPath, 'web', 'test-results');
  fs.rmSync(tr, { recursive: true, force: true });
  const ok = state === 'passed';
  shoot(page({ title: 'report', ok, rows: ok ? [['add', 9], ['mul', 20], ['ab', 45]] : [['add', 9]] }),
    path.join(tr, 'report-shows-add-and-mul-chromium', ok ? 'test-finished-1.png' : 'test-failed-1.png'), tmp);
  shoot(page({ title: 'main', ok: true, rows: [['x = mul(2, 3)', 6]] }), path.join(tr, 'main-prints-product-chromium', 'test-finished-1.png'), tmp);
  fs.writeFileSync(path.join(tr, '.last-run.json'), JSON.stringify({ status: state, failedTests: ok ? [] : ['report-shows-add-and-mul'] }));
  return tr;
}

module.exports = { run, EDGE };
