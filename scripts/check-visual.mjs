#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const failures = [];
const expectedVersion = process.argv[2] ?? (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return '1.1.1';
  }
})();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const manifest = JSON.parse(read('extension/manifest.json'));
assert(manifest.action?.default_popup === 'popup.html', 'manifest action.default_popup must be popup.html');
assert(manifest.version === expectedVersion, `manifest version must be ${expectedVersion}`);
assert(/[一-鿿]/.test(manifest.description || ''), 'manifest description must include Chinese localized text');

for (const rel of ['extension/popup.html', 'extension/popup.css', 'extension/popup.js']) {
  assert(fs.existsSync(path.join(root, rel)), `${rel} must exist`);
}

const popupHtml = read('extension/popup.html');
const popupJs = read('extension/popup.js');
assert(popupHtml.includes('检查中') && popupHtml.includes('最近错误'), 'popup.html must include Chinese status/error labels');
assert(popupJs.includes('准备就绪') && popupJs.includes('需要处理') && popupJs.includes('复制成功'), 'popup.js must include Chinese localized status and copy feedback');

const background = read('extension/background.js');
assert(background.includes("case 'health_check'"), 'background.js must handle health_check tool calls');
for (const code of ['NATIVE_HOST_NOT_FOUND', 'NATIVE_HOST_EXITED', 'NATIVE_HOST_FORBIDDEN', 'NATIVE_HOST_DISCONNECTED']) {
  assert(background.includes(code), `background.js must map ${code}`);
}
assert(background.includes('chrome.runtime.onMessage.addListener'), 'background.js must accept popup runtime messages');
assert(background.includes("method === 'health_check'"), 'background.js must accept health_check popup messages');
assert(!background.includes('chrome.runtime.onMessageExternal'), 'background.js must not expose tool calls to external extension messages');
assert(!background.includes('chrome.runtime.onConnectExternal'), 'background.js must not accept external extension connections');
assert(!background.includes('activeTabId'), 'health_check must not return active tab id');
assert(!background.includes('activeTab?.url'), 'health_check must not return active tab URL');
assert(background.includes('windowCount') && background.includes('tabCount'), 'health_check must return browser windowCount and tabCount');
assert(background.includes('重新运行 install.sh') && background.includes('重启浏览器'), 'background structured error hints must be localized to Chinese');

const readme = read('README.md');
assert(!readme.includes('full feature parity'), 'README must not claim full feature parity');
assert(!readme.includes('Accessibility tree traversal'), 'README must not claim accessibility tree traversal');
assert(readme.includes('### 快速验证') && readme.includes('### 可视化状态弹窗') && readme.includes('### 常见错误'), 'README must include Chinese quick verification, popup, and common error sections');
assert(readme.includes('`wait_for` | 等待匹配 CSS selector 的可见元素'), 'README wait_for description must be localized and selector-only');

const mcpCompat = read('host/mcp-server.js');
const mcpAdapter = read('host/mcp-adapter.js');
const mcpTools = read('host/tools.js');
assert(mcpCompat.includes('mcp-adapter.js'), 'MCP compatibility entrypoint must delegate to adapter');
assert(/name:\s*['"]health_check['"]/.test(mcpTools), 'MCP tools list must include health_check');
assert(mcpAdapter.includes('buildLocalHealthCheck') || mcpAdapter.includes('health_check'), 'MCP adapter must implement health_check handling');
assert(mcpTools.includes('扩展未连接') && mcpTools.includes('nextSteps'), 'MCP health_check must return localized diagnostics when extension is disconnected');
assert(mcpAdapter.includes(`version: '${expectedVersion}'`), `MCP server version must be ${expectedVersion}`);

if (failures.length) {
  console.error('Visual checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Visual checks passed');
