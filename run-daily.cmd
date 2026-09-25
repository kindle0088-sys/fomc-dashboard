@echo off
REM ============================================================
REM  FOMC Dashboard - daily collect launcher (scheduled task entry)
REM
REM  Keep this file ASCII-only + CRLF. cmd.exe parses .cmd with the
REM  system codepage (GBK); UTF-8 Chinese comments turn into bogus
REM  commands, and LF-only line endings break parsing entirely.
REM
REM  Two separate logs on purpose:
REM    launcher.log <- this script (process-level: started / rc / fatal)
REM    daily.log    <- daily.mjs writes it itself (job-level detail)
REM  Writing both to one file causes EBUSY (cmd holds it via >>).
REM ============================================================

setlocal enabledelayedexpansion
set "ROOT=C:\Users\jiali\WorkBuddy\Claw\fomc-dashboard"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LLOG=%LOGDIR%\launcher.log"

REM --- log immediately: tells "ran but died early" apart from "never started" ---
echo [%DATE% %TIME%] launcher start >> "%LLOG%"

REM --- inject bundled git into PATH (scheduled env often lacks git) ---
set "GITBIN=C:\Users\jiali\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd"
if exist "%GITBIN%\git.exe" set "PATH=%GITBIN%;%PATH%"

REM --- resolve node ---
REM versions\current is a POINTER FILE holding the version string, NOT a dir
set "NODE_EXE="
set "NODEBASE=C:\Users\jiali\.workbuddy\binaries\node\versions"

if exist "%NODEBASE%\current" (
  set /p VER=<"%NODEBASE%\current"
  if exist "%NODEBASE%\!VER!\node.exe" set "NODE_EXE=%NODEBASE%\!VER!\node.exe"
)

if not defined NODE_EXE (
  for /d %%D in ("%NODEBASE%\*") do (
    if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
  )
)

if not defined NODE_EXE (
  echo [%DATE% %TIME%] FATAL: node.exe not found under %NODEBASE% >> "%LLOG%"
  exit /b 1
)

echo [%DATE% %TIME%] node=%NODE_EXE% >> "%LLOG%"
REM do NOT redirect node stdout here - daily.mjs owns daily.log (EBUSY if shared)
"%NODE_EXE%" "%ROOT%\scripts\daily.mjs"
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] launcher end rc=%RC% >> "%LLOG%"
exit /b %RC%
