'use strict';
/** Build docs/ui-test/report.html from steps.json (+ the findings below). */
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'docs', 'ui-test');

// Found in the first UI test round and fixed before this run (0.1.2 -> 0.2.0)
const FIXED = [
  ['버그', '트리에 "#undefined undefined" 행이 생김', '테스트 결과 파일(*.artifacts.json)을 작업 파일로 읽음 → 작업 파일만 읽도록 수정'],
  ['문의 4', '"리뷰 (Pull Request 보기)" 버튼이 반응하지 않는 것처럼 보임', '행 클릭으로 이미 리뷰가 열려 있어 인라인 아이콘은 같은 화면을 다시 앞으로 가져올 뿐이었음 → 인라인 리뷰 아이콘 제거, 행 클릭 시 포커스는 트리에 유지, 다시 열 때 SVN 커밋 여부도 확인'],
  ['UX', '트리 상태 문구("changelist 준비됨 · 커밋 대기")가 잘림', '"진행 중 / 커밋 대기 · N파일 / 커밋 완료"로 줄임'],
  ['UX', 'scope 설명 "r2 (r2:r3)" 이 무슨 뜻인지 불분명', '"SVN r2" 로 표시, 혼합 리비전은 툴팁으로'],
  ['UX', '리뷰 화면 버튼 10개가 두 줄로 나열', '상태별 "다음 단계" 상자에 주 버튼 1개 + 보조 버튼 2개. worktree 열기·터미널·되돌리기는 링크로'],
  ['UX', '이미 changelist 를 만든 작업에도 "rebase 권장" 경고', '진행 중 작업에서만 안내 (changelist 는 SVN 변경과 3-way 병합되어 있음)'],
  ['불필요', '리뷰 화면 "새로 고침" 버튼', '자동 갱신 + 화면을 열 때/60초마다 외부(TortoiseSVN 등) 커밋 감지로 대체'],
  ['UX', '에이전트가 작업하는 동안 리뷰 화면이 다시 그려지며 스크롤이 맨 위로', '내용이 바뀔 때만 다시 그리고 스크롤 위치 유지'],
  ['UX', '커밋 메시지를 고친 뒤 "저장"을 눌러야 함', '자동 저장'],
  ['UX', '긴 svn commit 명령이 화면 맨 아래에 그대로 노출', '"커밋 명령 보기"로 접어서 상태 상자 안에 배치'],
  ['UX', '테스트 화면 캡션이 "report-shows-add-and-mul-chromium · test-failed-1.png"', '테스트 이름 + 브라우저로 표시, 실패 스크린샷은 ✗ 와 빨간 테두리'],
  ['불필요', '우클릭 메뉴 13개 (worktree 관련 4개, 명령 복사 중복)', '8개로 정리: worktree 관련은 "worktree 열기…" 하나, 명령 복사는 커밋 선택창에만'],
  ['불필요', '명령 팔레트에 내부용 명령 노출', '새로 고침, 명령 복사, worktree 하위 동작 숨김'],
  ['UX', '제목줄의 "새 작업"과 "scope 등록" 아이콘이 둘 다 + 모양', '"새 작업"만 노출, scope 등록은 … 메뉴로'],
  ['UX', '직접 만든 작업은 긴 경로 알림 + 작업 영역에 수동 추가', 'Copilot 이 만든 작업과 같은 규칙(svnwt.addWorktreeToWorkspace)으로 자동 추가, 짧은 알림'],
  ['UX', 'changelist 충돌 시: 반영할 파일이 없는데 "충돌 파일 제외하고 진행", 로컬 수정과의 충돌인데 rebase 권유', '충돌 원인별 안내(로컬 수정 / 다른 작업 changelist)와 실제로 가능한 버튼만 표시'],
];

// Added after the second round (0.3.0)
const ADDED = [
  ['같은 파일을 여러 작업이 고친 경우', '다른 작업 changelist 에 있는 파일도 줄이 겹치지 않으면 "공유 파일"로 함께 반영. 커밋할 때 그 파일을 "SVN BASE + 이 작업 변경"으로 잠시 바꿔 작업별로 따로 커밋하고, 끝나면 되돌린 뒤 남은 작업의 changelist 로 넘김'],
  ['TortoiseSVN 으로 직접 커밋', '"커밋 준비": 다른 변경은 TortoiseSVN 이 기본 체크 해제하는 ignore-on-commit 으로, 이 작업 파일은 changelist 밖으로, 다른 작업의 새 폴더는 잠시 추가 해제. 커밋 메시지는 클립보드. 커밋이 감지되면 자동 원상복구, 취소 버튼으로도 복구'],
  ['사용자 로컬 수정', '작업 파일에 섞인 사용자의 직접 수정도 커밋 동안 빼 두었다가 되돌림 (작업 커밋에 섞이지 않음)'],
  ['리뷰 탭이 작업마다 쌓임', '편집기 미리보기 탭처럼 1개를 재사용. 그 탭에서 버튼을 누르는 등 작업하면 유지되고, "리뷰를 새 탭으로 열기"도 있음'],
  ['중단 복구', '커밋 준비 중 VS Code 가 꺼져도 다시 켜면 감시를 이어 가고, 직접 커밋 중 비정상 종료되면 백업으로 복원'],
];

