# Build, package and sign a CEP-ZH release.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -SkipBuild
param(
    [switch]$SkipBuild,
    [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "VERSION must be x.y.z, got: $version"
}

Write-Host "== CEP-ZH release $version =="

# 1. Version stamp ---------------------------------------------------------
node scripts\stamp-version.mjs
if ($LASTEXITCODE -ne 0) { throw 'stamp-version failed' }
node scripts\stamp-version.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'version check failed' }

# 2. Builds ---------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host '-- building elevation helper --'
    & powershell -ExecutionPolicy Bypass -File tools\elevate\scripts\build.ps1
    if ($LASTEXITCODE -ne 0) { throw 'elevate build failed' }

    Write-Host '-- building native installer --'
    & powershell -ExecutionPolicy Bypass -File installer\native\scripts\build.ps1
    if ($LASTEXITCODE -ne 0) { throw 'installer build failed' }
}

$installer = Join-Path $root 'installer\native\dist\CepZhInstaller.exe'
if (-not (Test-Path $installer)) { throw "missing installer: $installer" }
$elevate = Join-Path $root 'tools\elevate\dist\cepzh-elevate.exe'
if (-not (Test-Path $elevate)) { throw "missing elevation helper: $elevate" }

# 3. Stage runtime --------------------------------------------------------
$releaseDir = Join-Path $root '.tmp-release'
$stage = Join-Path $releaseDir 'runtime'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

function Copy-Selected([string]$source, [string]$target, [string[]]$exclude) {
    New-Item -ItemType Directory -Force $target | Out-Null
    Get-ChildItem $source -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $target $_.Name) -Recurse -Force
    }
}

# MiSans is embedded in the release runtime (license permits embedding), while
# the public Git tree keeps only the license and extraction instructions.
$fonts = Join-Path $root 'product\cep.zh.manager\fonts'
if (-not (Test-Path (Join-Path $fonts 'MiSans-Regular.woff2')) -or
    -not (Test-Path (Join-Path $fonts 'MiSans-Medium.woff2'))) {
    throw 'MiSans WOFF2 files are missing. Run tools\fonts\extract_misans.py or copy them into product\cep.zh.manager\fonts.'
}
Copy-Selected (Join-Path $root 'product\cep.zh.manager') (Join-Path $stage 'product\cep.zh.manager') @('.debug', 'state.json')
Copy-Selected (Join-Path $root 'tools\cep-zh') (Join-Path $stage 'tools\cep-zh') @('state.json')
Copy-Selected (Join-Path $root 'tools\elevate') (Join-Path $stage 'tools\elevate') @('build')
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $stage 'LICENSE') -Force
Copy-Item (Join-Path $root 'README.md') (Join-Path $stage 'README.md') -Force

$zip = Join-Path $releaseDir "CEP-ZH-runtime-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host '-- packaging runtime --'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

$installerOut = Join-Path $releaseDir 'CepZhInstaller.exe'
Copy-Item $installer $installerOut -Force

# 4. Sign manifest --------------------------------------------------------
Write-Host '-- signing manifest --'
node scripts\sign-manifest.mjs $zip $installerOut $releaseDir
if ($LASTEXITCODE -ne 0) { throw 'sign-manifest failed' }

# 5. Report ---------------------------------------------------------------
$runtimeHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$installerHash = (Get-FileHash $installerOut -Algorithm SHA256).Hash.ToLower()
Write-Host ''
Write-Host "runtime : $zip"
Write-Host "          $runtimeHash"
Write-Host "installer: $installerOut"
Write-Host "          $installerHash"
Write-Host "manifest : $(Join-Path $releaseDir 'CEP-ZH-manifest.json')"
Write-Host "signature: $(Join-Path $releaseDir 'CEP-ZH-manifest.sig')"
Write-Host ''
Write-Host 'Upload these four assets to the GitHub Release:'
Write-Host '  CepZhInstaller.exe'
Write-Host "  CEP-ZH-runtime-v$version.zip"
Write-Host '  CEP-ZH-manifest.json'
Write-Host '  CEP-ZH-manifest.sig'

if (-not $KeepStage) {
    Remove-Item -Recurse -Force $stage
}
