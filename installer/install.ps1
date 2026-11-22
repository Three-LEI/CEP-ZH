#requires -Version 5.1
<#
.SYNOPSIS
  cep-zh one-click installer: engine proxy + CEP manager/agent extension.

.DESCRIPTION
  - Finds Adobe CEP 12 engine folders (CEPHtmlEngine.exe) under common roots.
  - Backs up and installs VCRUNTIME140_1.dll (the no-.debug bootstrap proxy).
  - Installs the CEP manager/agent extension into the current user's CEP folder.
  - Installs the Agent files under %LOCALAPPDATA%\CEP-ZH\agent.
  - Writes an uninstall entry and a manifest used by -Uninstall.
  - Needs administrator for the Adobe installation folders; the CEP extension
    itself is per-user and needs no admin.

.PARAMETER Uninstall
  Restore proxy backups, remove the extension/agent and uninstall entry.

.PARAMETER DryRun
  Print what would happen, do not touch anything.

.PARAMETER Silent
  No prompts; install to all supported engines.

.PARAMETER KeepData
  On uninstall keep %APPDATA%\CEP-ZH (dictionaries/config).

.PARAMETER IncludeUnsupported
  Also install to CEP 9/10/11 engines. NOT recommended: the proxy only knows
  the CEF 99 cef_settings_t layout.

.PARAMETER NodePath
  Path to node.exe. If omitted, the installer detects it on PATH / common paths.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Silent,
    [switch]$KeepData,
    [switch]$IncludeUnsupported,
    [string]$NodePath = '',
    [string]$ProxySource = '',
    [string]$ExtensionSource = '',
    [string]$AgentSource = '',
    [string]$ProgramDataRoot = '',
    [string]$InstallVersion = '0.2.0'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ProxySource) { $ProxySource = Join-Path $RepoRoot 'tools\bootstrap\dist\VCRUNTIME140_1.dll' }
if (-not $ExtensionSource) { $ExtensionSource = Join-Path $RepoRoot 'product\cep.zh.manager' }
if (-not $AgentSource) { $AgentSource = Join-Path $RepoRoot 'tools\cep-zh' }
if (-not $ProgramDataRoot) { $ProgramDataRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CEP-ZH' }

$ManifestPath = Join-Path $ProgramDataRoot 'install.json'
$ExtTarget = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Adobe\CEP\extensions\cep.zh.manager'
$AgentTarget = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CEP-ZH\agent'
$ConfigDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'CEP-ZH'
$ConfigPath = Join-Path $ConfigDir 'config.json'
$UninstallKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CEP-ZH'
$Marker = 'cep-zh CEP engine proxy'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-Sha256([string]$path) {
    if (-not (Test-Path $path)) { return '' }
    return (Get-FileHash $path -Algorithm SHA256).Hash
}
function Test-Ours([string]$path) {
    if (-not (Test-Path $path)) { return $false }
    try {
        $txt = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($path))
        return $txt.Contains($Marker)
    } catch { return $false }
}
function Test-Writable([string]$dir) {
    $probe = Join-Path $dir ('.cepzh-write-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try { [IO.File]::WriteAllText($probe, 'x'); Remove-Item $probe -Force; return $true } catch { return $false }
}
function Write-Utf8([string]$path, [string]$text) {
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Find-Engines {
    $roots = @('D:\Adobe', 'C:\Program Files\Adobe', 'C:\Program Files (x86)\Adobe')
    $extra = @()
    try {
        $extra = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match 'Adobe' -and $_.InstallLocation } |
            Select-Object -ExpandProperty InstallLocation
        $extra += Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match 'Adobe' -and $_.InstallLocation } |
            Select-Object -ExpandProperty InstallLocation
    } catch { }
    $allRoots = @($roots + $extra) | Where-Object { $_ -and (Test-Path $_) } | Sort-Object -Unique

    $seen = @{}
    $engines = @()
    foreach ($root in $allRoots) {
        $found = Get-ChildItem -Path $root -Recurse -Filter 'CEPHtmlEngine.exe' -ErrorAction SilentlyContinue
        foreach ($exe in $found) {
            $full = $exe.FullName.ToLower()
            if ($seen.ContainsKey($full)) { continue }
            $seen[$full] = $true
            $ver = $exe.VersionInfo.FileVersion
            $major = 0
            if ($ver -match '^\s*(\d+)') { $major = [int]$matches[1] }
            $supported = ($major -ge 12)
            if (-not $supported -and -not $IncludeUnsupported) { continue }
            $engines += [pscustomobject]@{
                Dir = $exe.DirectoryName
                Exe = $exe.FullName
                Version = $ver
                Major = $major
                Supported = $supported
                Writable = (Test-Writable $exe.DirectoryName)
            }
        }
    }
    return $engines | Sort-Object Dir -Unique
}

