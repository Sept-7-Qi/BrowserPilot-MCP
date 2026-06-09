#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"
MCP_SERVER_NAME="browserpilot-mcp"
MCP_SERVER_JS="$SCRIPT_DIR/host/mcp-server.js"
DEFAULT_BROWSER="Chrome"
DEFAULT_CLI="ask"

print_help() {
  cat <<'EOF'
BrowserPilot MCP 一键安装

用法：
  ./一键安装.sh <Extension ID>
  ./一键安装.sh --browser Chrome <Extension ID>
  ./一键安装.sh --full <Extension ID>
  ./一键安装.sh --full --cli claude <Extension ID>
  ./一键安装.sh --auto
  ./一键安装.sh --auto --browser Edge
  ./一键安装.sh --mcp-only --cli claude
  ./一键安装.sh --mcp-only --cli none
  ./一键安装.sh doctor <Extension ID>
  ./一键安装.sh --doctor <Extension ID>

CLI AI 选择：
  --cli claude   配置 Claude Code MCP（使用 claude mcp remove/add/list）
  --cli codex    检测 Codex CLI；当前不伪造配置命令，只生成配置片段
  --cli gemini   检测 Gemini CLI；当前不伪造配置命令，只生成配置片段
  --cli all      处理 Claude Code、Codex、Gemini
  --cli none     跳过 CLI AI MCP 配置，适合 CI/测试
  支持值：claude|codex|gemini|all|none

交互模式：
  --full 未提供 --cli 时会询问：选择要配置 MCP 的 CLI AI: 1) Claude Code 2) Codex 3) Gemini 4) 全部 5) 跳过
  15 秒内不输入时，默认 Claude Code。

--auto 模式：
  等同于 --full --cli claude，跳过所有交互。
  自动配置 Claude Code MCP，输出简洁的成功提示。
  Extension ID 从项目根目录 .extension-id 文件读取（若未传入参数）。

说明：
  - 默认浏览器是 Chrome。
  - 支持 --browser Chrome/Edge/Brave/Chromium。
  - Extension ID 必须是 32 位、只包含 a-p 的小写字母。
  - 普通模式只安装 Native Host 并运行 doctor。
  - --full 会安装 Native Host、运行 doctor，并按选择配置 CLI AI MCP。
  - --mcp-only 只配置 CLI AI MCP，不修改 Native Host allowed origins。
  - 本脚本调用现有 install.sh 和已知 CLI 命令，不重复实现底层 Native Messaging 逻辑。

重要限制：
  - Chrome 扩展本体仍需在 chrome://extensions 手动加载或手动点击 Reload/刷新。
  - 脚本无法静默替你加载 unpacked extension，这是 Chrome 的限制。
  - Codex/Gemini 若无法确认 MCP 配置命令，只会生成配置片段并提示手动查文档。

成功后：
  1. 重启或刷新 Chrome 扩展。
  2. 点击扩展图标，查看中文状态面板。
EOF
}

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

validate_browser() {
  case "$1" in
    Chrome|Edge|Brave|Chromium) ;;
    *) fail "不支持的浏览器：$1。支持：Chrome/Edge/Brave/Chromium" ;;
  esac
}

validate_cli() {
  case "$1" in
    ask|claude|codex|gemini|all|none) ;;
    *) fail "不支持的 --cli 值：$1。支持：claude/codex/gemini/all/none" ;;
  esac
}

validate_extension_id() {
  if [[ ! "$1" =~ ^[a-p]{32}$ ]]; then
    fail "Extension ID 格式不正确。请从 chrome://extensions 复制 32 位、只包含 a-p 的扩展 ID。"
  fi
}

node_path_or_fail() {
  local node_path=""
  node_path="$(command -v node || true)"
  [[ -n "$node_path" ]] || fail "找不到 node，请先安装 Node.js v18+。"
  [[ -f "$MCP_SERVER_JS" ]] || fail "找不到 MCP 服务文件：$MCP_SERVER_JS"
  printf '%s\n' "$node_path"
}

