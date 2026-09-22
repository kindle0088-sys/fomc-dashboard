@echo off
REM FOMC 看板 · 每日采集启动器（计划任务入口）
REM 注意：不要硬编码 node 版本路径，用 versions\current 或目录扫描。

setlocal
set "ROOT=C:\Users\jiali\WorkBuddy\Claw\fomc-dashboard"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM 注入内置 git 到 PATH（计划任务环境下 PATH 常无 git）
set "GITBIN=C:\Users\jiali\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd"
if exist "%GITBIN%\git.exe" set "PATH=%GITBIN%;%PATH%"

REM 定位 node：优先当前版本目录，其次扫描 versions 下任意可用版本
set "NODE_EXE="
if exist "C:\Users\jiali\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=C:\Users\jiali\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE (
  for /d %%D in ("C:\Users\jiali\.workbuddy\binaries\node\versions\*") do (
    if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
  )
)

if not defined NODE_EXE (
  echo [%DATE% %TIME%] FATAL: node.exe not found >> "%LOGDIR%\daily.log"
  exit /b 1
)

echo [%DATE% %TIME%] node=%NODE_EXE% >> "%LOGDIR%\daily.log"
"%NODE_EXE%" "%ROOT%\scripts\daily.mjs" >> "%LOGDIR%\daily.log" 2>&1
exit /b %ERRORLEVEL%