const TODO = [
  ['worktree 를 처음 추가하면 창이 "Untitled (Workspace)"가 되고, 닫을 때 저장 여부를 물음', 'VS Code 동작. 자주 쓰면 .code-workspace 저장을 안내하거나 svnwt.addWorktreeToWorkspace 를 ask 로'],
  ['worktree 가 git 저장소라 Git 확장이 소스 제어 뷰·상태 표시줄에 task 브랜치를 표시', '유용하지만 "parent folder 에서 Git 저장소 발견" 알림이 뜰 수 있음 (테스트에서는 꺼 둠)'],
  ['트리에서 선택된 행은 인라인 아이콘 때문에 설명이 잘림', '행이 좁을 때 아이콘 1개만 남김 (현재 상태별 1개)'],
  ['실제 Copilot 대화로는 검증하지 않음', '격리 프로필에는 Copilot 로그인이 없어 MCP 도구 호출로 에이전트 동작을 대신함 (도구 경로는 동일)'],
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function defaults() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
  let vscode = '';
  try {
    const cli = path.join(path.dirname(process.execPath), 'bin', 'code.cmd');
    const cli2 = path.join(path.dirname(path.dirname(process.execPath)), 'bin', 'code.cmd');
    const r = require('child_process').spawnSync('cmd.exe', ['/d', '/c', fs.existsSync(cli) ? cli : cli2, '--version'], { encoding: 'utf8' });
    vscode = (r.stdout || '').split(/\r?\n/)[0];
  } catch (_) { /* ignore */ }
  return { version: pkg.version, vscode };
}