run_doctor() {
  local browser="$1"
  local extension_id="$2"
  printf '正在诊断 %s 的原生消息配置...\n' "$browser"
  "$INSTALL_SH" doctor --browser "$browser" "$extension_id"
  printf '\n诊断通过：原生消息配置可用于当前扩展 ID。\n'
}

print_mcp_config_snippet() {
  local cli_label="$1"
  local node_path="$2"
  printf '\n%s MCP：生成配置片段（未自动写入配置）。\n' "$cli_label"
  printf '原因：当前脚本无法确认该 CLI 的非交互 MCP 配置命令；不会伪造命令。请查阅该 CLI 的 MCP 配置文档。\n'
  cat <<EOF
{
  "server name": "$MCP_SERVER_NAME",
  "command": "$node_path",
  "args": ["$MCP_SERVER_JS"]
}
EOF
}

configure_claude_mcp() {
  local node_path="$1"
  command -v claude >/dev/null 2>&1 || fail "找不到 claude 命令。请先安装/登录 Claude Code CLI，或使用 --cli none 跳过。"

  printf '正在配置 Claude Code MCP：%s...\n' "$MCP_SERVER_NAME"

  # Avoid duplicate add failures. Removing a missing MCP server may fail on some
  # Claude Code versions, so ignore that specific preparation step.
  claude mcp remove "$MCP_SERVER_NAME" >/dev/null 2>&1 || true
  claude mcp add "$MCP_SERVER_NAME" -- "$node_path" "$MCP_SERVER_JS"

  printf '\n正在验证 Claude Code MCP 列表...\n'
  local mcp_list=""
  mcp_list="$(claude mcp list)"
  printf '%s\n' "$mcp_list"
  if ! grep -Fq "$MCP_SERVER_NAME" <<< "$mcp_list"; then
    fail "Claude Code MCP 列表中没有找到 $MCP_SERVER_NAME"
  fi

  printf '\nClaude Code MCP 配置完成。若显示 Connected 更好；未连接通常表示浏览器扩展或浏览器尚未连接。\n'
}

configure_codex_mcp() {
  local node_path="$1"
  if command -v codex >/dev/null 2>&1; then
    printf '检测到 Codex CLI。\n'
  else
    printf '未检测到 Codex CLI（command -v codex 失败）。\n'
  fi
  print_mcp_config_snippet "Codex CLI" "$node_path"
}

configure_gemini_mcp() {
  local node_path="$1"
  if command -v gemini >/dev/null 2>&1; then
    printf '检测到 Gemini CLI。\n'
  else
    printf '未检测到 Gemini CLI（command -v gemini 失败）。\n'
  fi
  print_mcp_config_snippet "Gemini CLI" "$node_path"
}

prompt_cli_choice() {
  local choice=""
  printf '\n选择要配置 MCP 的 CLI AI: 1) Claude Code 2) Codex 3) Gemini 4) 全部 5) 跳过\n' >&2
  printf '15 秒内不输入时默认 Claude Code。请输入 1-5：' >&2
  if read -r -t 15 choice; then
    printf '\n' >&2
  else
    printf '\n未输入，默认 Claude Code。\n' >&2
    choice="1"
  fi
  case "$choice" in
    1|claude|Claude|Claude\ Code) printf 'claude\n' ;;
    2|codex|Codex) printf 'codex\n' ;;
    3|gemini|Gemini) printf 'gemini\n' ;;
    4|all|全部) printf 'all\n' ;;
    5|none|skip|跳过) printf 'none\n' ;;
    *) printf 'claude\n' ;;
  esac
}

configure_cli_mcp() {
  local cli_target="$1"

  if [[ "$cli_target" == "ask" ]]; then
    cli_target="$(prompt_cli_choice)"
  fi

  validate_cli "$cli_target"

  if [[ "$cli_target" == "none" ]]; then
    printf '已跳过 CLI AI MCP 配置。\n'
    return 0
  fi

  local node_path=""
  node_path="$(node_path_or_fail)"

  case "$cli_target" in
    claude)
      configure_claude_mcp "$node_path"
      ;;
    codex)
      configure_codex_mcp "$node_path"
      ;;
    gemini)
      configure_gemini_mcp "$node_path"
      ;;
    all)
      configure_claude_mcp "$node_path"
      configure_codex_mcp "$node_path"
      configure_gemini_mcp "$node_path"
      ;;
  esac
}

