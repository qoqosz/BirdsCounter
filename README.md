# BirdsCounter

Bird counting app built with Tauri (Rust backend + vanilla frontend).

## Reproducible Build Notes

Builds are intended to be reproducible from a clean checkout:

- Rust dependencies are locked in `src-tauri/Cargo.lock`.
- Android uses the Gradle wrapper in `src-tauri/gen/android/gradlew` (Gradle version pinned in wrapper properties).
- OpenCV version is pinned in scripts (`4.13.0`).
- Build scripts and config avoid machine-specific absolute paths.

## Prerequisites

- Rust toolchain (matching project lockfile)
- Tauri CLI
- Android SDK + NDK (for Android builds)
- Xcode + iOS toolchain (for iOS builds)

## Android Build

1. Download OpenCV Android SDK:
   - `./setup_opencv_android.sh`
2. Configure release signing locally (optional for unsigned builds):
   - Copy `src-tauri/gen/android/keystore.properties.example` to `src-tauri/gen/android/keystore.properties`
   - Fill in real values and keep the file local only (ignored by Git)
3. Build:
   - `./build_android.sh --target aarch64`

Output APK path:
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

You can also use:
- `make android`

## iOS Build

Build script:
- `./build_ios.sh --target aarch64-sim`

Default target is Apple Silicon simulator (`aarch64-sim`).
