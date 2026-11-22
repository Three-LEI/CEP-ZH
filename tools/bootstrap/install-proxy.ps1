#requires -Version 5.1
<#
.SYNOPSIS
  Install / uninstall the cep-zh CEP engine proxy (VCRUNTIME140_1.dll).

.DESCRIPTION
  The proxy is loaded by CEPHtmlEngine.exe before its entry point. It hooks
  cef_initialize() and gives every CEP panel a remote-debugging port, without
  any per-extension .debug file. One proxy per Adobe application engine folder.

  This modifies files inside the Adobe installation. It backs up an existing
  VCRUNTIME140_1.dll as .cepzh-orig and can restore it with -Uninstall.

.PARAMETER Uninstall
  Restore backups / remove the proxy.

.PARAMETER DryRun
  Only print what would happen.

.PARAMETER Roots
  Adobe install roots to scan. Defaults to D:\Adobe and the two Program Files
  Adobe folders.

.PARAMETER Elevate
  Relaunch this script with UAC if a target folder needs administrator rights.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Elevate,
    [string[]]$Roots = @('D:\Adobe', 'C:\Program Files\Adobe', 'C:\Program Files (x86)\Adobe'),
    [string]$ProxyPath = ''
)

if (-not $ProxyPath) { $ProxyPath = Join-Path $PSScriptRoot 'dist\VCRUNTIME140_1.dll' }

$ErrorActionPreference = 'Stop'
$TargetName = 'VCRUNTIME140_1.dll'
$BackupName = 'VCRUNTIME140_1.dll.cepzh-orig'
$Marker = 'cep-zh CEP engine proxy'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-Writable([string]$dir) {
    $probe = Join-Path $dir ('.cepzh-write-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        [IO.File]::WriteAllText($probe, 'x')
        Remove-Item $probe -Force
        return $true
    } catch {
        return $false
    }
}

if (-not $Uninstall -and -not (Test-Path $ProxyPath)) {
    throw "proxy not found: $ProxyPath"
}
if (-not $Uninstall) {
    $hash = (Get-FileHash $ProxyPath -Algorithm SHA256).Hash
    Write-Host "proxy: $ProxyPath"
    Write-Host "sha256: $hash"
}

$engines = @()
foreach ($root in $Roots) {
    if (-not (Test-Path $root)) { continue }
    $found = Get-ChildItem -Path $root -Recurse -Filter 'CEPHtmlEngine.exe' -ErrorAction SilentlyContinue
    foreach ($exe in $found) {
        $ver = $exe.VersionInfo.FileVersion
        $major = 0
        if ($ver -match '^\s*(\d+)') { $major = [int]$matches[1] }
        if (-not $Uninstall -and $major -lt 12) {
            Write-Warning "skip $($exe.DirectoryName) (CEPHtmlEngine $ver; proxy is validated on CEP 12 / CEF 99 only)"
            continue
        }
        $engines += $exe.DirectoryName
    }
}
$engines = $engines | Sort-Object -Unique

if (-not $engines) {
    Write-Host 'no CEPHtmlEngine.exe found under:' ($Roots -join ', ')
    exit 1
}

$needsAdmin = @()
$plan = @()
foreach ($dir in $engines) {
    $target = Join-Path $dir $TargetName
    $backup = Join-Path $dir $BackupName
    $writable = Test-Writable $dir
    $exists = Test-Path $target
    $isOurs = $false
    if ($exists) {
        $bytes = [IO.File]::ReadAllBytes($target)
        $text = [Text.Encoding]::ASCII.GetString($bytes)
        $isOurs = $text.Contains($Marker)
    }
    $plan += [pscustomobject]@{
        Dir = $dir
        Writable = $writable
        Exists = $exists
        IsOurs = $isOurs
        HasBackup = (Test-Path $backup)
    }
    if (-not $writable -and -not $Uninstall) { $needsAdmin += $dir }
    if (-not $writable -and $Uninstall -and ($exists -or (Test-Path $backup))) { $needsAdmin += $dir }
}

if ($needsAdmin.Count -and $Elevate -and -not (Test-Admin)) {
    Write-Host 'requesting administrator rights...'
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $args += '-Uninstall' }
    if ($DryRun) { $args += '-DryRun' }
    $quotedRoots = ($Roots | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ','
    $args += @('-Roots', "@($quotedRoots)")
    Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs
    exit 0
}

$failed = 0
foreach ($item in $plan) {
    $dir = $item.Dir
    $target = Join-Path $dir $TargetName
    $backup = Join-Path $dir $BackupName
    if (-not $item.Writable) {
        Write-Warning "skipped (not writable): $dir"
        $failed++
        continue
    }

    if ($Uninstall) {
        if (Test-Path $backup) {
            if ($DryRun) { Write-Host "[dry] restore $backup -> $target"; continue }
            Copy-Item $backup $target -Force
            Remove-Item $backup -Force -ErrorAction SilentlyContinue
            Write-Host "restored: $dir"
        } elseif ($item.IsOurs) {
            if ($DryRun) { Write-Host "[dry] remove $target"; continue }
            Remove-Item $target -Force
            Write-Host "removed: $dir"
        } else {
            Write-Host "skip (no cep-zh proxy): $dir"
        }
        continue
    }

    if ($DryRun) {
        Write-Host "[dry] install $ProxyPath -> $target (backup=$($item.HasBackup))"
        continue
    }

    if ($item.Exists -and -not $item.IsOurs -and -not $item.HasBackup) {
        Copy-Item $target $backup -Force
        Write-Host "backup: $backup"
    }
    Copy-Item $ProxyPath $target -Force
    Write-Host "installed: $dir"
}

if ($failed) {
    Write-Host ''
    Write-Host "Some folders need administrator rights. Re-run from an elevated prompt, or add -Elevate."
    exit 3
}
if ($DryRun) { Write-Host 'dry run complete' }
elseif ($Uninstall) { Write-Host 'uninstall complete; restart Adobe applications.' }
else { Write-Host 'install complete; restart Adobe applications.' }