main() {
  local browser="$DEFAULT_BROWSER"
  local mode="install"
  local cli_target="$DEFAULT_CLI"
  local cli_explicit=0
  local extension_id=""
  local auto_mode=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        print_help
        exit 0
        ;;
      --browser)
        [[ $# -ge 2 ]] || fail "--browser 后需要浏览器名称"
        browser="$2"
        shift 2
        ;;
      --cli)
        [[ $# -ge 2 ]] || fail "--cli 后需要 claude/codex/gemini/all/none"
        cli_target="$2"
        cli_explicit=1
        shift 2
        ;;
      --full)
        mode="full"
        shift
        ;;
      --auto)
        auto_mode=1
        mode="full"
        cli_target="claude"
        cli_explicit=1
        shift
        ;;
      --mcp-only)
        mode="mcp-only"
        shift
        ;;
      doctor|--doctor)
        mode="doctor"
        shift
        ;;
      --*)
        fail "未知参数：$1。运行 ./一键安装.sh --help 查看用法。"
        ;;
      *)
        if [[ -z "$extension_id" ]]; then
          extension_id="$1"
        else
          fail "只能提供一个 Extension ID"
        fi
        shift
        ;;
    esac
  done

  validate_browser "$browser"
  validate_cli "$cli_target"
  [[ -x "$INSTALL_SH" ]] || fail "找不到可执行 install.sh：$INSTALL_SH"

  # Extension ID resolution: argument > .extension-id file > error (for non-mcp-only modes)
  if [[ -z "$extension_id" && -f "$SCRIPT_DIR/.extension-id" ]]; then
    extension_id=$(head -n 1 "$SCRIPT_DIR/.extension-id" | tr -d '[:space:]')
    if [[ -n "$extension_id" ]]; then
      printf '从 %s 读取 Extension ID：%s\n' "$SCRIPT_DIR/.extension-id" "$extension_id"
    fi
  fi

  if [[ "$mode" == "mcp-only" ]]; then
    if [[ "$cli_explicit" -eq 0 ]]; then
      cli_target="ask"
    fi
    configure_cli_mcp "$cli_target"
    printf '\nMCP 配置流程完成。Chrome 扩展仍需在 chrome://extensions 手动加载或刷新。\n'
    exit 0
  fi

  # doctor/install/full modes require extension_id
  [[ -n "$extension_id" ]] || fail "缺少 Extension ID。请传入参数或在项目根目录创建 .extension-id 文件。运行 ./一键安装.sh --help 查看获取方式。"
  validate_extension_id "$extension_id"

  if [[ "$mode" == "doctor" ]]; then
    run_doctor "$browser" "$extension_id"
    exit 0
  fi

  printf '开始为 %s 安装 BrowserPilot MCP...\n' "$browser"
  "$INSTALL_SH" --browser "$browser" "$extension_id"
  printf '\n安装完成，开始自动诊断...\n'
  run_doctor "$browser" "$extension_id"

  if [[ "$mode" == "full" ]]; then
    printf '\n开始配置 CLI AI MCP...\n'
    if [[ "$cli_explicit" -eq 0 ]]; then
      cli_target="ask"
    fi
    configure_cli_mcp "$cli_target"
  fi

  if [[ "$auto_mode" -eq 1 ]]; then
    printf '\n✅ 自动安装完成\n'
    printf '   Extension ID : %s\n' "$extension_id"
    printf '   下一步       : 到 chrome://extensions 手动加载或 Reload/刷新扩展，然后点击扩展图标查看状态面板。\n'
  else
    printf '\n安装成功。Extension ID: %s\n' "$extension_id"
    printf '下一步：\n'
    printf '  1. 到 chrome://extensions 手动加载或 Reload/刷新扩展。\n'
    printf '  2. 点击扩展图标，查看中文状态面板。\n'
    if [[ "$mode" != "full" ]]; then
      printf '  3. 如需同时配置 CLI AI MCP，可运行：./一键安装.sh --full <Extension ID>\n'
    fi
  fi
}

main "$@"
