# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

BirdsCounter is a Tauri 2 app (macOS desktop, Android, iOS) that counts birds in a photo. A Rust backend
does the detection with OpenCV 5. The frontend is static HTML/CSS/JS in `src/`, with no bundler and no npm.

## Commands

All Rust commands run from `src-tauri/`, except the build scripts and `cargo tauri dev`, which run from the repo root.

```bash
cargo tauri dev                      # run the desktop app (frontend served from src/, frontendDist "../src")
cd src-tauri && cargo test --lib     # detector unit tests (synthetic cloudy-sky scenes)
cd src-tauri && cargo test --lib <test_name>   # run a single test in blob_filter::tests
cd src-tauri && cargo run --release --example count -- --out annotated/ photo1.jpg photo2.jpg
cd src-tauri && cargo clippy && cargo fmt
./build_android.sh --target aarch64  # release APK (also: make android); targets aarch64|armv7|x86_64|x86
./build_ios.sh --target sim          # iOS (sim | x86_64 | device)
```

The `count` example is the quickest way to tune the detector on real photos. It prints the count per file and
accepts `--method`, `--sensitivity`, `--window`, `--min-radius`, `--max-radius`, `--blur`, `--invert`, `--no-split` and
`--whole-image` (disables the sky mask).

The Rust toolchain is pinned to 1.92.0 in `rust-toolchain.toml`.

## OpenCV linking (the usual source of build failures)

- **OpenCV 5 only.** `contourArea` and `moments` live in the `geometry` module, which does not exist in 4.x.
  The crate features in `Cargo.toml` (`geometry`, `imgcodecs`, `imgproc`) must match `OPENCV_LINK_LIBS` in
  `build_android.sh`.
- **Desktop (macOS):** uses the host OpenCV through pkg-config (`opencv5`). `src-tauri/.cargo/config.toml` disables
  the `environment` probe on darwin targets, so the iOS framework variables don't leak into desktop builds.
- **Android:** static libs from `src-tauri/opencv-android-sdk`, downloaded by `./setup_opencv_android.sh` (the
  "16kb-page-fix" package, required by Google Play). `build_android.sh` sets the `OPENCV_*` variables.
  `src-tauri/build.rs` adds link paths and only the third-party archives the SDK actually ships, plus the NDK system
  libs. Release builds fail fast unless signing is configured, through `gen/android/keystore.properties` or the
  `ANDROID_*` environment variables.
- **iOS:** `src-tauri/opencv2.framework`, downloaded by `./setup_opencv_ios.sh`.

## Architecture

**Rust (`src-tauri/src/`)**

- `lib.rs` registers the Tauri commands:
  - `process_image(payload, params, mask_payload)` returns `{ bytes, count }`, where `bytes` is the annotated PNG.
  - `open_camera` launches Photo Booth or FaceTime on macOS, and the system camera app on Windows and Linux.
- `lib.rs` also builds the native macOS menu bar. Its "Open Image…" (⌘O) emits the `menu-open-image` event to
  the frontend.
- `blob_filter.rs` holds the whole detector. `BlobParams` is deserialized from the JS object built in
  `readParamsFromUI()` in `main.js`, so field names must stay in sync on both sides. Threshold methods:
  - `background` (default): sky estimation and Weber contrast with texture-adaptive hysteresis.
  - `adaptive` and `otsu`: the classic pipeline.
- With `sky_only` (default), `landscape_mask` runs before both methods. Candidate components that touch
  non-sky areas are dropped whole by `drop_touching`, while the user's painted mask only cuts them. Its
  thresholds are the `SKY_*` constants, in units of a downscaled copy where the local window is 5 px.
- Post-processing is shared by all methods. `drop_clutter` removes oversized and edge-touching blobs, and
  `split_merged` counts merged birds as `round(area / flock median)`. The README's "Detection Pipeline" section has
  the details.

**Frontend (`src/`)**

- `main.js` is a single file of global state and DOM handlers, using `window.__TAURI__` (`withGlobalTauri: true`).
- Image bytes go to Rust as plain arrays. Crop is applied client-side on a canvas, and the result is re-encoded as
  PNG and becomes the new original. The mask is painted on an offscreen canvas at the image's natural resolution
  and sent as a PNG.
- Any settings change calls `scheduleProcess`, which debounces by 100 ms. Calls arriving while processing is
  running are coalesced.
- `main.js` detects the platform from the user agent and sets `body.is-mac` or `body.is-android`. iOS is excluded
  from `is-mac`. `styles.css` has shared layout and components driven by tokens, plus two overrides:
  - `body.is-mac` follows the macOS HIG: WebKit `-apple-system-*` colors, native controls and a unified toolbar
    under the traffic lights (`titleBarStyle: Overlay` in `tauri.conf.json`).
  - `body.is-android` follows Material 3: `--md-*` color tokens, plus a ripple effect, slider and switch built in CSS.
- i18n: `src/i18n/{en,pl}.json` with `data-i18n` and `data-i18n-attr` attributes. `data-i18n-mac` and
  `data-i18n-android` give per-platform keys. Polish plural forms for the count are handled in `updateCount`.
  Add new keys to both files.

**Android native bridge**

- `src-tauri/gen/android/.../MainActivity.kt` is hand-maintained.
- `.../generated/` is regenerated by Tauri and gitignored, so don't edit it.
- `MainActivity` exposes a `window.Android` JS interface, for example `openCamera()`. The camera result returns
  through `window.onCameraResult(dataUrl)`.
- `main.js` also calls these optional bridge methods, each guarded by `typeof` checks:
  - `getMaterialThemeCss()`
  - `getSystemInsets()`
  - `setBackEnabled(bool)`
  - `setEditing(bool)`
- Kotlin calls back into JS through `window.onAndroidBack()` and `window.onAndroidInsets(insets)`.
- The Android app theme is in `gen/android/app/src/main/res/values{,-night}/themes.xml`.
