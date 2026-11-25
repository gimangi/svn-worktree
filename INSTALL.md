# SVN Worktree (svnwt) 설치 가이드

## 요구 사항

| 항목 | 버전 / 조건 |
|---|---|
| OS | Windows 10/11 |
| VS Code | 1.101 이상 (1.139.1 기준으로 작성) |
| GitHub Copilot Chat | Agent 모드 사용 가능, **MCP 서버 사용 허용** (조직 정책 `chat.mcp.access` 가 `none` 이면 Copilot 이 svnwt 도구를 쓰지 못합니다. 트리·리뷰·커밋 준비는 그래도 동작) |
| Git for Windows | 2.30 이상 (`git --version`) |
| SVN 명령줄 클라이언트 | TortoiseSVN 설치 시 *command line client tools* 포함 (`svn --version`) |
| Node.js | 필요 없음 (VS Code 내장 런타임 사용) |

Git / SVN 이 PATH 나 기본 위치에 없으면 설정 `svnwt.gitPath`, `svnwt.svnPath` 에 exe 경로를 지정합니다.

## 설치

```powershell
code --install-extension svn-worktree-0.4.4.vsix
```

또는 VS Code 확장 보기 → `...` → *VSIX에서 설치…* → `svn-worktree-0.4.4.vsix`. 설치 후 VS Code 를 재시작합니다.

> **주의**: `.vsix` 파일을 더블클릭하면 Visual Studio 의 *VSIX Installer* 가 열립니다 ("올바른 VSIX 패키지가 아닙니다" 등). 이 확장은 VS Code 용이므로 위 두 방법 중 하나로 **VS Code 에서** 설치하세요.
의존 패키지가 없어 오프라인 환경에서도 그대로 설치됩니다.

## 설치 확인

1. 활동 표시줄에 **SVN Worktree** 아이콘이 보입니다.
2. 명령 팔레트 → `SVN Worktree: 환경 점검 (Git / SVN)` → Git / svn 버전이 표시되면 정상.
3. Copilot Chat(Agent 모드) → 도구(🔧) 목록에 **SVN Worktree** MCP 서버가 있습니다.

## SVN 커밋

기본값(`svnwt.commitTool` = `prepare`)은 "커밋 준비"만 합니다.
작업 리뷰 화면 → **커밋 준비** → TortoiseSVN 커밋 창을 직접 열면 그 작업의 파일만 체크돼 있고, 커밋 메시지는 클립보드에 있습니다.
커밋이 끝나면 자동으로 원상 복구되고, 커밋을 그만두면 **커밋 취소 (되돌리기)** 를 누릅니다.

## 만드는 파일 / 폴더

| 위치 | 내용 |
|---|---|
| `<SVN working copy>.svnwt\<scope>\` (working copy 옆) | git 저장소(`repo.git`), 작업별 worktree(`wt\`), 작업 기록 |
| `%LOCALAPPDATA%\svnwt\` | scope 목록, MCP 서버 사본(Visual Studio 연동용) |
| `%APPDATA%\Code\User\prompts\svnwt.instructions.md`, `svnwt-task.agent.md`, `svnwt-review.agent.md` | Copilot 지침과 커스텀 에이전트 (설정 `svnwt.installCopilotInstructions` 로 끌 수 있음) |

SVN working copy 안에는 아무것도 만들지 않습니다 (`.git` 없음).

## 보안 참고

- 확장은 네트워크 통신을 하지 않습니다. Git / SVN 이 없을 때 안내 버튼을 누르면 설치 페이지를 브라우저로 여는 것이 전부입니다.
- `svn commit` 은 사람이 커밋할 때만 실행됩니다 (Copilot 도구·@svnwt 에이전트에는 SVN 커밋 기능이 없고, svn 쓰기 명령은 차단).
- @svnwt 에이전트는 VS Code 의 Copilot 언어 모델 API(`vscode.lm`)만 사용합니다. 별도 서버·키가 필요 없습니다.
- 소스: `svnwt-0.4.4-source.zip` (JavaScript, 빌드 단계·외부 패키지 없음). 체크섬: `SHA256SUMS.txt`.

## 문제 해결

- **"잠금 대기 시간 초과"**: 같은 scope 에서 오래 걸리는 작업(SVN 기준 읽기, changelist 반영)이 진행 중이라는 뜻입니다. 메시지에 진행 중인 작업과 경과 시간이 나옵니다.
  진행 중인 작업이 없는데 계속되면 명령 *SVN Worktree: 잠금 상태 확인/해제* 로 남은 잠금을 해제하세요 (VS Code 가 비정상 종료돼 남은 잠금은 0.3.3 부터 자동으로 풀립니다).
- **느린 SVN 기준 읽기**: *잠금 상태 확인/해제* 에 마지막 기준 읽기의 단계별 시간(svn status, 파일 해시)이 표시됩니다. scope 를 작업에 필요한 폴더로 좁히면 빨라집니다.

## 제거

1. 확장 보기에서 *SVN Worktree (svnwt)* 제거
2. 필요하면 위 표의 폴더/파일 삭제 (작업 worktree 와 기록이 지워집니다)

## Visual Studio 2026 (선택)

VS Code 명령 `SVN Worktree: Visual Studio용 MCP 설정 내보내기` → `%USERPROFILE%\.mcp.json` 에 등록됩니다. 실기 검증은 하지 않았습니다.
