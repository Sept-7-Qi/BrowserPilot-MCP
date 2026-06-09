const NATIVE_HOST_NAME = 'com.openclaudeinchrome.host';
const KEEP_ALIVE_ALARM = 'keep-alive-alarm';
const KEEP_ALIVE_INTERVAL = 25000;

const state = {
  nativePort: null,
  nativeStatus: 'disconnected',
  lastNativeError: null,
  connectedAt: null,
  disconnectedAt: null,
  reconnectAttempts: 0,
  pendingMessages: new Map(),
  messageId: 0,
  activeDebuggers: new Map(),
  debuggerTabs: new Map(),
  elementRefs: new WeakMap(),
  elementIdCounter: 0,
  // BrowserPilot-created tabs only. Reused user tabs are borrowed and never
  // eligible for close_managed_tabs.
  managedTabIds: new Set(),
  borrowedTabIds: new Set()
};

function log(...args) {
  console.log('[Background]', ...args);
}

function error(...args) {
  console.error('[Background]', ...args);
}

function generateMessageId() {
  return ++state.messageId;
}

function mapNativeDisconnectError(lastError) {
  const message = lastError?.message || '';
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('access to the specified native messaging host is forbidden')) {
    return {
      code: 'NATIVE_HOST_FORBIDDEN',
      message: '原生消息主机拒绝了当前扩展 ID。',
      rawMessage: message,
      hint: '请使用当前扩展 ID 重新运行 install.sh，然后重启浏览器。'
    };
  }

  if (lowerMessage.includes('specified native messaging host not found')) {
    return {
      code: 'NATIVE_HOST_NOT_FOUND',
      message: '浏览器找不到原生消息主机清单。',
      rawMessage: message,
      hint: '请使用当前扩展 ID 重新运行 install.sh，让 Chrome 能找到原生消息主机清单，然后重启浏览器。'
    };
  }

  if (lowerMessage.includes('native host has exited') || lowerMessage.includes('native messaging host exited')) {
    return {
      code: 'NATIVE_HOST_EXITED',
      message: '原生消息主机启动后退出。',
      rawMessage: message,
      hint: '请检查 host/native-host.js 日志，并确认 host 依赖已安装。'
    };
  }

  return {
    code: 'NATIVE_HOST_DISCONNECTED',
    message: '原生消息主机连接已断开。',
    rawMessage: message || null,
    hint: '请等待扩展重新连接原生主机后刷新弹窗；如持续失败，请重启浏览器。'
  };
}

function setupKeepAlive() {
  chrome.alarms.get(KEEP_ALIVE_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(KEEP_ALIVE_ALARM, {
        periodInMinutes: KEEP_ALIVE_INTERVAL / 60000
      });
    }
  });
}

const ACTION_STATES = {
  connected: {
    title: 'BrowserPilot MCP — 已连接',
    text: '✓',
    color: [34, 139, 34, 255]
  },
  connecting: {
    title: 'BrowserPilot MCP — 连接中',
    text: '…',
    color: [30, 144, 255, 255]
  },
  disconnected: {
    title: 'BrowserPilot MCP — 未连接',
    text: '',
    color: [220, 53, 69, 255]
  }
};

function updateActionState(status) {
  const config = ACTION_STATES[status] || ACTION_STATES.disconnected;
  try {
    chrome.action.setTitle({ title: config.title });
    chrome.action.setBadgeText({ text: config.text });
    chrome.action.setBadgeBackgroundColor({ color: config.color });
  } catch (e) {
    log('updateActionState failed:', e.message);
  }

  // Mirror the same state onto the active tab via a colored Tab Group so the
  // user sees an obvious visual signal in the tab strip that BrowserPilot MCP
  // is in control of the tab.
  applyTabGroupState(status);
}

// Tab Group colors are a fixed Chrome enum (grey/blue/red/yellow/green/pink/
// purple/cyan/orange). Older Chromium builds don't support every value, so
// each call wraps chrome.tabGroups.update in a try/catch + lastError guard
// and falls back to 'grey' if the requested color is rejected.
const TAB_GROUP_COLORS = {
  connected: 'green',
  connecting: 'blue',
  disconnected: null
};

