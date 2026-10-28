# BirdsCounter

Count the birds in a photo of a flock. BirdsCounter finds the sky, detects the birds against it, circles each one
and tells you how many there are. It runs in your browser, and as an app on macOS, Windows, Android and iOS, where
each platform gets its own native look.

<p align="center">
  <a href="https://qoqosz.github.io/BirdsCounter/"><img alt="Try it in your browser" width="316" src="https://img.shields.io/badge/%E2%96%B6%20%20Try%20it%20in%20your%20browser-2ea44f?style=for-the-badge"></a>
  <a href="https://github.com/qoqosz/BirdsCounter/releases/latest"><img alt="Download the apps" width="243" src="https://img.shields.io/badge/Download%20the%20apps-0969da?style=for-the-badge"></a>
</p>
<p align="center"><sub>The web version needs no install, and your photos never leave your device: they are counted in the browser.</sub></p>

<p align="center"><img src="images/screenshots/macos.png" width="600" alt="BirdsCounter on macOS"></p>

| Android | | iOS | |
|:---:|:---:|:---:|:---:|
| <img src="images/screenshots/android_start.png" width="200" alt="Android start screen"> | <img src="images/screenshots/android_result.png" width="200" alt="Android result"> | <img src="images/screenshots/ios_start.png" width="200" alt="iOS start screen"> | <img src="images/screenshots/ios_result.png" width="200" alt="iOS result"> |

The sample photo is [`images/flock.jpg`](images/flock.jpg). With *Only sky* on, the tree, the fields and the fence
are ignored and 53 birds are counted. Without the sky mask the landscape adds over 250 false detections.

## Download

