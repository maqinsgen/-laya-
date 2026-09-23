#!/usr/bin/env bash
set -euo pipefail

DEPLOYMENT_TARGET="15.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_PATH="$PROJECT_DIR/native-dlls/macos/image_scan_helper.c"
ENTITLEMENTS_PATH="$PROJECT_DIR/resources/macos/image_scan_entitlements.plist"
OUTPUT_PATH="$PROJECT_DIR/resources/macos/image_scan_helper.macos15"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ciphertalk-image-scan.XXXXXX")"

cleanup() {
  rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT

for arch in arm64 x86_64; do
  xcrun --sdk macosx clang \
    -arch "$arch" \
    -mmacosx-version-min="$DEPLOYMENT_TARGET" \
    -O2 \
    -Wall \
    -Wextra \
    "$SOURCE_PATH" \
    -o "$BUILD_ROOT/image_scan_helper-$arch"
done

lipo -create \
  "$BUILD_ROOT/image_scan_helper-arm64" \
  "$BUILD_ROOT/image_scan_helper-x86_64" \
  -output "$OUTPUT_PATH"
chmod +x "$OUTPUT_PATH"
codesign --force --sign - --entitlements "$ENTITLEMENTS_PATH" "$OUTPUT_PATH"
codesign --verify --strict --verbose=2 "$OUTPUT_PATH"
vtool -show-build "$OUTPUT_PATH"
shasum -a 256 "$OUTPUT_PATH"
