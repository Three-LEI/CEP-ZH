#requires -Version 5.1
<#
.SYNOPSIS
  Legacy CEP fallback: write official .debug ports for CEP 9/10/11.

.DESCRIPTION
  The CEP 12 VCRUNTIME140_1.dll proxy is not loaded by older engines
  (AE CC 2019/CEP 9 uses msvcr120/msvcp120), so use Adobe's official .debug
  mechanism instead. This script delegates to tools/cep-zh/cli.mjs enable.

.PARAMETER Hosts
  CEP host ids, e.g. AEFT,PHXS,PPRO,ILST. Default AEFT.

.PARAMETER Only
  Optional substring or /regex/ filter for extension / bundle id.

.PARAMETER DryRun
  Print the plan without writing .debug files.

.PARAMETER Elevate
  Ask CLI to relaunch elevated for system extension folders.

.PARAMETER NodePath
  Optional node.exe path.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\legacy-debug.ps1 -Hosts AEFT
  powershell -ExecutionPolicy Bypass -File installer\legacy-debug.ps1 -Hosts AEFT -Only flow -DryRun
#>
[CmdletBinding()]
param(
    [string[]]$Hosts = @('AEFT'),
    [string]$Only = '',
    [switch]$DryRun,
    [switch]$Elevate,
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Find-Node {
    if ($NodePath -and (Test-Path $NodePath)) { return (Resolve-Path $NodePath).Path }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @('C:\Program Files\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

$node = Find-Node
if (-not $node) { throw 'Node.js 18+ not found; pass -NodePath or install Node.' }
$cli = Join-Path $RepoRoot 'tools\cep-zh\cli.mjs'
if (-not (Test-Path $cli)) { throw "CLI not found: $cli" }

$hostList = ($Hosts | Where-Object { $_ }) -join ','
if (-not $hostList) { throw 'No host specified.' }

$cliArgs = @($cli, 'enable', '--hosts', $hostList)
if ($Only) { $cliArgs += @('--only', $Only) }
if ($DryRun) { $cliArgs += '--dry-run' }
if ($Elevate) { $cliArgs += '--elevate' }

Write-Host "node: $node"
Write-Host "CEP hosts: $hostList"
Write-Host 'Route: official .debug (no VCRUNTIME140_1.dll proxy)'
if (-not $DryRun -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning 'Not elevated: extensions under Program Files may be skipped. Rerun elevated or use -Elevate.'
}

& $node @cliArgs
if ($LASTEXITCODE -ne 0) { throw "cli.mjs enable failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Done. Fully quit and restart the Adobe application, then start/confirm the Agent:'
Write-Host '  node tools\cep-zh\cli.mjs agent --verbose'
Write-Host 'If the target extension already had .debug, the CLI will show "unchanged".'
