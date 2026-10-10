#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/application.AppImage" >&2
  exit 2
fi

appimage="$1"
test -f "$appimage"
test -x "$appimage"

offset="$("$appimage" --appimage-offset)"
if ! [[ "$offset" =~ ^[0-9]+$ ]] || [ "$offset" -le 0 ]; then
  echo "Unable to read the type-2 AppImage SquashFS offset." >&2
  exit 1
fi

verify_dir="$(mktemp -d)"
trap 'rm -rf "$verify_dir"' EXIT
unsquashfs -q -o "$offset" -d "$verify_dir/root" "$appimage" >/dev/null

for launcher in AppRun AppRun.wrapped; do
  launcher_path="$verify_dir/root/$launcher"
  if [ "$launcher" = "AppRun" ] || [ -e "$launcher_path" ]; then
    test -f "$launcher_path"
    mode="$(stat -c '%a' "$launcher_path")"
    if [ $((8#$mode & 0111)) -ne $((8#0111)) ]; then
      echo "$launcher is not executable by owner, group and other users (mode $mode)." >&2
      exit 1
    fi
    echo "$launcher mode: $mode"
  fi
done

max_glibc="$({
  find "$verify_dir/root" -type f -print0 \
    | xargs -0 -r grep -aohE 'GLIBC_[0-9]+\.[0-9]+' 2>/dev/null \
    | sort -Vu \
    | tail -n 1
} || true)"
if [ -z "$max_glibc" ]; then
  echo "No GLIBC symbol requirement was found in the extracted AppImage." >&2
  exit 1
fi
if [ "$(printf '%s\n%s\n' 'GLIBC_2.35' "$max_glibc" | sort -V | tail -n 1)" != "GLIBC_2.35" ]; then
  echo "AppImage requires $max_glibc, newer than the supported GLIBC_2.35 baseline." >&2
  exit 1
fi
echo "Maximum required glibc symbol: $max_glibc"

set +e
APPIMAGE_EXTRACT_AND_RUN=1 timeout 12s xvfb-run -a "$appimage" \
  >"$verify_dir/launch.log" 2>&1
launch_status=$?
set -e

if [ "$launch_status" -ne 124 ]; then
  cat "$verify_dir/launch.log" >&2
  echo "AppImage exited before the 12-second smoke-test window (status $launch_status)." >&2
  exit 1
fi

echo "AppImage stayed alive for the complete smoke-test window."
