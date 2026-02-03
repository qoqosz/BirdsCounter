#!/bin/bash
set -e

OPENCV_VERSION="4.13.0"
SDK_DIR="src-tauri/opencv-android-sdk"
ZIP_FILE="opencv-${OPENCV_VERSION}-android-sdk.zip"
DOWNLOAD_URL="https://github.com/opencv/opencv/releases/download/${OPENCV_VERSION}/${ZIP_FILE}"

# Force remove existing SDK directory to ensure clean update
if [ -d "$SDK_DIR" ]; then
    echo "Removing existing OpenCV Android SDK in $SDK_DIR..."
    rm -rf "$SDK_DIR"
fi

echo "Downloading OpenCV ${OPENCV_VERSION} Android SDK..."
# Use curl to download the file
curl -L -o "$ZIP_FILE" "$DOWNLOAD_URL"

echo "Unzipping SDK..."
unzip -q "$ZIP_FILE"

# Move the inner folder to the expected location if needed
# The zip usually contains "OpenCV-android-sdk" folder
if [ -d "OpenCV-android-sdk" ]; then
    mkdir -p "src-tauri"
    mv "OpenCV-android-sdk" "$SDK_DIR"
elif [ -d "opencv-${OPENCV_VERSION}-android-sdk" ]; then
     mkdir -p "src-tauri"
     mv "opencv-${OPENCV_VERSION}-android-sdk" "$SDK_DIR"
fi

# Cleanup
rm "$ZIP_FILE"

echo "OpenCV Android SDK setup complete in $SDK_DIR"
