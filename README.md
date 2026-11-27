# SVN Worktree (svnwt)

SVN working copy 하나를 여러 작업이 같이 쓸 때 생기는 충돌을 없애기 위한 도구입니다.
작업(task)마다 git worktree를 따로 만들어 Copilot이 그 안에서만 수정하고, 끝나면 작업 단위 **SVN changelist**로 묶어 줍니다.
커밋 전에는 GitHub Pull Request처럼 변경 내용을 확인하고, 에이전트에게 리뷰를 맡길 수 있습니다. SVN 커밋은 사람이 합니다.

```
SVN working copy (D:\svn\proj)            svnwt 저장 위치 (D:\svn\proj.svnwt\<scope>)
 └ trunk\app  ← scope (git 관리 범위)  ──►  repo.git   (svn-base 브랜치 = SVN BASE 상태)
                                          wt\1-fix-login\   ← task 1 worktree (Copilot 작업)
                                          wt\2-add-export\  ← task 2 worktree
 changelist "svnwt-1-fix-login"  ◄── 3-way 반영 ──┘
```

## 설치

1. **Git for Windows** 설치: <https://git-scm.com/download/win> 또는 `winget install --id Git.Git -e`
2. **SVN 명령줄 클라이언트** 설치: TortoiseSVN 설치 시 *command line client tools* 선택
   (`winget install --id TortoiseSVN.TortoiseSVN -e --override "/passive ADDLOCAL=ALL"`)
3. 확장 설치: `code --install-extension svn-worktree-0.5.4.vsix`
   (또는 VS Code 확장 보기 → `...` → *VSIX에서 설치*)
4. VS Code 재시작

끝입니다. Node.js는 필요 없습니다(VS Code에 포함된 런타임으로 MCP 서버를 실행). 확장이 설치되면

- Copilot(Agent 모드)에 MCP 서버 **SVN Worktree**가 자동 등록되고 (`mcp.json` 편집 불필요)
- 사용자 프로필에 Copilot 지침 `prompts/svnwt.instructions.md`가 설치되어 모든 작업 영역에서 이 워크플로를 따릅니다.

Git/SVN이 없으면 확장이 설치 안내를 띄웁니다. 다른 위치에 설치했다면 설정 `svnwt.gitPath`, `svnwt.svnPath`를 지정하세요.

## 사용 흐름

1. **scope 등록** — 활동 표시줄 *SVN Worktree* → *폴더를 scope로 등록* (탐색기 폴더 우클릭도 가능).
   큰 checkout 안에서 작업에 필요한 폴더만 고릅니다. 빌드가 `..\common` 같은 바깥 경로를 참조하면 *바깥 폴더 연결*을 고르세요(형제 폴더를 junction으로 연결).
   Copilot에게 "이 폴더를 svnwt scope로 등록해줘"라고 해도 됩니다.
2. **작업 요청** — Copilot Chat(Agent 모드)에서 평소처럼 요청합니다. Copilot이 `svnwt_task_create`로 작업을 만들고, worktree가 작업 영역에 자동으로 추가되며, 그 안에서만 수정·빌드·커밋합니다.
   처음 도구를 쓸 때 승인 창이 뜨면 *항상 허용*을 선택하면 편합니다.
3. **리뷰** — 트리에서 작업을 클릭하면 PR 형태의 리뷰 화면이 열립니다. 위쪽 상자에 작업 상태에 맞는 다음 단계 버튼이 있습니다.
   - *모든 변경 사항 보기*: 다중 파일 diff (SVN 기준 ↔ worktree)
   - *Copilot 리뷰 요청*: 에이전트가 diff를 검토해 verdict·코멘트를 남기고 이 화면에 표시
   - *테스트 화면*: 에이전트가 Playwright 등 UI 테스트를 worktree에서 돌린 뒤 `svnwt_task_attach_screenshots`로 첨부한 스크린샷·동영상과 통과/실패 (실행별로 보관)
   - SVN 커밋 메시지 편집 (자동 저장)