function build(meta = {}) {
  meta = Object.assign(defaults(), meta);
  const steps = JSON.parse(fs.readFileSync(path.join(OUT, 'steps.json'), 'utf8'));
  const passed = steps.filter((s) => s.result === 'pass').length;
  const groups = [];
  for (const s of steps) {
    let g = groups.find((x) => x.name === s.scenario);
    if (!g) groups.push(g = { name: s.scenario, steps: [] });
    g.steps.push(s);
  }
  const toc = groups.map((g, i) => `<a href="#g${i}">${esc(g.name)} <span class="muted">${g.steps.filter((s) => s.result === 'pass').length}/${g.steps.length}</span></a>`).join('');
  const body = groups.map((g, i) => `
    <section id="g${i}"><h2>${esc(g.name)}</h2>
    ${g.steps.map((s) => `
      <article class="step ${s.result}">
        <div class="txt">
          <div class="n">단계 ${s.n} <span class="badge ${s.result}">${s.result === 'pass' ? '통과' : '실패'}</span></div>
          <div class="act">${esc(s.action)}</div>
          <div class="exp"><b>기대</b> ${esc(s.expect)}</div>
          ${s.note ? `<div class="note"><b>확인</b> ${esc(s.note)}</div>` : ''}
        </div>
        <a class="img" href="${esc(s.shot)}" target="_blank"><img src="${esc(s.shot)}" loading="lazy" alt="단계 ${s.n}"></a>
      </article>`).join('')}
    </section>`).join('');

  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVN Worktree UI 테스트</title>
<style>
:root { --bg:#f6f7f9; --fg:#1d2433; --muted:#667085; --card:#fff; --line:#e3e6eb; --ok:#1a7f37; --bad:#c62828; --acc:#2060a0; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181d; --fg:#e6e8ec; --muted:#9aa3b2; --card:#1f232a; --line:#2e333c; --ok:#3fb950; --bad:#f85149; --acc:#58a6ff; } }
* { box-sizing: border-box; }
body { margin:0; font-family: "Segoe UI","Malgun Gothic",sans-serif; background:var(--bg); color:var(--fg); line-height:1.5; }
header { padding:28px 32px 12px; max-width:1280px; margin:auto; }
h1 { margin:0 0 6px; font-size:26px; } h2 { margin:32px 0 12px; font-size:20px; border-bottom:1px solid var(--line); padding-bottom:6px; }
.muted { color:var(--muted); } main { max-width:1280px; margin:auto; padding:0 32px 60px; }
.summary { display:flex; gap:12px; flex-wrap:wrap; margin:14px 0; }
.kpi { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 16px; min-width:150px; }
.kpi b { display:block; font-size:22px; }
nav { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 4px; } nav a { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:3px 12px; color:var(--fg); text-decoration:none; font-size:14px; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; font-size:14px; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { background:color-mix(in srgb, var(--card) 85%, var(--acc)); }
.tag { display:inline-block; font-size:12px; padding:1px 8px; border-radius:10px; border:1px solid var(--line); white-space:nowrap; }
.step { display:grid; grid-template-columns: minmax(260px, 360px) 1fr; gap:16px; background:var(--card); border:1px solid var(--line); border-left:4px solid var(--ok); border-radius:8px; padding:14px; margin:12px 0; }
.step.fail { border-left-color:var(--bad); }
.n { font-size:13px; color:var(--muted); } .act { font-weight:600; margin:4px 0 8px; } .exp, .note { font-size:14px; margin:4px 0; } .note { color:var(--muted); word-break:break-all; }
.badge { font-size:12px; padding:1px 8px; border-radius:10px; color:#fff; } .badge.pass { background:var(--ok); } .badge.fail { background:var(--bad); }
.img img { width:100%; border:1px solid var(--line); border-radius:4px; display:block; }
@media (max-width: 800px) { .step { grid-template-columns: 1fr; } header, main { padding-left:16px; padding-right:16px; } }
</style></head><body>
<header>
  <h1>SVN Worktree 확장 UI 테스트</h1>
  <div class="muted">${esc(meta.when || new Date().toLocaleString('ko-KR'))} · VS Code ${esc(meta.vscode || '')} (격리 프로필, 디버깅 포트로 자동 조작) · 확장 ${esc(meta.version || '')}</div>
  <div class="summary">
    <div class="kpi"><span class="muted">단계</span><b>${passed} / ${steps.length} 통과</b></div>
    <div class="kpi"><span class="muted">시나리오</span><b>${groups.length}개</b></div>
    <div class="kpi"><span class="muted">1차 테스트 후 고친 문제</span><b>${FIXED.length}건</b></div>
  </div>
  <div class="muted">데모 상태: SVN 저장소 + working copy, 에이전트 3개가 동시에 만든 작업(#2~#4, 각자 changelist), 커밋 완료된 예제 작업(#1), 작업 #2 에 Playwright 실행 2회(실패 → 통과) 결과 첨부.</div>
  <nav>${toc}<a href="#tortoise">TortoiseSVN 기본 선택</a><a href="#added">추가 기능</a><a href="#fixed">고친 문제</a><a href="#todo">남은 제안</a></nav>
</header>
<main>
${body}
${fs.existsSync(path.join(OUT, 'tortoise-commit.png')) ? `<section id="tortoise"><h2>커밋 준비 후 TortoiseSVN 커밋 창 (실제 캡처)</h2>
<p class="muted">커밋 대기 작업 3개 + 사용자 로컬 수정이 있는 working copy 루트에서 커밋 창을 연 모습. 체크된 것은 이 작업의 파일 1개뿐이고, 다른 작업 파일은 ignore-on-commit(체크 해제), 다른 작업의 새 폴더는 non-versioned 로 보입니다. 창을 닫으면 모두 원래 changelist 로 돌아갑니다.</p>
<a class="img" href="tortoise-commit.png" target="_blank"><img src="tortoise-commit.png" alt="TortoiseSVN commit dialog" style="width:100%;border:1px solid var(--line);border-radius:6px"></a></section>` : ''}
<section id="added"><h2>2차 테스트 이후 추가한 기능</h2>
<table><tr><th>상황</th><th>동작</th></tr>${ADDED.map(([p, f]) => `<tr><td>${esc(p)}</td><td>${esc(f)}</td></tr>`).join('')}</table></section>
<section id="fixed"><h2>1차 테스트에서 찾아 고친 문제</h2>
<table><tr><th>구분</th><th>문제</th><th>조치</th></tr>${FIXED.map(([k, p, f]) => `<tr><td><span class="tag">${esc(k)}</span></td><td>${esc(p)}</td><td>${esc(f)}</td></tr>`).join('')}</table></section>
<section id="todo"><h2>남은 개선 제안 (미적용)</h2>
<table><tr><th>관찰</th><th>제안</th></tr>${TODO.map(([p, f]) => `<tr><td>${esc(p)}</td><td>${esc(f)}</td></tr>`).join('')}</table></section>
<p class="muted">다시 실행: <code>scripts\\run-ui-test.cmd</code> → 이 파일과 shots/ 가 새로 생성됩니다.</p>
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html, 'utf8');
  return path.join(OUT, 'report.html');
}

module.exports = { build };
if (require.main === module) console.log(build());
