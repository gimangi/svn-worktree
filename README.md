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
3. 확장 설치: `code --install-extension svn-worktree-0.3.1.vsix`
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
4. **changelist 만들기** — 작업 변경을 SVN working copy에 3-way로 반영하고 `svnwt-<id>` changelist로 묶습니다.
   다른 사람이 SVN에 커밋한 내용이나 working copy의 다른 로컬 수정은 유지됩니다.
5. **SVN 커밋 (사람)** — 리뷰 화면의 *커밋 준비* → 평소처럼 TortoiseSVN 커밋 창을 열어 커밋합니다.
   커밋 준비를 하면 TortoiseSVN 커밋 창에 **이 작업의 파일만 체크된 상태**로 나오고, 커밋 메시지는 클립보드에 복사돼 있습니다. 파일을 고를 필요 없이 확인하고 OK만 누르면 됩니다.
   커밋이 감지되면 자동으로 원래 상태로 정리되고 작업이 *커밋 완료*로 바뀝니다. 커밋을 그만두려면 *커밋 취소 (되돌리기)*.

SVN이 갱신되면 *최신 SVN 기준으로 rebase*로 작업을 최신 상태에 맞춥니다.

**커밋 준비가 하는 일** (커밋이 끝나거나 취소하면 모두 원래대로 돌아옵니다)
- 이 작업 파일은 changelist 밖으로 → TortoiseSVN 기본 체크
- 다른 작업·사용자의 변경 파일은 TortoiseSVN 예약 changelist `ignore-on-commit`으로 → 기본 체크 해제
- 다른 작업이 새로 만든 폴더는 잠시 추가 예약 해제 → non-versioned로 보여 체크 해제
- 이 작업 파일에 다른 변경(다른 작업, 사용자 직접 수정)이 섞여 있으면 잠시 "SVN BASE + 이 작업 변경"으로 바꿔 둠

**여러 작업이 같은 파일을 고친 경우** — 줄이 겹치지 않으면 두 작업 모두 changelist를 만들 수 있습니다(나중 작업에서는 "공유 파일"로 표시). 커밋은 작업마다 따로 하며, 각 리비전에는 그 작업의 변경만 들어갑니다. 같은 줄을 고쳤다면 먼저 커밋한 뒤 나머지 작업을 *최신 SVN 기준으로 rebase* 합니다.

**커밋 방법 설정** (`svnwt.commitTool`): `prepare`(기본, 커밋 준비만) · `tortoise`(TortoiseSVN 커밋 창을 직접 띄움) · `vscode`(확인 창에서 바로 커밋) · `ask`. 어느 방법이든 이 작업의 변경만 커밋됩니다. 리뷰 화면의 *다른 방법으로 커밋…*으로 그때그때 고를 수도 있습니다.

**Playwright** — 각 worktree에서 `npm ci` 후 실행합니다. 스크린샷이 남도록 config에 `use: { screenshot: 'on' }`을 두거나 테스트에서 `page.screenshot`을 쓰세요. `test-results/`, `playwright-report/`, `node_modules/`는 작업 커밋에서 자동으로 제외됩니다.

## Copilot이 쓰는 MCP 도구

| 도구 | 용도 |
|---|---|
| `svnwt_status` | 시작점. 경로 → scope/작업/편집 위치, Git·SVN 설치 점검 |
| `svnwt_scope_init` / `svnwt_scope_refresh` | scope 등록 / SVN 기준 다시 읽기 |
| `svnwt_task_create` / `svnwt_task_list` / `svnwt_task_info` | 작업 생성·조회 |
| `svnwt_task_commit` / `svnwt_task_diff` / `svnwt_task_sync` | 커밋, diff, 최신 SVN 기준으로 rebase |
| `svnwt_task_review_get` / `svnwt_task_review_submit` | PR 형태 리뷰 |
| `svnwt_task_attach_screenshots` | UI 테스트 스크린샷·동영상을 리뷰 화면에 첨부 (Playwright 출력 자동 수집) |
| `svnwt_task_changelist` / `svnwt_task_unland` | SVN changelist 만들기 / 되돌리기 |
| `svnwt_task_remove` / `svnwt_path_map` | 작업 정리 / SVN 경로 ↔ worktree 경로 변환 |

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
```

구성: `src/core`(SVN·git 로직), `src/mcp`(의존성 없는 stdio MCP 서버), `src/ext`(VS Code 확장).