4. **로컬에 반영 (빌드까지)** — 로컬 IIS 처럼 SVN working copy 에서 도는 환경에서 확인하려면 리뷰 화면의 *로컬에 반영* 을 누릅니다.
   - 다른 로컬 변경은 잠시 빼 두고 SVN BASE 위에 이 작업만 올린 뒤 scope 의 빌드 명령을 실행합니다 (처음 반영할 때 한 번 묻고, scope 우클릭 *로컬 반영 빌드 명령 설정…* 으로 바꿈. scope 폴더에서 `cmd.exe` 로 실행).
   - 확인한 뒤 *커밋 준비* 를 누르면 changelist 만 붙입니다. TortoiseSVN 으로 바로 커밋해도 svnwt 가 감지해서 정리합니다. *되돌리기* 하면 빼 둔 변경이 그대로 돌아옵니다. 반영 중에 working copy 에서 고친 작업 파일은 보관본에 복사한 뒤 되돌립니다.
   - 한 번에 한 작업만 반영됩니다. 상태 표시줄 *#N 로컬 반영됨* 에서 커밋 준비 / 다시 빌드 / 되돌리기.
   - **에이전트 테스트**: 에이전트는 `svnwt_test_request` 로 반영을 요청하고, 요청은 차례로 처리됩니다. 반영 전에 *예 / 아니요 / 항상* 을 묻습니다 (설정 `svnwt.localApply.agentRequests`). 에이전트는 반영·빌드가 끝나면 로컬 사이트를 테스트하고 `svnwt_test_release` 로 돌려줍니다. DB 를 같이 쓰므로 데이터를 바꾸는 테스트는 요청에 표시하고 테스트 데이터만 씁니다.
5. **커밋 준비 (사람)** — 리뷰 화면의 *커밋 준비* 를 누른 뒤, scope 폴더에서 TortoiseSVN 커밋 창을 열어 OK 를 누릅니다.
   - scope 안의 다른 로컬 변경(다른 작업, 직접 고친 것, 기존 changelist)은 잠시 따로 보관하고 SVN BASE 로 되돌립니다. scope 밖은 건드리지 않습니다.
   - 깨끗한 BASE 위에 git 의 **이 작업만** 올립니다. 커밋 창에는 이 작업 파일만 작업 이름 changelist (`svnwt-<번호>-<제목>`) 로 묶여 체크돼 있습니다. 커밋 메시지는 클립보드에 있습니다.
   - 오래 걸리면 진행 알림의 *취소* 로 멈출 수 있습니다 (빼 둔 변경을 되돌림). 단계별 진행과 실행한 svn/git 명령은 출력 패널 *SVN Worktree* 에 남습니다.
   - 커밋이 감지되거나 *커밋 취소* 를 누르면, 보관했던 변경을 changelist 까지 그대로 되돌립니다. 커밋된 내용과 겹쳐 되돌릴 수 없는 파일은 보관본을 남기고 알려 줍니다.
   - 작업끼리 working copy 에서 부딪히지 않습니다. 막히는 경우는 SVN 에 새로 커밋된 내용과 같은 줄을 고쳤을 때뿐이며, 이때는 *rebase 후 커밋 준비* 로 이어집니다.
