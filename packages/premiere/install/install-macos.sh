#!/usr/bin/env bash
#
# Installs the EasyColor panel into Adobe Premiere Pro on macOS.
#
# Same two requirements as on Windows: the extension has to be in the
# per-user CEP folder, and Premiere has to be willing to load an extension
# Adobe has not signed. On macOS the second is a defaults key rather than a
# registry value, one per CEP runtime version.
#
# Nothing here needs sudo, and nothing is written outside your home folder.

set -euo pipefail

BUNDLE_ID="com.easycolor.premiere"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo
echo "EasyColor for Premiere Pro — installer"
echo

# --- locate the built extension ------------------------------------------

SOURCE="${1:-}"
if [[ -z "$SOURCE" ]]; then
  for candidate in \
    "$SCRIPT_DIR/$BUNDLE_ID" \
    "$SCRIPT_DIR/../dist/$BUNDLE_ID" \
    "$SCRIPT_DIR/dist/$BUNDLE_ID"; do
    if [[ -f "$candidate/CSXS/manifest.xml" ]]; then
      SOURCE="$candidate"
      break
    fi
  done
fi

if [[ -z "$SOURCE" || ! -f "$SOURCE/CSXS/manifest.xml" ]]; then
  echo "Could not find the built extension." >&2
  echo "Expected a folder containing CSXS/manifest.xml next to this script." >&2
  echo "If you are building from source, run:  npm run build -w @easycolor/premiere" >&2
  exit 1
fi

echo "  Source: $SOURCE"

# --- allow unsigned extensions -------------------------------------------

for version in $(seq 4 25); do
  defaults write "com.adobe.CSXS.${version}" PlayerDebugMode 1 2>/dev/null || true
done
echo "  Enabled unsigned extensions for CEP runtimes 4-25."

# --- copy into place ------------------------------------------------------

TARGET_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET="$TARGET_ROOT/$BUNDLE_ID"

mkdir -p "$TARGET_ROOT"
if [[ -d "$TARGET" ]]; then
  echo "  Removing the previous version..."
  rm -rf "$TARGET"
fi

echo "  Installing to: $TARGET"
cp -R "$SOURCE" "$TARGET"

# --- LUT folders ----------------------------------------------------------

for kind in Creative Technical; do
  lut_folder="$HOME/Library/Application Support/Adobe/Common/LUTs/$kind"
  if [[ ! -d "$lut_folder" ]]; then
    mkdir -p "$lut_folder"
    echo "  Created LUT folder: $lut_folder"
  fi
done

echo
echo "Installed."
echo
echo "Next steps:"
echo "  1. Quit Premiere Pro completely if it is running."
echo "  2. Start Premiere Pro."
echo "  3. Open  Window > Extensions > EasyColor."
echo

if pgrep -x "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro is running right now — it will not see the panel until you restart it."
  echo
fi
