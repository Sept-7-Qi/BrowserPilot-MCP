#!/bin/bash

set -e

NATIVE_HOST_NAME="com.openclaudeinchrome.host"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check for Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed. Please install Node.js v18+ from https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        error "Node.js v18+ is required. You have $(node -v)"
        exit 1
    fi

    log "Node.js version: $(node -v)"
}

# Install dependencies
install_deps() {
    log "Installing dependencies..."
    cd "$HOST_DIR"
    if [ ! -d "node_modules" ] || [ ! -f "package-lock.json" ]; then
        npm install
    else
        log "Dependencies already installed, skipping (use --force to reinstall)"
    fi
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
        MINGW*|MSYS*|CYGWIN*)
            echo "windows"
            ;;
        *)
            error "Unsupported OS: $(uname -s)"
            exit 1
            ;;
    esac
}

# Read extension ID from argument or .extension-id file
read_extension_id() {
    local id="$1"
    if [ -z "$id" ] && [ -f "$SCRIPT_DIR/.extension-id" ]; then
        id=$(head -n 1 "$SCRIPT_DIR/.extension-id" | tr -d '[:space:]')
    fi
    printf '%s\n' "$id"
}

# Show error when extension ID is missing and .extension-id not found
missing_extension_id_error() {
    error "Extension ID is required"
    error "Options to get an Extension ID:"
    error "  1. Run ./package-extension.sh to generate a fixed Extension ID"
    error "  2. Load the extension in Chrome and copy the ID from chrome://extensions"
    error "  3. Create a .extension-id file in the project root with the ID"
    usage
    exit 1
}

