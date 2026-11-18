#!/bin/sh
# Builds open-typeless and installs it as Handy's transcription hook (Handy 0.10.0 or newer).
# Handy then passes every transcript through it just before pasting.
set -eu

cd "$(dirname "$0")/.."
bin_dir="${OPEN_TYPELESS_BIN_DIR:-$HOME/.local/bin}"
handy_dir="${HANDY_DATA_DIR:-$HOME/Library/Application Support/com.pais.handy}"

if [ ! -d "$handy_dir" ]; then
    echo "Handy's data folder was not found at: $handy_dir" >&2
    echo "Install and open Handy once, then run this again." >&2
    exit 1
fi

cargo build --release
mkdir -p "$bin_dir" "$handy_dir/hooks"
install -m 755 target/release/open-typeless "$bin_dir/open-typeless"
ln -sf "$bin_dir/open-typeless" "$handy_dir/hooks/transcription"

echo "Installed $bin_dir/open-typeless"
echo "Hook:     $handy_dir/hooks/transcription"
echo "Next:     $bin_dir/open-typeless check"