Get the latest build from [GitHub Releases](https://github.com/qoqosz/BirdsCounter/releases):

- **Android:** `BirdsCounter_<version>_android_arm64.apk`, a signed release APK for 64-bit ARM phones.
- **macOS (Apple silicon):** `BirdsCounter_<version>_macos_aarch64.dmg`. It uses OpenCV 5 from Homebrew
  (`brew install opencv`) and is not notarized, so open it with right-click → *Open* the first time.
- **Windows (x64):** `BirdsCounter_<version>_windows_x64.exe`, a portable app in one file with OpenCV linked
  statically. Nothing to install, just run it. It uses the WebView2 runtime that comes with Windows 11 and current
  Windows 10. It is not signed, so SmartScreen may ask to confirm (*More info* → *Run anyway*).
- **iOS:** build and install from source, see [Build iOS](#build-ios).
- **Web:** [qoqosz.github.io/BirdsCounter](https://qoqosz.github.io/BirdsCounter/), nothing to install. The photos
  are counted in the browser and never leave the device. See [Web version](#web-version).

## How it works

- Rust backend (`src-tauri/`) for image processing with OpenCV
- Vanilla HTML/CSS/JS frontend (`src/`) for interaction, preview, and controls

The app loads an image, detects bird-like blobs, annotates them with circles, and returns the count.

- **Marked birds:** the eye button on the photo shows or hides the rings around the detected birds.
- **Full resolution:** the expand button (or a double click/tap on the photo) opens the photo full screen. Pinch,
  scroll or double tap to zoom down to single pixels, and drag to pan; the rings can be toggled there too.

- **Quick actions:** long-press the app icon on Android or iOS for *Take Photo* and *Choose Photo*. They appear
  after the app has run once, titled in the app's language.
- **Counting starts at once** for every photo: taken, picked, dropped, or opened from the history.
- **Crop** shows the whole photo with the crop frame. Drag a corner or an edge to resize it, drag inside to move
  it, or drag outside it to draw a new one. *Reset* goes back to the whole photo, and the crop can be changed
  again later. The mask is kept when the crop changes.
- **History** lists every photo with its latest count. Opening an entry restores its settings, crop and mask.
  Entries link to the photo instead of copying it: a file path on the desktop, the photo library on iOS (opening
  it again asks for photo access) and Android (a persisted permission). Photos taken in the app are stored in
  its own folder (iOS: *Files → BirdsCounter → Photos*) and deleted with their entry. Only a small thumbnail is
  kept per entry.

## Tech Stack

- Tauri 2.12 (`tauri`, `tauri-build`)
- Rust 2024 edition
- OpenCV 5 via `opencv` crate (`0.101`, modules `core`, `imgproc`, `imgcodecs`, `geometry`)
- Frontend: static HTML/CSS/JS (no Node bundler required)


## Detection Pipeline

`process_image` (Rust command, `src-tauri/src/blob_filter.rs`) supports three methods.

**Sky background** (`background`, default):
1. Decode image bytes, convert to grayscale (*Invert* looks for light birds on a dark background)
2. Estimate the sky: a 3×3 opening removes bright specks (sharpening halos around birds, noise peaks), then a
   morphological closing with a *local window* larger than a bird's thickness erases the birds, then box blur
3. Relative darkness (Weber contrast) `(sky − pixel) / sky` after a light Gaussian blur (*Blur*):
   birds are silhouettes, so they stand out against bright and dark clouds alike
4. Local sky texture: median absolute contrast × 1.4826 (a robust standard deviation, capped at 5%) over a window
   3× the local window; birds covering less than half of it do not raise it, so dense flocks stay detectable
5. Threshold per pixel = max(8%, *threshold* × local texture); hysteresis grows detections down to 60% of it,
   so cloud texture needs more contrast than a smooth sky
6. Connected components, radius filtering from pixel area

**Adaptive / Otsu** (classic): blur → threshold → optional inversion → morphological open/close → exclusion mask → external contours → radius filtering.

For all methods, *Only sky* (on by default) first finds the sky: the image is scaled so the local
window spans 5 px, birds are erased by a closing, and areas whose relative gradient (averaged over
~2 windows) exceeds 0.3 count as rough. The sky is the smooth area connected to the top edge plus rough
islands far from the rest (dense flocks); detections touching the rest (trees, roofs, the horizon,
fields) are dropped as a whole. If under 5% of the image is sky, the mask is skipped.

Then blobs over 25× the median detection, or over 3× when touching the image edge
(trees, roofs, lamps), are dropped. *Split merged birds* then compares every blob with the median
area of up to 12 detections of the same flock (within 12 of their own sizes) and counts it as
`round(area / reference)` birds. Single birds are circled in red, merged ones in orange with their count.

### Testing the detector

```bash
cd src-tauri
cargo test --lib
cargo run --release --example count -- --out annotated/ photo1.jpg photo2.jpg
```

The unit tests count birds on synthetic cloudy-sky scenes (faint, touching and light birds,
masks, large dark clutter, landscape below the sky). The `count` example prints the count per file and accepts
`--method`, `--sensitivity`, `--window`, `--min-radius`, `--max-radius`, `--blur`, `--invert`, `--no-split`, `--whole-image`.


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

### Desktop (macOS, Linux)

- OpenCV 5 available on host system (used by `opencv` crate probing), e.g. `brew install opencv`
- Platform dependencies required by Tauri (WebView/runtime toolchain)

Windows links OpenCV statically instead, see [Windows](#windows).

### Android

- Android SDK/NDK and Java 17 toolchain
- Generated Android project already present in `src-tauri/gen/android`
- OpenCV Android SDK folder: `src-tauri/opencv-android-sdk`

### Windows

- Visual Studio 2022 or newer with the *Desktop development with C++* workload, CMake and LLVM (libclang)
- Static OpenCV at `src-tauri/opencv-windows` (built with `./setup_opencv_windows.ps1`)

### iOS (macOS only)

- Xcode 27 with the iOS SDK, and an Apple ID signed in under Xcode → Settings → Accounts
- OpenCV iOS framework at `src-tauri/opencv2.framework` (download with `./setup_opencv_ios.sh`)
- rustup's `llvm-tools` component (listed in `rust-toolchain.toml`, installed automatically)

## Run in Development (Desktop)

```bash
cargo tauri dev
```

The frontend is served from the static `src/` directory (`frontendDist: "../src"` in `tauri.conf.json`).

## Build Android

1. Download/update OpenCV Android SDK (pinned to `5.0.0`, "16kb-page-fix" package):

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

## Build Windows

Run in PowerShell on Windows x64.

1. Build OpenCV 5 from source as static libraries with the static C runtime (`/MT`), installed into
   `src-tauri/opencv-windows`. OpenCV's own Windows package has only DLLs, so it can't be used. Takes about 10 minutes:

```powershell
./setup_opencv_windows.ps1
```

2. Build:

```powershell
./build_windows.ps1
```

Output: `src-tauri/target/x86_64-pc-windows-msvc/release/birdscounter.exe`. The frontend is embedded in the exe, and
Rust is built with `crt-static` (`src-tauri/.cargo/config.toml`), so the exe needs no DLLs beyond Windows itself and
WebView2. The script fails if `dumpbin` finds imports of the dynamic C runtime or OpenCV.

## Web version

The same frontend runs in a browser, with the detector ported to JavaScript on
[OpenCV.js](https://docs.opencv.org/5.x/d5/d10/tutorial_js_root.html) 5.0:

- `src/detector.js` is a port of `blob_filter.rs`, step for step, and gives the same counts.
- `src/detector-worker.js` runs it in a Web Worker, so the page stays responsive. It decodes each photo once.
- `src/web.js` stands in for Tauri when the page is not inside the app. It answers the commands `main.js` calls:
  counting, and the history in IndexedDB. In the app it does nothing.

Differences from the apps:

- The history keeps a copy of each photo in the browser's storage, since a web page can't link to files.
  Clearing the site's data clears the history.
- The first count after the page loads waits for OpenCV.js (13 MB, cached by the browser afterwards).
- Photos over 16.7 MP are counted scaled down to that size where the browser limits canvases (Safari and iOS).

Build into `target/web` and serve it locally:

```bash
./build_web.sh --serve
```

Then open http://localhost:8000. To try it on a phone in the same network, serve `target/web` on all interfaces
(`python3 -m http.server 8000 --directory target/web`) and open the computer's address. The tests run the web
detector in Node on the synthetic scenes of the Rust tests:

```bash
node --test tests/web/*.test.cjs
```

## Build iOS

1. Download the OpenCV iOS framework:

```bash
./setup_opencv_ios.sh
```

2. Build for a device, passing your Apple team ID (shown in Xcode → Settings → Accounts):

```bash
env APPLE_DEVELOPMENT_TEAM=<team-id> ./build_ios.sh --target device
```

3. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode**. If the switch is missing, run any app
   on the phone from Xcode once. Then install:

```bash
xcrun devicectl list devices
xcrun devicectl device install app --device <device-id> src-tauri/gen/apple/build/arm64/birdscounter.ipa
```

4. The first launch needs **Settings → General → VPN & Device Management → Apple Development: … → Trust**, which
   requires an internet connection. With a free Apple ID the app has to be rebuilt and reinstalled every 7 days.

### Refreshing the certificate (every 7 days)

A free Apple ID signs the app with a certificate and profile that expire after 7 days. Then the app stops launching
(*Unable to Verify App* or an instant crash). There is nothing to renew by hand: rebuild and install over the old
copy, which keeps the app's data and history.

1. Connect the iPhone, unlock it and check that it is listed as `available (paired)`:

```bash
xcrun devicectl list devices
```

2. Rebuild. Xcode signs with a fresh certificate and profile:

```bash
env APPLE_DEVELOPMENT_TEAM=<team-id> ./build_ios.sh --target device
```

3. Install over the existing app (do not delete it first):

```bash
xcrun devicectl device install app --device <device-id> src-tauri/gen/apple/build/arm64/birdscounter.ipa
```

4. If the phone still complains, trust the profile again under **Settings → General → VPN & Device Management**.
   If the phone is not paired after an iOS update, run `xcrun devicectl manage pair --device <device-id>` and tap
   **Trust** on the phone. A new phone must be registered in the team profile first: run `xcodebuild` once with
   `-allowProvisioningUpdates -allowProvisioningDeviceRegistration` or run the app from Xcode once.

`build_ios.sh` passes the OpenCV settings to cargo as `--config env.*`, because Tauri's Xcode build phase drops
`OPENCV_*` environment variables. The Xcode project links `opencv2.framework` and the Swift 5.6 compatibility library.
The app runs only on physical devices, since the OpenCV framework has no arm64 simulator slice.

## App icons

`src-tauri/icons/icon.png` is the source. After regenerating the icons with `cargo tauri icon`, run:

```bash
./app_icons.sh
```

It fixes what `cargo tauri icon` leaves out. It pads the Android adaptive icon into the launcher's safe zone, and it
copies the iOS icons into the Xcode asset catalog.

## Releases

Publishing a GitHub release runs four workflows. Three build the apps and attach them to the release, and they can
also be run by hand for an existing tag. The fourth publishes the web version.

- [`macos-dmg.yml`](.github/workflows/macos-dmg.yml) builds the Apple silicon DMG.
- [`windows-exe.yml`](.github/workflows/windows-exe.yml) builds the portable x64 exe with `./setup_opencv_windows.ps1`
  (cached) and `./build_windows.ps1`. Run by hand without a tag, it builds the selected branch and uploads the exe as
  a workflow artifact instead (Actions → the run → *Artifacts*).
- [`android-apk.yml`](.github/workflows/android-apk.yml) builds and signs the arm64 APK with `./build_android.sh`. It
  needs the repository secrets `ANDROID_KEYSTORE_BASE64` (the keystore, base64-encoded), `ANDROID_KEY_ALIAS`,
  `ANDROID_STORE_PASSWORD` and `ANDROID_KEY_PASSWORD`.
- [`web-pages.yml`](.github/workflows/web-pages.yml) builds the web version with `./build_web.sh`, runs its tests
  and deploys it to GitHub Pages. It needs *Settings → Pages → Source: GitHub Actions*. Run by hand, it deploys the
  selected branch, if the `github-pages` environment allows it (by default only the default branch).

Build outputs such as APKs and EXEs are not committed.

## Troubleshooting

- `Error: Android release signing is not configured.`
  - Configure `keystore.properties` or required `ANDROID_*` environment variables.

- OpenCV link/probe failures on desktop:
  - Ensure host OpenCV dev libraries are installed and discoverable by `opencv` crate.
  - The project targets OpenCV 5 (`pkg-config --modversion opencv5`). OpenCV 4.x is not supported:
    `contourArea`/`moments` live in the `geometry` module, which only exists in OpenCV 5.

- Windows link errors such as `LNK2038` (runtime library mismatch):
  - OpenCV, the crate's C++ wrapper and Rust must all use the static CRT (`/MT`). Re-run
    `./setup_opencv_windows.ps1` to rebuild OpenCV, then build with `./build_windows.ps1`, which sets
    `OPENCV_MSVC_CRT=static` and checks the exe's imports.

- iOS OpenCV link errors:
  - Verify `src-tauri/opencv2.framework` exists and is valid for selected architecture; re-run `./setup_opencv_ios.sh`.

- Camera does not open on Linux desktop:
  - `open_camera` tries `gnome-photos`, `cheese`, then `ffplay`; install one of them or use gallery input.
