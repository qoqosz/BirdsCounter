# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

BirdsCounter is a Tauri 2 app (Android, iOS) that counts birds in a photo. A Rust backend does the detection with
OpenCV 5. The frontend is static HTML/CSS/JS in `src/`, with no bundler and no npm. The same frontend is also a web
page (GitHub Pages) that counts in the browser with OpenCV.js. The web page is the only version for computers: there
are no desktop apps, and `cargo test` and the `count` example are the only things that run natively on the host.

## Commands

All Rust commands run from `src-tauri/`, except the build scripts, which run from the repo root.

```bash
cd src-tauri && cargo test --lib     # detector unit tests (synthetic cloudy-sky scenes)
cd src-tauri && cargo test --lib <test_name>   # run a single test in blob_filter::tests
cd src-tauri && cargo run --release --example count -- --out annotated/ photo1.jpg photo2.jpg
cd src-tauri && cargo clippy && cargo fmt
./build_android.sh --target aarch64  # release APK (also: make android); targets aarch64|armv7|x86_64|x86
./build_ios.sh --target sim          # iOS (sim | x86_64 | device)
./app_icons.sh                       # copy the icon into the Android/iOS projects (run after `cargo tauri icon`)
./build_web.sh --serve               # web version into target/web (downloads OpenCV.js), served at localhost:8000
node --test tests/web/*.test.cjs     # web detector tests (after ./build_web.sh, which fetches OpenCV.js)
```

Publishing a GitHub release runs `.github/workflows/android-apk.yml`, which builds the signed arm64 APK from the
`ANDROID_*` repository secrets and attaches it to the release, and `.github/workflows/web-pages.yml`, which builds the
web version, runs its tests and deploys it to GitHub Pages. Don't commit APKs or other build outputs.

When creating a new release:

1. Collect all the changes since the previous release (for example with `git log <previous-tag>..HEAD`).
2. Name the release "BirdsCounter vX.Y.Z", where X.Y.Z is the actual version number.
3. Give the release notes two sections, Changes and Downloads, like the previous releases.

The `count` example is the quickest way to tune the detector on real photos. It prints the count per file and
accepts `--method`, `--sensitivity`, `--window`, `--min-radius`, `--max-radius`, `--blur`, `--invert`, `--no-split` and
`--whole-image` (disables the sky mask).

The Rust toolchain is pinned to 1.92.0 in `rust-toolchain.toml`.

## OpenCV linking (the usual source of build failures)

- **OpenCV 5 only.** `contourArea` and `moments` live in the `geometry` module, which does not exist in 4.x.
  The crate features in `Cargo.toml` (`geometry`, `imgcodecs`, `imgproc`) must match `OPENCV_LINK_LIBS` in
  `build_android.sh`.
- **Host (tests and the `count` example):** uses the host OpenCV through pkg-config (`opencv5`).
  `src-tauri/.cargo/config.toml` disables the `environment` probe on darwin targets, so the iOS framework variables
  don't leak into host builds.
- **Android:** static libs from `src-tauri/opencv-android-sdk`, downloaded by `./setup_opencv_android.sh` (the
  "16kb-page-fix" package, required by Google Play). `build_android.sh` sets the `OPENCV_*` variables.
  `src-tauri/build.rs` adds link paths and only the third-party archives the SDK actually ships, plus the NDK system
  libs. Release builds fail fast unless signing is configured, through `gen/android/keystore.properties` or the
  `ANDROID_*` environment variables.
- **iOS:** `src-tauri/opencv2.framework`, downloaded by `./setup_opencv_ios.sh`. The Rust code is compiled inside
  Xcode's "Build Rust Code" phase, and `tauri ios xcode-script` forwards only `TAURI*`/`CARGO_*`/`RUST_*` variables,
  so `build_ios.sh` passes the `OPENCV_*` settings as `cargo --config env.*`. The Xcode project links
  `opencv2.framework` and `libswiftCompatibility56` itself. `src-tauri/vendor/swift-rs` is patched so Tauri's
  Swift runtime symbols link under Xcode 27; it needs rustup's `llvm-tools` component.

## Architecture

**Rust (`src-tauri/src/`)**

