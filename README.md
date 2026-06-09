# BrowserPilot MCP

BrowserPilot MCP 是一个通过本地 MCP 服务与原生消息主机连接 AI Agent 和 Chromium 浏览器的自动化工具。

它由浏览器扩展、本地 MCP 服务和 Native Messaging Host 组成，可以让 Claude Code 等 MCP 客户端执行网页导航、点击、输入、截图、读取浏览器状态等自动化操作。

中文短介绍

BrowserPilot MCP 是一个本地浏览器自动化桥接工具。它通过 MCP 协议把 Claude Code 等 AI Agent 连接到 Chrome/Chromium 浏览器，让 AI 可以安全地执行导航、点击、输入、截图和页面状态读取等操作。

英文短介绍

BrowserPilot MCP is a local browser automation bridge that connects Claude Code and other MCP clients to Chromium-based browsers through a browser extension and Native Messaging Host.

更偏产品介绍

BrowserPilot MCP turns your local Chromium browser into an MCP-controllable automation target. It lets AI agents navigate pages, click elements, type text, capture screenshots, and inspect browser state through a local, explicit, user-installed bridge.

package.json 推荐字段

{
  "name": "browserpilot-mcp",
  "description": "Browser automation MCP bridge for Claude and AI agents"
}

Chrome Extension 描述

{
  "name": "BrowserPilot MCP",
  "description": "通过本地 MCP 与原生消息主机连接 AI Agent 的 Chrome 浏览器自动化扩展"
}

README 功能描述

## 功能

BrowserPilot MCP turns your local Chromium browser into an MCP-controllable automation target. It lets AI agents navigate pages, click elements, type text, capture screenshots, and inspect browser state through a local, explicit, user-installed bridge.

package.json 推荐字段

{
  "name": "browserpilot-mcp",
  "description": "Browser automation MCP bridge for Claude and AI agents"
}

Chrome Extension 描述

{
  "name": "BrowserPilot MCP",
  "description": "通过本地 MCP 与原生消息主机连接 AI Agent 的 Chrome 浏览器自动化扩展"
}

README 功能描述

## 功能

- 浏览器自动化：导航、点击、输入、截图、等待元素、执行页面脚本
- MCP 集成：通过本地 MCP server 暴露浏览器控制工具
- 原生消息桥接：使用 Chrome Native Messaging 连接浏览器扩展和本地服务
- Chromium 支持：适用于 Chrome、Edge、Brave、Vivaldi 和 Chromium
- 本地安装：支持 npm link / npm install -g . 和一键安装脚本
