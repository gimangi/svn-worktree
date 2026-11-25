# 변경 이력

## 0.3.1
- 커밋 방식 설정값 `external` → `prepare` 로 이름 변경, 안내 문구 정리

## 0.3.0
- 같은 파일을 여러 작업이 고쳐도 함께 changelist 로 반영 ("공유 파일"), 커밋은 작업별로 분리
- **커밋 준비** (기본값): TortoiseSVN 커밋 창을 직접 열면 해당 작업 파일만 체크돼 있도록 정리하고, 커밋이 감지되면 자동 복구
- 작업 파일에 섞인 다른 변경(다른 작업, 사용자 직접 수정)은 커밋에서 자동 제외
- TortoiseSVN 직접 실행 / VS Code 에서 바로 커밋 방식 선택 가능 (`svnwt.commitTool`)
- 리뷰 탭 재사용 (미리보기 탭), "리뷰를 새 탭으로 열기"
- 커밋 도중 비정상 종료 시 다음 실행 때 복구

## 0.2.0
- Playwright 등 UI 테스트 스크린샷을 작업 리뷰 화면에 표시 (`svnwt_task_attach_screenshots`)
- 리뷰 화면을 상태별 "다음 단계" 구성으로 정리, 커밋 메시지 자동 저장
- 트리·메뉴 정리 (우클릭 13 → 8개, 내부 명령 숨김), changelist 충돌 안내 개선
- test-results / playwright-report / node_modules 는 작업 커밋에서 자동 제외

## 0.1.x
- SVN 하위 폴더를 git 으로 관리 (scope), 작업별 git worktree
- 작업 → SVN changelist 3-way 반영 (svn add / delete / move), 되돌리기
- PR 형태 리뷰 화면, 다중 diff, Copilot 리뷰 기록
- Copilot 용 MCP 서버 (VS Code 자동 등록), Copilot 지침 자동 설치
- 대소문자만 다른 이름 변경, 한글 경로·CP949·CRLF 보존
