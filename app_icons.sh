#!/bin/bash
# Put the app icon into the generated Android and iOS projects. Run it after `cargo tauri icon`, which writes
# src-tauri/icons/ but leaves gaps in the mobile projects. Needs ImageMagick.
#
# - Android: launchers mask adaptive icons to the inner ~66 of their 108 dp, but `cargo tauri icon` fills the
#   whole canvas with the logo, so the bird and the ring get cropped. The foreground gets the logo at 66 dp,
#   centered on a transparent 108 dp canvas.
# - iOS: the Xcode asset catalog is not updated by `cargo tauri icon` (it kept Tauri's default icon). The icons
#   from src-tauri/icons/ios are copied in, flattened onto white because iOS shows transparency as black.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS="$SCRIPT_DIR/src-tauri/icons"
RES="$SCRIPT_DIR/src-tauri/gen/android/app/src/main/res"
APPICONSET="$SCRIPT_DIR/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"

if ! command -v magick >/dev/null; then
    echo "Error: ImageMagick not found (brew install imagemagick)"
    exit 1
fi

echo "Android adaptive icon foreground:"
# density:scale (px per dp)
for entry in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
    density="${entry%%:*}"
    scale="${entry##*:}"
    canvas=$(awk "BEGIN { print int(108 * $scale) }")
    logo=$(awk "BEGIN { print int(66 * $scale) }")
    out="$RES/mipmap-$density/ic_launcher_foreground.png"
    magick "$ICONS/icon.png" -background none -resize "${logo}x${logo}" -gravity center -extent "${canvas}x${canvas}" \
        -strip "$out"
    echo "  $out (${canvas}px, logo ${logo}px)"
done

echo "iOS app icon:"
for src in "$ICONS"/ios/AppIcon-*.png; do
    out="$APPICONSET/$(basename "$src")"
    magick "$src" -background white -alpha remove -alpha off -strip "$out"
    echo "  $out"
done
