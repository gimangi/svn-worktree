'use strict';

/** Shared agent guidance: MCP server `instructions`, Copilot instruction files, VS copilot-instructions. */
const AGENT_INSTRUCTIONS = `# SVN Worktree (svnwt) workflow — mandatory for code changes in SVN working copies

The user's code lives in a Subversion (SVN) working copy that several tasks share. To avoid tasks
overwriting each other, every change is done in an isolated git worktree managed by the svnwt tools,
the same way an agent works on a git branch/worktree and opens a pull request.

## Rules
1. Before reading/editing code for a change request, call \`svnwt_status\` with the file or folder path
   you are about to work on (or the workspace folder). It tells you the scope, existing tasks and where to edit.
2. If no scope covers the path, ask the user which SVN sub-folder should be managed (or propose the
   closest project folder) and call \`svnwt_scope_init\`. Keep scopes as small as the work allows.
3. One task per independent request. Call \`svnwt_task_create\` (short English or Korean title) unless the user
   is clearly continuing an existing active task — then reuse it. Never mix unrelated changes in one task.
4. Edit files ONLY inside the task's \`workPath\` (the git worktree). NEVER edit files inside the SVN
   working copy directly, and never edit files reached through linked (junction) folders outside workPath.
   Use \`svnwt_path_map\` to translate a path the user mentions (SVN path) into the worktree path.
   Run builds/tests with the worktree as the working directory.
5. Commit logical steps with \`svnwt_task_commit\` (or git in the worktree). Uncommitted work is not landed.
   Renames that only change letter case (a.cpp -> A.cpp) must be done with \`git mv\` in the worktree
   (Windows file names are case-insensitive, a plain rename is not detected).
6. If the project has UI/E2E tests (Playwright etc.), run them inside the worktree (install dependencies there
   first, e.g. \`npm ci\`; enable screenshots with \`use: { screenshot: 'on' }\` or page.screenshot in tests),
   then call \`svnwt_task_attach_screenshots\` so the screens appear in the review panel. Test outputs
   (test-results/, playwright-report/, node_modules/) are excluded from commits automatically.
7. When the work is done: review it (\`svnwt_task_review_get\`, then \`svnwt_task_review_submit\`), then call
   \`svnwt_task_changelist\`. It marks the task ready for review and does not touch the SVN working copy:
   at commit time the human presses "커밋 준비", which puts only this task on the working copy. Tell the user
   the task is ready for review.
8. NEVER run \`svn commit\`, \`svn revert\`, \`svn update\` or \`svn switch\` yourself. The human reviews the change
   in the "SVN Worktree" view (PR-like review) and commits there ("커밋 준비" / "SVN 커밋…"), which makes
   sure only this task's changes are committed. Tell the user the task is ready and where to commit it.
9. If the SVN base moved (other commits), call \`svnwt_task_sync\` to rebase the task on the latest SVN state;
   resolve conflicts inside the worktree, then \`svnwt_task_sync\` with cont=true.
10. Report results to the user in the user's language (Korean if they write Korean).
11. Follow the user's lasting rules (\`rules\` in the \`svnwt_status\` result). When the user gives feedback meant for
   every future task ("앞으로 항상 …", "매번 …", "이런 건 하지 마"), save it with \`svnwt_rule_add\` (one short
   sentence) and say so. When feedback on the current task looks like a general preference that will come up again
   (style, naming, how to test, review habits), apply it, then ask once: "이 내용을 규칙에 추가할까요? — <one
   sentence>". Call \`svnwt_rule_add\` only after the user says yes; do not ask about fixes that only concern this
   task, and do not ask again about something they declined. Do not write instruction files (.github/*.md,
   AGENTS.md, *.instructions.md) inside a worktree for this: they would be committed to SVN with the task.
`;

module.exports = { AGENT_INSTRUCTIONS };
