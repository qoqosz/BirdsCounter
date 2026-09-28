#!/bin/bash
set -e

OPENCV_VERSION="5.0.0"
FRAMEWORK_DIR="src-tauri/opencv2.framework"
ZIP_FILE="opencv-${OPENCV_VERSION}-ios-framework.zip"
DOWNLOAD_URL="https://github.com/opencv/opencv/releases/download/${OPENCV_VERSION}/${ZIP_FILE}"

# Force remove existing framework to ensure clean update
if [ -d "$FRAMEWORK_DIR" ]; then
    echo "Removing existing OpenCV iOS framework in $FRAMEWORK_DIR..."
    rm -rf "$FRAMEWORK_DIR"
fi

echo "Downloading OpenCV ${OPENCV_VERSION} iOS framework..."
curl -L -o "$ZIP_FILE" "$DOWNLOAD_URL"

echo "Unzipping framework..."
mkdir -p "src-tauri"
unzip -q "$ZIP_FILE" -d "src-tauri"

# Cleanup
rm "$ZIP_FILE"

echo "OpenCV iOS framework setup complete in $FRAMEWORK_DIR"
