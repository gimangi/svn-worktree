'use strict';
const path = require('path');

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const TASK = str('Task id (e.g. "7-fix-login" or just the number "7"), changelist name, or any path inside the task worktree.');

/**
 * Tool table. handler(service, args, ctx) => result object (serialized as JSON text).
 */
const TOOLS = [
  {
    name: 'svnwt_status',
    description: 'START HERE before any code change in an SVN working copy. Checks git/svn installation, and maps a path to its svnwt scope and tasks (where to edit). Without path it lists all scopes and active tasks.',
    inputSchema: { type: 'object', properties: { path: str('File or folder the user is talking about (SVN working copy path or task worktree path). Defaults to the workspace folders.') } },
    async handler(svc, a, ctx) {
      const envInfo = await svc.environment();
      if (!envInfo.ok) return { ok: false, problems: envInfo.problems };
      const paths = a.path ? [a.path] : ctx.workspaceFolders;
      const locations = paths.map((p) => ({ path: p, ...svc.mapPath(p) }));
      const scopes = svc.listScopes().map((s) => ({ id: s.id, svnPath: s.svnPath, revision: s.revision, url: s.url, lastSnapshot: s.lastSnapshot || null }));
      const tasks = svc.listTasks().map((t) => ({ id: t.id, scope: t.scopeId, title: t.title, status: t.status, workPath: t.workPath, changelist: t.changelist }));
      const locks = svc.locks().map((l) => ({ scope: l.scope, lock: l.name, op: l.op, pid: l.pid, runningSec: Math.round(l.since / 1000), holderAlive: l.alive, stale: l.stale }));
      return {
        ok: true, git: envInfo.git.version, svn: envInfo.svn.version, locations, scopes, tasks, locks,
        hint: scopes.length === 0
          ? 'No scope yet: ask the user which SVN folder to manage, then call svnwt_scope_init.'
          : 'Create a task with svnwt_task_create (or reuse an active one) and edit only inside its workPath.',
      };
    },
  },
  {
    name: 'svnwt_scope_init',
    description: 'Register a folder inside an SVN working copy as an svnwt scope (creates a git mirror of its pristine SVN state). Use the smallest folder that contains the code (and build files) for the work. Idempotent.',
    inputSchema: {
      type: 'object', required: ['path'], properties: {
        path: str('Absolute path of the SVN working copy folder to manage.'),
        name: str('Optional short scope name.'),
        linkOutside: bool('Mirror the working copy layout and link (junction) sibling folders outside the scope into each worktree, so relative references like ../common keep building. Default false.'),
      },
    },
    handler: (svc, a) => svc.initScope(a.path, { name: a.name, linkOutside: a.linkOutside }),
  },
  {
    name: 'svnwt_scope_refresh',
    description: 'Re-snapshot the SVN pristine state of a scope into the git base branch (after the user ran svn update / committed). svnUpdate=true runs "svn update" first — only when the user asked for it.',
    inputSchema: { type: 'object', properties: { scope: str('Scope id or path.'), svnUpdate: bool('Run svn update before snapshot. Only with user consent.') } },
    handler: (svc, a) => svc.refreshScope(a.scope, { svnUpdate: !!a.svnUpdate }),
  },
  {
    name: 'svnwt_task_create',
    description: 'Create an isolated task: a git branch + worktree from the latest SVN base. Returns workPath — do ALL edits, builds and tests there, never in the SVN working copy.',
    inputSchema: {
      type: 'object', required: ['title'], properties: {
        scope: str('Scope id or any path inside the scope. Optional when only one scope exists.'),
        title: str('Short task title (becomes branch/changelist name).'),
        description: str('What the task should achieve (used for review and the SVN commit message).'),
      },
    },
    async handler(svc, a) {
      const t = await svc.createTask(a.scope, { title: a.title, description: a.description });
      return { ...t, next: `Edit files only under ${t.workPath}. Commit with svnwt_task_commit. When done: svnwt_task_review_get -> svnwt_task_changelist.` };
    },
  },
  {
    name: 'svnwt_task_list',
    description: 'List svnwt tasks (active, landed = changelist waiting for SVN commit, committed).',
    inputSchema: { type: 'object', properties: { scope: str('Optional scope id or path.'), includeArchived: bool('Include removed tasks.') } },
    handler: (svc, a) => svc.listTasks({ scope: a.scope, includeArchived: !!a.includeArchived })
      .map((t) => ({ id: t.id, scope: t.scopeId, title: t.title, status: t.status, workPath: t.workPath, changelist: t.changelist, createdAt: t.createdAt })),
  },
  {
    name: 'svnwt_task_info',
    description: 'Detailed task state: commits, changed files with line stats, uncommitted files, whether the SVN base moved, reviews, and the SVN commit command when landed.',
    inputSchema: { type: 'object', required: ['task'], properties: { task: TASK } },
    handler: (svc, a) => svc.taskInfo(a.task),
  },
  {
    name: 'svnwt_task_commit',
    description: 'Stage all changes in the task worktree (git add -A) and commit them on the task branch.',
    inputSchema: { type: 'object', required: ['task', 'message'], properties: { task: TASK, message: str('Commit message (first line = summary).') } },
    handler: (svc, a) => svc.commitTask(a.task, a.message),
  },
  {
    name: 'svnwt_task_diff',
    description: 'Unified diff of the task against its SVN base (what will become the SVN changelist).',
    inputSchema: {
      type: 'object', required: ['task'], properties: {
        task: TASK, file: str('Limit to one file (path relative to the scope).'), stat: bool('Only diffstat.'),
        uncommitted: bool('Diff the worktree (including uncommitted edits) instead of the committed branch.'),
        maxChars: { type: 'number', description: 'Truncate output (default 60000).' },
      },
    },
    handler: (svc, a) => svc.diffTask(a.task, { file: a.file, stat: !!a.stat, uncommitted: !!a.uncommitted, maxChars: a.maxChars || 60000 }),
  },
  {
    name: 'svnwt_task_sync',
    description: 'Bring the task up to date with the latest SVN state: snapshot SVN, then rebase (default) or merge the task branch. On conflicts fix files in the worktree and call again with cont=true (or abort=true).',
    inputSchema: {
      type: 'object', required: ['task'], properties: {
        task: TASK, strategy: { type: 'string', enum: ['rebase', 'merge'] },
        svnUpdate: bool('Run svn update before snapshot (only with user consent).'),
        cont: bool('Continue after resolving conflicts.'), abort: bool('Abort an in-progress sync.'),
      },
    },
    handler: (svc, a) => svc.syncTask(a.task, { strategy: a.strategy || 'rebase', svnUpdate: !!a.svnUpdate, cont: !!a.cont, abort: !!a.abort }),
  },
  {
    name: 'svnwt_task_changelist',
    description: 'Finish a task: 3-way apply its committed changes onto the SVN working copy and group the files into SVN changelist "svnwt-<id>" (svn add/delete/move included). The SVN working copy holds ONE task changelist at a time: if another task is in it, nothing is applied and the task is marked ready for review (ready=true) — the human switches it from the SVN Worktree panel. Does NOT commit. Run again after more commits to update the changelist.',
    inputSchema: {
      type: 'object', required: ['task'], properties: {
        task: TASK, dryRun: bool('Only report what would happen.'), autoCommit: bool('Commit uncommitted worktree changes first.'),
        force: bool('Skip conflicting files instead of stopping.'),
      },
    },
    handler: (svc, a) => svc.requestChangelist(a.task, { dryRun: !!a.dryRun, autoCommit: !!a.autoCommit, force: !!a.force }),
  },
  {
    name: 'svnwt_task_unland',
    description: 'Take a landed task back out of the SVN working copy (reverse of svnwt_task_changelist). Other local edits are kept. Only on user request.',
    inputSchema: { type: 'object', required: ['task'], properties: { task: TASK } },
    handler: (svc, a) => svc.unlandTask(a.task),
  },
  {
    name: 'svnwt_task_review_get',
    description: 'Get everything needed to review a task like a pull request: task goal, commits, file list and full diff. Review for correctness, side effects on other code, missing changes, and coding style; then call svnwt_task_review_submit.',
    inputSchema: { type: 'object', required: ['task'], properties: { task: TASK, maxChars: { type: 'number', description: 'Diff truncation (default 80000).' } } },
    async handler(svc, a) {
      const info = await svc.taskInfo(a.task, { checkSvn: false });
      const d = await svc.diffTask(a.task, { maxChars: a.maxChars || 80000 });
      return {
        task: { id: info.task.id, title: info.task.title, description: info.task.description, workPath: info.task.workPath, status: info.task.status },
        svnBase: info.scope, baseIsLatest: info.baseIsLatest, commits: info.commits, files: info.files,
        uncommitted: info.worktree.dirty, previousReviews: svc.listReviews(a.task),
        testRuns: svc.listArtifacts(a.task).map((r) => ({ id: r.id, at: r.at, title: r.title, status: r.status, failedTests: r.failedTests, staleCommit: r.commit !== info.tip, files: r.items.map((x) => ({ caption: x.caption, path: x.file })) })),
        diff: d.diff, truncated: d.truncated,
        checklist: [
          'Does the change do what the task description asks, completely?',
          'Bugs: null/edge cases, error handling, resource leaks, concurrency.',
          'Impact on callers / other modules in the SVN tree (search outside the diff if needed).',
          'Build/test: are project files, headers, resources updated together?',
          'Encoding/line endings preserved (CP949/UTF-8, CRLF) and no unrelated reformatting.',
          'No debug code, secrets, or generated files.',
          'UI changes: are there test screenshots (testRuns) for the current commit? Open the image files to check the screens if needed.',
        ],
      };
    },
  },
  {
    name: 'svnwt_task_review_submit',
    description: 'Record a review result for a task (shown in the SVN Worktree review panel).',
    inputSchema: {
      type: 'object', required: ['task', 'verdict', 'summary'], properties: {
        task: TASK,
        verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
        summary: str('Overall review summary (markdown).'),
        comments: {
          type: 'array', items: {
            type: 'object', required: ['file', 'body'], properties: {
              file: str('Path relative to scope.'), line: { type: 'number' },
              severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'info'] }, body: str('Comment (markdown).'),
            },
          },
        },
      },
    },
    handler: (svc, a) => svc.submitReview(a.task, { verdict: a.verdict, summary: a.summary, comments: a.comments || [], reviewer: 'copilot' }),
  },
  {
    name: 'svnwt_task_attach_screenshots',
    description: 'After running UI/E2E tests (e.g. Playwright `npx playwright test` in the task worktree), attach the screenshots/videos to the task so the human sees them in the review panel. Without paths it collects test-results/ (and playwright-report/) in the worktree and reads the pass/fail status. Call it after every meaningful test run.',
    inputSchema: {
      type: 'object', required: ['task'], properties: {
        task: TASK,
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional image/video files or folders (absolute or relative to workPath).' },
        dir: str('Optional output folder to scan instead of auto-detection (e.g. "web/test-results").'),
        title: str('Short label for this run, e.g. "Playwright: login flow".'),
        status: { type: 'string', enum: ['passed', 'failed'], description: 'Override the detected status.' },
        summary: str('What was tested / result notes (markdown).'),
      },
    },
    handler: (svc, a) => svc.attachArtifacts(a.task, { paths: a.paths, dir: a.dir, title: a.title, status: a.status, summary: a.summary }),
  },
  {
    name: 'svnwt_task_remove',
    description: 'Delete a task worktree (and branch) after its changelist was committed or when the user abandons it.',
    inputSchema: { type: 'object', required: ['task'], properties: { task: TASK, force: bool('Remove even if the changelist is not committed yet.'), keepBranch: bool('Keep the git branch.') } },
    handler: (svc, a) => svc.removeTask(a.task, { force: !!a.force, keepBranch: !!a.keepBranch }),
  },
  {
    name: 'svnwt_path_map',
    description: 'Translate a path between the SVN working copy and task worktrees (e.g. user mentions D:\\svn\\proj\\src\\a.cpp -> edit <workPath>\\src\\a.cpp).',
    inputSchema: { type: 'object', required: ['path'], properties: { path: str('Absolute path.'), task: str('Optional task id to narrow results.') } },
    handler: (svc, a) => svc.mapPath(path.resolve(a.path), a.task),
  },
];

