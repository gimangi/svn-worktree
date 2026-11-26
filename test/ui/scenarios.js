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
    for (let i = 0; i < 30 && b[0] !== 'worktree 정리'; i++) {
      await sleep(300);
      b = await d.webview(`(doc) => [...doc.querySelectorAll('.next .actions button')].map((x) => x.textContent)`, 8000, P.docs);
    }
    assert(b[0] === 'worktree 정리', b.join(', '));
    return { note: `changelist 비움, 알림: ${(await d.notifications()).join(' | ').slice(0, 160)}` };
  });
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
    for (let i = 0; i < 40 && !(/추가 지시 확인/.test(tr) && !/중지 버튼 남음/.test(tr)); i++) {
      await sleep(300);
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
}

module.exports = { scenarios };
