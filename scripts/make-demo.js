'use strict';
/**
 * Build a demo environment: local SVN repository + working copy + svnwt scope + one sample task.
 *   scripts\make-demo.cmd [targetDir]      (default: %USERPROFILE%\Desktop\svnwt-demo)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const env = require('../src/core/env');
const { Service } = require('../src/core/service');

const target = path.resolve(process.argv[2] || path.join(os.homedir(), 'Desktop', 'svnwt-demo'));
const crlf = (lines) => lines.join('\r\n') + '\r\n';

const FILES = {
  'trunk/common/mathutil.h': crlf(['#pragma once', '', 'int add(int a, int b);', 'int mul(int a, int b);']),
  'trunk/common/mathutil.cpp': crlf(['#include "mathutil.h"', '', 'int add(int a, int b) { return a + b; }', 'int mul(int a, int b) { return a * b; }']),
  'trunk/app/src/main.cpp': crlf([
    '#include <cstdio>', '#include "../../common/mathutil.h"', '', 'void report(int a, int b);', '',
    'int main() {', '  int x = add(2, 3);', '  std::printf("%d\\n", x);', '  report(4, 5);', '  return 0;', '}']),
  'trunk/app/src/report.cpp': crlf([
    '#include <cstdio>', '#include "../../common/mathutil.h"', '', '// 계산 결과를 출력한다', 'void report(int a, int b) {',
    '  std::printf("add=%d\\n", add(a, b));', '}']),
  'trunk/app/README.md': crlf(['# Demo app', '', 'SVN Worktree 데모용 프로젝트입니다.']),
  'trunk/tools/build.cmd': crlf(['@echo off', 'echo build']),
};

const GUIDE = `# SVN Worktree 데모

- SVN 저장소: \`repo\` (file://)
- SVN working copy: \`wc\`  ← VS Code에서 이 폴더를 엽니다
- svnwt 데이터(git 저장소, worktree): \`wc.svnwt\`

미리 준비된 것
- scope \`demo\` = \`wc\\trunk\`
- 작업 #1 "main에서 mul 사용" — main.cpp 한 줄 수정 후 커밋까지 된 상태 (changelist는 아직 안 만듦)

## 해볼 것

1. 활동 표시줄 **SVN Worktree** → 작업 #1 클릭 → PR 형태 리뷰 화면
   - *모든 변경 사항 보기* → 다중 diff
   - *Copilot 리뷰 요청* → Copilot이 리뷰 후 결과가 이 화면에 표시됨
   - *SVN changelist 만들기* → \`wc\`에 반영되고 \`svnwt-1-main-mul\` changelist 생성 (\`svn status\`로 확인)
   - *SVN 커밋…* → TortoiseSVN 커밋 창 또는 터미널 명령 (커밋은 직접)
2. Copilot Chat을 **Agent 모드**로 열고 요청 (처음엔 svnwt 도구 승인 → *항상 허용*):
   - "report.cpp 에 mul 결과도 출력하도록 추가해줘"
   - 같은 대화나 새 대화에서 다른 요청: "mathutil 에 sub 함수를 추가해줘"
   → 요청마다 작업이 따로 생기고 worktree가 작업 영역에 추가되는지 확인
3. 두 작업이 같은 파일을 건드리면 changelist 만들기에서 충돌로 멈추는지 확인
   → 먼저 만든 작업을 SVN 커밋 → 나머지 작업에서 *최신 SVN 기준으로 rebase* → 다시 changelist

처음부터 다시: \`scripts\\make-demo.cmd\` 를 다시 실행 (기존 폴더를 지웁니다).
`;

async function main() {
  const t = await env.requireTools();
  const svn = (...a) => execFileSync(t.svn.path, ['--non-interactive', ...a], { encoding: 'utf8', windowsHide: true });
  const svnadmin = path.join(path.dirname(t.svn.path), 'svnadmin.exe');
  if (!fs.existsSync(svnadmin)) throw new Error(`svnadmin.exe 가 없습니다: ${svnadmin}`);

  const svc = new Service();
  // drop previous demo registration + folder
  for (const s of svc.listScopes().filter((x) => x.svnPath.toLowerCase().startsWith(target.toLowerCase() + path.sep))) {
    await svc.removeScope(s.id, { force: true });
  }
  if (fs.existsSync(target)) {
    // Remove contents (git objects / .svn files are read-only => PowerShell -Force). A folder kept open by
    // VS Code may survive as an empty directory, which is fine for svn checkout.
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-ChildItem -LiteralPath $env:T -Recurse -Force -File | Remove-Item -Force -ErrorAction SilentlyContinue; Get-ChildItem -LiteralPath $env:T -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue'],
      { env: { ...process.env, T: target }, stdio: 'inherit' });
    const left = [];
    const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else left.push(p); } };
    scan(target);
    if (left.length) throw new Error(`기존 데모 파일을 지우지 못했습니다 (사용 중인 프로그램을 닫고 다시 실행): ${left.slice(0, 3).join(', ')}`);
  }

  const repo = path.join(target, 'repo');
  const wc = path.join(target, 'wc');
  fs.mkdirSync(target, { recursive: true });
  execFileSync(svnadmin, ['create', repo]);
  svn('checkout', '-q', 'file:///' + repo.replace(/\\/g, '/'), wc);
  for (const [rel, text] of Object.entries(FILES)) {
    const p = path.join(wc, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  }
  svn('add', '-q', path.join(wc, 'trunk'));
  svn('propset', '-q', 'svn:ignore', 'bin\nobj\n*.user\n', path.join(wc, 'trunk', 'app'));
  svn('commit', '-q', '-m', 'demo initial', wc);
  svn('update', '-q', wc);
  fs.writeFileSync(path.join(target, 'README-데모.md'), GUIDE, 'utf8');

  const { scope } = await svc.initScope(path.join(wc, 'trunk'), { name: 'demo' });
  const task = await svc.createTask(scope.id, { title: 'main에서 mul 사용', description: 'add(2, 3) 대신 mul(2, 3) 결과를 출력하도록 변경 (예제 작업)' });
  const main = path.join(task.workPath, 'app', 'src', 'main.cpp');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('int x = add(2, 3);', 'int x = mul(2, 3);'), 'utf8');
  await svc.commitTask(task.id, 'main: add 대신 mul 사용');

  console.log(`demo ready
  working copy : ${wc}
  scope        : ${scope.id} (${scope.svnPath})
  sample task  : #${task.no} ${task.title} -> ${task.workPath}
  guide        : ${path.join(target, 'README-데모.md')}`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
