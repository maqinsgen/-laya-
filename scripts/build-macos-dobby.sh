#!/usr/bin/env bash
set -euo pipefail

DOBBY_COMMIT="5dfc8546954ce3b3198132ab13fddb89ee92cdd7"
DEPLOYMENT_TARGET="15.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ciphertalk-dobby.XXXXXX")"
SOURCE_DIR="$BUILD_ROOT/source"
ARCHIVE_PATH="$BUILD_ROOT/dobby.tar.gz"
OUTPUT_PATH="$PROJECT_DIR/resources/macos/libdobby.macos15.dylib"

cleanup() {
  rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT

command -v cmake >/dev/null || {
  echo "cmake is required (brew install cmake)" >&2
  exit 1
}

mkdir -p "$SOURCE_DIR"
curl -fL "https://codeload.github.com/jmpews/Dobby/tar.gz/$DOBBY_COMMIT" -o "$ARCHIVE_PATH"
tar -xf "$ARCHIVE_PATH" -C "$SOURCE_DIR" --strip-components=1

for arch in arm64 x86_64; do
  build_dir="$BUILD_ROOT/build-$arch"
  cmake \
    -S "$SOURCE_DIR" \
    -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
    -DDOBBY_BUILD_EXAMPLE=OFF \
    -DDOBBY_BUILD_TEST=OFF
  cmake --build "$build_dir" --config Release --target dobby --parallel 8
done

lipo -create \
  "$BUILD_ROOT/build-arm64/libdobby.dylib" \
  "$BUILD_ROOT/build-x86_64/libdobby.dylib" \
  -output "$OUTPUT_PATH"
codesign --force --sign - "$OUTPUT_PATH"
codesign --verify --strict --verbose=2 "$OUTPUT_PATH"
vtool -show-build "$OUTPUT_PATH"
shasum -a 256 "$OUTPUT_PATH"