const TAB_GROUP_TITLES = {
  connected: 'BrowserPilot 已连接',
  connecting: 'BrowserPilot 连接中'
};

function isInjectableTabUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // chrome://, edge://, about:, the Chrome Web Store, and PDF viewers cannot
  // host a content script. Skip them to avoid "Receiving end does not exist".
  return /^https?:\/\//i.test(url);
}

function validateBrowserPilotUrl(url, { allowEmpty = true } = {}) {
  if ((url === undefined || url === null || url === '') && allowEmpty) return 'about:blank';
  if (typeof url !== 'string') throw new Error('URL must be a string');
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === 'about:blank') return trimmed;
  for (const scheme of ['file:', 'javascript:', 'data:', 'chrome:', 'chrome-extension:', 'devtools:']) {
    if (lower.startsWith(scheme)) {
      throw new Error(`URL scheme is not allowed: ${scheme}`);
    }
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Only http://, https://, and about:blank URLs are allowed');
  }
  return trimmed;
}

async function applyTabGroupState(status) {
  if (!chrome.tabs?.query || !chrome.tabGroups || !chrome.tabs.group || !chrome.tabGroups.update || !chrome.tabs.ungroup) {
    return;
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    log('applyTabGroupState query failed:', e.message);
    return;
  }

  const tab = tabs && tabs[0];
  if (!tab || !isInjectableTabUrl(tab.url)) return;

  if (status === 'disconnected') {
    // Always clear any existing group on the active tab when we disconnect so
    // the visual marker disappears as soon as the native host goes away.
    try {
      await chrome.tabs.ungroup([tab.id]);
    } catch (e) {
      void chrome.runtime.lastError;
      log('applyTabGroupState ungroup failed:', e?.message || chrome.runtime.lastError?.message);
    }
    return;
  }

  const desiredColor = TAB_GROUP_COLORS[status];
  const title = TAB_GROUP_TITLES[status];
  if (!desiredColor || !title) return;

  let groupId;
  try {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  } catch (e) {
    void chrome.runtime.lastError;
    log('applyTabGroupState group failed:', e?.message || chrome.runtime.lastError?.message);
    return;
  }

  if (groupId === undefined || groupId === null || groupId === -1) {
    void chrome.runtime.lastError;
    return;
  }

  try {
    await chrome.tabGroups.update(groupId, { title, color: desiredColor });
  } catch (e) {
    void chrome.runtime.lastError;
    // Older Chromium versions may not support every color name. Fall back to
    // 'grey' so the user still gets a visible group marker.
    try {
      await chrome.tabGroups.update(groupId, { title, color: 'grey' });
      log('applyTabGroupState: color', desiredColor, 'not supported, fell back to grey');
    } catch (e2) {
      void chrome.runtime.lastError;
      log('applyTabGroupState fallback update failed:', e2?.message || chrome.runtime.lastError?.message);
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) {
    chrome.storage.local.get('keepalive', () => {});
  }
});

function connectNative() {
  if (state.nativePort) {
    try {
      state.nativePort.disconnect();
    } catch (e) {}
  }

  state.nativeStatus = 'connecting';
  updateActionState('connecting');
  state.nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  state.nativeStatus = 'connected';
  updateActionState('connected');
  state.lastNativeError = null;
  state.connectedAt = new Date().toISOString();

  state.nativePort.onMessage.addListener(handleNativeMessage);
  state.nativePort.onDisconnect.addListener(() => {
    const lastError = chrome.runtime.lastError;
    const mappedError = mapNativeDisconnectError(lastError);
    state.nativeStatus = 'disconnected';
    updateActionState('disconnected');
    state.lastNativeError = mappedError;
    state.disconnectedAt = new Date().toISOString();
    state.reconnectAttempts += 1;
    if (lastError) {
      error('Native host disconnected:', lastError.message);
    }
    state.nativePort = null;
    setTimeout(connectNative, 1000);
  });

  log('Connected to native host');
}

function handleNativeMessage(message) {
  log('Received from native:', { id: message?.id, method: message?.method });

  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.id && state.pendingMessages.has(message.id)) {
    const { resolve, reject } = state.pendingMessages.get(message.id);
    state.pendingMessages.delete(message.id);
    if (message.error) {
      reject(new Error(message.error));
    } else {
      resolve(message.result);
    }
    return;
  }

  if (message.method) {
    handleToolCall(message);
  }
}