const PROMPTS = [
  {
    name: 'start_task',
    description: 'Start an isolated svnwt task for a change request',
    arguments: [{ name: 'request', description: 'What to change', required: true }],
    text: (a) => `Use the svnwt tools for this change request. First call svnwt_status for the relevant path, create (or reuse) a task with svnwt_task_create, then implement the change ONLY inside the task workPath, build/test there, and commit with svnwt_task_commit. Finally review it and produce the SVN changelist with svnwt_task_changelist.\n\nRequest: ${a.request || ''}`,
  },
  {
    name: 'review_task',
    description: 'Review an svnwt task like a pull request',
    arguments: [{ name: 'task', description: 'Task id', required: true }],
    text: (a) => `Review svnwt task "${a.task}" like a GitHub pull request. Call svnwt_task_review_get, read surrounding code in the worktree when needed, then call svnwt_task_review_submit with a verdict, a summary and file/line comments. Do not modify files during the review.`,
  },
  {
    name: 'finish_task',
    description: 'Finish an svnwt task and prepare the SVN changelist',
    arguments: [{ name: 'task', description: 'Task id', required: true }],
    text: (a) => `Finish svnwt task "${a.task}": make sure everything is committed (svnwt_task_commit), sync with the latest SVN base if it moved (svnwt_task_sync), run svnwt_task_changelist with dryRun=true, then without dryRun. Report the changelist name and the svn commit command to the user. Do not run svn commit.`,
  },
];

module.exports = { TOOLS, PROMPTS };
