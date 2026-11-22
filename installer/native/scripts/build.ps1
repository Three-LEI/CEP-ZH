# Build the native CEP-ZH installer (Win32, Direct2D, static CRT).
#   powershell -ExecutionPolicy Bypass -File installer\native\scripts\build.ps1
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$dist = Join-Path $root 'dist'

function Find-BuildTools {
    $candidates = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $candidates += (& $vswhere -products * -version '[17.0,19.0)' -property installationPath) -split "`r?`n"
    }
    $candidates += 'F:\DevTools\VS2022\BuildTools'
    foreach ($candidate in $candidates) {
        $candidate = "$candidate".Trim()
        if ($candidate -and (Test-Path (Join-Path $candidate 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'))) {
            return $candidate
        }
    }
    throw 'Cannot find Visual Studio 2022 Build Tools with CMake.'
}

$vs = Find-BuildTools
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if ($Clean -and (Test-Path $buildDir)) { Remove-Item -Recurse -Force $buildDir }

if (-not (Test-Path (Join-Path $buildDir 'CMakeCache.txt'))) {
    Write-Host 'Configuring (VS2022 x64, v141, SDK 10.0.19041)...'
    & $cmake -S $root -B $buildDir -G 'Visual Studio 17 2022' -A x64 -T v141 '-DCMAKE_SYSTEM_VERSION=10.0.19041.0'
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }
}

Write-Host 'Building Release...'
& $cmake --build $buildDir --config Release
if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }

New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item (Join-Path $buildDir 'Release\CepZhInstaller.exe') (Join-Path $dist 'CepZhInstaller.exe') -Force
$exe = Join-Path $dist 'CepZhInstaller.exe'
Write-Host ("Built: {0} ({1:N0} bytes)" -f $exe, (Get-Item $exe).Length)