- `lib.rs` registers the Tauri commands:
  - `load_photo` takes the photo as the raw request body (`invoke("load_photo", bytes)`), decodes it once to
    grayscale and keeps it (one photo at a time) under the id it returns, so settings changes don't send it
    again. `countBirds` in `main.js` sends it only when it changes, and again after `photo-missing`.
  - `process_image` takes `photoId`, `params`, `crop` and the mask in one raw body (`framedBody` in `main.js`,
    `split_framed` in `lib.rs`) and returns `{ birds, count }`, where `birds` lists the
    detections (`x`, `y`, `radius`, `count`) in pixels of the whole photo. `crop` is a rectangle in photo pixels. The
    mask covers the whole photo (at any resolution, Rust scales it), and Rust crops it too. The frontend draws the
    rings; `BlobFilter::apply` still returns an annotated PNG for the `count` example.
  - `history.rs`: `history_*` commands and `read_image`. The history is `history.json` plus `thumbs/` and `masks/`
    in the app data dir. Entries link to the photo through a `source` string (`file:`, `appdoc:`, `content://`
    or `photos:`, see the module docs) instead of copying it. Photos the app took (`owned`, named
    `BirdsCounter_*`) are deleted with their entry.
  - `native.rs`: the iOS camera, photo library picker, photos opened from other apps (document type
    `public.image` in `Info.plist`, and the Share extension `gen/apple/BirdsCounterShare`, which leaves the image in the
    App Group `group.com.birdscounter.app` and opens `birdscounter://shared`; `BCNativeBridge` also imports it whenever
    the app becomes active, reports it as request 0, and Rust emits `shared-photo`) and home screen quick actions.
    The extension target is hand-added to the `.pbxproj` (don't regenerate it with xcodegen). It calls the Objective-C class
    `BCNativeBridge` (`gen/apple/Sources/birdscounter/BCNativeBridge.m`, hand-maintained, listed in the
    `.pbxproj`) by name at runtime. `native::install` must run between `build()` and `run()` in `lib.rs`, so it
    can hook Tao's `AppDelegate`/`TaoSceneDelegate` before a quick action launches the app. On other platforms
    the commands report that they are unsupported.
- Sharing (iOS and Android only): `shareCurrentResult` (header ⋮ menu and viewer button) and `shareHistoryEntry` (history
  rows, which count again with the entry's settings) compose a JPEG with `composeShareImage` (photo, rings if shown,
  black bar with the count). iOS: `native_share_image` writes it to the temp dir and `+[BCNativeBridge shareFile:]`
  opens `UIActivityViewController`. Android: `window.Android.shareImage(base64, name)` uses the FileProvider cache path.
- `blob_filter.rs` holds the whole detector. `BlobParams` is deserialized from the JS object built in
  `readParamsFromUI()` in `main.js`, so field names must stay in sync on both sides. Threshold methods:
  - `background` (default): sky estimation and Weber contrast with texture-adaptive hysteresis.
  - `adaptive` and `otsu`: the classic pipeline.
- With `sky_only` (default), `landscape_mask` runs before both methods. Candidate components that touch
  non-sky areas are dropped whole by `drop_touching`, while the user's painted mask only cuts them. Its
  thresholds are the `SKY_*` constants, in units of a downscaled copy where the local window is 5 px.
- Post-processing is shared by all methods. `drop_clutter` removes oversized and edge-touching blobs, and
  `split_merged` counts merged birds as `round(area / flock median)`. `docs/processing.md` has the details.

**Frontend (`src/`)**

- `main.js` is a single file of global state and DOM handlers, using `window.__TAURI__` (`withGlobalTauri: true`).
- Commands that take bytes (`load_photo`, `process_image`, `history_save`, `native_share_image`) take raw request
  bodies (`request_bytes` in `lib.rs`; Android has no raw bodies, so Tauri sends them as JSON arrays there).
- Every photo goes through `openImage()`, which counts it at once. Crop is non-destructive: `cropRect` (photo pixels) goes to Rust, and crop mode shows the whole photo with the frame.
  The mask is painted on an offscreen canvas covering the whole photo, capped at `MASK_MAX_PIXELS` (full-resolution
  canvases made every stroke slow on iOS, which also refuses canvases over 16.7 MP), so it survives crop changes,
  and is sent as a PNG. A stroke paints only its own segment on the overlay; `renderMaskPreview` redraws all of
  it only when the view changes.
- The editor shows a scaled-down copy of the photo (`PREVIEW_SIZE`) with the rings on `#birdCanvas`. The
  eye button above the photo hides them (`showRings`, kept in `localStorage`). While scrolling, the header's edge
  shrinks the count above the photo, and once it is gone `#countBelow` shows it as plain text under the photo
  (`updateCountPosition`, `body.is-count-below`). Under the photo are Crop,
  Mask and Detection (opens the settings, open by default). The header's ⋮ menu has Language and, on iOS and
  Android, Share. The full resolution viewer (`#photoViewer`, opened by
  its button or a double click/tap) draws the visible part of the photo and the rings on one canvas per frame;
  pinch, drag, ctrl/⌘ + wheel and double tap zoom and pan.
- History: each opened photo gets one entry. `queueHistorySave` updates it after each result, saves are chained
  and keyed by `editSession`, and saves that change nothing are skipped.
- Any settings change calls `scheduleProcess`, which debounces by 100 ms. Calls arriving while processing is
  running are coalesced.
- `main.js` detects the platform from the user agent and sets `body.is-android` or `body.is-ios`. `styles.css` has
  shared layout and components driven by tokens, plus two overrides:
  - `body.is-android` follows Material 3: `--md-*` color tokens, plus a ripple effect, slider and switch built in CSS.
  - `body.is-ios` follows the iOS HIG: 44 pt targets, capsule buttons, inset grouped settings and native WebKit
    switches. Avoid nested `backdrop-filter` (it hides the sticky header's content in WebKit). Preview it in
    Simulator Safari, which uses the same WebKit as the app's WKWebView.
- i18n: `src/i18n/{en,pl}.json` with `data-i18n` and `data-i18n-attr` attributes. `data-i18n-web`
  (desktop browsers), `data-i18n-android` and `data-i18n-ios` give per-platform keys. Polish plural forms for the count are handled in `birdsSuffix`.
  Add new keys to both files.

**Web version**

- `index.html` loads `web.js` before `main.js`. Without `window.__TAURI__` it installs a stand-in with `core.invoke`
  and sets `window.__BIRDS_WEB__` (`isWeb` in `main.js`). It handles `load_photo` and `process_image`, the `history_*` commands and
  `read_image` (IndexedDB, with a copy of each photo under a `web:` source) and `web_keep_photo`. `main.js` passes
  arguments as they are there, with bytes as `Uint8Array`. Desktop browsers get the default look, with no camera button and with drag and drop.
- `src/detector.js` ports `blob_filter.rs` to OpenCV.js 5.0. **Keep the two in sync**: constants, steps and their
  order match, and `tests/web/detector.test.cjs` mirrors the Rust tests. `detector-worker.js` runs it in a worker
  and decodes the photo with `createImageBitmap` (gray with OpenCV's fixed-point weights; scaled down over 16.7 MP
  where canvases are limited). The painted mask is read by its alpha.
- Paths must stay relative (the site lives under `/BirdsCounter/`). OpenCV.js comes from npm
  (`@techstark/opencv-js`, checksum pinned in `build_web.sh`) and is not committed.

**Android native bridge**

- `src-tauri/gen/android/.../MainActivity.kt` is hand-maintained.
- `.../generated/` is regenerated by Tauri and gitignored, so don't edit it.
- `MainActivity` exposes a `window.Android` JS interface:
  - `openCamera()` and `pickImage()` (photo picker; the permission is persisted for the history).
  - `takePendingResult()`: the result waits in Kotlin, and `window.onNativeImageReady()` tells the page to take
    it. The page also takes it on load, so a photo taken before the page loaded is not lost.
  - `readImage(source)`, used by the history.
  - Sharing a photo to the app (`ACTION_SEND`, `image/*`) copies it to `BirdsCounter_*.jpg` and delivers it like a
    camera photo.
  - `setQuickActions(json)`: dynamic shortcuts that start `ACTION_TAKE_PHOTO` or `ACTION_CHOOSE_PHOTO`.
- Camera photos are kept in `getExternalFilesDir(Pictures)` as `BirdsCounter_*.jpg`.
- `main.js` also calls these optional bridge methods, each guarded by `typeof` checks:
  - `getMaterialThemeCss()`
  - `getSystemInsets()`
  - `setBackEnabled(bool)`
  - `setEditing(bool)`
- Kotlin calls back into JS through `window.onAndroidBack()` and `window.onAndroidInsets(insets)`.
- The Android app theme is in `gen/android/app/src/main/res/values{,-night}/themes.xml`.