function Get-AdobeRunning {
    $names = @('AfterFX', 'Photoshop', 'Illustrator', 'Adobe Premiere Pro', 'InDesign', 'Animate')
    return @(Get-Process -Name $names -ErrorAction SilentlyContinue)
}

function Install-Proxy($engines, $entries) {
    if (-not (Test-Path $ProxySource)) { throw "proxy not found: $ProxySource" }
    $proxyHash = Get-Sha256 $ProxySource
    Write-Host "proxy: $ProxySource"
    Write-Host "sha256: $proxyHash"
    foreach ($e in $engines) {
        $target = Join-Path $e.Dir 'VCRUNTIME140_1.dll'
        $backup = Join-Path $e.Dir 'VCRUNTIME140_1.dll.cepzh-orig'
        if (-not $e.Writable) {
            Write-Warning "skip (not writable, run elevated): $($e.Dir)"
            continue
        }
        if ($DryRun) {
            Write-Host "[dry] install proxy -> $target (CEP $($e.Version), writable)"
            continue
        }
        if ((Test-Path $target) -and -not (Test-Ours $target) -and -not (Test-Path $backup)) {
            Copy-Item $target $backup -Force
            Write-Host "backup: $backup"
        }
        Copy-Item $ProxySource $target -Force
        $entries += [pscustomobject]@{ Dir = $e.Dir; Backup = $backup; Hash = (Get-Sha256 $target); Version = $e.Version }
        Write-Host "installed proxy: $($e.Dir)"
    }
    return $entries
}

function Remove-Proxy($entries) {
    foreach ($entry in @($entries)) {
        $target = Join-Path $entry.Dir 'VCRUNTIME140_1.dll'
        $backup = $entry.Backup
        if (-not (Test-Path $entry.Dir)) { continue }
        if ($DryRun) { Write-Host "[dry] restore/remove proxy in $($entry.Dir)"; continue }
        if ($backup -and (Test-Path $backup)) {
            Copy-Item $backup $target -Force
            Remove-Item $backup -Force -ErrorAction SilentlyContinue
            Write-Host "restored: $($entry.Dir)"
        } elseif ((Test-Path $target) -and ((Get-Sha256 $target) -eq $entry.Hash -or (Test-Ours $target))) {
            Remove-Item $target -Force
            Write-Host "removed: $($entry.Dir)"
        }
    }
}

function Install-Extension {
    if (-not (Test-Path $ExtensionSource)) { throw "extension not found: $ExtensionSource" }
    if ($DryRun) { Write-Host "[dry] install extension -> $ExtTarget"; return }
    if (Test-Path $ExtTarget) {
        $backup = $ExtTarget + '.cepzh-backup'
        if (-not (Test-Path $backup)) { Copy-Item $ExtTarget $backup -Recurse -Force }
        Remove-Item $ExtTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $ExtTarget -Parent) | Out-Null
    Copy-Item $ExtensionSource $ExtTarget -Recurse -Force
    Write-Host "installed extension: $ExtTarget"
}

