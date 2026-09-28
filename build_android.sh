#!/bin/bash
# Build script for Android that sets OpenCV environment variables correctly
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCV_SDK="$SCRIPT_DIR/src-tauri/opencv-android-sdk/sdk/native"
ANDROID_PROJECT_DIR="$SCRIPT_DIR/src-tauri/gen/android"
KEYSTORE_PROPS_FILE="$ANDROID_PROJECT_DIR/keystore.properties"

# Export OpenCV environment variables for the opencv-rust crate
export OPENCV_VERSION="5.0.0"
export OPENCV_STATIC="1"
export OPENCV_INCLUDE_PATHS="$OPENCV_SDK/jni/include"
export OPENCV_DISABLE_PROBES="pkg_config,cmake,vcpkg_cmake,vcpkg"

# OpenCV libraries used by the app (in dependency order); must match the crate features in Cargo.toml
export OPENCV_LINK_LIBS="opencv_imgcodecs,opencv_geometry,opencv_imgproc,opencv_core"

# Fail fast for release builds if signing is not configured.
# Supported config sources:
# 1) Local file: src-tauri/gen/android/keystore.properties
# 2) Env vars: ANDROID_KEYSTORE_FILE, ANDROID_KEY_ALIAS, ANDROID_STORE_PASSWORD/ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_PASSWORD/ANDROID_KEYSTORE_PASSWORD
has_signing_config="0"
if [ -f "$KEYSTORE_PROPS_FILE" ]; then
    has_signing_config="1"
elif [ -n "$ANDROID_KEYSTORE_FILE" ] && [ -n "$ANDROID_KEY_ALIAS" ] && \
     { [ -n "$ANDROID_STORE_PASSWORD" ] || [ -n "$ANDROID_KEYSTORE_PASSWORD" ]; } && \
     { [ -n "$ANDROID_KEY_PASSWORD" ] || [ -n "$ANDROID_KEYSTORE_PASSWORD" ]; }; then
    has_signing_config="1"
fi

if [ "$has_signing_config" != "1" ]; then
    echo "Error: Android release signing is not configured."
    echo "Create $KEYSTORE_PROPS_FILE from keystore.properties.example, or set ANDROID_* signing env vars."
    exit 1
fi

# Check if a specific target was requested
if [ "$1" == "--target" ] && [ -n "$2" ]; then
    TARGET=$2
    shift 2
    case "$TARGET" in
        aarch64-linux-android|aarch64)
            TAURI_TARGET="aarch64"
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/arm64-v8a"
            ;;
        armv7-linux-androideabi|armv7)
            TAURI_TARGET="armv7"
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/armeabi-v7a"
            ;;
        x86_64-linux-android|x86_64)
            TAURI_TARGET="x86_64"
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/x86_64"
            ;;
        i686-linux-android|i686|x86)
            TAURI_TARGET="x86"
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/x86"
            ;;
        *)
            echo "Unknown target: $TARGET"
            echo "Supported targets: aarch64, armv7, x86_64, x86 (or full target triples)"
            exit 1
            ;;
    esac
else
    # Default: build for aarch64 (most common modern Android devices)
    TAURI_TARGET="aarch64"
    export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/arm64-v8a"
fi

echo "Building for Android with OpenCV..."
echo "  OPENCV_LINK_PATHS=$OPENCV_LINK_PATHS"
echo "  OPENCV_INCLUDE_PATHS=$OPENCV_INCLUDE_PATHS"

# Run the actual build command (same as your Makefile)
cargo tauri android build --apk true --target "$TAURI_TARGET" "$@"
