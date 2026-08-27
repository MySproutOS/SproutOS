#!/usr/bin/env bash
# Build input -> a Lambda external-extension layer with the one path Lambda discovers.
set -euo pipefail

binary=${1:?usage: package-log-extension.sh <aarch64-musl-binary> <output.zip>}
output=${2:?usage: package-log-extension.sh <aarch64-musl-binary> <output.zip>}

[ -x "$binary" ] || { echo "log extension is missing or not executable: $binary" >&2; exit 1; }
file "$binary" | grep -Eq 'ELF 64-bit LSB.*(ARM aarch64|ARM64)' || {
  echo "log extension is not an AArch64 ELF executable: $(file "$binary")" >&2
  exit 1
}
if readelf -l "$binary" | grep -q 'INTERP'; then
  echo "log extension has a dynamic interpreter; Lambda does not contain this musl runtime" >&2
  exit 1
fi

stage=$(mktemp -d)
verify=$(mktemp -d)
trap 'rm -rf "$stage" "$verify"' EXIT
mkdir -p "$stage/extensions"
install -m 0755 "$binary" "$stage/extensions/log-extension"

output_dir=$(dirname "$output")
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
output="$output_dir/$(basename "$output")"
(cd "$stage" && zip -q -X "$output" extensions/log-extension)

[ "$(zipinfo -1 "$output")" = 'extensions/log-extension' ] || {
  echo "layer must contain only extensions/log-extension" >&2
  exit 1
}
unzip -q "$output" -d "$verify"
[ -x "$verify/extensions/log-extension" ] || {
  echo "layer archive lost the extension executable bit" >&2
  exit 1
}
cmp "$binary" "$verify/extensions/log-extension"