function sendToNative(message) {
  return new Promise((resolve, reject) => {
    if (!state.nativePort) {
      reject(new Error('Native host not connected'));
      return;
    }

    const id = generateMessageId();
    const wrapped = { ...message, id };

    state.pendingMessages.set(id, { resolve, reject });

    try {
      state.nativePort.postMessage(wrapped);
    } catch (e) {
      state.pendingMessages.delete(id);
      reject(e);
    }
  });
}

function respondToNative(id, payload) {
  if (!state.nativePort) {
    error('Cannot respond to native host: disconnected');
    return;
  }

  try {
    state.nativePort.postMessage({ ...payload, id });
  } catch (e) {
    error('Failed to respond to native host:', e.message);
  }
}

async function handleToolCall(message) {
  const { id, method, params = {} } = message;

  try {
    let result;
    switch (method) {
      case 'list_pages':
        result = await toolListPages();
        break;
      case 'navigate_page':
        result = await toolNavigatePage(params);
        break;
      case 'take_screenshot':
        result = await toolTakeScreenshot(params);
        break;
      case 'click':
        result = await toolClick(params);
        break;
      case 'type_text':
        result = await toolTypeText(params);
        break;
      case 'fill_form':
        result = await toolFillForm(params);
        break;
      case 'press_key':
        result = await toolPressKey(params);
        break;
      case 'hover':
        result = await toolHover(params);
        break;
      case 'drag':
        result = await toolDrag(params);
        break;
      case 'wait_for':
        result = await toolWaitFor(params);
        break;
      case 'evaluate_script':
        result = await toolEvaluateScript(params);
        break;
      case 'get_console_message':
        result = await toolGetConsoleMessage(params);
        break;
      case 'list_console_messages':
        result = await toolListConsoleMessages(params);
        break;
      case 'get_network_request':
        result = await toolGetNetworkRequest(params);
        break;
      case 'list_network_requests':
        result = await toolListNetworkRequests(params);
        break;
      case 'handle_dialog':
        result = await toolHandleDialog(params);
        break;
      case 'resize_page':
        result = await toolResizePage(params);
        break;
      case 'new_page':
        result = await toolNewPage(params);
        break;
      case 'close_page':
        result = await toolClosePage(params);
        break;
      case 'health_check':
        result = await toolHealthCheck();
        break;
      case 'ensure_active_tab':
        result = await toolEnsureActiveTab(params);
        break;
      case 'close_managed_tabs':
        result = await toolCloseManagedTabs(params);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    if (id !== undefined && id !== null) {
      respondToNative(id, { result });
    }
    return result;
  } catch (e) {
    error(`Tool ${method} failed:`, e);
    if (id !== undefined && id !== null) {
      respondToNative(id, { error: e.message });
    }
    throw e;
  }
}

async function toolListPages() {
  const windows = await chrome.windows.getAll({ populate: true });
  const pages = [];

  for (const win of windows) {
    for (const tab of win.tabs || []) {
      pages.push({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: win.id,
        incognito: win.incognito
      });
    }
  }

  return { pages };
}

async function toolNavigatePage({ url, page }) {
  const safeUrl = validateBrowserPilotUrl(url, { allowEmpty: false });
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  if (!state.managedTabIds.has(tabId)) state.borrowedTabIds.add(tabId);
  await chrome.tabs.update(tabId, { url: safeUrl });
  await waitForTabLoad(tabId);

  return { success: true, url: safeUrl };
}

async function toolTakeScreenshot({ page, fullPage = false }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  if (!state.managedTabIds.has(tabId)) state.borrowedTabIds.add(tabId);
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });

  await new Promise(resolve => setTimeout(resolve, 300));

  if (fullPage) {
    await ensureDebuggerAttached(tabId);
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const contentSize = metrics.cssContentSize || metrics.contentSize;

    if (!contentSize || !contentSize.width || !contentSize.height) {
      throw new Error('Unable to determine full page content size');
    }

    const screenshot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(contentSize.width),
        height: Math.ceil(contentSize.height),
        scale: 1
      }
    });

    return { screenshot: `data:image/png;base64,${screenshot.data}`, fullPage: true };
  }

  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png'
  });

  return { screenshot, fullPage: false };
}

