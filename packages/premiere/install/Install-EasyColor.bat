@echo off
REM Double-clickable wrapper for the PowerShell installer.
REM
REM PowerShell refuses to run unsigned .ps1 files under the default
REM execution policy, which stops most people at the first step. Bypassing
REM the policy for this one invocation is scoped to this process only: it
REM does not change the machine's policy or affect anything else.

echo.
echo Installing the EasyColor panel for Premiere Pro...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-EasyColor.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Installation failed with code %ERRORLEVEL%.
)

echo.
pause
