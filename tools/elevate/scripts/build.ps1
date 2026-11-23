$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
$build = Join-Path $here 'build'
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) {
    $candidates = @(
        'F:\DevTools\VS2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe',
        (Join-Path ${env:ProgramFiles} 'CMake\bin\cmake.exe')
    )
    $cmake = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cmake) { throw 'CMake not found' }
& $cmake -S $here -B $build -G 'Visual Studio 17 2022' -A x64
if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
& $cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }
$exe = Get-ChildItem (Join-Path $here 'dist') -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (!(Test-Path $exe.FullName)) { throw 'missing elevation helper' }
Get-Item $exe.FullName | Select-Object FullName, Length