async function toolClick({ selector, page, coordinates }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  let result;
  if (coordinates) {
    result = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (x, y) => {
        const elem = document.elementFromPoint(x, y);
        if (!elem) {
          return { success: false, error: 'No element at coordinates' };
        }
        elem.click();
        return { success: true, tag: elem.tagName };
      },
      args: [coordinates.x, coordinates.y]
    });
  } else if (selector) {
    result = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (sel) => {
        const elem = document.querySelector(sel);
        if (!elem) {
          return { success: false, error: 'Element not found' };
        }
        elem.scrollIntoView({ behavior: 'instant', block: 'center' });
        elem.click();
        return { success: true, tag: elem.tagName };
      },
      args: [selector]
    });
  }

  const frameResult = result?.[0]?.result;
  if (!frameResult?.success) {
    throw new Error(frameResult?.error || 'Click failed');
  }

  return { success: true };
}

async function toolTypeText({ selector, text, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const result = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (sel, txt) => {
      const elem = sel ? document.querySelector(sel) : document.activeElement;
      if (!elem) {
        return { success: false, error: 'Element not found' };
      }
      elem.scrollIntoView({ behavior: 'instant', block: 'center' });
      elem.focus();

      if (elem instanceof HTMLInputElement || elem instanceof HTMLTextAreaElement || elem.isContentEditable) {
        if ('value' in elem) {
          elem.value = txt;
        } else {
          elem.textContent = txt;
        }
        elem.dispatchEvent(new Event('input', { bubbles: true }));
        elem.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }
      return { success: false, error: 'Not an input element' };
    },
    args: [selector, text]
  });

  const frameResult = result?.[0]?.result;
  if (!frameResult?.success) {
    throw new Error(frameResult?.error || 'Type failed');
  }

  return { success: true };
}

async function toolFillForm({ fields, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const result = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (fieldList) => {
      const results = [];
      for (const { selector, value } of fieldList) {
        const elem = document.querySelector(selector);
        if (elem) {
          elem.scrollIntoView({ behavior: 'instant', block: 'center' });
          if ('value' in elem) {
            elem.value = value;
          } else if (elem.isContentEditable) {
            elem.textContent = value;
          }
          elem.dispatchEvent(new Event('input', { bubbles: true }));
          elem.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ selector, success: true });
        } else {
          results.push({ selector, success: false, error: 'Not found' });
        }
      }
      return results;
    },
    args: [fields]
  });

  return { results: result?.[0]?.result || [] };
}

async function toolPressKey({ key, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  await ensureDebuggerAttached(tabId);

  const keyMap = {
    'Enter': 'Enter',
    'Escape': 'Escape',
    'Tab': 'Tab',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'ArrowUp': 'ArrowUp',
    'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft',
    'ArrowRight': 'ArrowRight',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown'
  };

  const keyName = keyMap[key] || key;

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    windowsVirtualKeyCode: getKeyCode(keyName)
  });

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    windowsVirtualKeyCode: getKeyCode(keyName)
  });

  return { success: true };
}

function getKeyCode(key) {
  const map = {
    'Enter': 13, 'Escape': 27, 'Tab': 9, 'Backspace': 8, 'Delete': 46,
    'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
    'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34
  };
  return map[key] || 0;
}

async function toolHover({ selector, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  await ensureDebuggerAttached(tabId);

  const posResult = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (sel) => {
      const elem = document.querySelector(sel);
      if (!elem) return null;
      const rect = elem.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    },
    args: [selector]
  });

  const pos = posResult?.[0]?.result;
  if (!pos) {
    throw new Error('Element not found');
  }

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: pos.x,
    y: pos.y
  });

  return { success: true };
}

async function toolDrag({ start, end, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  await ensureDebuggerAttached(tabId);

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left'
  });

  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = start.x + (end.x - start.x) * (i / steps);
    const y = start.y + (end.y - start.y) * (i / steps);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y
    });
  }

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: end.x,
    y: end.y,
    button: 'left'
  });

  return { success: true };
}

