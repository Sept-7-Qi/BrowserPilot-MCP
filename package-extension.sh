#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$ROOT_DIR/extension"
DIST_DIR="${OUT_DIR:-$ROOT_DIR/dist}"
PEM_FILE="$ROOT_DIR/browserpilot-mcp-extension.pem"

usage() {
  cat <<EOF
Usage: $0 [--out DIR]

Packages only the browser extension payload.

Options:
  --out DIR   Output directory (default: ./dist, or OUT_DIR env var)
  -h, --help  Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Missing value for --out" >&2
        exit 1
      fi
      DIST_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$DIST_DIR" != /* ]]; then
  DIST_DIR="$ROOT_DIR/$DIST_DIR"
fi

UNPACKED_DIR="$DIST_DIR/extension-unpacked"
ZIP_PATH="$DIST_DIR/browserpilot-mcp-extension.zip"
CRX_BASENAME="$DIST_DIR/browserpilot-mcp-extension"

required_files=(
  "$EXTENSION_DIR/manifest.json"
  "$EXTENSION_DIR/background.js"
  "$EXTENSION_DIR/content.js"
  "$EXTENSION_DIR/popup.html"
  "$EXTENSION_DIR/popup.css"
  "$EXTENSION_DIR/popup.js"
  "$EXTENSION_DIR/icons"
)

for required in "${required_files[@]}"; do
  if [[ ! -e "$required" ]]; then
    echo "Missing required extension artifact: $required" >&2
    exit 1
  fi
done

if [[ -e "$UNPACKED_DIR" || -e "$ZIP_PATH" || -e "$CRX_BASENAME.crx" || -e "$CRX_BASENAME.pem" ]]; then
  echo "Packaging targets already exist under $DIST_DIR." >&2
  echo "Move or remove the existing dist artifacts before re-running this script." >&2
  exit 1
fi

# Ensure a fixed PEM key exists for reproducible Extension ID
if [[ ! -f "$PEM_FILE" ]]; then
  echo "Generating new RSA key pair for fixed Extension ID..."
  openssl genpkey -algorithm RSA -outform PEM -out "$PEM_FILE" -pkeyopt rsa_keygen_bits:2048 2>/dev/null
  if [[ ! -f "$PEM_FILE" ]]; then
    echo "Failed to generate PEM key at $PEM_FILE" >&2
    exit 1
  fi
  echo "Generated new PEM: $PEM_FILE"
else
  echo "Using existing PEM: $PEM_FILE"
fi

mkdir -p "$UNPACKED_DIR"

# Copy only the browser extension payload. This intentionally excludes the native
# host, dependencies, local Claude/GStack state, and other repository files.
cp -R "$EXTENSION_DIR"/. "$UNPACKED_DIR"/

(
  cd "$UNPACKED_DIR"
  zip -qr "$ZIP_PATH" .
)

echo "Created unpacked extension: $UNPACKED_DIR"
echo "Created zip package: $ZIP_PATH"

chrome_bin=""
for candidate in \
  "${CHROME_BIN:-}" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "google-chrome" \
  "google-chrome-stable" \
  "chromium" \
  "chromium-browser"; do
  if [[ -n "$candidate" ]]; then
    if [[ "$candidate" == */* && -x "$candidate" ]]; then
      chrome_bin="$candidate"
      break
    elif command -v "$candidate" >/dev/null 2>&1; then
      chrome_bin="$(command -v "$candidate")"
      break
    fi
  fi
done

if [[ -n "$chrome_bin" ]]; then
  set +e
  "$chrome_bin" --pack-extension="$UNPACKED_DIR" --pack-extension-key="$PEM_FILE" --no-message-box >/tmp/browserpilot-mcp-crx-pack.log 2>&1
  crx_status=$?
  set -e
  if [[ -f "$UNPACKED_DIR.crx" ]]; then
    mv "$UNPACKED_DIR.crx" "$CRX_BASENAME.crx"
    echo "Created CRX package: $CRX_BASENAME.crx"
    if [[ $crx_status -ne 0 ]]; then
      echo "Chrome pack command returned non-zero status after creating the CRX; see /tmp/browserpilot-mcp-crx-pack.log" >&2
    fi
  else
    echo "CRX package not created: Chrome pack command failed; see /tmp/browserpilot-mcp-crx-pack.log" >&2
  fi
else
  echo "CRX package not created: no Chrome/Chromium command found." >&2
fi

# Compute and persist the fixed Extension ID from the PEM public key
if [[ -f "$PEM_FILE" && -f "$ROOT_DIR/scripts/compute-extension-id.mjs" ]]; then
  EXTENSION_ID=$(node "$ROOT_DIR/scripts/compute-extension-id.mjs" "$PEM_FILE")
  echo "$EXTENSION_ID" > "$ROOT_DIR/.extension-id"
  echo "Fixed Extension ID: $EXTENSION_ID"
  echo "Extension ID written to: $ROOT_DIR/.extension-id"
else
  echo "Could not compute Extension ID: missing PEM or compute script." >&2
fi

# Copy packaging artifacts to dist directory if they were generated elsewhere
if [[ "$DIST_DIR" != "$ROOT_DIR" ]]; then
  if [[ -f "$PEM_FILE" ]]; then
    cp "$PEM_FILE" "$DIST_DIR/browserpilot-mcp-extension.pem"
    echo "Copied PEM to: $DIST_DIR/browserpilot-mcp-extension.pem"
  fi
  if [[ -f "$ROOT_DIR/.extension-id" ]]; then
    cp "$ROOT_DIR/.extension-id" "$DIST_DIR/.extension-id"
    echo "Copied Extension ID to: $DIST_DIR/.extension-id"
  fi
fi
