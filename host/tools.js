export function buildLocalHealthCheck({ daemonConnected = false, nativeHostConnected = false, daemonStatus = null, lastError = null } = {}) {
  const ready = Boolean(daemonConnected && nativeHostConnected);
  return {
    overallStatus: ready ? 'Ready' : 'Action required',
    mcpServer: {
      connected: true,
      mode: 'stdio-adapter',
      daemonConnected,
    },
    daemon: daemonStatus || {
      connected: daemonConnected,
    },
    extension: {
      connected: nativeHostConnected,
    },
    nativeHost: {
      connected: nativeHostConnected,
      status: nativeHostConnected ? '已通过 daemon 连接' : 'Native host / browser extension is not connected to daemon',
    },
    browserAccess: {
      ok: nativeHostConnected,
      status: nativeHostConnected ? '将由扩展 health_check 检查' : '扩展未连接，暂无法确认浏览器访问状态',
    },
    lastError,
    nextSteps: ready ? [] : [
      'Start the daemon with browserpilot-mcp daemon start --foreground or an external launch agent.',
      'Reload the browser extension so Chrome starts the Native Messaging host.',
      'Run browserpilot-mcp daemon status --json to inspect daemon/client state.',
    ],
    checkedAt: new Date().toISOString(),
  };
}

export function formatMcpToolResult(result) {
  if (result && typeof result === 'object' && typeof result.screenshot === 'string') {
    return {
      content: [{
        type: 'image',
        data: result.screenshot.split(',')[1] || result.screenshot,
        mimeType: 'image/png',
      }],
      isError: false,
    };
  }

  return {
    content: [{
      type: 'text',
      text: result === undefined ? 'Operation completed successfully' : JSON.stringify(result, null, 2),
    }],
    isError: false,
  };
}

