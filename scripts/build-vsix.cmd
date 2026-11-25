@echo off
rem Builds dist\svn-worktree-<version>.vsix using the Node runtime bundled with VS Code (no npm needed).
setlocal
set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not exist "%CODE_EXE%" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0build-vsix.js"
) else (
  set ELECTRON_RUN_AS_NODE=1
  "%CODE_EXE%" "%~dp0build-vsix.js"
)
