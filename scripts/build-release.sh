#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

version=$(node -p "require('./package.json').version")
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "build-release: unsupported operating system $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "build-release: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

out=$(mktemp -d)
stage="$out/sketchdex-$version-$os-$arch"

npm run build
npm run build:server

mkdir -p "$stage"
cp bin/sketchdex "$stage/sketchdex"
cp -R dist "$stage/dist"
cp README.md BRIEF.md install.sh "$stage/"

if [ "$os" = darwin ]; then
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    codesign --force --options runtime --timestamp \
      --sign "$APPLE_SIGNING_IDENTITY" "$stage/sketchdex"
  else
    echo "build-release: APPLE_SIGNING_IDENTITY is unset; using an ad-hoc signature" >&2
    codesign --force --sign - "$stage/sketchdex"
  fi
  codesign --verify --verbose=2 "$stage/sketchdex"
fi

tarball="$out/sketchdex-$version-$os-$arch.tar.gz"
tar -czf "$tarball" -C "$out" "sketchdex-$version-$os-$arch"
binary="$out/sketchdex-$os-$arch-$version"
cp "$stage/sketchdex" "$binary"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$tarball" > "$tarball.sha256"
  shasum -a 256 "$binary" > "$binary.sha256"
else
  sha256sum "$tarball" > "$tarball.sha256"
  sha256sum "$binary" > "$binary.sha256"
fi

echo "$tarball"
echo "$binary"
