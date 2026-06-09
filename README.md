# BrowserPilot MCP

BrowserPilot MCP 是一个通过本地 MCP 服务与原生消息主机连接 AI Agent 和 Chromium 浏览器的自动化工具。

它由浏览器扩展、用户级常驻 daemon、MCP stdio adapter 和 Chrome Native Messaging host 组成，可以让 Claude Desktop / Claude Code 等 MCP 客户端执行网页导航、点击、输入、截图、读取浏览器状态等自动化操作。

BrowserPilot MCP is a local browser automation bridge that connects Claude Code and other MCP clients to Chromium-based browsers through a browser extension and Native Messaging Host.

当前文档对应 **BrowserPilot MCP 1.1.2**。

## 功能

- 浏览器自动化：导航、点击、输入、截图、等待元素、执行页面脚本
- MCP 集成：通过本地 MCP server 暴露浏览器控制工具
- 原生消息桥接：使用 Chrome Native Messaging 连接浏览器扩展和本地服务
- Chromium 支持：适用于 Chrome、Edge、Brave、Vivaldi 和 Chromium
- 本地安装：支持 npm link / npm install -g . 和一键安装脚本

## 推荐安装流程

### 1. 安装 CLI

可以从 npm/tarball 安装，也可以在源码目录本地安装：

```bash
# npm / tarball 示例
npm install -g browserpilot-mcp-1.1.2.tgz

# 本地源码目录示例
npm install -g .
# 或
npm link
```

`npm install -g .` / `npm link` 只暴露 `browserpilot-mcp` CLI 并安装运行依赖；不会自动修改 Native Host、LaunchAgent 或 Claude MCP 配置。

### 2. 一键自动安装

推荐入口：

```bash
browserpilot-mcp install --auto
```

该命令会安装并验证 BrowserPilot daemon 的 macOS 用户级 LaunchAgent，然后配置 Native Messaging host 和 Claude MCP。安装完成后，daemon 会通过 LaunchAgent 自动常驻，用户通常 **不需要手动运行** `browserpilot-mcp daemon start`。

安装后检查：

```bash
browserpilot-mcp daemon status --json
claude mcp list
```

- `browserpilot-mcp daemon status --json` 用于确认本机 daemon 状态。
- `claude mcp list` 用于确认 Claude Code 已看到 `browserpilot-mcp` MCP server。

## daemon + adapter 架构

BrowserPilot MCP 1.1.2 使用 daemon + adapter 架构：

```text
Claude Desktop / Claude Code
      ↓ stdio
MCP stdio adapter (`browserpilot-mcp start`)
      ↓ TCP client + token auth
BrowserPilot daemon (`127.0.0.1:18765`)
      ↑ TCP client + token auth
Native Messaging Host
      ↓ Chrome Native Messaging
Browser Extension
      ↓
Chromium tabs
```

关键点：

- **daemon** 是唯一监听本地 TCP 的进程，地址为 `127.0.0.1:18765`。
- `browserpilot-mcp start` 是 Claude MCP **stdio adapter**，只通过 stdio 和 Claude 通信，并作为 TCP client 连接 daemon；它 **不监听** `18765`。
- 多个 Claude / MCP 客户端实例可以共用同一个 daemon。
- macOS 推荐通过 `browserpilot-mcp install --auto` 安装 LaunchAgent，让 daemon 用户级自动常驻。

## Chrome 扩展安装

BrowserPilot 扩展需要安装到 Chrome / Chromium 系浏览器：

1. 打开 `chrome://extensions`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本地生成或 Release 下载的打包产物 `dist/extension-unpacked/`。

`dist/` 不提交到 git。需要本地产物时运行 `./package-extension.sh` 生成，或从 GitHub Release 下载已发布产物。也可以安装打包生成的 CRX（如果本机 Chrome/Chromium 打包命令已生成 `dist/browserpilot-mcp-extension.crx`）。

### Extension ID 与 `.extension-id`

BrowserPilot 支持固定 Extension ID：

- `.extension-id` 是本地打包/安装流程生成的状态文件，不提交到 git。
- 安装脚本会在本地优先读取 `.extension-id`；如果不存在，可通过本地打包或安装流程重新生成。
- 固定 ID 由打包使用的 PEM 密钥控制；同一个 PEM 会生成同一个扩展 ID。
- 如果更换或丢失 PEM，扩展 ID 可能变化，需要重新安装 Native Host allowed origins 和 MCP 配置。

## 新视觉行为（1.1.2）

BrowserPilot 1.1.2 取消了旧版页面高亮样式：

- 不再给页面添加橙色页面边界高亮。
- 改用 Chrome Tab Group 展示连接状态：
  - `connected`：绿色 Tab Group，标题为「BrowserPilot 已连接」。
  - `connecting`：蓝色 Tab Group，标题为「BrowserPilot 连接中」。
  - `disconnected`：取消 BrowserPilot 创建的分组。

这意味着连接状态主要体现在浏览器标签分组上，而不是网页内容区域的边框。

## 新 tab 生命周期（1.1.2）

BrowserPilot 1.1.2 对 tab 管理做了更安全的区分。

### `ensure_active_tab`

推荐在需要可操作页面时使用 `ensure_active_tab`：

- 如果当前没有 active tab，会打开一个新 tab。
- 如果浏览器未启动，会按需启动浏览器。
- 不会关闭浏览器。

