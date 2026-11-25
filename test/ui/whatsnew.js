'use strict';
/** docs/ui-test/whats-new.html: what changed in this release, illustrated with the UI test screenshots. */
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'docs', 'ui-test');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** sections: title, bullets, screenshots picked by a regex on the step action */
const SECTIONS = [
  {
    title: 'SVN changelist 는 하나만',
    tag: '새 기능',
    bullets: [
      'SVN working copy 에는 한 작업만 반영합니다. 다른 작업이 있으면 <b>SVN changelist 만들기</b> 가 그것을 버리고 바꿀지 한 번 묻습니다.',
      '작업 내용은 git 에 남아 있어 언제든 다시 만들 수 있습니다. 같은 줄을 고친 작업끼리 막히지 않습니다.',
      '에이전트는 바꾸지 않고 <b>리뷰 대기</b> 로만 표시합니다.',
    ],
    shots: [/에이전트가 changelist 를 요청/, /"SVN changelist 만들기" 클릭/, /"바꾸기" 확인/],
  },
  {
    title: '남은 변경 버리기',
    tag: '새 기능',
    bullets: [
      '커밋에서 뺀 파일은 트리에 <b>남은 변경 N</b> 으로 표시됩니다.',
      '<b>남은 변경 버리기</b> 는 이 작업의 변경만 되돌립니다. 같은 파일의 다른 수정은 그대로입니다.',
    ],
    shots: [/일부만 SVN 커밋/, /"남은 변경 버리기" 클릭/, /"버리기" 확인/],
  },
  {
    title: '@svnwt 에이전트 (작업 하나 = 세션 하나)',
    tag: '새 기능',
    bullets: [
      '✨ <b>새 작업 (에이전트에게 맡기기)</b> 또는 채팅의 <code>@svnwt</code> 로 시작하면 작업 worktree 에서 에이전트가 일합니다.',
      '여러 작업을 동시에 돌릴 수 있고, 트리에 <b>실행 중 / 승인 대기</b> 가 보입니다. 리뷰 화면에서 바로 추가 지시를 보낼 수 있습니다.',
    ],
    shots: [/새 작업 \(에이전트에게 맡기기\)/, /완료까지 대기/, /추가 지시/],
  },
  {
    title: '에이전트 안전장치',
    tag: '새 기능',
    bullets: [
      '파일 수정은 작업 worktree 안에서만. <code>svn commit/revert/update</code> 는 차단, 다른 명령은 실행 전 승인.',
      'CP949·UTF-8(BOM)·CRLF 를 파일별로 유지합니다.',
    ],
    shots: [/run_command 를 요청/],
  },
  {
    title: '커스텀 에이전트 / Chat 세션 목록',
    tag: '새 기능',
    bullets: [
      'Copilot Chat 에 <b>SVN Task</b>, <b>SVN Review</b> 에이전트가 설치됩니다.',
      '(실험) VS Code Chat 세션 목록에 작업을 표시할 수 있습니다.',
    ],
    shots: [/커스텀 에이전트/],
  },
  {
    title: '커밋 준비',
    tag: '0.3.x',
    bullets: [
      '<b>커밋 준비</b> 후 TortoiseSVN 커밋 창을 열면 이 작업 파일만 체크돼 있습니다. 커밋이 끝나면 자동으로 원래대로 돌아옵니다.',
    ],
    shots: [/"커밋 준비"$/, /기본 선택 확인/],
    image: 'tortoise-commit.png',
  },
  {
    title: '리뷰 화면 · 테스트 화면',
    tag: '0.2~0.3',
    bullets: [
      '상태별 다음 단계와 주 버튼 1개, Playwright 스크린샷 갤러리, 리뷰 탭 재사용.',
    ],
    shots: [/상태 상자/, /테스트 화면 갤러리/],
  },
  {
    title: '안정성 · 업그레이드',
    tag: '검증',
    bullets: [
      '여러 에이전트가 동시에 작업을 만들어도 잠금 대기 없이 병렬로 생성 (0.3.3).',
      '0.3.x 위에 덮어 설치해도 기존 작업·changelist·커밋 준비 상태를 그대로 이어받습니다.',
    ],
    shots: [],
  },
];

function build() {
  const steps = JSON.parse(fs.readFileSync(path.join(OUT, 'steps.json'), 'utf8'));
  const pick = (re) => steps.find((s) => re.test(s.action));
  const sections = SECTIONS.map((sec) => {
    const shots = sec.shots.map(pick).filter(Boolean);
    const imgs = shots.map((s) => `<figure><a href="${esc(s.shot)}" target="_blank"><img src="${esc(s.shot)}" loading="lazy"></a><figcaption>${esc(s.action)}${s.result !== 'pass' ? ' <span class="bad">(실패)</span>' : ''}</figcaption></figure>`);
    if (sec.image && fs.existsSync(path.join(OUT, sec.image))) imgs.push(`<figure><a href="${sec.image}" target="_blank"><img src="${sec.image}" loading="lazy"></a><figcaption>커밋 준비 후 TortoiseSVN 커밋 창 (실제 캡처): 이 작업 파일 1개만 체크</figcaption></figure>`);
    return `<section><h2>${esc(sec.title)} <span class="tag">${esc(sec.tag)}</span></h2><ul>${sec.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>${imgs.length ? `<div class="shots">${imgs.join('')}</div>` : ''}</section>`;
  }).join('');
  const passed = steps.filter((s) => s.result === 'pass').length;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVN Worktree ${esc(pkg.version)} 개선 내역</title>
<style>
:root { --bg:#f6f7f9; --fg:#1d2433; --muted:#667085; --card:#fff; --line:#e3e6eb; --acc:#2060a0; --bad:#c62828; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181d; --fg:#e6e8ec; --muted:#9aa3b2; --card:#1f232a; --line:#2e333c; --acc:#58a6ff; --bad:#f85149; } }
* { box-sizing: border-box; } body { margin:0; font-family:"Segoe UI","Malgun Gothic",sans-serif; background:var(--bg); color:var(--fg); line-height:1.55; }
main { max-width:1180px; margin:auto; padding:28px 32px 60px; } h1 { margin:0 0 4px; font-size:26px; } .muted { color:var(--muted); }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin:18px 0; }
h2 { margin:0 0 8px; font-size:19px; } .tag { font-size:12px; font-weight:500; border:1px solid var(--line); border-radius:10px; padding:1px 8px; color:var(--muted); vertical-align:middle; }
li { margin:4px 0; } code { background:color-mix(in srgb, var(--line) 60%, transparent); padding:1px 5px; border-radius:4px; }
.shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; margin-top:10px; }
figure { margin:0; } figure img { width:100%; border:1px solid var(--line); border-radius:6px; display:block; } figcaption { font-size:13px; color:var(--muted); margin-top:4px; } .bad { color:var(--bad); }
@media (max-width:700px) { main { padding:16px; } .shots { grid-template-columns:1fr; } }
</style></head><body><main>
<h1>SVN Worktree ${esc(pkg.version)} 개선 내역</h1>
<div class="muted">화면은 격리된 VS Code 를 자동 조작한 UI 테스트 캡처입니다 (${passed}/${steps.length} 단계 통과). 전체 단계는 <a href="report.html">report.html</a>.</div>
${sections}
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, 'whats-new.html'), html, 'utf8');
  return path.join(OUT, 'whats-new.html');
}

module.exports = { build };
if (require.main === module) console.log(build());
