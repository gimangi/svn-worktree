@echo off
rem Live multi-task scenario on the demo environment. Run scripts\make-demo.cmd first.
setlocal
set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not exist "%CODE_EXE%" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
set ELECTRON_RUN_AS_NODE=1
"%CODE_EXE%" "%~dp0..\test\scenario.js" %*
