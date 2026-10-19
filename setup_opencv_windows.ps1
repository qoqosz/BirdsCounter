# Builds OpenCV 5 from source as static libraries with the static C runtime (/MT) and installs it into
# src-tauri/opencv-windows, for the portable Windows build (build_windows.ps1).
# OpenCV's own Windows package ships only DLLs built against the dynamic runtime, so it can't be used.
#
# Needs Visual Studio 2022 or newer with the "Desktop development with C++" workload, CMake and tar
# (built into Windows 10 and later). Takes about 10 minutes.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$OpenCvVersion = "5.0.0"
$InstallDir = Join-Path $PSScriptRoot "src-tauri\opencv-windows"
# A short path outside the repo, so the Visual Studio build stays under MAX_PATH.
$WorkDir = Join-Path ([IO.Path]::GetTempPath()) "ocv$($OpenCvVersion -replace '\.', '')"

if (Test-Path $InstallDir) {
    Write-Host "Removing existing OpenCV in $InstallDir..."
    Remove-Item -Recurse -Force $InstallDir
}
if (Test-Path $WorkDir) {
    Remove-Item -Recurse -Force $WorkDir
}
New-Item -ItemType Directory -Force $WorkDir | Out-Null

Write-Host "Downloading OpenCV $OpenCvVersion sources..."
$Archive = Join-Path $WorkDir "opencv.tar.gz"
Invoke-WebRequest -Uri "https://github.com/opencv/opencv/archive/refs/tags/$OpenCvVersion.tar.gz" -OutFile $Archive
tar -xzf $Archive -C $WorkDir
if ($LASTEXITCODE -ne 0) { throw "Extracting $Archive failed" }
$SourceDir = Join-Path $WorkDir "opencv-$OpenCvVersion"
$BuildDir = Join-Path $WorkDir "build"

# Only the modules the app uses (see the opencv crate features in Cargo.toml) and their dependency flann.
# Image codecs are built from OpenCV's bundled sources; everything that would need a DLL at run time is off.
$CMakeArgs = @(
    "-S", $SourceDir,
    "-B", $BuildDir,
    "-A", "x64",
    "-DCMAKE_INSTALL_PREFIX=$InstallDir",
    # OpenCV enables ASM whenever CMake finds an assembler. On GitHub's runner that is MinGW's cc.exe, which
    # renames every static library to lib*.a and breaks the IPP lookup. x64 doesn't need it (libjpeg-turbo uses NASM).
    "-DCMAKE_ASM_COMPILER:FILEPATH=CMAKE_ASM_COMPILER-NOTFOUND",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DBUILD_WITH_STATIC_CRT=ON",
    "-DBUILD_LIST=core,flann,geometry,imgproc,imgcodecs",
    "-DBUILD_opencv_world=OFF",
    "-DBUILD_opencv_apps=OFF",
    "-DBUILD_opencv_python3=OFF",
    "-DBUILD_opencv_python_bindings_generator=OFF",
    "-DBUILD_opencv_java_bindings_generator=OFF",
    "-DBUILD_opencv_js_bindings_generator=OFF",
    "-DBUILD_opencv_objc_bindings_generator=OFF",
    "-DBUILD_JAVA=OFF",
    "-DBUILD_TESTS=OFF",
    "-DBUILD_PERF_TESTS=OFF",
    "-DBUILD_EXAMPLES=OFF",
    "-DBUILD_DOCS=OFF",
    "-DBUILD_ZLIB=ON",
    "-DBUILD_PNG=ON",
    "-DBUILD_JPEG=ON",
    "-DBUILD_WEBP=ON",
    "-DBUILD_TIFF=ON",
    "-DWITH_IPP=ON",
    "-DWITH_OPENJPEG=OFF",
    "-DWITH_JASPER=OFF",
    "-DWITH_OPENEXR=OFF",
    "-DWITH_AVIF=OFF",
    "-DWITH_JPEGXL=OFF",
    "-DWITH_FFMPEG=OFF",
    "-DWITH_GSTREAMER=OFF",
    "-DWITH_MSMF=OFF",
    "-DWITH_DSHOW=OFF",
    "-DWITH_OBSENSOR=OFF",
    "-DWITH_OPENCL=OFF",
    "-DWITH_DIRECTX=OFF",
    "-DWITH_CUDA=OFF",
    "-DWITH_EIGEN=OFF",
    "-DWITH_LAPACK=OFF",
    "-DWITH_PROTOBUF=OFF",
    "-DWITH_ADE=OFF",
    "-DWITH_QT=OFF",
    "-DWITH_VTK=OFF",
    "-DWITH_WIN32UI=OFF"
)

Write-Host "Configuring OpenCV..."
cmake @CMakeArgs
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed" }

Write-Host "Building OpenCV..."
cmake --build $BuildDir --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw "OpenCV build failed" }

cmake --install $BuildDir --config Release
if ($LASTEXITCODE -ne 0) { throw "OpenCV install failed" }

Remove-Item -Recurse -Force $WorkDir

$Libs = Get-ChildItem -Path $InstallDir -Recurse -Filter *.lib
if (-not ($Libs | Where-Object { $_.Name -like "opencv_core*.lib" })) {
    throw "No opencv_core*.lib in $InstallDir; check the library names CMake used"
}
Write-Host "Static libraries:"
$Libs | ForEach-Object { Write-Host "  $($_.Name)" }

Write-Host "OpenCV $OpenCvVersion (static, /MT) installed in $InstallDir"
