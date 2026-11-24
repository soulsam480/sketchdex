#!/bin/sh
set -eu

REPO="soulsam480/sketchdex"
PREFIX="${SKETCHDEX_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/share/sketchdex"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

version="${SKETCHDEX_VERSION:-}"
version="${version#v}"
if [ -z "$version" ]; then
  latest=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
  version=$(printf '%s' "$latest" |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
fi
[ -n "$version" ] || { echo "could not find the latest release" >&2; exit 1; }

tag="v$version"
asset="sketchdex-$version-$os-$arch.tar.gz"
url="https://github.com/$REPO/releases/download/$tag/$asset"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading $asset"
curl -fsSL "$url" -o "$tmp/$asset"
curl -fsSL "$url.sha256" -o "$tmp/$asset.sha256"
expected=$(awk '{print $1}' "$tmp/$asset.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
  actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
fi
[ "$expected" = "$actual" ] || {
  echo "checksum mismatch for $asset" >&2
  exit 1
}

tar -xzf "$tmp/$asset" -C "$tmp"
root="$tmp/sketchdex-$version-$os-$arch"
[ -x "$root/sketchdex" ] || {
  echo "archive does not contain sketchdex" >&2
  exit 1
}

mkdir -p "$BIN_DIR" "$LIB_DIR"
cp "$root/sketchdex" "$LIB_DIR/sketchdex.new"
chmod 755 "$LIB_DIR/sketchdex.new"
mv "$LIB_DIR/sketchdex.new" "$LIB_DIR/sketchdex"
rm -rf "$LIB_DIR/dist"
cp -R "$root/dist" "$LIB_DIR/dist"

cat > "$BIN_DIR/sketchdex" <<EOF
#!/bin/sh
export SKETCHDEX_ASSETS="$LIB_DIR/dist"
exec "$LIB_DIR/sketchdex" "\$@"
EOF
chmod 755 "$BIN_DIR/sketchdex"

echo "sketchdex $version installed at $BIN_DIR/sketchdex"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add $BIN_DIR to PATH" ;;
esac
if [ -z "${SKETCHDEX_BROWSER:-}" ]; then
  echo "set SKETCHDEX_BROWSER to a Chromium binary before using render_scene"
fi
