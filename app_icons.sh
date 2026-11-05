#!/bin/bash
# Put the app icon into the generated Android and iOS projects. Run it after `cargo tauri icon`, which writes
# src-tauri/icons/ but leaves gaps in the mobile projects. Needs ImageMagick.
#
# - Android: launchers mask adaptive icons to the inner ~72 of their 108 dp, but `cargo tauri icon` fills the whole
#   canvas with the logo, so the geese get cropped. The foreground gets the full-bleed logo at 72 dp, with its edges
#   extended over the outer 18 dp on each side, which launchers only show for motion effects. It is opaque, so the
#   background color in ic_launcher_background.xml doesn't show.
# - Desktop icons: `cargo tauri icon` always writes them, but nothing uses them, so they are deleted.
# - iOS: `cargo tauri icon` writes the icons straight into the Xcode asset catalog, but keeps an alpha channel. They
#   are flattened onto white in place because iOS shows transparency as black.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS="$SCRIPT_DIR/src-tauri/icons"
RES="$SCRIPT_DIR/src-tauri/gen/android/app/src/main/res"
APPICONSET="$SCRIPT_DIR/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"

if ! command -v magick >/dev/null; then
    echo "Error: ImageMagick not found (brew install imagemagick)"
    exit 1
fi

rm -f "$ICONS"/icon.icns "$ICONS"/icon.ico "$ICONS"/[0-9]*x[0-9]*.png "$ICONS"/Square*Logo.png "$ICONS"/StoreLogo.png

echo "Android adaptive icon foreground:"
# density:scale (px per dp)
for entry in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
    density="${entry%%:*}"
    scale="${entry##*:}"
    canvas=$(awk "BEGIN { print int(108 * $scale) }")
    logo=$(awk "BEGIN { print int(72 * $scale) }")
    inset=$(awk "BEGIN { print int(18 * $scale) }")
    out="$RES/mipmap-$density/ic_launcher_foreground.png"
    magick "$ICONS/icon.png" -alpha off -resize "${logo}x${logo}" -virtual-pixel edge \
        -define distort:viewport="${canvas}x${canvas}-${inset}-${inset}" -filter point -distort SRT 0 +repage -strip "$out"
    echo "  $out (${canvas}px, logo ${logo}px)"
done

echo "iOS app icon:"
for out in "$APPICONSET"/AppIcon-*.png; do
    magick "$out" -background white -alpha remove -alpha off -strip "$out"
    echo "  $out"
done
