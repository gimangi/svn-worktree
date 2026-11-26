'use strict';
/**
 * UI scenarios for test/ui/run.js. Each step: do something like a user, assert, take a screenshot.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, '..', '..');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** Call an svnwt MCP tool the way Copilot would (separate server process). */
function mcp(tool, args) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'src', 'mcp', 'server.js'), 'cli', tool, JSON.stringify(args)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${tool}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function scenarios(d, ctx) {
  // task numbers depend on the order of concurrent creation: resolve by title
  const byTitle = (t) => ctx.svc.listTasks({ includeArchived: true }).find((x) => x.title === t).id.split('-')[0] + '-';
  const P = { report: byTitle('report mul output'), sub: byTitle('add sub function'), docs: byTitle('docs usage'), sample: byTitle('main에서 mul 사용') };
  const step = async (s, fn) => {
    try {
      const extra = (await fn()) || {};
      return d.shot({ result: 'pass', ...s, ...extra });
    } catch (e) {
      return d.shot({ result: 'fail', ...s, note: e.message.split('\n')[0] });
    }
  };
  const treeRows = () => d.eval(`[...document.querySelectorAll('.pane-body .monaco-list-row')].filter((r) => r.closest('[id*="svnwt"]') || true).map((r) => r.getAttribute('aria-label') || '')`);
  const dialog = () => d.eval(`[...document.querySelectorAll('.monaco-dialog-box .dialog-message-text, .monaco-dialog-box .dialog-message, .monaco-dialog-box .dialog-message-detail')].map((e) => e.textContent.trim()).filter(Boolean).join(' / ')`);
  const dialogButtons = () => d.eval(`[...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].map((b) => b.textContent.trim())`);
  const quickPickItems = () => d.eval(`[...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].map((r) => (r.getAttribute('aria-label') || '').trim())`);
  const activeIsTree = () => d.eval(`!!(document.activeElement && document.activeElement.closest('.pane-body') && document.activeElement.closest('.monaco-list'))`);

  // ---------------------------------------------------------------- 1
  const S1 = '1. 확장 진입';
  await step({ scenario: S1, action: 'SVN working copy 를 연 VS Code 시작 화면', expect: '활동 표시줄에 SVN Worktree 아이콘' }, async () => {
    await d.waitFor(`!!document.querySelector('.activitybar')`, 30000);
    await sleep(4000);
    const has = await d.rect('.activitybar .action-item .action-label', 'SVN Worktree');
    assert(has, 'activity bar icon missing');
  });
  await step({ scenario: S1, action: 'SVN Worktree 아이콘 클릭', expect: 'scope 와 작업 목록. 상태가 짧게 표시되고 잘리지 않음' }, async () => {
    await d.click('.activitybar .action-item .action-label', 'SVN Worktree');
    await d.waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').includes('report mul output'))`, 15000, 'task rows');
    const rows = (await treeRows()).filter((r) => /^#|demo/.test(r));
    assert(!rows.some((r) => r.includes('undefined')), 'undefined row: ' + rows.join(' | '));
    const truncated = await d.eval(`[...document.querySelectorAll('.monaco-list-row .label-description')].some((e) => e.scrollWidth > e.clientWidth + 1)`);
    return { note: `행: ${rows.map((r) => r.replace(/, has actions/, '')).join(' / ')}${truncated ? ' (설명 잘림 있음)' : ''}` };
  });

  // ---------------------------------------------------------------- 2
  const S2 = '2. 리뷰 화면 (Pull Request 보기)';
  await step({ scenario: S2, action: '"report mul output" 작업 행 클릭', expect: '리뷰 화면이 열리고 포커스는 트리에 남음 (키보드로 계속 이동 가능)' }, async () => {
    await d.click('.monaco-list-row', 'report mul output');
    const title = await d.webview(`(doc) => doc.querySelector('h1').textContent.replace(/\\s+/g, ' ').trim()`, 8000, P.report);
    const treeFocus = await activeIsTree();
    assert(treeFocus, 'focus moved away from the tree');
    return { note: `제목: ${title}` };
  });
  await step({ scenario: S2, action: '리뷰 화면 상단 — 상태 상자', expect: '상태에 맞는 다음 단계와 주 버튼 1개 (커밋 대기 → "SVN 커밋…")' }, async () => {
    const r = await d.webview(`(doc) => ({ title: doc.querySelector('.next-title').textContent, buttons: [...doc.querySelectorAll('.next .actions button')].map((b) => b.textContent + (b.classList.contains('primary') ? '*' : '')), h2: [...doc.querySelectorAll('h2')].map((h) => h.textContent.replace(/\\s*\\(.*$/, '').trim()) })`, 8000, P.report);
    assert(r.buttons.filter((b) => b.endsWith('*')).length === 1, 'primary buttons: ' + r.buttons.join(','));
    const at = (name) => r.h2.findIndex((x) => x.startsWith(name));
    assert(at('변경된 파일') >= 0 && at('변경된 파일') + 1 === at('커밋') && at('커밋') + 1 === at('테스트 화면'), 'section order: ' + r.h2.join(', '));
    return { note: `${r.title} · 버튼: ${r.buttons.join(', ')} (*=주 버튼) · 섹션: ${r.h2.join(', ')}` };
  });
  await step({ scenario: S2, action: '테스트 화면 갤러리 (Playwright 2회 실행)', expect: '최신(통과) 펼침, 이전(실패) 접힘, 테스트 이름으로 표시' }, async () => {
    const r = await d.webview(`(doc) => { [...doc.querySelectorAll('h2')].find((h) => h.textContent.includes('테스트 화면')).scrollIntoView(); return [...doc.querySelectorAll('details.run')].map((x) => x.querySelector('summary').textContent.replace(/\\s+/g, ' ').trim() + (x.open ? ' [펼침]' : '') + ' :: ' + [...x.querySelectorAll('figcaption')].map((f) => f.textContent.trim()).join(', ')); }`, 8000, P.report);
    assert(r.length === 2, 'runs: ' + r.length);
    return { note: r.join(' | ') };
  });
  await step({ scenario: S2, action: '이전(실패) 실행 펼치기', expect: '실패한 테스트 이름과 실패 스크린샷(빨간 테두리)' }, async () => {
    const r = await d.webview(`(doc) => { const x = doc.querySelectorAll('details.run')[1]; x.open = true; x.scrollIntoView(); return { failed: doc.querySelectorAll('figure.shot.failed').length, text: x.textContent.includes('실패한 테스트') }; }`, 8000, P.report);
    assert(r.failed >= 1 && r.text, JSON.stringify(r));
  });
  await step({ scenario: S2, action: '스크린샷 클릭', expect: '옆 편집기 그룹에 이미지 원본' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('figure.shot img').click(); return true; }`, 8000, P.report);
    await sleep(1500);
    const tabs = await d.tabs();
    assert(tabs.some((t) => /\.png/.test(t)), tabs.join(' | '));
    return { note: tabs.join(' | ') };
  });
  await step({ scenario: S2, action: '"모든 변경 사항 보기"', expect: '다중 파일 diff 편집기' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('button[data-cmd="openChanges"]').click(); return true; }`, 8000, P.report);
    await sleep(2500);
    const tabs = await d.tabs();
    assert(tabs.some((t) => /변경 사항/.test(t)), tabs.join(' | '));
    return { note: tabs.join(' | ') };
  });
  await step({ scenario: S2, action: '트리에서 "add sub function" 펼치기 → 변경 파일 클릭', expect: '파일별 diff (SVN 기준 ↔ worktree)' }, async () => {
    const tw = await d.eval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find((x) => (x.getAttribute('aria-label') || '').includes('add sub function')); const t = r && r.querySelector('.monaco-tl-twistie'); if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, expanded: r.getAttribute('aria-expanded') }; })()`);
    if (tw && tw.expanded !== 'true') { await d.mouse('mousePressed', tw.x, tw.y); await d.mouse('mouseReleased', tw.x, tw.y); }
    await d.waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').includes('mathutil.cpp'))`, 8000, 'file rows');
    await d.click('.monaco-list-row', 'mathutil.cpp');
    await sleep(2000);
    const tabs = await d.tabs();
    assert(tabs.some((t) => /mathutil\.cpp/.test(t)), tabs.join(' | '));
    return { note: tabs.filter((t) => /mathutil/.test(t)).join(' | ') };
  });

  await step({ scenario: S2, action: '다른 작업 행을 연달아 클릭 ("docs usage" → "add sub function")', expect: '리뷰 탭이 쌓이지 않음: 작업한 탭 1개 + 미리보기 탭 1개' }, async () => {
    const reviewTabs = async () => (await d.tabs()).filter((t) => /^#\d+ /.test(t) && !/변경 사항|↔/.test(t));
    await d.click('.monaco-list-row', 'docs usage');
    await sleep(1200);
    await d.click('.monaco-list-row', 'add sub function');
    await sleep(1500);
    const tabs = await reviewTabs();
    assert(tabs.length === 2, tabs.join(' | '));
    const pv = await d.webview(`(doc) => !!doc.querySelector('.pv')`, 8000, P.sub);
    assert(pv, 'preview banner');
    return { note: `리뷰 탭: ${tabs.map((t) => t.split(',')[0]).join(' | ')}` };
  });
  // ---- diff: on top of the review (side by side), keyboard, separate window
  const groupsNow = () => d.eval(`[...document.querySelectorAll('.editor-group-container')].map((g) => { const a = g.querySelector('.tab.active'); return { tabs: [...g.querySelectorAll('.tab')].map((t) => (t.getAttribute('aria-label') || '').split(',')[0]), active: a ? (a.getAttribute('aria-label') || '').split(',')[0] : '', sbs: !!g.querySelector('.monaco-diff-editor.side-by-side') }; })`);
  const activeDiff = async (re, ms = 8000) => {
    const t0 = Date.now();
    let g = [];
    for (;;) {
      g = await groupsNow();
      const hit = g.find((x) => /↔/.test(x.active) && re.test(x.active));
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`no active diff ${re}: ${JSON.stringify(g.map((x) => x.active))}`);
      await sleep(250);
    }
  };
  const cursorLine = async () => Number((/Ln (\d+)/.exec(await d.eval(`[...document.querySelectorAll('.statusbar-item')].map((e) => e.textContent).join(' | ')`)) || [])[1] || 0);
  const titleButtons = () => d.eval(`[...document.querySelectorAll('.editor-group-container .editor-actions .action-label')].map((a) => a.getAttribute('aria-label') || '').filter((x) => /변경 파일|리뷰 화면|새 창/.test(x))`);
  const clickTitleButton = async (re) => {
    const r = await d.eval(`(() => { const a = [...document.querySelectorAll('.editor-group-container .editor-actions .action-label')].find((x) => ${re}.test(x.getAttribute('aria-label') || '')); if (!a) return null; const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    assert(r, 'title button ' + re);
    await d.mouse('mousePressed', r.x, r.y); await d.mouse('mouseReleased', r.x, r.y);
  };
  await step({ scenario: S2, action: '리뷰 화면에서 변경 파일 클릭', expect: '리뷰 화면과 같은 탭 그룹에 전체 폭 diff (좌우 비교), 제목줄에 이전/다음 파일 · 리뷰 화면 · 새 창으로 분리' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('tr.file').click(); return true; }`, 8000, P.sub);
    const g = await activeDiff(/main\.cpp .*1\/3/);
    assert(g.tabs.some((t) => /add sub function/.test(t)), 'diff not in the review group: ' + JSON.stringify(g.tabs));
    // the editor column is narrow here (two groups): VS Code shows one column until the one-time offer is accepted
    await d.waitFor(`[...document.querySelectorAll('.notifications-toasts .monaco-button')].some((b) => b.textContent.trim() === '항상 좌우로')`, 10000, 'side-by-side offer');
    await d.click('.notifications-toasts .monaco-button', '항상 좌우로');
    for (let i = 0; i < 30 && !(await groupsNow()).some((x) => x.sbs); i++) await sleep(250);
    assert((await groupsNow()).some((x) => x.sbs), 'diff is not side by side');
    const btns = await titleButtons();
    assert(btns.length >= 4, JSON.stringify(btns));
    return { note: `탭 그룹: ${g.tabs.join(' | ')} · 버튼: ${btns.join(', ')}` };
  });
  await step({ scenario: S2, action: 'diff 제목줄 버튼 툴팁', expect: '이전/다음 변경 · 이전/다음 파일 · 리뷰 화면 버튼에 단축키가 함께 표시됨 (Alt+←/→, Alt+Shift+←/→, Esc)' }, async () => {
    const labels = await d.eval(`[...document.querySelectorAll('.editor-group-container .editor-actions .action-label')].map((a) => a.getAttribute('aria-label') || a.getAttribute('title') || '').filter(Boolean)`);
    const find = (re) => labels.find((x) => re.test(x)) || '';
    const want = [[/^다음 변경 \(/, /\(Alt\+RightArrow\)$/], [/^이전 변경 \(/, /\(Alt\+LeftArrow\)$/], [/^다음 변경 파일/, /\(Shift\+Alt\+RightArrow\)$/], [/^이전 변경 파일/, /\(Shift\+Alt\+LeftArrow\)$/]];
    for (const [name, key] of want) assert(key.test(find(name)), `no key in tooltip ${name}: ${JSON.stringify(labels)}`);
    return { note: labels.filter((x) => /변경|리뷰 화면/.test(x)).join(' · ') };
  });
  await step({ scenario: S2, action: 'Alt+→ → Alt+→ → Alt+←', expect: '첫 변경으로, 파일 끝에서는 다음 파일의 첫 변경으로, 거꾸로는 이전 파일의 마지막 변경으로' }, async () => {
    await d.key('ArrowRight', { alt: true });
    await sleep(500);
    const l1 = await cursorLine();
    assert(l1 > 1, 'cursor did not move to the change: Ln ' + l1);
    await d.key('ArrowRight', { alt: true });
    const g2 = await activeDiff(/2\/3/);
    await sleep(500);
    const l2 = await cursorLine();
    await d.key('ArrowLeft', { alt: true });
    const g3 = await activeDiff(/main\.cpp .*1\/3/);
    await sleep(500);
    const l3 = await cursorLine();
    assert(l3 === l1, `back on the change of main.cpp: Ln ${l3} (was ${l1})`);
    assert(g3.tabs.filter((t) => /↔/.test(t)).length === 1, 'one diff tab: ' + g3.tabs.join(' | '));
    return { note: `main.cpp Ln ${l1} → ${g2.active} Ln ${l2} → ${g3.active} Ln ${l3}` };
  });
  await step({ scenario: S2, action: 'Alt+Shift+→ (다음 파일) → Esc', expect: '같은 탭에서 다음 파일 diff, Esc 로 리뷰 화면' }, async () => {
    await d.key('ArrowRight', { alt: true, shift: true });
    const g = await activeDiff(/2\/3/);
    // Esc goes back only from a focused diff (editorTextFocus): wait until the new diff has the focus
    for (let i = 0; i < 20 && !(await d.eval(`!!(document.activeElement && document.activeElement.closest('.monaco-diff-editor'))`)); i++) await sleep(250);
    await sleep(300);
    await d.key('Escape');
    let now = [];
    for (let i = 0; i < 20; i++) { await sleep(250); now = await groupsNow(); if (now.some((x) => /add sub function/.test(x.active))) break; }
    assert(now.some((x) => /add sub function/.test(x.active) && !/↔/.test(x.active)), 'review not active: ' + JSON.stringify(now.map((x) => x.active)));
    return { note: `${g.active} → Esc → ${now.find((x) => /add sub function/.test(x.active)).active}` };
  });
  await step({ scenario: S2, action: '리뷰 화면 안내 줄의 "단축키 보기·바꾸기" (제목줄 키보드 버튼과 같음)', expect: '바로 가기 키 화면이 svnwt 명령으로 걸러져 열리고 Alt+→ 등이 보임' }, async () => {
    const hasBtn = await d.eval(`[...document.querySelectorAll('.editor-group-container .editor-actions .action-label')].some((a) => /단축키 보기/.test(a.getAttribute('aria-label') || ''))`);
    assert(hasBtn, 'no keyboard button in the review title bar');
    await d.webview(`(doc) => { const a = doc.querySelector('a[data-cmd="shortcuts"]'); if (!a) return null; a.click(); return true; }`, 8000, P.sub);
    await d.waitFor(`(() => { const e = document.querySelector('.keybindings-editor'); return !!e && /다음 변경/.test(e.innerText) && /RightArrow/.test(e.innerText); })()`, 10000, 'keybindings editor');
    const txt = await d.eval(`document.querySelector('.keybindings-editor').innerText`);
    assert(/@ext:svnwt\.svn-worktree/.test(txt) || !/파일 열기/.test(txt), 'not filtered to svnwt');
    await d.key('w', { ctrl: true });
    for (let i = 0; i < 20 && await d.eval(`!!document.querySelector('.keybindings-editor')`); i++) await sleep(250);
    const rows = txt.split('\n').filter((l) => /Arrow|Escape|변경/.test(l)).slice(0, 12);
    return { note: rows.join(' | ') };
  });
  await step({ scenario: S2, action: '리뷰 화면에서 ↓ ↓ Enter', expect: '파일 행을 키보드로 골라 diff 열기 (두 번째 파일)' }, async () => {
    const focused = await d.webview(`(doc) => { const k = (key) => (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); k('ArrowDown'); k('ArrowDown'); const a = doc.activeElement; const label = a && a.classList.contains('nav') ? a.querySelector('.path').textContent.trim() : ''; k('Enter'); return label; }`, 8000, P.sub);
    assert(/mathutil\.cpp/.test(focused), 'focused row: ' + focused);
    const g = await activeDiff(/mathutil\.cpp .*2\/3/);
    return { note: `선택한 행: ${focused} → ${g.active}` };
  });
  const settingsFile = path.join(path.dirname(ctx.demo), 'ud', 'User', 'settings.json');
  const readSettings = () => { try { return JSON.parse(require('fs').readFileSync(settingsFile, 'utf8')); } catch (_) { return {}; } };
  const pages = async () => (await (await fetch('http://127.0.0.1:9333/json/list')).json()).filter((t) => t.type === 'page').map((t) => t.title || t.url);
  await step({ scenario: S2, action: 'diff 제목줄 "새 창으로 분리" → 리뷰 화면에서 다른 파일 클릭', expect: 'diff 가 별도 창으로 옮겨지고 다음 diff 도 그 창에 열림. 방식이 설정에 저장됨' }, async () => {
    await clickTitleButton('/새 창으로 분리/');
    let p = [];
    for (let i = 0; i < 30; i++) { await sleep(300); p = await pages(); if (p.length >= 2 && !(await groupsNow()).some((x) => x.tabs.some((t) => /↔/.test(t)))) break; }
    assert(p.length >= 2, 'no second window: ' + p.join(' | '));
    assert(!(await groupsNow()).some((x) => x.tabs.some((t) => /↔/.test(t))), 'diff still in the main window');
    for (let i = 0; i < 20 && readSettings()['svnwt.diffPlacement'] !== 'window'; i++) await sleep(250);
    assert(readSettings()['svnwt.diffPlacement'] === 'window', 'setting not saved: ' + JSON.stringify(readSettings()['svnwt.diffPlacement']));
    await d.webview(`(doc) => { doc.querySelectorAll('tr.file')[2].click(); return true; }`, 8000, P.sub);
    let titles = [];
    for (let i = 0; i < 30; i++) { await sleep(300); titles = await pages(); if (titles.some((t) => /mathutil\.h/.test(t))) break; }
    const main = await groupsNow();
    assert(!main.some((x) => x.tabs.some((t) => /↔/.test(t))), 'the next diff opened in the main window: ' + JSON.stringify(main.map((x) => x.tabs)));
    assert(titles.length === p.length, 'another window was opened: ' + titles.join(' | '));
    assert(titles.some((t) => /mathutil\.h/.test(t)), 'the diff window does not show the next file: ' + titles.join(' | '));
    return { note: `창: ${titles.join(' | ')}` };
  });
  await step({ scenario: S2, action: '설정을 리뷰 화면 위(review)로 되돌린 뒤 파일 클릭', expect: '다시 리뷰 화면 탭 그룹에 좌우 diff' }, async () => {
    const cfg = readSettings();
    cfg['svnwt.diffPlacement'] = 'review';
    require('fs').writeFileSync(settingsFile, JSON.stringify(cfg, null, 2));
    await sleep(1500);
    await d.webview(`(doc) => { doc.querySelector('tr.file').click(); return true; }`, 8000, P.sub);
    const g = await activeDiff(/main\.cpp .*1\/3/);
    assert(g.tabs.some((t) => /add sub function/.test(t)), JSON.stringify(g.tabs));
    await d.key('Escape');
    await sleep(600);
    return { note: `탭 그룹: ${g.tabs.join(' | ')}` };
  });
  const tabAt = (re) => d.eval(`(() => { const t = [...document.querySelectorAll('.editor-group-container .tab')].find((x) => ${re}.test(x.getAttribute('aria-label') || '')); if (!t) return null; t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const b = t.getBoundingClientRect(); const c = (t.closest('.tabs-and-actions-container .monaco-scrollable-element') || t.closest('.tabs-container')).getBoundingClientRect(); return { x: Math.min(Math.max(b.left + b.width / 2, c.left + 4), c.right - 4), y: b.top + b.height / 2, inView: b.left >= c.left - 1 && b.right <= c.right + 1 }; })()`);
  const focusDiff = async () => { for (let i = 0; i < 20 && !(await d.eval(`!!(document.activeElement && document.activeElement.closest('.monaco-diff-editor'))`)); i++) await sleep(250); await sleep(300); };
  await step({ scenario: S2, action: 'diff 탭을 고정해 두고 다른 파일 diff 를 연 뒤, 고정한 탭으로 돌아가 Alt+Shift+→', expect: '마지막에 연 diff 가 아니어도 그 탭의 다음 파일로 (열린 탭 사이를 오가지 않음)' }, async () => {
    // activate a tab by clicking it (again if the click did not take)
    const clickTab = async (re, expect) => {
      for (let k = 0; k < 3; k++) {
        const t = await tabAt(re);
        if (t) { await d.mouse('mouseMoved', t.x, t.y); await d.mouse('mousePressed', t.x, t.y); await d.mouse('mouseReleased', t.x, t.y); }
        try { return await activeDiff(expect, 3000); } catch (_) { /* again */ }
      }
      throw new Error(`tab ${re} not activated: ${JSON.stringify((await groupsNow()).map((x) => x.tabs))}`);
    };
    // the main.cpp diff of the previous step is still open behind the review: activate it and keep it
    await clickTab('/^main\\.cpp \\(r/', /main\.cpp .*1\/3/);
    await d.command('View: Keep Editor');
    await clickTitleButton('/^리뷰 화면으로/');
    await sleep(600);
    await d.webview(`(doc) => { doc.querySelectorAll('tr.file')[2].click(); return true; }`, 8000, P.sub);
    await activeDiff(/mathutil\.h .*3\/3/);
    await clickTab('/^main\\.cpp \\(r/', /main\.cpp .*1\/3/);
    await focusDiff();
    await d.key('ArrowRight', { alt: true, shift: true });
    const g = await activeDiff(/mathutil\.cpp .*2\/3/);
    // clean up: close the kept main.cpp tab and the preview diff
    for (const re of ['/^main\\.cpp \\(r/', '/^mathutil\\.(cpp|h) \\(r/']) {
      const t = await tabAt(re);
      if (!t) continue;
      await d.mouse('mousePressed', t.x, t.y); await d.mouse('mouseReleased', t.x, t.y);
      await sleep(300);
      await d.key('w', { ctrl: true });
      await sleep(400);
    }
    return { note: `고정 탭 main.cpp → Alt+Shift+→ → ${g.active} · 탭: ${g.tabs.join(' | ')}` };
  });


  // ---------------------------------------------------------------- 3
  const S3 = '3. 메뉴';
  await step({ scenario: S3, action: '커밋 대기 작업(#4) 우클릭', expect: '상태에 맞는 메뉴만 (worktree 관련은 하나로 묶음)' }, async () => {
    const p = await d.hover('.monaco-list-row', 'docs usage');
    await d.mouse('mousePressed', p.x, p.y, 'right');
    await d.mouse('mouseReleased', p.x, p.y, 'right');
    await sleep(800);
    const items = await d.eval(`[...document.querySelectorAll('.context-view .action-label, .monaco-menu .action-label')].map((e) => e.textContent.trim()).filter(Boolean)`);
    assert(items.length > 0 && items.length <= 12, 'menu items: ' + items.length);
    return { note: `${items.length}개: ${items.join(', ')}` };
  });
  await d.key('Escape');
  await step({ scenario: S3, action: '명령 팔레트에서 "SVN Worktree" 검색', expect: '사람이 쓰는 명령만 노출' }, async () => {
    await d.key('F1');
    await sleep(400);
    await d.type('SVN Worktree:');
    await sleep(900);
    const items = await quickPickItems();
    return { note: `${items.length}개: ${items.map((i) => i.replace(/^SVN Worktree: /, '').split(',')[0]).join(', ')}` };
  });
  await d.key('Escape');

  // ---------------------------------------------------------------- 4
  const S4 = '4. SVN 커밋 (사람, 커밋 준비 → TortoiseSVN)';
  const svnExe = (await require('../../src/core/env').detect()).svn.path;
  const svnSt = () => require('child_process').execFileSync(svnExe, ['status', ctx.wc], { encoding: 'utf8' });
  await step({ scenario: S4, action: '"docs usage" 리뷰 화면 → "커밋 준비"', expect: '상태 표시줄 "커밋 준비됨", working copy 에는 이 작업 변경만 (다른 changelist 와 변경은 잠시 빼 둠), changelist 는 이 작업 이름 하나' }, async () => {
    await d.click('.monaco-list-row', 'docs usage');
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="commitSvn"]').click(); return true; }`, 8000, P.docs);
    await d.waitFor(`[...document.querySelectorAll('.statusbar-item')].some((e) => /커밋 준비됨/.test(e.textContent))`, 15000, 'status bar');
    const st = svnSt();
    const changed = st.split(/\r?\n/).filter((l) => /^[MAD]/.test(l));
    const groups = [...st.matchAll(/--- Changelist '([^']+)'/g)].map((m) => m[1]);
    assert(groups.length === 1 && /docs-usage/.test(groups[0]) && changed.length && changed.every((l) => /docs|README/.test(l)), st);
    let title = '';
    for (let i = 0; i < 30 && title !== '커밋 준비됨'; i++) {
      title = await d.webview(`(doc) => doc.querySelector('.next-title').textContent`, 8000, P.docs);
      if (title !== '커밋 준비됨') await sleep(300);
    }
    assert(title === '커밋 준비됨', title);
    return { note: `상태 상자: ${title} / 알림: ${(await d.notifications()).join(' | ').slice(0, 160)}` };
  });
  await step({ scenario: S4, action: 'TortoiseSVN 커밋 창의 항목 확인', expect: '이 작업 파일은 모두 작업 이름 changelist 묶음 안 (기본 체크), 묶음 밖에는 새 폴더만', delay: 200 }, async () => {
    const st = svnSt();
    const lines = st.split(/\r?\n/);
    const idx = lines.findIndex((l) => /--- Changelist/.test(l));
    assert(idx >= 0, st);
    const rel = (l) => l.replace(/^.\s+/, '').replace(ctx.wc + '\\', '');
    const inCl = lines.slice(idx + 1).filter((l) => /^[MAD]/.test(l)).map(rel);
    const outside = lines.slice(0, idx).filter((l) => /^[MAD]/.test(l)).map(rel);
    assert(inCl.length > 0 && inCl.every((p) => /docs|README/.test(p)), inCl.join(', '));
    assert(outside.every((p) => { try { return require('fs').statSync(require('path').join(ctx.wc, p)).isDirectory(); } catch (_) { return false; } }), outside.join(', '));
    return { note: `${lines[idx].trim()}: ${inCl.join(', ')}${outside.length ? ` / 묶음 밖(폴더): ${outside.join(', ')}` : ''}` };
  });
  await step({ scenario: S4, action: '"커밋 취소 (되돌리기)"', expect: 'changelist 원상복구, 상태 표시줄 사라짐' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="cancelCommit"]').click(); return true; }`, 8000, P.docs);
    await d.waitFor(`![...document.querySelectorAll('.statusbar-item')].some((e) => /커밋 준비됨/.test(e.textContent))`, 15000, 'status bar cleared');
    let st = svnSt();
    for (let i = 0; i < 40 && (/ignore-on-commit/.test(st) || !/svnwt-.*docs-usage/.test(st)); i++) { await sleep(300); st = svnSt(); }
    assert(!/ignore-on-commit/.test(st) && /svnwt-.*docs-usage/.test(st), st);
    return { note: 'ignore-on-commit 없음, changelist 복원' };
  });
  await step({ scenario: S4, action: '"다른 방법으로 커밋…"', expect: '커밋 준비 / TortoiseSVN 직접 / VS Code 에서 바로' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('a[data-cmd="commitChoose"]').click(); return true; }`, 8000, P.docs);
    await d.waitFor(`[...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].some((r) => /커밋 준비/.test(r.getAttribute('aria-label') || ''))`, 8000, 'quick pick');
    return { note: (await quickPickItems()).filter((i) => !/^SVN Worktree:/.test(i)).join(' | ') };
  });
  await d.key('Escape');

  // ---------------------------------------------------------------- 5
  const S5 = '5. Copilot(MCP)이 작업을 만들 때';
  let agentTask = null;
  await step({ scenario: S5, action: 'MCP 도구 svnwt_task_create 호출 (Copilot 대행)', expect: '트리에 새 작업, worktree 가 작업 영역에 자동 추가' }, async () => {
    agentTask = mcp('task_create', { scope: 'demo', title: 'tools build script', description: 'build.cmd 에 clean 단계 추가' });
    await d.waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').includes('tools build script'))`, 15000, 'new task row');
    await sleep(3500);
    const folders = await d.eval(`[...document.querySelectorAll('.monaco-workbench')].length && (window.vscodeWorkspaceFolders || null)`);
    return { note: `작업 #${agentTask.no} ${agentTask.id}${folders ? '' : ''}` };
  });
  await step({ scenario: S5, action: '에이전트가 worktree 에서 수정·커밋 (2회) → 탐색기 확인', expect: '탐색기에 [svnwt] #N 폴더, 상태 표시줄에 작업 표시' }, async () => {
    const f = path.join(agentTask.workPath, 'tools', 'build.cmd');
    require('fs').appendFileSync(f, 'echo clean\r\n');
    mcp('task_commit', { task: agentTask.id, message: 'build: clean 단계' });
    require('fs').appendFileSync(f, 'echo done\r\n');
    mcp('task_commit', { task: agentTask.id, message: 'build: 완료 메시지' });
    await d.key('E', { ctrl: true, shift: true });
    await sleep(1500);
    const roots = await d.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row[aria-level="1"]')].map((r) => r.getAttribute('aria-label'))`);
    assert(roots.some((r) => /\[svnwt\]/.test(r)), roots.join(' | '));
    return { note: `탐색기 루트: ${roots.join(' | ')}` };
  });
  await step({ scenario: S5, action: 'worktree 파일 열기', expect: '상태 표시줄에 "svnwt #N" (클릭 시 리뷰)' }, async () => {
    await d.key('P', { ctrl: true });
    await sleep(500);
    await d.type('build.cmd');
    await sleep(1500);
    const items = await quickPickItems();
    const idx = items.findIndex((i) => /\[svnwt\]|wt\\|wt\//.test(i) || /tools build/.test(i));
    for (let i = 0; i < Math.max(0, idx); i++) await d.key('ArrowDown');
    await d.key('Enter');
    await sleep(1500);
    const sb = await d.eval(`[...document.querySelectorAll('.statusbar-item')].map((e) => e.textContent.trim()).filter((t) => /svnwt|SVN 원본/.test(t))`);
    assert(sb.some((t) => /svnwt #/.test(t)), 'status bar: ' + sb.join(' | ') + ' / picks: ' + items.join(' | '));
    return { note: `상태 표시줄: ${sb.join(' | ')}` };
  });
  await step({ scenario: S5, action: 'SVN 원본(wc) 의 같은 파일 열기', expect: '상태 표시줄에 "SVN 원본" 경고' }, async () => {
    await d.key('P', { ctrl: true });
    await sleep(500);
    await d.type('build.cmd');
    await sleep(1500);
    const items = await quickPickItems();
    const idx = items.findIndex((i) => /trunk/.test(i) && !/wt/.test(i));
    for (let i = 0; i < Math.max(0, idx); i++) await d.key('ArrowDown');
    await d.key('Enter');
    await sleep(1500);
    const sb = await d.eval(`[...document.querySelectorAll('.statusbar-item')].map((e) => e.textContent.trim()).filter((t) => /svnwt|SVN 원본/.test(t))`);
    assert(sb.some((t) => /SVN 원본/.test(t)), 'status bar: ' + sb.join(' | ') + ' / picks: ' + items.join(' | '));
    return { note: `상태 표시줄: ${sb.join(' | ')}` };
  });

  // ---------------------------------------------------------------- 6
  const S6 = '6. 커밋 준비: 다른 변경은 잠시 빼 두고 이 작업만';
  let stBefore6 = '';
  await step({ scenario: S6, action: '새 작업 리뷰 → "커밋 준비" (다른 작업 changelist 3개, 같은 파일을 SVN 원본에서 직접 고쳐 둔 상태)', expect: '거부·확인 없이 바로 준비: working copy 에는 이 작업의 build.cmd 만 (작업 이름 changelist), 상태 표시줄 "커밋 준비됨"' }, async () => {
    stBefore6 = svnSt();
    assert((stBefore6.match(/--- Changelist/g) || []).length >= 3 && /build\.cmd/.test(stBefore6), stBefore6);
    await d.click('.activitybar .action-item .action-label', 'SVN Worktree');
    await sleep(600);
    await d.click('.monaco-list-row', 'tools build script');
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="commitSvn"]').click(); return true; }`, 15000, String(agentTask.no) + '-');
    await d.waitFor(`[...document.querySelectorAll('.statusbar-item')].some((e) => /커밋 준비됨/.test(e.textContent))`, 30000, 'status bar');
    const st = svnSt();
    const changed = st.split(/\r?\n/).filter((l) => /^[MAD?]/.test(l));
    const cls6 = [...st.matchAll(/--- Changelist '([^']+)'/g)].map((m) => m[1]);
    assert(cls6.length === 1 && cls6[0] === ctx.svc.resolveTask(agentTask.id).task.changelist && changed.length === 1 && /build\.cmd/.test(changed[0]), st);
    const build = require('fs').readFileSync(path.join(ctx.wc, 'trunk', 'tools', 'build.cmd'), 'utf8');
    assert(/echo clean/.test(build) && /echo done/.test(build), build);
    return { note: `svn status: ${changed.join(' ')} / 알림: ${(await d.notifications()).join(' | ').slice(0, 200)}` };
  });
  await step({ scenario: S6, action: '"커밋 취소 (되돌리기)"', expect: '빼 두었던 changelist 3개와 직접 고친 내용이 그대로 돌아옴' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="cancelCommit"]').click(); return true; }`, 15000, String(agentTask.no) + '-');
    await d.waitFor(`![...document.querySelectorAll('.statusbar-item')].some((e) => /커밋 준비됨/.test(e.textContent))`, 30000, 'status bar cleared');
    let st = svnSt();
    const lines = (t) => t.split(/\r?\n/).filter((l) => l.trim()).sort().join('\n'); // svn prints changelist groups in no fixed order
    for (let i = 0; i < 40 && lines(st) !== lines(stBefore6); i++) { await sleep(300); st = svnSt(); }
    assert(lines(st) === lines(stBefore6), st);
    return { note: `복구: changelist ${(st.match(/--- Changelist '[^']+'/g) || []).join(', ')}` };
  });

  // ---------------------------------------------------------------- 7
  const S7 = '7. 커밋 완료 / 정리';
  await step({ scenario: S7, action: '"docs usage" changelist 를 만든 뒤 일부만 SVN 커밋 (app/docs 만, README 는 커밋에서 뺌)', expect: '작업은 커밋 완료, 트리에 "남은 변경 1", 리뷰 화면에 "남은 변경 버리기" 주 버튼과 남은 파일' }, async () => {
    const docsId = ctx.svc.listTasks().find((t) => t.title === 'docs usage').id;
    await ctx.svc.clearWorkingCopy(docsId);
    const ld = await ctx.svc.landTask(docsId);
    assert(ld.ok, 'land docs: ' + JSON.stringify(ld.blocked));
    require('child_process').execFileSync(svnExe, ['commit', '-q', '-m', 'docs only', path.join(ctx.wc, 'trunk', 'app', 'docs')]);
    const cs = await ctx.svc.checkCommitted(docsId);
    assert(cs.status === 'committed', JSON.stringify(cs));
    let row = '';
    for (let i = 0; i < 70 && !/남은 변경 1/.test(row); i++) {
      await sleep(300);
      row = (await treeRows()).find((r) => r.includes('docs usage')) || '';
    }
    assert(/남은 변경 1/.test(row), row || 'docs usage row not visible');
    await d.click('.monaco-list-row', 'docs usage');
    let r = {};
    for (let i = 0; i < 80 && !(r.buttons || []).includes('남은 변경 버리기'); i++) {
      await sleep(300);
      r = await d.webview(`(doc) => ({ title: doc.querySelector('.next-title').textContent, notes: [...doc.querySelectorAll('.next .note')].map((n) => n.textContent).join(' '), buttons: [...doc.querySelectorAll('.next .actions button')].map((b) => b.textContent) })`, 8000, P.docs);
    }
    if (!(/커밋 완료/.test(r.title) && r.buttons[0] === '남은 변경 버리기')) {
      const all = await d.webviewAll(`(doc) => doc.querySelector('.next-title').textContent`, P.docs);
      throw new Error(`stale review: ${JSON.stringify(r)} · frames: ${JSON.stringify(all)}`);
    }
    assert(/README/.test(r.notes), JSON.stringify(r));
    return { note: `${row.replace(/, has actions/, '')} / ${r.notes} [${r.buttons.join(', ')}]` };
  });
  await step({ scenario: S7, action: '"남은 변경 버리기" 클릭', expect: '버릴 파일 목록과 설명이 있는 확인 창' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="discardLeftovers"]').click(); return true; }`, 8000, P.docs);
    await d.waitFor(`!!document.querySelector('.monaco-dialog-box')`, 10000, 'dialog');
    const note = `${await dialog()} [버튼: ${(await dialogButtons()).join(', ')}]`;
    assert(/README/.test(note), note);
    return { note };
  });
  await step({ scenario: S7, action: '"버리기" 확인', expect: 'README 의 작업 변경이 SVN working copy 에서 빠지고 changelist 가 비고, 상태 상자는 "worktree 정리"' }, async () => {
    await d.click('.monaco-dialog-box .dialog-buttons .monaco-button', '버리기');
    let st = svnSt();
    for (let i = 0; i < 40 && /svnwt-.*docs-usage/.test(st); i++) { await sleep(300); st = svnSt(); }
    assert(!/svnwt-.*docs-usage/.test(st), 'changelist left: ' + st.trim().replace(/\s+/g, ' '));
    const readme = require('fs').readFileSync(path.join(ctx.wc, 'trunk', 'app', 'README.md'), 'utf8');
    assert(!/docs\/guide\.md/.test(readme), readme);
    let b = [];
    const PRIMARY = '보관 (worktree 정리)';
    for (let i = 0; i < 30 && b[0] !== PRIMARY; i++) {
      await sleep(300);
      b = await d.webview(`(doc) => [...doc.querySelectorAll('.next .actions button')].map((x) => x.textContent)`, 8000, P.docs);
    }
    assert(b[0] === PRIMARY, b.join(', '));
    return { note: `changelist 비움, 알림: ${(await d.notifications()).join(' | ').slice(0, 160)}` };
  });
  await step({ scenario: S7, action: '커밋 완료된 작업(#1) 리뷰 화면', expect: '"보관 (worktree 정리)" 주 버튼, "SVN 남은 변경 정리…"' }, async () => {
    await d.click('.monaco-list-row', 'main에서 mul');
    const r = await d.webview(`(doc) => ({ title: doc.querySelector('.next-title').textContent, buttons: [...doc.querySelectorAll('.next .actions button')].map((b) => b.textContent) })`, 8000, P.sample);
    assert(/커밋 완료/.test(r.title) && r.buttons.includes('SVN 남은 변경 정리…'), JSON.stringify(r));
    return { note: `${r.title} · ${r.buttons.join(', ')}` };
  });
  await step({ scenario: S7, action: '"보관 (worktree 정리)" 클릭', expect: '확인 창: 커밋 기록·리뷰·대화는 "보관된 작업"에 남음' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="remove"]').click(); return true; }`, 8000, P.sample);
    await d.waitFor(`!!document.querySelector('.monaco-dialog-box')`, 10000, 'dialog');
    const note = `${await dialog()} [버튼: ${(await dialogButtons()).join(', ')}]`;
    assert(/보관된 작업/.test(note), note);
    return { note };
  });
  await step({ scenario: S7, action: '"보관" 확인', expect: '진행 중 목록에서 빠지고 "보관된 작업" 아래로, 리뷰 탭은 보관 기록 화면으로 바뀜' }, async () => {
    await d.click('.monaco-dialog-box .dialog-buttons .monaco-button', '보관');
    let rows = [];
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      rows = await treeRows();
      if (!rows.some((r) => /^#\d+ main에서 mul/.test(r)) && rows.some((r) => r.startsWith('보관된 작업'))) break;
    }
    assert(!rows.some((r) => /^#\d+ main에서 mul/.test(r)) && rows.some((r) => r.startsWith('보관된 작업')), rows.join(' | '));
    let h = '';
    for (let i = 0; i < 30 && !/보관됨/.test(h); i++) {
      h = await d.webview(`(doc) => doc.querySelector('h1').textContent.replace(/\\s+/g, ' ').trim()`, 8000, P.sample).catch(() => '');
      if (!/보관됨/.test(h)) await sleep(300);
    }
    assert(/보관됨/.test(h), h);
    return { note: `남은 작업: ${rows.filter((r) => r.startsWith('#')).map((r) => r.split(' ').slice(0, 1)).join(', ')} · 리뷰 탭: ${h}` };
  });
  await step({ scenario: S7, action: '"보관된 작업" 펼치기 → 보관한 작업 클릭', expect: '보관 기록: 생성·SVN 커밋·보관 시각, 커밋 목록, 변경 파일, 리뷰' }, async () => {
    const tw = await d.eval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find((x) => (x.getAttribute('aria-label') || '').startsWith('보관된 작업')); if (!r) return null; const t = r.querySelector('.monaco-tl-twistie'); const b = t.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, expanded: r.getAttribute('aria-expanded') }; })()`);
    assert(tw, 'archive node');
    if (tw.expanded !== 'true') { await d.mouse('mousePressed', tw.x, tw.y); await d.mouse('mouseReleased', tw.x, tw.y); }
    await d.waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((r) => /main에서 mul/.test(r.getAttribute('aria-label') || '') && /커밋 \\d+개/.test(r.getAttribute('aria-label') || ''))`, 8000, 'archived row');
    await d.click('.monaco-list-row', 'main에서 mul');
    const r = await d.webview(`(doc) => ({ meta: [...doc.querySelectorAll('header .meta')].map((m) => m.textContent.replace(/\\s+/g, ' ').trim()), commits: doc.querySelectorAll('li.commit').length, files: doc.querySelectorAll('tr.file').length, h2: [...doc.querySelectorAll('h2')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()) })`, 8000, P.sample);
    assert(r.commits > 0 && r.files > 0 && /SVN 커밋/.test(r.meta[0]), JSON.stringify(r));
    return { note: `${r.meta.join(' / ')} · 섹션: ${r.h2.join(', ')}` };
  });
  await step({ scenario: S7, action: '보관 기록에서 커밋 클릭', expect: '그 커밋의 변경 (worktree 없이 git 기록으로)' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('li.commit').click(); return true; }`, 8000, P.sample);
    let tabs = [];
    for (let i = 0; i < 20 && !tabs.some((t) => /^#\d+ [0-9a-f]{8} /.test(t)); i++) { await sleep(300); tabs = await d.tabs(); }
    assert(tabs.some((t) => /^#\d+ [0-9a-f]{8} /.test(t)), tabs.join(' | '));
    return { note: `탭: ${tabs.filter((t) => /^#\d+ [0-9a-f]{8} /.test(t)).join(', ')}` };
  });

  // ---------------------------------------------------------------- 8
  const S8 = '8. 에이전트 (작업별 세션)';
  const fsx = require('fs');
  await step({ scenario: S8, action: '커스텀 에이전트 / Chat 세션 등록 확인', expect: 'SVN Task·SVN Review 에이전트 파일, @svnwt 참가자, (제안 API 허용 시) 세션 목록 등록' }, async () => {
    const prompts = path.join(process.env.SVNWT_TEST_USERDATA || path.join(path.dirname(ctx.demo), 'ud'), 'User', 'prompts');
    const files = fsx.existsSync(prompts) ? fsx.readdirSync(prompts) : [];
    assert(files.includes('svnwt-task.agent.md') && files.includes('svnwt-review.agent.md'), files.join(','));
    const logDir = path.join(path.dirname(ctx.demo), 'ud', 'logs');
    let out = '';
    const walk = (dd) => { for (const e of fsx.readdirSync(dd, { withFileTypes: true })) { const p = path.join(dd, e.name); if (e.isDirectory()) walk(p); else if (/SVN Worktree\.log$/.test(e.name)) out += fsx.readFileSync(p, 'utf8'); } };
    walk(logDir);
    const sessions = /chat sessions: 작업 목록을/.test(out) ? '세션 목록 등록됨' : (/chat sessions:/.test(out) ? out.match(/chat sessions:[^\n]*/)[0] : '세션 목록 로그 없음');
    return { note: `${files.filter((f) => /agent\.md$/.test(f)).join(', ')} · ${sessions}` };
  });
  let agentTaskNo = null;
  await step({ scenario: S8, action: '트리 제목줄 "새 작업 (에이전트에게 맡기기)" → 할 일 입력', expect: '작업 생성, 리뷰 화면이 열리고 트리에 "에이전트 실행 중"' }, async () => {
    await d.command('SVN Worktree: 새 작업 (에이전트에게 맡기기)');
    await sleep(800);
    await d.type('README 에 에이전트 설명을 한 줄 추가해줘');
    await d.key('Enter');
    await d.waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((r) => /에이전트 실행 중|승인 대기/.test(r.getAttribute('aria-label') || ''))`, 20000, 'running row');
    const row = (await treeRows()).find((r) => /에이전트 실행 중|승인 대기/.test(r)) || '';
    agentTaskNo = (/#(\d+)/.exec(row) || [])[1];
    return { note: row.replace(/, has actions/, '') };
  });
  await step({ scenario: S8, action: '에이전트가 run_command 를 요청', expect: '명령과 실행 위치가 보이는 승인 창 (실행 / 이 작업에서 항상 허용)' }, async () => {
    await d.waitFor(`!!document.querySelector('.monaco-dialog-box')`, 30000, 'approval dialog');
    const msg = await dialog();
    assert(/명령을 실행하려고/.test(msg) && /build-ok/.test(msg), msg);
    return { note: `${msg.slice(0, 160)} [버튼: ${(await dialogButtons()).join(', ')}]` };
  });
  await step({ scenario: S8, action: '"실행" 승인 → 완료까지 대기', expect: '완료 알림, 세션에 도구 실행 기록(✓)과 최종 답변, 작업 커밋' }, async () => {
    await d.click('.monaco-dialog-box .dialog-buttons .monaco-button', '실행');
    await d.waitFor(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].some((e) => /에이전트 완료/.test(e.textContent))`, 30000, 'done notification');
    await sleep(1200);
    const prefix = agentTaskNo + '-';
    const tr = await d.webview(`(doc) => { const t = doc.getElementById('transcript'); if (t) t.scrollIntoView(); return t ? [...t.children].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ') : ''; }`, 30000, prefix);
    assert(/✓ 수정 app\/README\.md/.test(tr) && /✓ 실행 Write-Output build-ok/.test(tr) && /완료: app\/README\.md/.test(tr), tr);
    const info = ctx.svc.listTasks().find((t) => String(t.no) === agentTaskNo);
    const st = await ctx.svc.taskInfo(info.id, { checkSvn: false });
    assert(st.commits.some((c) => /에이전트 설명/.test(c.subject)), JSON.stringify(st.commits));
    return { note: tr.slice(0, 300) };
  });
  await step({ scenario: S8, action: '리뷰 화면 에이전트 입력란에서 추가 지시 (Ctrl+Enter)', expect: '같은 작업 세션에 이어서 기록' }, async () => {
    const prefix = agentTaskNo + '-';
    await d.webview(`(doc) => { const a = doc.getElementById('agentInput'); a.value = '남은 작업이 있는지 확인해줘'; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); return true; }`, 8000, prefix);
    await d.waitFor(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].some((e) => /추가 지시 확인/.test(e.textContent))`, 30000, 'second run');
    let tr = '';
    for (let i = 0; i < 60 && !(/추가 지시 확인/.test(tr) && !/중지 버튼 남음/.test(tr)); i++) {
      await sleep(500);
      tr = await d.webview(`(doc) => [...doc.getElementById('transcript').children].slice(-3).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ') + (doc.querySelector('button[data-cmd="agentStop"]') ? ' [중지 버튼 남음]' : '')`, 8000, prefix);
    }
    assert(/남은 작업이 있는지/.test(tr) && /추가 지시 확인/.test(tr) && !/중지 버튼 남음/.test(tr), tr);
    const files = await d.webview(`(doc) => [...doc.querySelectorAll('h2')].map((h) => h.textContent.trim()).find((x) => x.startsWith('변경된 파일'))`, 8000, prefix);
    assert(/\(1\)/.test(files), 'review shows the committed file: ' + files);
    return { note: `${tr} · ${files}` };
  });

  // ---------------------------------------------------------------- 9
  const S9 = '9. 커밋까지 한 번에 (에이전트 작업 → 커밋 준비 → TortoiseSVN 커밋 → 복구)';
  const scopeId = 'demo';
  const OA = await ctx.svc.createTask(scopeId, { title: 'readme title A' });
  const OB = await ctx.svc.createTask(scopeId, { title: 'readme title B' });
  const editReadme = async (t, from, to) => {
    const f = path.join(t.workPath, 'app', 'README.md');
    fsx.writeFileSync(f, fsx.readFileSync(f, 'utf8').replace(from, to));
    await ctx.svc.commitTask(t.id, to);
  };
  await editReadme(OA, '# Demo app', '# Demo app (A)');
  await editReadme(OB, 'SVN Worktree 데모용 프로젝트입니다.', 'SVN Worktree 데모용 프로젝트입니다 (B).');
  await ctx.svc.clearWorkingCopy(OA.id);
  const la = await ctx.svc.landTask(OA.id); // A has a changelist made the old way (like 0.3.x/0.4.0)
  assert(la.ok, 'land A: ' + JSON.stringify(la.blocked));
  const rqB = await ctx.svc.requestChangelist(OB.id);
  assert(rqB.ready, JSON.stringify(rqB));
  const readmeWc = path.join(ctx.wc, 'trunk', 'app', 'README.md');
  await step({ scenario: S9, action: '에이전트가 끝낸 작업 (B) 리뷰 화면', expect: '트리와 상태 상자에 "리뷰 대기", 주 버튼 "커밋 준비"' }, async () => {
    let row = '';
    for (let i = 0; i < 70 && !/리뷰 대기/.test(row); i++) { await sleep(300); row = (await treeRows()).find((r) => r.includes('readme title B')) || ''; }
    assert(/리뷰 대기/.test(row), row || 'row not visible');
    await d.click('.monaco-list-row', 'readme title B');
    let r = {};
    for (let i = 0; i < 60 && r.title !== '리뷰 대기'; i++) {
      await sleep(300);
      r = await d.webview(`(doc) => ({ title: doc.querySelector('.next-title').textContent, buttons: [...doc.querySelectorAll('.next .actions button')].map((b) => b.textContent) })`, 20000, String(OB.no) + '-').catch(() => r);
    }
    assert(r.title === '리뷰 대기' && r.buttons[0] === '커밋 준비', JSON.stringify(r));
    return { note: `${row.replace(/, has actions/, '')} / ${r.title} [${r.buttons.join(', ')}]` };
  });
  await step({ scenario: S9, action: '"커밋 준비" 클릭', expect: 'working copy 에는 B 만 (A 의 changelist 는 잠시 빼 둠), changelist 는 B 이름 하나' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="commitSvn"]').click(); return true; }`, 15000, String(OB.no) + '-');
    await d.waitFor(`[...document.querySelectorAll('.statusbar-item')].some((e) => /커밋 준비됨/.test(e.textContent))`, 30000, 'status bar');
    const readme = fsx.readFileSync(readmeWc, 'utf8');
    const cls = [...svnSt().matchAll(/--- Changelist '([^']+)'/g)].map((m) => m[1]);
    assert(/\(B\)/.test(readme) && !/\(A\)/.test(readme) && cls.length === 1 && cls[0] === ctx.svc.resolveTask(OB.id).task.changelist, readme + svnSt());
    return { note: svnSt().split(/\r?\n/).filter((l) => /^[MAD?]/.test(l)).join(' ') };
  });
  await step({ scenario: S9, action: 'TortoiseSVN 으로 커밋 (svn commit 대행) → 자동 감지', expect: '"SVN 커밋 완료" 알림, B 는 커밋 완료, 빼 두었던 A 의 changelist 와 변경이 새 기준 위에 돌아옴' }, async () => {
    require('child_process').execFileSync(svnExe, ['commit', '-q', '-m', 'README B', ctx.wc]);
    await d.waitFor(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].some((e) => /SVN 커밋 완료/.test(e.textContent))`, 30000, 'commit detected');
    const st = svnSt();
    const readme = fsx.readFileSync(readmeWc, 'utf8');
    assert(/\(A\)/.test(readme) && /\(B\)/.test(readme), readme);
    assert(new RegExp(ctx.svc.resolveTask(OA.id).task.changelist).test(st), st);
    assert(ctx.svc.resolveTask(OB.id).task.status === 'committed', ctx.svc.resolveTask(OB.id).task.status);
    return { note: `README: A 변경 복구 + B 커밋됨 / changelist: ${(st.match(/--- Changelist '[^']+'/g) || []).join(', ')}` };
  });

  // ---------------------------------------------------------------- 10. review → ask the agent about one spot
  const S10 = '10. 변경 내용을 보다가 그 자리에서 질문/수정 지시';
  await step({ scenario: S10, action: '에이전트 작업의 README 를 열고 첫 줄 선택 → "이 부분 질문/수정 지시…" → 질문 입력', expect: '작업 세션에 파일·줄 위치, 선택한 코드, 그 부분 diff 가 붙은 요청이 들어가고 에이전트가 답함' }, async () => {
    const sf = path.join(path.dirname(ctx.demo), 'ud', 'User', 'settings.json');
    let cfg = {};
    try { cfg = JSON.parse(fsx.readFileSync(sf, 'utf8')); } catch (_) { /* none */ }
    cfg['svnwt.reviewAskTarget'] = 'background';
    fsx.mkdirSync(path.dirname(sf), { recursive: true });
    fsx.writeFileSync(sf, JSON.stringify(cfg, null, 2));
    await sleep(1000);
    const info = ctx.svc.listTasks().find((t) => String(t.no) === agentTaskNo);
    const file = path.join(info.workPath, 'app', 'README.md');
    await d.key('P', { ctrl: true });
    await sleep(500);
    await d.type(file);
    await sleep(800);
    await d.key('Enter');
    await sleep(1500);
    await d.key('L', { ctrl: true }); // select the first line
    await d.command('SVN Worktree: 이 부분 질문/수정 지시');
    await d.waitFor(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`, 5000, 'input box');
    const title = await d.eval(`(document.querySelector('.quick-input-widget .quick-input-title') || {}).textContent || ''`);
    assert(new RegExp(`#${agentTaskNo} app/README\\.md:1`).test(title), title);
    await d.type('이 제목 줄은 왜 있어?');
    await d.key('Enter');
    const tr = await (async () => {
      for (let i = 0; i < 60; i++) {
        const t = await d.webview(`(doc) => { const t = doc.getElementById('transcript'); return t ? t.textContent.replace(/\\s+/g, ' ') : ''; }`, 15000, agentTaskNo + '-').catch(() => '');
        if (/선택한 줄 확인/.test(t)) return t;
        await sleep(500);
      }
      return '';
    })();
    assert(/\[리뷰 중 요청\] 파일 `?app\/README\.md`? 1행/.test(tr) && /요청: 이 제목 줄은 왜 있어\?/.test(tr) && /선택한 줄 확인/.test(tr), tr.slice(-1500));
    return { note: `입력 창: ${title} / 세션: ${(tr.match(/\[리뷰 중 요청\][^|]{0,80}/) || [''])[0]} … 선택한 줄 확인` };
  });

  // ---------------------------------------------------------------- 11. after the SVN commit: throw away what is left, keep the worktrees
  const S11 = '11. SVN 남은 변경 정리 (worktree 는 그대로)';
  const leftFile = path.join(ctx.wc, 'trunk', 'app', 'src', 'main.cpp'); // README belongs to #7 (waiting for its commit): not offered
  const leftOrig = fsx.readFileSync(leftFile, 'utf8');
  await step({ scenario: S11, action: 'SVN 원본 main.cpp 를 직접 고친 상태 → "SVN Worktree: SVN 남은 변경 정리…"', expect: 'scope 폴더의 남은 변경 목록 (버전 관리 안 되는 파일은 기본 해제)' }, async () => {
    await d.key('Escape');
    fsx.writeFileSync(leftFile, leftOrig + '// left over\n');
    await d.command('SVN Worktree: SVN 남은 변경 정리');
    await d.waitFor(`[...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].some((r) => /main\\.cpp/.test(r.getAttribute('aria-label') || ''))`, 15000, 'quick pick');
    const items = await quickPickItems();
    const checked = await d.eval(`[...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('aria-label'))`);
    assert(checked.some((x) => /main\.cpp/.test(x)) && !items.some((x) => /README/.test(x)), JSON.stringify({ items, checked }));
    return { note: `항목: ${items.join(' | ').slice(0, 300)} · 체크: ${checked.length}` };
  });
  await step({ scenario: S11, action: 'Enter → 확인 창 "버리기"', expect: 'main.cpp 가 SVN 원본으로 돌아가고 복사본이 남음, worktree 는 그대로' }, async () => {
    const wts = ctx.svc.listTasks().map((t) => t.workPath).filter((p) => fsx.existsSync(p));
    await d.key('Enter');
    await d.waitFor(`!!document.querySelector('.monaco-dialog-box')`, 10000, 'dialog');
    const note = await dialog();
    await d.click('.monaco-dialog-box .dialog-buttons .monaco-button', '버리기');
    for (let i = 0; i < 40 && fsx.readFileSync(leftFile, 'utf8') !== leftOrig; i++) await sleep(300);
    assert(fsx.readFileSync(leftFile, 'utf8') === leftOrig, 'main.cpp not reverted');
    assert(wts.every((p) => fsx.existsSync(p)), 'a worktree was removed');
    return { note: `${note.slice(0, 120)} / 알림: ${(await d.notifications()).join(' | ').slice(0, 160)}` };
  });

  // ---------------------------------------------------------------- 12
  const S12 = '12. SVN 이 바뀌면 svnwt 가 묻는다 (rebase 를 찾아 누를 필요 없음)';
  const scope0 = ctx.svc.listScopes()[0];
  const toastButton = async (textRe, label, ms = 20000) => {
    await d.waitFor(`[...document.querySelectorAll('.notifications-toasts .notification-list-item')].some((n) => ${textRe}.test(n.textContent) && [...n.querySelectorAll('.monaco-button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)}))`, ms, 'toast ' + textRe);
    const msg = (await d.notifications()).find((x) => new RegExp(textRe.slice(1, -1)).test(x)) || '';
    const at = () => d.eval(`(() => { const n = [...document.querySelectorAll('.notifications-toasts .notification-list-item')].find((x) => ${textRe}.test(x.textContent)); if (!n) return null; const b = [...n.querySelectorAll('.monaco-button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    // toasts slide in: click once it stands still, again if it is still there
    for (let i = 0; i < 3; i++) {
      await sleep(700);
      const r = await at();
      if (!r) break;
      await d.mouse('mouseMoved', r.x, r.y);
      await d.mouse('mousePressed', r.x, r.y); await d.mouse('mouseReleased', r.x, r.y);
      await sleep(1500);
      if (!(await at())) break;
    }
    return msg;
  };
  await step({ scenario: S12, action: '다른 사람이 SVN 서버에 커밋 → "SVN Worktree: SVN 지금 확인"', expect: '"SVN 서버에 새 커밋 1개" 알림 (내가 커밋한 것은 빼고) → svn update' }, async () => {
    const cp = require('child_process');
    const url = /<url>([^<]+)<\/url>/.exec(cp.execFileSync(svnExe, ['info', '--xml', scope0.svnPath], { encoding: 'utf8' }))[1];
    const other = path.join(path.dirname(ctx.demo), 'other-checkout');
    cp.execFileSync(svnExe, ['checkout', '-q', url, other]);
    fsx.writeFileSync(path.join(other, 'NOTES.txt'), '다른 사람이 추가한 파일\r\n');
    cp.execFileSync(svnExe, ['add', '-q', path.join(other, 'NOTES.txt')]);
    cp.execFileSync(svnExe, ['commit', '-q', '-m', '다른 사람의 커밋', other]);
    ctx.fresh = await ctx.svc.createTask(scope0.id, { title: 'rebase 대상' });
    await sleep(1500);
    await d.command('SVN Worktree: SVN 지금 확인');
    const msg = await toastButton('/SVN 서버에 새 커밋 1개/', 'svn update');
    for (let i = 0; i < 100 && !fsx.existsSync(path.join(scope0.svnPath, 'NOTES.txt')); i++) await sleep(300);
    assert(fsx.existsSync(path.join(scope0.svnPath, 'NOTES.txt')), 'svn update did not run: ' + JSON.stringify({ msg, toasts: await d.notifications(), marker: ctx.svc.pendingCommits().map((m) => m.task), svn: scope0.svnPath }));
    return { note: msg };
  });
  await step({ scenario: S12, action: '이어서 뜨는 알림 "새 기준으로 rebase 할까요?" → rebase', expect: '진행 중인 작업이 새 SVN 기준으로 옮겨짐 (worktree 에 NOTES.txt), 충돌 없으면 조용히 끝남' }, async () => {
    const msg = await toastButton('/rebase 할까요/', 'rebase');
    // a clean task is rebased; one that changed the same lines as newer SVN commits is left as it was and reported
    let left = [];
    let conflictMsg = '';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      left = (await ctx.svc.tasksBehind(scope0.id)).filter((t) => !t.blocked);
      conflictMsg = (await d.notifications()).find((x) => /rebase 하지 않았습니다/.test(x)) || '';
      if (!left.some((t) => t.id === ctx.fresh.id) && (!left.length || conflictMsg)) break;
    }
    assert(!left.some((t) => t.id === ctx.fresh.id) && fsx.existsSync(path.join(ctx.fresh.workPath, 'NOTES.txt')), 'clean task not rebased: ' + JSON.stringify(left));
    for (const t of left) assert(conflictMsg.includes('#' + t.no), `#${t.no} neither rebased nor reported: ${conflictMsg}`);
    const active = ctx.svc.listTasks({ scope: scope0.id }).filter((t) => t.status === 'active');
    const moved = active.filter((t) => fsx.existsSync(path.join(t.workPath, 'NOTES.txt')));
    return { note: `${msg.slice(0, 160)} · 옮겨진 작업: ${moved.map((t) => '#' + t.no).join(', ')}${conflictMsg ? ` · 충돌 알림: ${conflictMsg.slice(0, 140)}` : ''}` };
  });

  // ---------------------------------------------------------------- 13
  const S13 = '13. 작업 이름 변경 / 에이전트 세션 접힘';
  await step({ scenario: S13, action: '에이전트 작업 리뷰 화면의 "에이전트 세션"', expect: '기본으로 접혀 한 줄(상태 + 마지막 메시지)만 차지' }, async () => {
    const r = await d.webview(`(doc) => { const b = doc.getElementById('agentBox'); if (!b) return null; const s = b.querySelector('summary'); return { open: b.open, h: Math.round(s.getBoundingClientRect().height), text: s.textContent.replace(/\\s+/g, ' ').trim() }; }`, 15000, agentTaskNo + '-');
    assert(r && !r.open && r.h < 40, JSON.stringify(r));
    return { note: `${r.text.slice(0, 120)} (높이 ${r.h}px)` };
  });
  await step({ scenario: S13, action: '트리에서 "report mul output" 선택 → F2 → 새 이름 입력', expect: '목록과 리뷰 화면 제목이 새 이름으로 (브랜치·worktree 는 그대로)' }, async () => {
    const before = ctx.svc.listTasks().find((t) => /report mul output/.test(t.title));
    await d.command('Notifications: Clear All Notifications');
    await d.click('.sidebar .monaco-list-row', 'report mul output');
    await sleep(600);
    await d.key('F2');
    try { await d.waitFor(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`, 8000, 'rename input'); } catch (e) {
      throw new Error(e.message + ' ' + JSON.stringify(await d.eval(`(() => { const a = document.activeElement; return { tag: a && a.tagName, cls: a && String(a.className).slice(0, 80), view: a && a.closest('[id]') && a.closest('[id]').id, sel: [...document.querySelectorAll('.monaco-list-row.selected')].map((r) => r.getAttribute('aria-label')).slice(0, 3) }; })()`)));
    }
    await d.type('mul 결과 출력');
    await sleep(600);
    await d.key('Enter');
    await sleep(1000);
    if (await d.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`)) await d.key('Enter');
    await d.waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').includes('mul 결과 출력'))`, 10000, 'renamed row');
    const after = ctx.svc.resolveTask(before.id).task;
    assert(after.title === 'mul 결과 출력' && after.branch === before.branch && after.workPath === before.workPath, JSON.stringify({ t: after.title, b: after.branch }));
    let tabs = [];
    for (let i = 0; i < 20; i++) { tabs = await d.eval(`[...document.querySelectorAll('.editor-group-container .tab .label-name, .editor-group-container .tab .monaco-icon-label')].map((e) => e.textContent.trim())`); if (tabs.some((t) => /mul 결과 출력/.test(t))) break; await sleep(250); }
    assert(tabs.some((t) => /#\d+ mul 결과 출력/.test(t)), 'review tab title: ' + tabs.join(' | '));
    return { note: `#${after.no}: "${before.title}" → "${after.title}" · 탭: ${tabs.filter((t) => /#\d/.test(t)).join(' | ').slice(0, 160)}` };
  });
}

module.exports = { scenarios };