### `close_managed_tabs`

推荐使用 `close_managed_tabs` 清理 BrowserPilot 自动创建/管理的 tab：

- 只关闭 BrowserPilot 自己创建或管理的 tab。
- 不关闭用户原本已经打开的 tab。
- 不关闭 Chrome / Chromium 浏览器本身。

### `close_page`

`close_page` 仍作为低层兼容工具存在，用于关闭指定 tab。日常清理 BrowserPilot 会话时，推荐优先使用 `close_managed_tabs`，避免误关用户原有标签页。

BrowserPilot 不提供关闭浏览器的能力。

## 常用命令

```bash
browserpilot-mcp install --auto
browserpilot-mcp daemon status --json
browserpilot-mcp daemon install --dry-run
browserpilot-mcp daemon uninstall --dry-run
browserpilot-mcp doctor --browser Chrome
npm run check:extension
npm run check:daemon-contract
```

说明：

- `browserpilot-mcp install --auto`：推荐安装入口；安装 daemon LaunchAgent、Native Host 和 Claude MCP 配置。
- `browserpilot-mcp daemon status --json`：以 JSON 查看 daemon 状态。
- `browserpilot-mcp daemon install --dry-run`：只打印 LaunchAgent 安装计划，不写文件、不运行 launchctl。
- `browserpilot-mcp daemon uninstall --dry-run`：只打印 LaunchAgent 卸载计划。
- `browserpilot-mcp doctor --browser Chrome`：诊断 Chrome 相关安装状态。
- `npm run check:extension`：检查扩展相关构建/约束。
- `npm run check:daemon-contract`：检查 daemon contract。

## 验证和排错

安装后建议按顺序验证：

```bash
browserpilot-mcp daemon status --json
claude mcp list
browserpilot-mcp doctor --browser Chrome
```

然后在 `chrome://extensions` 中找到 BrowserPilot MCP 扩展并点击 reload / 刷新。

排查建议：

- 确认版本为 **1.1.2**。
- `browserpilot-mcp daemon status --json` 应显示 daemon 可访问。
- `claude mcp list` 应包含 `browserpilot-mcp`。
- `browserpilot-mcp doctor --browser Chrome` 可用于检查 Native Host、扩展 ID 和浏览器配置。
- 如果扩展刚安装或 Native Host 配置刚变化，请 reload 扩展，必要时完全退出并重新打开 Chrome。
- 如果 `.extension-id` 与浏览器显示的 Extension ID 不一致，请确认是否更换过 PEM 或重新打包过扩展。

## 安全说明

BrowserPilot MCP 的安全边界设计：

- daemon 只监听 loopback：`127.0.0.1:18765`，不暴露公网监听端口。
- daemon client 使用 token auth，adapter 和 native host 都需要通过本机 token 连接 daemon。
- LaunchAgent 是 macOS 用户级配置，不是系统级 daemon。
- 不提供关闭浏览器的工具，避免 MCP 工具关闭用户浏览器。
- URL 输入只允许 `http:`、`https:` 和 `about:blank`。
- `close_managed_tabs` 只清理 BrowserPilot 管理的 tab，不清理用户原有 tab。

## 清理 / 卸载

如果版本已实现 daemon 卸载命令，可以运行：

```bash
browserpilot-mcp daemon uninstall
```

查看卸载计划但不执行：

```bash
browserpilot-mcp daemon uninstall --dry-run
```

完整清理 Native Messaging manifest 等安装产物：

```bash
./uninstall.sh
```

卸载后也可以在浏览器扩展管理页手动移除 BrowserPilot MCP 扩展。

## MCP Tools

常用 MCP 工具包括：

| Tool | Description |
|------|-------------|
| `health_check` | 返回 daemon、native host、扩展等结构化诊断信息 |
| `ensure_active_tab` | 确保存在可操作 active tab；必要时打开 tab / 启动浏览器 |
| `close_managed_tabs` | 只关闭 BrowserPilot 创建/管理的 tab |
| `list_pages` | List all open browser tabs |
| `navigate_page` | Navigate to a URL in a tab |
| `take_screenshot` | Capture a screenshot of the current page |
| `click` | Click an element by selector or coordinates |
| `type_text` | Type text into an input field |
| `fill_form` | Fill multiple form fields at once |
| `press_key` | Press a keyboard key (Enter, Escape, arrows, etc.) |
| `hover` | Hover over an element |
| `drag` | Drag from one coordinate to another |
| `wait_for` | Wait for a visible element matching a CSS selector |
| `evaluate_script` | Execute JavaScript on the page |
| `get_console_message` | Get a specific console message |
| `list_console_messages` | List console messages |
| `get_network_request` | Get a network request |
| `list_network_requests` | List network requests |
| `handle_dialog` | Accept or dismiss JavaScript dialogs |
| `resize_page` | Resize the browser window |
| `new_page` | Open a new tab |
| `close_page` | Low-level compatibility tool for closing a specified tab |

## Development checks

开发或发布前常用检查：

```bash
npm run check:extension
npm run check:daemon-contract
```

扩展改动后，在 `chrome://extensions` 中点击 BrowserPilot MCP 的 reload / 刷新按钮，让 service worker 和扩展资源重新加载。

## License

MIT
