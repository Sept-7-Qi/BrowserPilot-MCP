#!/bin/bash

set -e

NATIVE_HOST_NAME="com.openclaudeinchrome.host"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin)
            echo "macos"
            ;;
        Linux)
            echo "linux"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# Get manifest directories
get_manifest_dirs() {
    local os=$1
    local dirs=()

    if [ "$os" = "macos" ]; then
        dirs+=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts")
        dirs+=("$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts")
        dirs+=("$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts")
        dirs+=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts")
        dirs+=("$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts")
    elif [ "$os" = "linux" ]; then
        dirs+=("$HOME/.config/google-chrome/NativeMessagingHosts")
        dirs+=("$HOME/.config/chromium/NativeMessagingHosts")
        dirs+=("$HOME/.config/microsoft-edge/NativeMessagingHosts")
        dirs+=("$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
        dirs+=("/etc/opt/chrome/native-messaging-hosts")
        dirs+=("/etc/chromium/native-messaging-hosts")
    fi

    echo "${dirs[@]}"
}

# Usage
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Uninstalls the BrowserPilot MCP native messaging host.

Options:
  -h, --help    Show this help message

EOF
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                usage
                exit 0
                ;;
            *)
                error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done

    echo "========================================="
    echo "  BrowserPilot MCP Uninstaller"
    echo "========================================="
    echo

    local os=$(detect_os)
    log "Detected OS: $os"

    local dirs=($(get_manifest_dirs "$os"))
    local removed=0

    for dir in "${dirs[@]}"; do
        local manifest_path="$dir/$NATIVE_HOST_NAME.json"
        if [ -f "$manifest_path" ]; then
            if [[ "$dir" == /etc/* ]]; then
                log "System-wide manifest found: $manifest_path"
                if sudo rm -f "$manifest_path" 2>/dev/null; then
                    success "Removed $manifest_path"
                    removed=$((removed + 1))
                fi
            else
                if rm -f "$manifest_path" 2>/dev/null; then
                    success "Removed $manifest_path"
                    removed=$((removed + 1))
                fi
            fi
        fi
    done

    # Remove wrapper script if it exists
    local wrapper="$SCRIPT_DIR/host/native-host-wrapper.sh"
    if [ -f "$wrapper" ]; then
        rm -f "$wrapper"
        log "Removed wrapper script"
    fi

    echo
    if [ $removed -gt 0 ]; then
        success "Uninstallation complete!"
        echo
        echo "Please restart your browser to complete the process."
    else
        log "No manifests found to remove."
    fi
}

main "$@"
