#!/usr/bin/env bash
# Builds the web version into target/web: the frontend from src/ plus OpenCV.js, which
# counts the birds in the browser (src/detector.js, a port of blob_filter.rs).
#
#   ./build_web.sh           build target/web
#   ./build_web.sh --serve   build, then serve it at http://localhost:8000
set -euo pipefail

cd "$(dirname "$0")"

# The official OpenCV.js 5.0.0 build, as packaged on npm (UMD wrapper fixed for workers).
OPENCV_JS_URL="https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js"
OPENCV_JS_SHA256="b873c8211421da7b9bf41ae157a923f05a46a0b8d3e5904c44c6f3ad6d39a1bd"
OPENCV_JS="target/opencv-js/opencv-5.0.0.js"
OUT="target/web"

serve=false
for arg in "$@"; do
  case "$arg" in
    --serve) serve=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

if [[ ! -f "$OPENCV_JS" || "$(sha256 "$OPENCV_JS")" != "$OPENCV_JS_SHA256" ]]; then
  echo "Downloading OpenCV.js..."
  mkdir -p "$(dirname "$OPENCV_JS")"
  curl -fsSL -o "$OPENCV_JS.tmp" "$OPENCV_JS_URL"
  if [[ "$(sha256 "$OPENCV_JS.tmp")" != "$OPENCV_JS_SHA256" ]]; then
    echo "OpenCV.js checksum mismatch" >&2
    rm -f "$OPENCV_JS.tmp"
    exit 1
  fi
  mv "$OPENCV_JS.tmp" "$OPENCV_JS"
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R src/. "$OUT/"
rm -f "$OUT/.DS_Store"
mkdir -p "$OUT/vendor"
cp "$OPENCV_JS" "$OUT/vendor/opencv.js"
echo "Built $OUT"

if $serve; then
  echo "Serving at http://localhost:8000"
  exec python3 -m http.server 8000 --bind 127.0.0.1 --directory "$OUT"
fi