function Install-Agent {
    if (-not (Test-Path $AgentSource)) { Write-Warning "agent source not found: $AgentSource"; return '' }
    if ($DryRun) { Write-Host "[dry] install agent -> $AgentTarget"; return '' }
    if (Test-Path $AgentTarget) { Remove-Item $AgentTarget -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $AgentTarget | Out-Null
    $toolDir = Join-Path $AgentTarget 'tools\cep-zh'
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    foreach ($item in @('agent.mjs', 'translate.mjs', 'config.example.json')) {
        $p = Join-Path $AgentSource $item
        if (Test-Path $p) { Copy-Item $p (Join-Path $toolDir $item) -Force }
    }
    foreach ($dir in @('lib', 'runtime', 'dict')) {
        $p = Join-Path $AgentSource $dir
        if (Test-Path $p) { Copy-Item $p (Join-Path $toolDir $dir) -Recurse -Force }
    }
    Write-Host "installed agent: $toolDir"
    return (Join-Path $toolDir 'agent.mjs')
}

function Find-Node {
    if ($NodePath -and (Test-Path $NodePath)) { return (Resolve-Path $NodePath).Path }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        'C:\Program Files\nodejs\node.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $RepoRoot 'node\node.exe')
    )) {
        if (Test-Path $p) { return $p }
    }
    return ''
}

function Write-AgentConfig([string]$agentScript) {
    $node = Find-Node
    $cfg = @{}
    if (Test-Path $ConfigPath) {
        try {
            $obj = Get-Content $ConfigPath -Raw | ConvertFrom-Json
            foreach ($p in $obj.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
        } catch { $cfg = @{} }
    }
    if ($node) { $cfg['nodePath'] = $node }
    if ($agentScript) { $cfg['agentScript'] = $agentScript }
    if (-not $cfg.ContainsKey('extraArgs')) { $cfg['extraArgs'] = @('--verbose') }
    if ($DryRun) { Write-Host "[dry] would write $ConfigPath (node=$node agent=$agentScript)"; return }
    Write-Utf8 $ConfigPath ($cfg | ConvertTo-Json -Depth 6)
    Write-Host "config: $ConfigPath"
    if (-not $node) { Write-Warning 'Node.js not found; the hidden Agent will stay unconfigured until nodePath is set.' }
}

function Write-UninstallEntry {
    if ($DryRun) { Write-Host '[dry] would write uninstall registry entry'; return }
    New-Item -Path $UninstallKey -Force | Out-Null
    $uninstall = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $RepoRoot 'installer\install.ps1') + '" -Uninstall'
    Set-ItemProperty $UninstallKey -Name DisplayName -Value 'CEP-ZH（Adobe CEP 汉化）'
    Set-ItemProperty $UninstallKey -Name DisplayVersion -Value $InstallVersion
    Set-ItemProperty $UninstallKey -Name Publisher -Value 'CEP-ZH open source project'
    Set-ItemProperty $UninstallKey -Name InstallLocation -Value $RepoRoot
    Set-ItemProperty $UninstallKey -Name UninstallString -Value $uninstall
    Set-ItemProperty $UninstallKey -Name QuietUninstallString -Value ($uninstall + ' -Silent')
    Set-ItemProperty $UninstallKey -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty $UninstallKey -Name NoRepair -Value 1 -Type DWord
}