6. **커밋 후 정리** — 커밋이 끝나면 두 가지를 따로 할 수 있습니다.
   - *SVN 남은 변경 정리…* (리뷰 화면, scope 우클릭, 명령 팔레트): scope 폴더에 남은 SVN 변경(되돌려 놓은 다른 로컬 수정, 커밋에서 뺀 파일 등)을 골라 버립니다. worktree 와 git 커밋은 그대로입니다. 버리기 전에 파일을 svnwt 저장 폴더의 `discarded\` 에 복사해 둡니다. 버전 관리 안 되는 파일은 기본으로 선택되지 않고, 커밋 대기 중인 작업 파일은 목록에서 빠집니다.
   - *보관 (worktree 정리)*: worktree 폴더와 브랜치를 지우고 진행 중 목록에서 뺍니다. 커밋 기록(`refs/svnwt/archive/<작업>`)·리뷰·에이전트 대화·테스트 화면은 남아서 scope 아래 *보관된 작업* 에서 커밋별 diff 까지 볼 수 있습니다 (돋보기 버튼으로 제목 검색). 커밋하지 않은 worktree 변경은 커밋해서 같이 보관합니다. 완전히 지우려면 보관된 작업 우클릭 → *보관 기록 삭제*.

**일부만 고치거나 되돌리기** — 리뷰 화면에서 파일을 누르면 리뷰 화면이 있는 탭 그룹에 diff 가 전체 폭으로 열립니다 (양쪽 비교). 제목줄의 *이전/다음 변경 파일* 로 넘겨 보고 *리뷰 화면* 으로 돌아갑니다. *새 창으로 분리* 를 누르면 diff 전용 창에서 보고, 그 방식이 저장되어 다음에도 새 창에 열립니다 (*리뷰 화면 탭으로* 로 되돌림, 설정 `svnwt.diffPlacement`). 오른쪽은 worktree 의 실제 파일이라 바로 고칠 수 있고, 변경 블록 사이의 화살표(*Revert Block*)로 그 부분만 SVN 기준으로 되돌릴 수 있습니다. 특정 부분을 에이전트에게 묻거나 고치게 하려면 그 줄을 선택하고 우클릭 → *이 부분 질문/수정 지시…* (파일·줄 위치, 선택한 코드, 그 부분 diff 가 같이 전달됨). 저장한 변경은 *커밋 준비* 때 함께 올라갑니다 (git 커밋 여부를 물어봄).

**키보드로 리뷰** — 리뷰 화면: `↑` `↓` (또는 `j` `k`) 로 파일·커밋 행 이동, `Enter` 로 열기. diff: `Alt+→` / `Alt+←` 다음·이전 변경 (파일 끝에서 다음 파일로 이어짐), `Alt+Shift+→` / `Alt+Shift+←` 다음·이전 파일, `Esc` 리뷰 화면으로 (보던 행에 그대로), `Alt+Q` 선택한 부분 질문/수정 지시. diff 제목줄 버튼에 마우스를 올리면 툴팁에 키가 보입니다. 전체 목록은 리뷰 화면 제목줄의 키보드 버튼이나 명령 *SVN Worktree: 단축키 보기·바꾸기* 로 열고, 거기서 바로 바꿀 수 있습니다.

**규칙** — 작업 피드백 중 앞으로 항상 지킬 내용("앞으로 주석은 한국어로")은 Copilot 이 `svnwt_rule_add` 로 저장합니다. 피드백이 다른 작업에도 해당할 것 같으면 에이전트가 "규칙에 추가할까요?" 하고 묻고, 그렇다고 할 때만 저장합니다. 사이드바 *규칙* 에 목록과 추가 시각·작업 번호가 보이고, 추가/수정/삭제할 수 있습니다. 규칙은 사용자 지침 파일 `svnwt-rules.instructions.md` 로 모든 Copilot 채팅에 들어갑니다. Copilot 이 읽는 다른 지침 파일(`.github/copilot-instructions.md`, `AGENTS.md` 등)은 *규칙 → 다른 지침 파일* 에 나옵니다.

**SVN 이 바뀌면 svnwt 가 묻습니다** — 백그라운드에서 SVN 을 확인합니다 (working copy 는 1분마다와 VS Code 로 돌아올 때 `svn info` 한 번, 서버는 10분마다). TortoiseSVN 으로 update 하면 SVN 기준을 조용히 다시 읽고, 진행 중인 작업이 옛 기준이면 "새 기준으로 rebase 할까요?" 하고 묻습니다. 서버에 남이 커밋한 것이 있으면 svn update 할지 묻습니다. 같은 줄을 고쳐 충돌하면 rebase 하지 않고 알려 줍니다. 설정 `svnwt.svnWatch`, `svnwt.svnServerCheckMinutes`. 바로 확인하려면 명령 *SVN 지금 확인*.

**작업 이름 변경** — 트리에서 `F2`, 우클릭 *작업 이름 변경…*, 리뷰 화면 제목 옆 ✎. 브랜치와 worktree 폴더 이름은 그대로입니다.

에이전트는 SVN working copy 를 건드리지 않고, 끝난 작업을 "리뷰 대기"로 표시합니다.

**커밋 방법 설정** (`svnwt.commitTool`): `prepare`(기본, 커밋 준비만) · `tortoise`(TortoiseSVN 커밋 창을 직접 띄움) · `vscode`(확인 창에서 바로 커밋) · `ask`. 어느 방법이든 이 작업의 변경만 커밋됩니다. 리뷰 화면의 *다른 방법으로 커밋…*으로 그때그때 고를 수도 있습니다.

**Playwright** — 각 worktree에서 `npm ci` 후 실행합니다. 스크린샷이 남도록 config에 `use: { screenshot: 'on' }`을 두거나 테스트에서 `page.screenshot`을 쓰세요. `test-results/`, `playwright-report/`, `node_modules/`는 작업 커밋에서 자동으로 제외됩니다.

## 에이전트 (`@svnwt`, 작업별 세션)

작업 하나가 에이전트 세션 하나입니다. Claude Code 처럼 작업마다 대화·상태가 따로 관리되고, 여러 작업을 동시에 돌릴 수 있습니다.

- **채팅**: Copilot Chat 에서 `@svnwt 할 일` → 새 작업(worktree)을 만들고 그 안에서 진행합니다. 같은 대화에서 이어서 말하면 같은 작업이 이어집니다.
  `/new` 새 작업으로 시작 · `/continue <번호> <지시>` 기존 작업 이어가기 · `/tasks` 작업 목록
- **백그라운드**: SVN Worktree 트리의 ✨ *새 작업 (에이전트에게 맡기기)* → 할 일 입력. 트리에 *에이전트 실행 중 / 승인 대기* 가 표시되고, 끝나면 알림이 옵니다. 우클릭 *에이전트에게 지시… / 에이전트 중지*.
- **작업 화면**: 리뷰 화면의 *에이전트 세션* 에서 요청·답변·도구 실행 기록을 보고, 바로 추가 지시(Ctrl+Enter)하거나 *채팅에서 이어가기*.
- **안전장치**: 파일 도구는 작업 worktree 밖(SVN 원본, junction 으로 연결된 폴더, `.git`)에 접근할 수 없습니다. `svn commit/revert/update…` 같은 쓰기 명령은 막혀 있고, 명령 실행은 승인 후에만 됩니다 (`svnwt.agent.commandApproval`). SVN 커밋은 항상 사람이 합니다.
- **인코딩**: CP949·UTF-8(BOM)·CRLF 를 파일별로 보존합니다.
- **모델**: 채팅은 채팅 창에서 고른 모델, 백그라운드는 `svnwt.agent.model` (비우면 자동).
- **커스텀 에이전트**: Chat 의 에이전트 선택에서 *SVN Task* (작업 진행) / *SVN Review* (리뷰만) 를 쓸 수도 있습니다 (Copilot 기본 에이전트 + svnwt MCP 도구).
- **Chat 세션 목록 (실험)**: 명령 *SVN Worktree: Chat 세션 목록에 작업 표시 (실험)* → VS Code 재시작. VS Code 제안 API 를 쓰므로 버전에 따라 동작하지 않을 수 있습니다.

## Copilot이 쓰는 MCP 도구

| 도구 | 용도 |
|---|---|
| `svnwt_status` | 시작점. 경로 → scope/작업/편집 위치, Git·SVN 설치 점검 |
| `svnwt_scope_init` / `svnwt_scope_refresh` | scope 등록 / SVN 기준 다시 읽기 |
| `svnwt_task_create` / `svnwt_task_list` / `svnwt_task_info` | 작업 생성·조회 |
| `svnwt_task_commit` / `svnwt_task_diff` / `svnwt_task_sync` | 커밋, diff, 최신 SVN 기준으로 rebase |
| `svnwt_task_rename` | 작업 이름 변경 |
| `svnwt_task_review_get` / `svnwt_task_review_submit` | PR 형태 리뷰 |
| `svnwt_task_attach_screenshots` | UI 테스트 스크린샷·동영상을 리뷰 화면에 첨부 (Playwright 출력 자동 수집) |
| `svnwt_test_request` / `svnwt_test_wait` / `svnwt_test_release` / `svnwt_test_queue` | 작업을 로컬(SVN working copy)에 반영해 테스트 요청 (차례 대기, 사용자 확인) / 반영·빌드 결과 기다리기 / 테스트 끝내고 되돌리기 / 큐 보기 |
| `svnwt_task_changelist` / `svnwt_task_unland` | 리뷰 대기 표시 / changelist 되돌리기 |
| `svnwt_rule_add` / `svnwt_rule_list` | 앞으로 항상 지킬 규칙 저장 / 목록 |
| `svnwt_task_remove` / `svnwt_path_map` | 작업 보관 (worktree 삭제, 커밋 기록 유지) / SVN 경로 ↔ worktree 경로 변환 |

프롬프트: `/mcp.svnwt.start_task`, `/mcp.svnwt.review_task`, `/mcp.svnwt.finish_task`

명령줄에서도 쓸 수 있습니다: `%LOCALAPPDATA%\svnwt\server\svnwt.cmd cli task_list`

## Visual Studio 2026

Visual Studio 2022 17.14 이상 / 2026의 Copilot Agent 모드는 MCP를 지원하므로 같은 도구를 쓸 수 있습니다.

1. VS Code에서 명령 *SVN Worktree: Visual Studio용 MCP 설정 내보내기* 실행 → `%USERPROFILE%\.mcp.json`에 `svnwt` 서버가 등록됩니다.
2. 솔루션 폴더의 `.github\copilot-instructions.md`에 `%LOCALAPPDATA%\svnwt\server\copilot-instructions.md` 내용을 넣습니다.
3. Copilot Chat → Agent 모드 → 도구 목록에서 svnwt 확인.

제약: Visual Studio Copilot은 열려 있는 솔루션/폴더의 파일을 편집하므로, 작업 worktree 폴더를 *폴더 열기*로 열어야 그 안에서 편집합니다. 리뷰 화면·트리 뷰는 VS Code에만 있습니다. (Visual Studio 실기 동작은 아직 검증하지 않았습니다.)

## 동작 방식 / 주의

- git 저장소와 worktree는 SVN working copy **밖**(`<wc>.svnwt\`)에 만들어집니다. SVN 쪽에 `.git`이나 미버전 파일이 생기지 않습니다.
- `svn-base`는 SVN BASE(pristine) 상태입니다. working copy에서 로컬 수정된 파일은 `svn cat -r BASE` 내용으로 기록합니다.
- 바이트 그대로 보존: CRLF, CP949/UTF-8, `$Id$` 키워드 확장 상태가 SVN과 동일합니다 (`core.autocrlf=false`, `* -text`).
- `svn:ignore`, `svn:global-ignores`는 git exclude로 변환되어 빌드 산출물이 커밋되지 않습니다.
- changelist에는 디렉터리를 넣을 수 없어서, 새 폴더가 생긴 작업은 `--targets` 파일로 커밋 명령을 만듭니다.
- svn:needs-lock 파일은 먼저 `svn lock`이 필요합니다.
- *바깥 폴더 연결*로 만든 junction은 SVN 원본을 가리킵니다. Copilot 지침에서 그 경로는 편집하지 말라고 안내합니다.

## 개발

```
scripts\build-vsix.cmd             # dist\svn-worktree-<ver>.vsix
test\e2e.js                        # 실제 svnadmin 로컬 저장소로 전체 흐름 검증
scripts\make-demo.cmd              # 데모 SVN 저장소 + scope + 예제 작업
scripts\run-scenario.cmd           # 에이전트 3개 동시 작업 시나리오 (MCP)
scripts\run-ui-test.cmd            # 격리 VS Code 를 CDP 로 조작하는 UI 테스트 → docs\ui-test\report.html
test\agent.js                      # 에이전트 루프 (가짜 모델, 실제 SVN 저장소)
test\upgrade.js [ref]               # 이전 버전(git ref)이 만든 데이터를 현재 코드가 이어받는지
test\ui\upgrade-ext.js old.vsix new.vsix  # 설치본 위에 새 vsix 를 덮어 설치하는 업그레이드
```

구성: `src/core`(SVN·git 로직), `src/mcp`(의존성 없는 stdio MCP 서버), `src/agent`(에이전트 루프·도구·채팅 참가자), `src/ext`(VS Code 확장).
