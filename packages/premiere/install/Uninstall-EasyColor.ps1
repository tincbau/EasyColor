<#
.SYNOPSIS
    Removes the EasyColor panel from Premiere Pro.

.DESCRIPTION
    Deletes the extension folder. PlayerDebugMode is deliberately left
    alone: other panels on this machine may rely on it, and turning it off
    would break them silently.

    LUTs you have already sent to Premiere are left in place too — they are
    your work, and Lumetri will keep offering them.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$BundleId = 'com.easycolor.premiere'
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$BundleId"

if (Test-Path $target) {
    Remove-Item -Path $target -Recurse -Force
    Write-Host "Removed $target" -ForegroundColor Green
} else {
    Write-Host 'EasyColor is not installed for this user.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Left in place on purpose:'
Write-Host '  - PlayerDebugMode, which other unsigned panels may need.'
Write-Host "  - Any LUTs you sent to Premiere, under %APPDATA%\Adobe\Common\LUTs."
Write-Host ''
Write-Host 'Restart Premiere Pro to finish.'