export const tools = [
  { name: 'list_pages', description: 'List all open browser tabs/pages', inputSchema: { type: 'object', properties: {} } },
  { name: 'navigate_page', description: 'Navigate to a URL in the browser', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to navigate to' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['url'] } },
  { name: 'take_screenshot', description: 'Take a PNG screenshot of the current page. By default captures the visible viewport; with fullPage=true, uses CDP Page.getLayoutMetrics and Page.captureScreenshot to capture the full page.', inputSchema: { type: 'object', properties: { page: { type: 'number', description: 'Optional page/tab ID to use' }, fullPage: { type: 'boolean', description: 'When true, capture the full page using CDP Page.captureScreenshot; when false or omitted, capture the visible viewport.' } } } },
  { name: 'click', description: 'Click an element on the page', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the element to click' }, page: { type: 'number', description: 'Optional page/tab ID to use' }, coordinates: { type: 'object', description: 'Optional x/y coordinates to click', properties: { x: { type: 'number' }, y: { type: 'number' } } } } } },
  { name: 'type_text', description: 'Type text into an input field', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the input field' }, text: { type: 'string', description: 'The text to type' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['text'] } },
  { name: 'fill_form', description: 'Fill multiple form fields at once', inputSchema: { type: 'object', properties: { fields: { type: 'array', description: 'Array of field selectors and values', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['fields'] } },
  { name: 'press_key', description: 'Press a keyboard key', inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The key to press (e.g., Enter, Escape, ArrowUp)' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['key'] } },
  { name: 'hover', description: 'Hover over an element', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the element to hover over' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['selector'] } },
  { name: 'drag', description: 'Drag from one point to another', inputSchema: { type: 'object', properties: { start: { type: 'object', description: 'Starting coordinates', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, end: { type: 'object', description: 'Ending coordinates', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['start', 'end'] } },
  { name: 'wait_for', description: 'Wait for a visible element matching a CSS selector. JavaScript conditions are not supported; use evaluate_script explicitly when script execution is intended.', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to wait for; required because condition-based waiting is not supported.' }, timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }, condition: { type: 'string', const: '', description: 'Unsupported. Passing a condition will make the extension reject the request; use evaluate_script explicitly instead.' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['selector'] } },
  { name: 'evaluate_script', description: 'Evaluate JavaScript on the page via chrome.scripting.executeScript. The script runs with extension execution semantics and must return a JSON-serializable value; returnByValue is accepted for API compatibility but the extension always returns the serialized result value.', inputSchema: { type: 'object', properties: { script: { type: 'string', description: 'The JavaScript to evaluate' }, page: { type: 'number', description: 'Optional page/tab ID to use' }, returnByValue: { type: 'boolean', description: 'Accepted for compatibility only. The extension currently always returns the serialized result value.' } }, required: ['script'] } },
  { name: 'get_console_message', description: 'Get a captured console message by ID. Console events are captured from CDP Runtime.consoleAPICalled, Log.entryAdded, and content-script interception.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The message ID' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['id'] } },
  { name: 'list_console_messages', description: 'List captured console messages from CDP Runtime.consoleAPICalled, Log.entryAdded, and content-script interception.', inputSchema: { type: 'object', properties: { page: { type: 'number', description: 'Optional page/tab ID to use' }, type: { type: 'string', description: 'Optional message type filter (log, error, warn, etc.)' } } } },
  { name: 'get_network_request', description: 'Get captured network request metadata by ID. Captures CDP Network request/response lifecycle metadata only; response bodies are not included.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The request ID' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['id'] } },
  { name: 'list_network_requests', description: 'List captured network request metadata from CDP Network events. Returns metadata such as URL, method, headers, status, mime type, timing/status fields, and encoded data length; response bodies are not included.', inputSchema: { type: 'object', properties: { page: { type: 'number', description: 'Optional page/tab ID to use' }, type: { type: 'string', description: 'Optional CDP resource type filter, such as Document, Fetch, XHR, Script, Stylesheet, Image, Media, Font, WebSocket, or Other.' }, status: { type: 'string', enum: ['pending', 'completed', 'failed'], description: 'Optional request lifecycle status filter.' }, urlContains: { type: 'string', description: 'Optional substring filter applied to request URLs.' } } } },
  { name: 'handle_dialog', description: 'Handle a JavaScript dialog (alert, confirm, prompt)', inputSchema: { type: 'object', properties: { accept: { type: 'boolean', description: 'Whether to accept (true) or dismiss (false) the dialog' }, promptText: { type: 'string', description: 'Optional text to enter for prompt dialogs' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['accept'] } },
  { name: 'resize_page', description: 'Resize the browser window', inputSchema: { type: 'object', properties: { width: { type: 'number', description: 'The window width in pixels' }, height: { type: 'number', description: 'The window height in pixels' }, page: { type: 'number', description: 'Optional page/tab ID to use' } }, required: ['width', 'height'] } },
  { name: 'new_page', description: 'Open a new browser tab', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Optional URL to navigate to in the new tab' } } } },
  { name: 'close_page', description: 'Low-level tab close tool kept for compatibility; refuses to close the last browser window. Prefer close_managed_tabs for BrowserPilot-managed lifecycle cleanup.', inputSchema: { type: 'object', properties: { page: { type: 'number', description: 'Optional page/tab ID to close' } } } },
  { name: 'health_check', description: '返回 MCP 服务、浏览器扩展、原生主机、浏览器访问状态和下一步操作的结构化诊断信息。Use this to check whether the browser automation bridge is ready.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ensure_active_tab', description: '确保存在一个可用且激活的浏览器 tab。如果当前窗口已有 active tab 则直接复用；如果没有任何 tab 但浏览器进程仍在，则新建 tab；如果连窗口都没有，会按 platform 启动 Chrome（macOS: open -a Google Chrome；Linux: xdg-open；Windows: rundll32.exe url.dll,FileProtocolHandler）。本工具不会关 Chrome，不会结束浏览器进程；启动浏览器仅在显式调用本工具时发生。', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '可选：新建 tab 时要打开的 URL，缺省 about:blank' }, browser: { type: 'string', enum: ['auto', 'chrome', 'edge', 'brave'], description: '缺省 chrome；auto 由系统决定，chrome/edge/brave 显式指定浏览器应用名（仅用于启动命令）' } } } },
  { name: 'close_managed_tabs', description: '关闭 BrowserPilot MCP 自身打开/使用过的 tab。默认只关参数里给定的 tabId（如果属于受管集合）；传 allManaged=true 时关闭所有受管 tab。永远不关 Chrome 浏览器本身；如果关闭全部受管 tab 会导致最后一个窗口被清空，工具会改为仅从受管集合移除而不调用 chrome.tabs.remove。', inputSchema: { type: 'object', properties: { tabId: { type: 'integer', description: '可选：要关闭的 tab id（必须此前被 BrowserPilot 注册为受管）' }, allManaged: { type: 'boolean', description: '可选：true 时关闭所有受管 tab；缺省 false 只关 tabId' } } } },
];
