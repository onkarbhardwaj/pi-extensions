#!/bin/sh
# Builds the meetings helper as a small macOS app bundle, so macOS asks for calendar access for
# "Busywork Meetings" itself instead of for whichever terminal or app started Pi.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$here/bin/Busywork Meetings.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
swiftc -O "$here/meetings.swift" -o "$app/Contents/MacOS/meetings"
# Ad-hoc signing: macOS ties the calendar permission to this build, so a rebuild asks once more.
codesign --force --sign - "$app"
echo "Built $app"
