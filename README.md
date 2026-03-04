# BirdsCounter

![birds](images/birds.png)

Cross-platform bird counting app built with Tauri:
- Rust backend (`src-tauri/`) for image processing with OpenCV
- Vanilla HTML/CSS/JS frontend (`src/`) for interaction, preview, and controls

The app loads an image, detects bird-like blobs, annotates them with circles, and returns the count.

## Tech Stack

- Tauri 2 (`tauri`, `tauri-build`)
- Rust 2024 edition
- OpenCV via `opencv` crate (`0.98.1`)
- Frontend: static HTML/CSS/JS (no Node bundler required)


## Detection Pipeline

`process_image` (Rust command) applies:
1. Decode image bytes
2. Convert to grayscale
3. Gaussian blur
4. Threshold (`adaptive` or `otsu`)
5. Optional auto/manual inversion
6. Morphological open/close cleanup
7. Optional exclusion mask application
8. External contour extraction
9. Radius-based filtering from contour area
10. Circle annotation + PNG encode


## Prerequisites

### Common

- Rust toolchain from `rust-toolchain.toml` (`1.92.0`)
- Tauri CLI 2.x (`cargo tauri ...`)

Install Rust toolchain:

```bash
rustup toolchain install 1.92.0
rustup default 1.92.0
```

Install Tauri CLI (if not installed):

```bash
cargo install tauri-cli --version "^2"
```

### Desktop

- OpenCV available on host system (used by `opencv` crate probing)
- Platform dependencies required by Tauri (WebView/runtime toolchain)

### Android

- Android SDK/NDK and Java 17 toolchain
- Generated Android project already present in `src-tauri/gen/android`
- OpenCV Android SDK folder: `src-tauri/opencv-android-sdk`

### iOS (macOS only)

- Xcode + iOS toolchain + signing setup
- OpenCV iOS framework at `src-tauri/opencv2.framework`

## Run in Development (Desktop)

```bash
cargo tauri dev
```

The frontend is served from the static `src/` directory (`frontendDist: "../src"` in `tauri.conf.json`).

## Build Android

1. Download/update OpenCV Android SDK (pinned to `4.13.0`):

```bash
./setup_opencv_android.sh
```

2. Configure release signing (required by `build_android.sh`):
- Option A: file-based
  - Copy `src-tauri/gen/android/keystore.properties.example` to `src-tauri/gen/android/keystore.properties`
  - Fill `storeFile`, `keyAlias`, `storePassword`, `keyPassword`
- Option B: environment variables
  - `ANDROID_KEYSTORE_FILE`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_STORE_PASSWORD` (or `ANDROID_KEYSTORE_PASSWORD`)
  - `ANDROID_KEY_PASSWORD` (or `ANDROID_KEYSTORE_PASSWORD`)

3. Build:

```bash
./build_android.sh --target aarch64
```

Supported targets:
- `aarch64` (`aarch64-linux-android`)
- `armv7` (`armv7-linux-androideabi`)
- `x86_64` (`x86_64-linux-android`)
- `x86` (`i686-linux-android`)

Output APK:
- `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

Shortcut:

```bash
make android
```

## Troubleshooting

- `Error: Android release signing is not configured.`
  - Configure `keystore.properties` or required `ANDROID_*` environment variables.

- OpenCV link/probe failures on desktop:
  - Ensure host OpenCV dev libraries are installed and discoverable by `opencv` crate.

- iOS OpenCV link errors:
  - Verify `src-tauri/opencv2.framework` exists and is valid for selected architecture.

- Camera does not open on Linux desktop:
  - `open_camera` tries `gnome-photos`, `cheese`, then `ffplay`; install one of them or use gallery input.
