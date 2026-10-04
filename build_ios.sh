#!/bin/bash
# Build script for iOS that sets OpenCV environment variables correctly
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# OpenCV for iOS framework
OPENCV_IOS_FRAMEWORK="$SCRIPT_DIR/src-tauri/opencv2.framework"

# Disable OpenCV probes to prevent linking against macOS Homebrew installation
export OPENCV_DISABLE_PROBES="pkg_config,cmake,vcpkg_cmake,vcpkg"

# Configure OpenCV environment variables for iOS
# (paths point at the directory containing opencv2.framework; the crate resolves Headers itself)
export OPENCV_VERSION="5.0.0"
export OPENCV_LINK_LIBS="opencv2.framework"
export OPENCV_LINK_PATHS="$(dirname "$OPENCV_IOS_FRAMEWORK")"
export OPENCV_INCLUDE_PATHS="$(dirname "$OPENCV_IOS_FRAMEWORK")"

# The Rust code is compiled inside Xcode's "Build Rust Code" phase, and
# `cargo tauri ios xcode-script` only forwards TAURI*/CARGO_*/RUST_* variables
# to cargo. Pass the OpenCV settings as cargo config so they survive that.
CARGO_OPENCV_ENV=()
for var in OPENCV_DISABLE_PROBES OPENCV_VERSION OPENCV_LINK_LIBS OPENCV_LINK_PATHS OPENCV_INCLUDE_PATHS; do
    CARGO_OPENCV_ENV+=(--config "env.$var=\"${!var}\"")
done

# Check if a specific target was requested
if [ "$1" == "--target" ] && [ -n "$2" ]; then
    TARGET=$2
    shift 2
    case "$TARGET" in
        aarch64-apple-ios-sim|aarch64-sim|sim)
            echo "Building for iOS Simulator (Apple Silicon)..."
            TAURI_TARGET="aarch64-sim"
            ;;
        x86_64-apple-ios|x86_64|x86-sim)
            echo "Building for iOS Simulator (Intel)..."
            TAURI_TARGET="x86_64"
            ;;
        aarch64-apple-ios|aarch64|device)
            echo "Building for iOS Device (ARM64)..."
            TAURI_TARGET="aarch64"
            ;;
        *)
            echo "Unknown target: $TARGET"
            echo "Supported targets: aarch64-sim (or sim), x86_64 (or x86-sim), aarch64 (or device)"
            exit 1
            ;;
    esac
else
    # Default: build for aarch64 simulator (Apple Silicon Macs)
    TAURI_TARGET="aarch64-sim"
fi

echo "Building for iOS with target: $TAURI_TARGET"
echo "  OPENCV_DISABLE_PROBES=$OPENCV_DISABLE_PROBES"

# Run the actual build command
# Arguments after `--` are passed to cargo by the Xcode build phase
cargo tauri ios build --target "$TAURI_TARGET" "$@" -- "${CARGO_OPENCV_ENV[@]}"

echo ""
echo "iOS build complete!"
echo "To run on simulator, use: cargo tauri ios dev"