async function toolWaitFor({ selector, timeout = 30000, condition, page }) {
  if (condition) {
    throw new Error('wait_for.condition is not supported because it would require implicit eval; use evaluate_script explicitly when script execution is intended');
  }

  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  if (!selector) {
    throw new Error('wait_for requires selector');
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (sel) => {
        const elem = document.querySelector(sel);
        if (!elem) {
          return { found: false, visible: false };
        }

        const rect = elem.getBoundingClientRect();
        const style = window.getComputedStyle(elem);
        const visible = style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;

        return { found: true, visible };
      },
      args: [selector]
    });

    const frameResult = result?.find(item => item?.result?.found)?.result || result?.[0]?.result;
    if (frameResult?.found && frameResult.visible) {
      return { success: true };
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Wait timed out');
}

async function toolEvaluateScript({ script, page, returnByValue = true }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const result = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (scr) => {
      try {
        const result = eval(scr);
        return { success: true, result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    args: [script]
  });

  const frameResult = result?.[0]?.result;
  if (!frameResult?.success) {
    throw new Error(frameResult?.error || 'Evaluation failed');
  }

  return { result: frameResult.result };
}

async function toolGetConsoleMessage({ id, page }) {
  const messages = await getConsoleMessages(page);
  const msg = messages.find(m => m.id === id);
  return { message: msg || null };
}

async function toolListConsoleMessages({ page, type }) {
  const messages = await getConsoleMessages(page);
  const filtered = type ? messages.filter(m => m.type === type) : messages;
  return { messages: filtered };
}

async function getConsoleMessages(page) {
  const tabId = await getTargetTabId(page);
  if (!tabId) return [];

  const tabState = await ensureDebuggerAttached(tabId);
  const debuggerMessages = tabState.consoleMessages;
  const contentMessages = await getContentConsoleMessages(tabId);
  const merged = [...debuggerMessages, ...contentMessages];
  const unique = new Map();

  for (const message of merged) {
    unique.set(message.id, message);
  }

  return Array.from(unique.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function getContentConsoleMessages(tabId) {
  try {
    const responses = await chrome.tabs.sendMessage(tabId, { action: 'getConsoleMessages' });
    if (responses?.success && Array.isArray(responses.messages)) {
      return responses.messages.map(message => ({
        ...message,
        source: message.source || 'content-script',
        timestamp: normalizeTimestamp(message.timestamp)
      }));
    }
  } catch (e) {
    log('Content console messages unavailable:', e.message);
  }

  return [];
}

async function toolGetNetworkRequest({ id, page }) {
  const requests = await getNetworkRequests(page);
  return { request: requests.find(request => request.id === id) || null };
}

async function toolListNetworkRequests({ page, type, status, urlContains }) {
  const requests = await getNetworkRequests(page);
  const filtered = requests.filter(request => {
    if (type && request.type !== type) return false;
    if (status && request.status !== status) return false;
    if (urlContains && !request.url?.includes(urlContains)) return false;
    return true;
  });

  return { requests: filtered };
}

async function getNetworkRequests(page) {
  const tabId = await getTargetTabId(page);
  if (!tabId) return [];

  const tabState = await ensureDebuggerAttached(tabId);
  return Array.from(tabState.networkRequests.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'number') return timestamp;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function pushBounded(array, item, max = 1000) {
  array.push(item);
  while (array.length > max) {
    array.shift();
  }
}

function createTabDebugState(tabId) {
  return {
    tabId,
    consoleMessages: [],
    networkRequests: new Map()
  };
}

function getTabDebugState(tabId) {
  let tabState = state.debuggerTabs.get(tabId);
  if (!tabState) {
    tabState = createTabDebugState(tabId);
    state.debuggerTabs.set(tabId, tabState);
  }
  return tabState;
}

async function toolHandleDialog({ accept, promptText, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  await ensureDebuggerAttached(tabId);

  await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
    accept,
    promptText
  });

  return { success: true };
}

async function toolResizePage({ width, height, page }) {
  const tabId = await getTargetTabId(page);

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, {
    width: width + 16,
    height: height + 136
  });

  return { success: true };
}

async function toolNewPage({ url }) {
  const targetUrl = validateBrowserPilotUrl(url);
  const tab = await chrome.tabs.create({ url: targetUrl });
  state.managedTabIds.add(tab.id);
  if (url) {
    await waitForTabLoad(tab.id);
  }
  return { pageId: tab.id, url: tab.url };
}

async function wouldCloseLastWindow(tabId) {
  const windows = await chrome.windows.getAll({ populate: true });
  if ((windows || []).length > 1) return false;
  const onlyWindow = windows && windows[0];
  const tabs = onlyWindow?.tabs || [];
  return tabs.length <= 1 && tabs.some(tab => tab.id === tabId);
}

async function toolClosePage({ page }) {
  const tabId = await getTargetTabId(page);

  if (tabId) {
    if (await wouldCloseLastWindow(tabId)) {
      return { success: false, reason: 'WOULD_CLOSE_LAST_WINDOW', message: 'Refused to close the last browser window.' };
    }
    await chrome.tabs.remove(tabId);
    state.managedTabIds.delete(tabId);
    state.borrowedTabIds.delete(tabId);
  }

  return { success: true };
}

async function toolEnsureActiveTab({ url, browser } = {}) {
  const targetUrl = validateBrowserPilotUrl(url);

  // 1. Prefer the active tab in the current window. This is a borrowed user
  // tab and must never be closable via close_managed_tabs.
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs && activeTabs[0];
  if (active && typeof active.id === 'number') {
    state.borrowedTabIds.add(active.id);
    return {
      tabId: active.id,
      url: active.url || null,
      source: 'active',
      browserStarted: false,
      managed: false,
      message: 'Reused existing active tab as borrowed; Chrome was not restarted.'
    };
  }

  // 2. Otherwise reuse any tab as borrowed.
  const anyTabs = await chrome.tabs.query({});
  const anyTab = anyTabs && anyTabs[0];
  if (anyTab && typeof anyTab.id === 'number') {
    state.borrowedTabIds.add(anyTab.id);
    return {
      tabId: anyTab.id,
      url: anyTab.url || null,
      source: 'any',
      browserStarted: false,
      managed: false,
      message: 'Reused existing tab as borrowed; Chrome was not restarted.'
    };
  }

  // 3. No tabs at all. If no windows exist, delegate the process launch to
  // native-host.js; the extension cannot spawn OS processes.
  const windows = await chrome.windows.getAll({});
  if (!windows || windows.length === 0) {
    return {
      tabId: null,
      url: targetUrl,
      source: 'needs-browser-launch',
      browserStarted: false,
      delegatedTo: 'native-host',
      browser: browser || 'chrome',
      message: 'No browser windows exist; native-host must start the browser for explicit ensure_active_tab.'
    };
  }

  // 4. Windows exist but no tabs — create a BrowserPilot-managed tab.
  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  state.managedTabIds.add(created.id);
  if (url) await waitForTabLoad(created.id);
  return {
    tabId: created.id,
    url: created.url || targetUrl,
    source: 'created',
    browserStarted: false,
    managed: true,
    message: 'Created a new BrowserPilot-managed tab; Chrome was not restarted.'
  };
}

async function toolCloseManagedTabs({ tabId, allManaged } = {}) {
  if (allManaged !== undefined && typeof allManaged !== 'boolean') {
    throw new Error('close_managed_tabs.allManaged must be a boolean when provided');
  }
  if (tabId !== undefined && !Number.isInteger(tabId)) {
    throw new Error('close_managed_tabs.tabId must be an integer when provided');
  }

  const targets = new Set();
  if (allManaged === true) {
    for (const id of state.managedTabIds) targets.add(id);
  } else if (Number.isInteger(tabId)) {
    if (!state.managedTabIds.has(tabId)) {
      return {
        removed: [],
        skipped: [tabId],
        reason: 'TAB_NOT_MANAGED',
        message: `tabId ${tabId} is not managed by BrowserPilot; refusing to close it.`
      };
    }
    targets.add(tabId);
  } else {
    return {
      removed: [],
      skipped: [],
      reason: 'NO_TARGET',
      message: 'close_managed_tabs requires either tabId or allManaged=true.'
    };
  }

  const windows = await chrome.windows.getAll({ populate: true });
  const allTabs = [];
  for (const win of windows || []) for (const tab of win.tabs || []) allTabs.push(tab);
  const wouldEmptyLastWindow = (windows || []).length <= 1
    && allTabs.length > 0
    && targets.size >= allTabs.length;

  const removed = [];
  const kept = [];

  for (const id of targets) {
    if (wouldEmptyLastWindow) {
      state.managedTabIds.delete(id);
      kept.push(id);
      continue;
    }
    try {
      await chrome.tabs.remove(id);
      state.managedTabIds.delete(id);
      removed.push(id);
    } catch (e) {
      void chrome.runtime.lastError;
      state.managedTabIds.delete(id);
      kept.push(id);
    }
  }

  return {
    removed,
    kept,
    reason: wouldEmptyLastWindow ? 'WOULD_EMPTY_LAST_WINDOW' : null,
    message: wouldEmptyLastWindow
      ? 'Refused to close the last window; tabs ungrouped from managed set only.'
      : 'Closed only tabs BrowserPilot itself manages; Chrome was not closed.'
  };
}

async function toolHealthCheck() {
  const windows = await chrome.windows.getAll({ populate: true });
  const windowCount = windows.length;
  const tabCount = windows.reduce((count, win) => count + (win.tabs?.length || 0), 0);
  const browserAccessOk = tabCount > 0;
  const nativeConnected = state.nativeStatus === 'connected' && Boolean(state.nativePort);

  // Keep the toolbar badge/title in sync whenever popup asks for a health check.
  updateActionState(nativeConnected ? 'connected' : state.nativeStatus);

  return {
    overallStatus: nativeConnected && browserAccessOk ? 'Ready' : 'Action required',
    extensionLoaded: true,
    nativeHost: {
      connected: nativeConnected,
      status: state.nativeStatus,
      connectedAt: state.connectedAt,
      disconnectedAt: state.disconnectedAt,
      reconnectAttempts: state.reconnectAttempts
    },
    mcpServer: {
      connected: nativeConnected,
      status: nativeConnected ? 'connected via native host' : 'unknown until native host connects'
    },
    browserAccess: {
      ok: browserAccessOk,
      windowCount,
      tabCount
    },
    extensionId: chrome.runtime.id,
    lastError: state.lastNativeError,
    checkedAt: new Date().toISOString()
  };
}

async function getTargetTabId(page) {
  if (page) {
    try {
      await chrome.tabs.get(page);
      return page;
    } catch {
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab.id;

  const [anyTab] = await chrome.tabs.query({});
  return anyTab?.id;
}

async function waitForTabLoad(tabId, timeout = 60000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Tab load timeout');
}

async function ensureDebuggerAttached(tabId) {
  const tabState = getTabDebugState(tabId);

  if (state.activeDebuggers.has(tabId)) {
    return tabState;
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!e.message || !e.message.includes('already attached')) {
      throw e;
    }
  }

  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  state.activeDebuggers.set(tabId, true);

  return tabState;
}

function handleDebuggerEvent(source, method, params) {
  if (!source.tabId) return;

  const tabState = getTabDebugState(source.tabId);

  if (method === 'Runtime.consoleAPICalled') {
    pushBounded(tabState.consoleMessages, {
      id: `runtime-${source.tabId}-${params.timestamp}-${tabState.consoleMessages.length}`,
      source: 'debugger-runtime',
      type: params.type,
      timestamp: params.timestamp || Date.now(),
      args: (params.args || []).map(formatRemoteObject),
      stackTrace: params.stackTrace || null,
      executionContextId: params.executionContextId
    });
    return;
  }

  if (method === 'Log.entryAdded') {
    const entry = params.entry || {};
    pushBounded(tabState.consoleMessages, {
      id: `log-${source.tabId}-${entry.timestamp || Date.now()}-${tabState.consoleMessages.length}`,
      source: 'debugger-log',
      type: entry.level || 'log',
      timestamp: entry.timestamp || Date.now(),
      args: [entry.text || ''],
      url: entry.url || null,
      lineNumber: entry.lineNumber || null
    });
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {};
    tabState.networkRequests.set(params.requestId, {
      id: params.requestId,
      url: request.url,
      method: request.method,
      type: params.type,
      timestamp: params.wallTime ? params.wallTime * 1000 : Date.now(),
      requestHeaders: request.headers || {},
      initiator: params.initiator || null,
      documentURL: params.documentURL || null,
      status: 'pending'
    });
    trimNetworkRequests(tabState.networkRequests);
    return;
  }

  if (method === 'Network.responseReceived') {
    const existing = tabState.networkRequests.get(params.requestId) || { id: params.requestId };
    const response = params.response || {};
    tabState.networkRequests.set(params.requestId, {
      ...existing,
      url: response.url || existing.url,
      type: params.type || existing.type,
      status: 'completed',
      statusCode: response.status,
      statusText: response.statusText,
      mimeType: response.mimeType,
      responseHeaders: response.headers || {},
      remoteIPAddress: response.remoteIPAddress,
      remotePort: response.remotePort,
      protocol: response.protocol,
      securityState: response.securityState,
      responseTimestamp: params.timestamp || Date.now()
    });
    trimNetworkRequests(tabState.networkRequests);
    return;
  }

  if (method === 'Network.loadingFailed') {
    const existing = tabState.networkRequests.get(params.requestId) || { id: params.requestId };
    tabState.networkRequests.set(params.requestId, {
      ...existing,
      type: params.type || existing.type,
      status: 'failed',
      errorText: params.errorText,
      canceled: params.canceled,
      blockedReason: params.blockedReason,
      failedTimestamp: params.timestamp || Date.now()
    });
    trimNetworkRequests(tabState.networkRequests);
    return;
  }

  if (method === 'Network.loadingFinished') {
    const existing = tabState.networkRequests.get(params.requestId);
    if (existing) {
      tabState.networkRequests.set(params.requestId, {
        ...existing,
        status: existing.status === 'pending' ? 'completed' : existing.status,
        encodedDataLength: params.encodedDataLength,
        finishedTimestamp: params.timestamp || Date.now()
      });
      trimNetworkRequests(tabState.networkRequests);
    }
  }
}

function formatRemoteObject(remoteObject) {
  if (!remoteObject) return '';
  if (Object.prototype.hasOwnProperty.call(remoteObject, 'value')) return remoteObject.value;
  if (remoteObject.unserializableValue) return remoteObject.unserializableValue;
  if (remoteObject.description) return remoteObject.description;
  return remoteObject.type || '';
}

function trimNetworkRequests(networkRequests, max = 1000) {
  while (networkRequests.size > max) {
    const oldestKey = networkRequests.keys().next().value;
    networkRequests.delete(oldestKey);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  log('Extension installed');
  setupKeepAlive();
  connectNative();
});

chrome.runtime.onStartup.addListener(() => {
  log('Extension started');
  setupKeepAlive();
  connectNative();
});

chrome.debugger.onEvent.addListener(handleDebuggerEvent);

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    state.activeDebuggers.delete(source.tabId);
    state.debuggerTabs.delete(source.tabId);
  }
});

