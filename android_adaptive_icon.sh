#!/bin/bash
# Regenerate the Android adaptive icon foreground from src-tauri/icons/icon.png.
#
# Launchers mask adaptive icons to the inner ~66 of their 108 dp, but `cargo tauri icon` fills the whole
# canvas with the logo, so the bird and the ring get cropped. This scales the logo to 66 dp and centers it
# on a transparent 108 dp canvas. Run it again after `cargo tauri icon`. Needs ImageMagick.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/src-tauri/icons/icon.png"
RES="$SCRIPT_DIR/src-tauri/gen/android/app/src/main/res"

if ! command -v magick >/dev/null; then
    echo "Error: ImageMagick not found (brew install imagemagick)"
    exit 1
fi

# density:scale (px per dp)
for entry in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
    density="${entry%%:*}"
    scale="${entry##*:}"
    canvas=$(awk "BEGIN { print int(108 * $scale) }")
    logo=$(awk "BEGIN { print int(66 * $scale) }")
    out="$RES/mipmap-$density/ic_launcher_foreground.png"
    magick "$SOURCE" -background none -resize "${logo}x${logo}" -gravity center -extent "${canvas}x${canvas}" \
        -strip "$out"
    echo "  $out (${canvas}px, logo ${logo}px)"
done
