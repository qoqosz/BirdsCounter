# Builds the portable Windows app (x64): a single birdscounter.exe with OpenCV and the C runtime linked
# statically, so it runs without installing anything. Needs the static OpenCV from ./setup_opencv_windows.ps1,
# Visual Studio 2022 or newer (C++ workload) and LLVM (libclang, for the opencv crate's binding generator).
#
# The webview is the system's WebView2 runtime, which comes with Windows 11 and current Windows 10.
$ErrorActionPreference = "Stop"

$Target = "x86_64-pc-windows-msvc"
$OpenCvDir = Join-Path $PSScriptRoot "src-tauri\opencv-windows"
$Exe = Join-Path $PSScriptRoot "src-tauri\target\$Target\release\birdscounter.exe"

if (-not (Test-Path (Join-Path $OpenCvDir "include\opencv2\core.hpp"))) {
    throw "Static OpenCV not found in $OpenCvDir. Run ./setup_opencv_windows.ps1 first."
}

# Link every static library of the OpenCV install: the modules, their bundled codecs, IPP and ittnotify.
# The MSVC linker resolves symbols across all libraries, so the order doesn't matter.
$Libs = Get-ChildItem -Path $OpenCvDir -Recurse -Filter *.lib
if (-not $Libs) { throw "No .lib files in $OpenCvDir" }

$env:OPENCV_INCLUDE_PATHS = Join-Path $OpenCvDir "include"
$env:OPENCV_LINK_PATHS = ($Libs | ForEach-Object { $_.DirectoryName } | Sort-Object -Unique) -join ","
$env:OPENCV_LINK_LIBS = ($Libs | ForEach-Object { $_.BaseName }) -join ","
$env:OPENCV_DISABLE_PROBES = "pkg_config,cmake,vcpkg_cmake,vcpkg"
# The opencv crate compiles its C++ wrapper with /MD unless told otherwise; OpenCV and Rust
# (crt-static, see src-tauri/.cargo/config.toml) use the static runtime.
$env:OPENCV_MSVC_CRT = "static"

if (-not $env:LIBCLANG_PATH) {
    $LlvmBin = Join-Path $env:ProgramFiles "LLVM\bin"
    if (Test-Path (Join-Path $LlvmBin "libclang.dll")) {
        $env:LIBCLANG_PATH = $LlvmBin
    }
}

Write-Host "OpenCV configuration:"
Write-Host "  OPENCV_INCLUDE_PATHS=$env:OPENCV_INCLUDE_PATHS"
Write-Host "  OPENCV_LINK_PATHS=$env:OPENCV_LINK_PATHS"
Write-Host "  OPENCV_LINK_LIBS=$env:OPENCV_LINK_LIBS"
Write-Host "  LIBCLANG_PATH=$env:LIBCLANG_PATH"

rustup target add $Target
if ($LASTEXITCODE -ne 0) { throw "rustup target add failed" }

Push-Location $PSScriptRoot
try {
    # The frontend is embedded in the executable, so no installer bundle is needed.
    cargo tauri build --target $Target --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed" }
} finally {
    Pop-Location
}

# Fail if the executable still imports the dynamic C runtime (VC++ Redistributable, UCRT) or OpenCV DLLs.
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$DumpBin = if (Test-Path $VsWhere) {
    & $VsWhere -latest -products * -find "VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe" | Select-Object -First 1
}
if ($DumpBin) {
    $Dependents = & $DumpBin /nologo /dependents $Exe | Where-Object { $_ -match "^\s+\S+\.dll\s*$" } |
        ForEach-Object { $_.Trim() }
    Write-Host "DLLs imported by birdscounter.exe:"
    $Dependents | ForEach-Object { Write-Host "  $_" }
    $Unexpected = $Dependents | Where-Object { $_ -match "^(vcruntime|msvcp|concrt|ucrtbase|api-ms-win-crt|opencv|webview2loader)" }
    if ($Unexpected) {
        throw "birdscounter.exe imports the dynamic C runtime or OpenCV: $($Unexpected -join ', ')"
    }
} else {
    Write-Warning "dumpbin not found, skipping the DLL dependency check"
}

Write-Host "Built $Exe"
