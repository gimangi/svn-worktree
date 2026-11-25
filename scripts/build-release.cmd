@echo off
rem Builds dist\svnwt-<version>-release.zip (vsix + install guide + source + test report + checksums).
setlocal
set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not exist "%CODE_EXE%" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
set ELECTRON_RUN_AS_NODE=1
"%CODE_EXE%" "%~dp0build-release.js"