function Install-All {
    if (-not $DryRun -and -not (Test-Admin)) {
        Write-Warning 'not elevated: writable D:\Adobe engines will be installed; Program Files engines will be skipped.'
    }
    $running = Get-AdobeRunning
    if ($running.Count -and -not $DryRun) {
        throw "Close Adobe applications first: $($running.ProcessName -join ', ')"
    }
    $engines = Find-Engines
    if (-not $engines.Count) { throw 'No supported CEP engine found (CEP 12 / VCRUNTIME140_1.dll).' }

    Write-Host ''
    Write-Host 'CEP engines:'
    $engines | ForEach-Object { Write-Host ("  CEP {0,-8} {1}" -f $_.Version, $_.Dir) }

    $manifest = @{ version = $InstallVersion; installedAt = (Get-Date).ToString('o'); engines = @(); extension = $ExtTarget; agent = $AgentTarget }
    if (Test-Path $ManifestPath) {
        try { $old = Get-Content $ManifestPath -Raw | ConvertFrom-Json; if ($old.engines) { $manifest.engines = @($old.engines) } } catch {}
    }
    $entries = @($manifest.engines)
    $entries = Install-Proxy $engines $entries
    $manifest.engines = @($entries | Where-Object { $_ -and $_.Dir })
    Install-Extension
    $agentScript = Install-Agent
    if ($agentScript) { Write-AgentConfig $agentScript }
    Write-UninstallEntry

    if (-not $DryRun) {
        New-Item -ItemType Directory -Force -Path $ProgramDataRoot | Out-Null
        Write-Utf8 $ManifestPath ($manifest | ConvertTo-Json -Depth 8)
        Write-Host "manifest: $ManifestPath"
    }
    Write-Host ''
    Write-Host 'Done. Restart Adobe applications, then open: 窗口 > 扩展 > CEP 汉化管理'
}

function Uninstall-All {
    if (-not $DryRun -and -not (Test-Admin)) {
        Write-Warning 'not elevated: only writable engine folders can be restored.'
    }
    $manifest = $null
    if (Test-Path $ManifestPath) {
        try { $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json } catch {}
    }
    if ($manifest -and $manifest.engines) {
        Remove-Proxy $manifest.engines
    } else {
        Write-Warning 'no manifest; scanning all CEP 12 engines for our proxy'
        $engines = Find-Engines
        $entries = $engines | ForEach-Object { [pscustomobject]@{ Dir = $_.Dir; Backup = (Join-Path $_.Dir 'VCRUNTIME140_1.dll.cepzh-orig'); Hash = '' } }
        Remove-Proxy $entries
    }
    if ($DryRun) {
        Write-Host "[dry] remove extension: $ExtTarget"
        Write-Host "[dry] remove agent: $AgentTarget"
    } else {
        if (Test-Path $ExtTarget) {
            $txt = Get-Content (Join-Path $ExtTarget 'CSXS\manifest.xml') -Raw -ErrorAction SilentlyContinue
            if ($txt -and $txt.Contains('cep.zh.manager')) { Remove-Item $ExtTarget -Recurse -Force; Write-Host "removed extension: $ExtTarget" }
        }
        $extBackup = $ExtTarget + '.cepzh-backup'
        if (Test-Path $extBackup) { Remove-Item $extBackup -Recurse -Force; Write-Host "removed extension backup: $extBackup" }
        if (Test-Path $AgentTarget) { Remove-Item $AgentTarget -Recurse -Force; Write-Host "removed agent: $AgentTarget" }
        $localCepZh = Split-Path $AgentTarget -Parent
        if (Test-Path $localCepZh) {
            $left = Get-ChildItem $localCepZh -Force -ErrorAction SilentlyContinue
            if (-not $left) { Remove-Item $localCepZh -Force }
        }
    }
    if (-not $KeepData) {
        if ($DryRun) { Write-Host "[dry] remove data: $ConfigDir" }
        elseif (Test-Path $ConfigDir) { Remove-Item $ConfigDir -Recurse -Force; Write-Host "removed data: $ConfigDir" }
    }
    if (-not $DryRun) {
        if (Test-Path $ManifestPath) { Remove-Item $ManifestPath -Force -ErrorAction SilentlyContinue }
        if (Test-Path $ProgramDataRoot) {
            $left = Get-ChildItem $ProgramDataRoot -Force -ErrorAction SilentlyContinue
            if (-not $left) { Remove-Item $ProgramDataRoot -Force }
        }
        Remove-Item $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host 'Uninstall complete. Restart Adobe applications.'
}

Write-Host "cep-zh installer $InstallVersion"
Write-Host "repo: $RepoRoot"
if ($DryRun) { Write-Host '*** DRY RUN ***' }

if ($Uninstall) { Uninstall-All } else { Install-All }