# Detect browsers and their Native Messaging directories
get_browser_dirs() {
    local os=$1
    local extension_id=$2
    local dirs=()

    if [ "$os" = "macos" ]; then
        # Chrome
        if [ -d "$HOME/Library/Application Support/Google/Chrome" ]; then
            dirs+=("Chrome:$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts")
        fi
        # Chrome Beta/Dev
        if [ -d "$HOME/Library/Application Support/Google/Chrome Beta" ]; then
            dirs+=("Chrome Beta:$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts")
        fi
        # Edge
        if [ -d "$HOME/Library/Application Support/Microsoft Edge" ]; then
            dirs+=("Edge:$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts")
        fi
        # Brave
        if [ -d "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" ]; then
            dirs+=("Brave:$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts")
        fi
        # Vivaldi
        if [ -d "$HOME/Library/Application Support/Vivaldi" ]; then
            dirs+=("Vivaldi:$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts")
        fi
    elif [ "$os" = "linux" ]; then
        # Chrome
        if [ -d "$HOME/.config/google-chrome" ]; then
            dirs+=("Chrome:$HOME/.config/google-chrome/NativeMessagingHosts")
        fi
        # Chromium
        if [ -d "$HOME/.config/chromium" ]; then
            dirs+=("Chromium:$HOME/.config/chromium/NativeMessagingHosts")
        fi
        # Edge
        if [ -d "$HOME/.config/microsoft-edge" ]; then
            dirs+=("Edge:$HOME/.config/microsoft-edge/NativeMessagingHosts")
        fi
        # Brave
        if [ -d "$HOME/.config/BraveSoftware/Brave-Browser" ]; then
            dirs+=("Brave:$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
        fi
        # System-wide (requires sudo)
        dirs+=("System (Chrome):/etc/opt/chrome/native-messaging-hosts")
        dirs+=("System (Chromium):/etc/chromium/native-messaging-hosts")
    fi

    printf '%s\n' "${dirs[@]}"
}

# Run non-interactive diagnostics for Native Messaging installation
doctor() {
    local extension_id=""
    local browser_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --browser)
                if [[ $# -lt 2 || -z "$2" ]]; then
                    error "Missing value for --browser"
                    exit 1
                fi
                browser_filter="$2"
                shift 2
                ;;
            -h|--help)
                echo "Usage: $0 doctor [--browser NAME] [extension-id]"
                exit 0
                ;;
            -*)
                error "Unknown doctor option: $1"
                exit 1
                ;;
            *)
                if [ -z "$extension_id" ]; then
                    extension_id="$1"
                else
                    error "Multiple extension IDs provided"
                    exit 1
                fi
                shift
                ;;
        esac
    done

    extension_id=$(read_extension_id "$extension_id")
    if [ -z "$extension_id" ]; then
        missing_extension_id_error
        exit 1
    fi

    check_node

    local os=$(detect_os)
    local checked=0
    local failures=0

    log "Running Native Messaging diagnostics for OS: $os"
    if [ -n "$extension_id" ]; then
        log "Expected extension origin: chrome-extension://$extension_id/"
    else
        warning "No extension ID provided; allowed_origins membership will not be checked"
    fi

    while IFS= read -r browser_dir; do
        [ -n "$browser_dir" ] || continue
        IFS=':' read -r browser dir <<< "$browser_dir"

        if [ -n "$browser_filter" ] && [ "$browser" != "$browser_filter" ]; then
            continue
        fi

        checked=$((checked + 1))
        local manifest_path="$dir/$NATIVE_HOST_NAME.json"
        echo
        log "Checking $browser"
        echo "  manifest: $manifest_path"

        if [ ! -f "$manifest_path" ]; then
            error "  missing manifest"
            failures=$((failures + 1))
            continue
        fi

        if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$manifest_path" >/dev/null 2>&1; then
            error "  manifest is not valid JSON"
            failures=$((failures + 1))
            continue
        fi

        local manifest_name
        manifest_name=$(node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(m.name || '')" "$manifest_path")
        if [ "$manifest_name" != "$NATIVE_HOST_NAME" ]; then
            error "  manifest name mismatch: expected $NATIVE_HOST_NAME, got $manifest_name"
            failures=$((failures + 1))
        else
            success "  manifest name OK"
        fi

        if [ -n "$extension_id" ]; then
            local expected_origin="chrome-extension://$extension_id/"
            if node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.exit((m.allowed_origins || []).includes(process.argv[2]) ? 0 : 1)" "$manifest_path" "$expected_origin"; then
                success "  allowed_origins contains current extension ID"
            else
                error "  allowed_origins does not contain $expected_origin"
                failures=$((failures + 1))
            fi
        fi

        local host_path
        host_path=$(node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(m.path || '')" "$manifest_path")
        echo "  host path: $host_path"
        if [ ! -f "$host_path" ]; then
            error "  host path does not exist"
            failures=$((failures + 1))
        elif [ ! -x "$host_path" ]; then
            error "  host path is not executable"
            failures=$((failures + 1))
        else
            success "  host path exists and is executable"
        fi

        local first_line=""
        if [ -f "$host_path" ]; then
            IFS= read -r first_line < "$host_path" || true
            if [[ "$first_line" == '#!'* ]]; then
                success "  host shebang OK: $first_line"
            else
                error "  host shebang missing"
                failures=$((failures + 1))
            fi
        fi
    done < <(get_browser_dirs "$os" "$extension_id")

    if [ "$checked" -eq 0 ]; then
        error "No matching supported browser profile directories found"
        exit 1
    fi

    echo
    if [ "$failures" -eq 0 ]; then
        success "Native Messaging diagnostics passed"
    else
        error "Native Messaging diagnostics found $failures issue(s)"
        exit 1
    fi
}

# Create native messaging manifest
create_manifest() {
    local os=$1
    local extension_id=$2
    local manifest_dir=$3

    # Create manifest directory if it doesn't exist
    mkdir -p "$manifest_dir"

    # Native Messaging hosts are launched by the browser GUI environment, which may not
    # include shell-managed PATH entries such as nvm. Always point the manifest at a
    # small executable wrapper that invokes the absolute Node.js binary detected here.
    local host_path="$HOST_DIR/native-host.js"
    local wrapper_path="$HOST_DIR/native-host-wrapper.sh"
    local node_path=$(command -v node)

    chmod +x "$host_path"
    cat > "$wrapper_path" <<EOF
#!/bin/bash
exec "$node_path" "$host_path" "\$@"
EOF
    chmod +x "$wrapper_path"

    cat > "$manifest_dir/$NATIVE_HOST_NAME.json" <<EOF
{
  "name": "$NATIVE_HOST_NAME",
  "description": "BrowserPilot MCP Native Messaging Host",
  "path": "$wrapper_path",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$extension_id/"
  ]
}
EOF

    chmod 644 "$manifest_dir/$NATIVE_HOST_NAME.json"
    success "Created manifest at $manifest_dir/$NATIVE_HOST_NAME.json"
}

# Show usage
usage() {
    cat <<EOF
Usage: $0 [OPTIONS] [extension-id]

Installs the BrowserPilot MCP native messaging host.

Arguments:
  [extension-id]    The ID of the Chrome extension (optional if .extension-id exists)

Options:
  -h, --help        Show this help message
  -f, --force       Force reinstall dependencies
  --browser NAME    Only install for specific browser (Chrome, Edge, Brave, etc.)
  --auto            Pass through to one-click install (optional)

Commands:
  doctor [--browser NAME] [extension-id]
                   Check installed Native Messaging manifests without modifying them

Examples:
  $0                              # Uses .extension-id if present
  $0 abcdefghijklmnopqrstuvwxyzabcdef
  $0 doctor --browser Chrome abcdefghijklmnopqrstuvwxyzabcdef
EOF
}

