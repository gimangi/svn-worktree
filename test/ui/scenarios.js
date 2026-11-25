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
    const r = await d.webview(`(doc) => ({ title: doc.querySelector('.next-title').textContent, buttons: [...doc.querySelectorAll('.next .actions button')].map((b) => b.textContent + (b.classList.contains('primary') ? '*' : '')) })`, 8000, P.report);
    assert(r.buttons.filter((b) => b.endsWith('*')).length === 1, 'primary buttons: ' + r.buttons.join(','));
    return { note: `${r.title} · 버튼: ${r.buttons.join(', ')} (*=주 버튼)` };
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

  // ---------------------------------------------------------------- 3
  const S3 = '3. 메뉴';
  await step({ scenario: S3, action: '커밋 대기 작업(#4) 우클릭', expect: '상태에 맞는 메뉴만 (worktree 관련은 하나로 묶음)' }, async () => {
    const p = await d.hover('.monaco-list-row', 'docs usage');
    await d.mouse('mousePressed', p.x, p.y, 'right');
    await d.mouse('mouseReleased', p.x, p.y, 'right');
    await sleep(800);
    const items = await d.eval(`[...document.querySelectorAll('.context-view .action-label, .monaco-menu .action-label')].map((e) => e.textContent.trim()).filter(Boolean)`);
    assert(items.length > 0 && items.length <= 9, 'menu items: ' + items.length);
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
  const S4 = '4. SVN 커밋 (사람, 사내 커밋 도구 사용)';
  const svnExe = (await require('../../src/core/env').detect()).svn.path;
  const svnSt = () => require('child_process').execFileSync(svnExe, ['status', ctx.wc], { encoding: 'utf8' });
  await step({ scenario: S4, action: '"docs usage" 리뷰 화면 → "커밋 준비"', expect: '알림 + 상태 표시줄 "커밋 준비됨", 다른 변경은 ignore-on-commit 으로 이동' }, async () => {
    await d.click('.monaco-list-row', 'docs usage');
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="commitSvn"]').click(); return true; }`, 8000, P.docs);
    await d.waitFor(`[...document.querySelectorAll('.statusbar-item')].some((e) => /커밋 준비됨/.test(e.textContent))`, 15000, 'status bar');
    const st = svnSt();
    assert(/ignore-on-commit/.test(st), st);
    let title = '';
    for (let i = 0; i < 30 && title !== '커밋 준비됨'; i++) {
      title = await d.webview(`(doc) => doc.querySelector('.next-title').textContent`, 8000, P.docs);
      if (title !== '커밋 준비됨') await sleep(300);
    }
    assert(title === '커밋 준비됨', title);
    return { note: `상태 상자: ${title} / 알림: ${(await d.notifications()).join(' | ').slice(0, 160)}` };
  });
  await step({ scenario: S4, action: '(사내 도구가 띄운) TortoiseSVN 커밋 창의 기본 선택 확인', expect: '체크되는 항목 = 이 작업의 파일과 새 폴더만', delay: 200 }, async () => {
    const st = svnSt();
    const lines = st.split(/\r?\n/);
    const idx = lines.findIndex((l) => /--- Changelist/.test(l));
    const noCl = (idx < 0 ? lines : lines.slice(0, idx)).filter((l) => /^[MAD]/.test(l)).map((l) => l.replace(/^.\s+/, '').replace(ctx.wc + '\\', ''));
    assert(noCl.length > 0 && noCl.every((p) => /docs|README/.test(p)), noCl.join(', '));
    return { note: `changelist 밖(= TortoiseSVN 기본 체크): ${noCl.join(', ')}` };
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
  const S6 = '6. changelist 만들기와 충돌 (사람이 버튼으로)';
  const land = async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="land"]').click(); return true; }`, 8000, String(agentTask.no) + '-');
    await d.waitFor(`!!document.querySelector('.monaco-dialog-box')`, 10000, 'dialog');
    return `${await dialog()} [버튼: ${(await dialogButtons()).join(', ')}]`;
  };
  await step({ scenario: S6, action: '새 작업 리뷰 → "SVN changelist 만들기" (사용자가 같은 파일을 SVN 원본에서 직접 고쳐 둔 상태)', expect: '충돌 확인 창: 원인 설명, 적용 가능한 선택지만' }, async () => {
    await d.click('.activitybar .action-item .action-label', 'SVN Worktree');
    await sleep(600);
    await d.click('.monaco-list-row', 'tools build script');
    const note = await land();
    assert(/직접 고친/.test(note), note);
    return { note };
  });
  await d.key('Escape');
  await sleep(500);
  await step({ scenario: S6, action: '사용자가 SVN 원본의 로컬 수정을 되돌림 (svn revert) → 다시 "SVN changelist 만들기"', expect: '반영할 파일 목록이 있는 확인 창' }, async () => {
    const svnExe = (await require('../../src/core/env').detect()).svn.path;
    require('child_process').execFileSync(svnExe, ['revert', path.join(ctx.wc, 'trunk', 'tools', 'build.cmd')]);
    await sleep(800);
    const note = await land();
    assert(/반영/.test(note), note);
    return { note };
  });
  await step({ scenario: S6, action: '"반영" 클릭', expect: '완료 알림, 트리 상태 "커밋 대기 · 1파일"' }, async () => {
    await d.click('.monaco-dialog-box .dialog-buttons .monaco-button', '반영');
    await sleep(3500);
    const rows = await treeRows();
    const row = rows.find((r) => r.includes('tools build script')) || '';
    assert(/커밋 대기/.test(row), row);
    return { note: `${row.replace(/, has actions/, '')} / 알림: ${(await d.notifications()).join(' | ')}` };
  });

  // ---------------------------------------------------------------- 7
  const S7 = '7. 커밋 완료 / 정리';
  await step({ scenario: S7, action: '커밋 완료된 작업(#1) 리뷰 화면', expect: '"worktree 정리" 주 버튼' }, async () => {
    await d.click('.monaco-list-row', 'main에서 mul');
    const r = await d.webview(`(doc) => ({ title: doc.querySelector('.next-title').textContent, buttons: [...doc.querySelectorAll('.next .actions button')].map((b) => b.textContent) })`, 8000, P.sample);
    assert(/커밋 완료/.test(r.title), r.title);
    return { note: `${r.title} · ${r.buttons.join(', ')}` };
  });
  await step({ scenario: S7, action: '"worktree 정리" 클릭', expect: '삭제 확인 창' }, async () => {
    await d.webview(`(doc) => { doc.querySelector('.next button[data-cmd="remove"]').click(); return true; }`, 8000, P.sample);
    await d.waitFor(`!!document.querySelector('.monaco-dialog-box')`, 10000, 'dialog');
    return { note: `${await dialog()} [버튼: ${(await dialogButtons()).join(', ')}]` };
  });
  await step({ scenario: S7, action: '"삭제" 확인', expect: '트리에서 작업이 사라지고 리뷰 탭 닫힘' }, async () => {
    await d.click('.monaco-dialog-box .dialog-buttons .monaco-button', '삭제');
    await sleep(3500);
    const rows = await treeRows();
    assert(!rows.some((r) => r.includes('main에서 mul')), rows.join(' | '));
    return { note: `남은 작업: ${rows.filter((r) => r.startsWith('#')).map((r) => r.split(' ').slice(0, 1)).join(', ')}` };
  });
}

module.exports = { scenarios };
