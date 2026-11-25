@echo off
rem Creates a demo SVN repository + working copy + svnwt scope + sample task.
rem   make-demo.cmd [targetDir]   (default: %USERPROFILE%\Desktop\svnwt-demo)
setlocal
set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not exist "%CODE_EXE%" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
set ELECTRON_RUN_AS_NODE=1
"%CODE_EXE%" "%~dp0make-demo.js" %*