// When a tab finishes loading (navigation, restore, refresh), replay the
// current native-host state so the colored Tab Group is reapplied to the
// freshly-active tab instead of waiting for the next status change.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.active) return;
  if (!isInjectableTabUrl(tab?.url)) return;
  applyTabGroupState(state.nativeStatus || 'disconnected');
});

// When the user switches active tabs, re-apply the current native-host state
// so the freshly-active tab gets the colored Tab Group (or is ungrouped when
// the host is disconnected) without waiting for a status transition.
chrome.tabs.onActivated.addListener((activeInfo) => {
  applyTabGroupState(state.nativeStatus || 'disconnected');
});

// Tab lifecycle bookkeeping: when a tab is removed (by the user, by Chrome,
// or by close_managed_tabs) drop it from the managed set. If we lose the
// active tab entirely, fall back to the disconnected visual state without
// ungrouping other tabs — the user may still be on their own tab.
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (state.managedTabIds.has(tabId)) {
    state.managedTabIds.delete(tabId);
  }
  if (state.borrowedTabIds.has(tabId)) {
    state.borrowedTabIds.delete(tabId);
  }

  if (removeInfo?.isWindowClosing) {
    return;
  }

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) {
      updateActionState('disconnected');
    }
  } catch (e) {
    log('onRemoved active query failed:', e?.message);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.method === 'health_check') {
    toolHealthCheck().then(result => {
      sendResponse({ result });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
  return false;
});

log('Background service worker loaded');
setupKeepAlive();
connectNative();
