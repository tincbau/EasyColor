<#
.SYNOPSIS
    Installs the EasyColor panel into Adobe Premiere Pro.

.DESCRIPTION
    Two things have to happen for a CEP panel to load.

    1. The extension folder has to sit in Premiere's per-user extensions
       directory. Per-user, not the shared one under Program Files: the
       shared location needs administrator rights and is wiped by Creative
       Cloud updates.

    2. Premiere has to be willing to load an extension that Adobe has not
       signed. That is what PlayerDebugMode does. Adobe's own documentation
       describes this as the supported way to run an in-house or
       self-distributed panel, and it is set per CSXS runtime version, so
       the key has to be written for every version Premiere might use.

    Nothing here needs administrator rights, and nothing is written outside
    the current user's profile.

.PARAMETER Source
    Folder containing the built extension. Defaults to the copy shipped
    beside this script.

.EXAMPLE
    .\Install-EasyColor.ps1
#>

[CmdletBinding()]
param(
    [string]$Source
)

$ErrorActionPreference = 'Stop'
$BundleId = 'com.easycolor.premiere'

function Write-Step($message) { Write-Host "  $message" }

Write-Host ''
Write-Host 'EasyColor for Premiere Pro — installer' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------------
# Locate the extension we are installing
# ---------------------------------------------------------------------

if (-not $Source) {
    $candidates = @(
        (Join-Path $PSScriptRoot $BundleId),
        (Join-Path $PSScriptRoot "..\dist\$BundleId"),
        (Join-Path $PSScriptRoot "dist\$BundleId")
    )
    $Source = $candidates | Where-Object { Test-Path (Join-Path $_ 'CSXS\manifest.xml') } | Select-Object -First 1
}

if (-not $Source -or -not (Test-Path (Join-Path $Source 'CSXS\manifest.xml'))) {
    Write-Host 'Could not find the built extension.' -ForegroundColor Red
    Write-Host 'Expected a folder containing CSXS\manifest.xml next to this script.'
    Write-Host 'If you are building from source, run:  npm run build -w @easycolor/premiere'
    exit 1
}

$Source = (Resolve-Path $Source).Path
Write-Step "Source: $Source"

# ---------------------------------------------------------------------
# Allow unsigned extensions
# ---------------------------------------------------------------------

# Each Premiere release uses a particular CSXS runtime. Writing the whole
# range costs nothing and means the panel keeps working when Premiere
# updates to a runtime that did not exist when this was written.
$csxsVersions = 4..25
$written = 0

foreach ($version in $csxsVersions) {
    $key = "HKCU:\Software\Adobe\CSXS.$version"
    try {
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        # The value is the *string* "1", not a number. A DWORD here is
        # silently ignored and the panel simply never appears.
        New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
        $written++
    }
    catch {
        Write-Warning "Could not write $key : $_"
    }
}

Write-Step "Enabled unsigned extensions for $written CEP runtime versions."

# ---------------------------------------------------------------------
# Copy the extension into place
# ---------------------------------------------------------------------

$extensionsRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$target = Join-Path $extensionsRoot $BundleId

if (-not (Test-Path $extensionsRoot)) {
    New-Item -Path $extensionsRoot -ItemType Directory -Force | Out-Null
}

if (Test-Path $target) {
    Write-Step 'Removing the previous version...'
    Remove-Item -Path $target -Recurse -Force
}

Write-Step "Installing to: $target"
Copy-Item -Path $Source -Destination $target -Recurse -Force

# ---------------------------------------------------------------------
# Make sure the LUT folders exist
# ---------------------------------------------------------------------

# Premiere only scans these folders at launch, and only if they exist. The
# panel creates them too, but doing it here means the very first "send to
# Premiere" works without a second restart.
foreach ($kind in @('Creative', 'Technical')) {
    $lutFolder = Join-Path $env:APPDATA "Adobe\Common\LUTs\$kind"
    if (-not (Test-Path $lutFolder)) {
        New-Item -Path $lutFolder -ItemType Directory -Force | Out-Null
        Write-Step "Created LUT folder: $lutFolder"
    }
}

# ---------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Quit Premiere Pro completely if it is running.'
Write-Host '  2. Start Premiere Pro.'
Write-Host '  3. Open  Window > Extensions > EasyColor.'
Write-Host ''

if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) {
    Write-Host 'Premiere Pro is running right now — it will not see the panel until you restart it.' -ForegroundColor Yellow
    Write-Host ''
}