# Parse arguments
main() {
    if [[ "${1:-}" == "doctor" ]]; then
        shift
        doctor "$@"
        exit $?
    fi

    local extension_id=""
    local force=0
    local browser_filter=""
    local auto_mode=0

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                usage
                exit 0
                ;;
            -f|--force)
                force=1
                shift
                ;;
            --browser)
                browser_filter="$2"
                shift 2
                ;;
            --auto)
                auto_mode=1
                shift
                ;;
            -*)
                error "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                if [ -z "$extension_id" ]; then
                    extension_id="$1"
                else
                    error "Multiple extension IDs provided"
                    usage
                    exit 1
                fi
                shift
                ;;
        esac
    done

    extension_id=$(read_extension_id "$extension_id")
    if [ -z "$extension_id" ]; then
        missing_extension_id_error
        exit 1
    fi

    # Validate extension ID format (32 lowercase letters)
    if ! [[ "$extension_id" =~ ^[a-p]{32}$ ]]; then
        warning "Extension ID '$extension_id' doesn't look like a standard Chrome extension ID"
        warning "It should be 32 characters long, using only letters a-p"
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if ! [[ $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    echo "========================================="
    echo "  BrowserPilot MCP Installer"
    echo "========================================="
    echo

    log "Extension ID: $extension_id"

    check_node
    local node_path=$(command -v node)

    if [ $force -eq 1 ]; then
        cd "$HOST_DIR"
        rm -rf node_modules package-lock.json
    fi
    install_deps

    local os=$(detect_os)
    log "Detected OS: $os"

    echo
    log "Found browsers:"
    local found=0
    while IFS= read -r browser_dir; do
        [ -n "$browser_dir" ] || continue
        IFS=':' read -r browser dir <<< "$browser_dir"
        if [ -n "$browser_filter" ] && [ "$browser" != "$browser_filter" ]; then
            continue
        fi
        found=$((found + 1))
        echo "  - $browser"
    done < <(get_browser_dirs "$os" "$extension_id")

    if [ "$found" -eq 0 ]; then
        error "No supported browsers found. Please install Chrome, Edge, or Brave, or check --browser value."
        exit 1
    fi

    echo
    log "Installing manifests..."

    local installed=0
    while IFS= read -r browser_dir; do
        [ -n "$browser_dir" ] || continue
        IFS=':' read -r browser dir <<< "$browser_dir"

        if [ -n "$browser_filter" ] && [ "$browser" != "$browser_filter" ]; then
            continue
        fi

        # Check if system directory (might need sudo)
        if [[ "$dir" == /etc/* ]]; then
            log "System-wide directory detected: $dir"
            read -p "Install for $browser system-wide? (requires sudo) (y/N) " -n 1 -r
            echo
            if ! [[ $REPLY =~ ^[Yy]$ ]]; then
                continue
            fi
            if ! sudo mkdir -p "$dir"; then
                warning "Failed to create $dir, skipping..."
                continue
            fi
            # Create manifest first, then copy with sudo
            local temp_dir=$(mktemp -d)
            create_manifest "$os" "$extension_id" "$temp_dir"
            sudo cp "$temp_dir/$NATIVE_HOST_NAME.json" "$dir/"
            sudo chmod 644 "$dir/$NATIVE_HOST_NAME.json"
            rm -rf "$temp_dir"
            success "Installed for $browser (system-wide)"
        else
            create_manifest "$os" "$extension_id" "$dir"
            success "Installed for $browser"
        fi
        installed=$((installed + 1))
    done < <(get_browser_dirs "$os" "$extension_id")

    if [ $installed -eq 0 ]; then
        error "No manifests were installed"
        exit 1
    fi

    echo
    echo "========================================="
    success "Installation complete!"
    echo "========================================="
    echo
    echo "Next steps:"
    echo "  1. Make sure the extension is loaded in Chrome"
    echo "  2. Restart your browser completely"
    echo "  3. Check the extension's service worker logs"
    echo "     (chrome://extensions > Developer mode > Service Worker)"
    echo
    echo "To start the MCP server for Claude Desktop:"
    echo "  cd $HOST_DIR"
    echo "  node mcp-server.js"
    echo
    echo "Or add this to your Claude Desktop config:"
    echo "  {"
    echo "    \"mcpServers\": {"
    echo "      \"browserpilot-mcp\": {"
    echo "        \"command\": \"$node_path\","
    echo "        \"args\": [\"$HOST_DIR/mcp-server.js\"]"
    echo "      }"
    echo "    }"
    echo "  }"
    echo
}

main "$@"
