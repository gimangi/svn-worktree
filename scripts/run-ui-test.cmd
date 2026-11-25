@echo off
rem UI test of the VS Code extension in an isolated VS Code instance (CDP) -> docs\ui-test\report.html
setlocal
set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not exist "%CODE_EXE%" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
call "%~dp0build-vsix.cmd" || exit /b 1
set ELECTRON_RUN_AS_NODE=1
"%CODE_EXE%" "%~dp0..\test\ui\run.js" %*
