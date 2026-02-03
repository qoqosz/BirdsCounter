#!/bin/bash
# Build script for Android that sets OpenCV environment variables correctly
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCV_SDK="$SCRIPT_DIR/src-tauri/opencv-android-sdk/sdk/native"

# Export OpenCV environment variables for the opencv-rust crate
export OPENCV_VERSION="4.13.0"
export OPENCV_STATIC="1"
export OPENCV_INCLUDE_PATHS="$OPENCV_SDK/jni/include"
export OPENCV_DISABLE_PROBES="pkg_config,cmake,vcpkg_cmake,vcpkg"

# List of OpenCV libraries to link (in dependency order)
export OPENCV_LINK_LIBS="opencv_gapi,opencv_stitching,opencv_calib3d,opencv_dnn,opencv_features2d,opencv_flann,opencv_highgui,opencv_imgcodecs,opencv_imgproc,opencv_ml,opencv_objdetect,opencv_photo,opencv_video,opencv_videoio,opencv_core"

# Check if a specific target was requested
if [ "$1" == "--target" ] && [ -n "$2" ]; then
    TARGET=$2
    shift 2
    case "$TARGET" in
        aarch64-linux-android|aarch64)
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/arm64-v8a"
            ;;
        armv7-linux-androideabi|armv7)
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/armeabi-v7a"
            ;;
        x86_64-linux-android|x86_64)
            export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/x86_64"
            ;;
        i686-linux-android|i686|x86)
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
    export OPENCV_LINK_PATHS="$OPENCV_SDK/staticlibs/arm64-v8a"
fi

echo "Building for Android with OpenCV..."
echo "  OPENCV_LINK_PATHS=$OPENCV_LINK_PATHS"
echo "  OPENCV_INCLUDE_PATHS=$OPENCV_INCLUDE_PATHS"

# Run the actual build command (same as your Makefile)
cargo tauri android build --apk true --target aarch64 "$@"
