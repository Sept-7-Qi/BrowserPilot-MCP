#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BrowserPilot MCP exposes a "tab lifecycle management" surface so an MCP
// client can ensure a usable tab exists (and is the active tab) and can
// close only the tabs that BrowserPilot itself opened. This check enforces
// the structural wiring: tool schemas, native-host helpers, and the
// background-service-worker listener that keeps the managed set in sync.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsPath = path.join(root, 'host/tools.js');
const nativeHostPath = path.join(root, 'host/native-host.js');
const tabLifecyclePath = path.join(root, 'host/tab-lifecycle.js');
const backgroundPath = path.join(root, 'extension/background.js');
const packagePath = path.join(root, 'package.json');

const tools = fs.readFileSync(toolsPath, 'utf8');
const nativeHost = fs.readFileSync(nativeHostPath, 'utf8');
const background = fs.readFileSync(backgroundPath, 'utf8');
const tabLifecycle = fs.existsSync(tabLifecyclePath) ? fs.readFileSync(tabLifecyclePath, 'utf8') : '';
const rootPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// --- host/tools.js: must declare ensure_active_tab and close_managed_tabs ---
assert.match(
  tools,
  /name:\s*['"`]ensure_active_tab['"`]/,
  'host/tools.js must register ensure_active_tab tool schema'
);
assert.match(
  tools,
  /name:\s*['"`]close_managed_tabs['"`]/,
  'host/tools.js must register close_managed_tabs tool schema'
);

// --- host/tools.js: ensure_active_tab description must call out start/no-shutdown semantics ---
const ensureActiveMatch = tools.match(
  /name:\s*['"`]ensure_active_tab['"`][\s\S]*?description:\s*['"`]([^'"`]+)['"`]/
);
assert.ok(ensureActiveMatch, 'ensure_active_tab schema missing description');
assert.match(
  ensureActiveMatch[1],
  /chrome/i,
  'ensure_active_tab description must reference Chrome/browser'
);
assert.match(
  ensureActiveMatch[1],
  /(不会|永远不|不)\s*关/i,
  'ensure_active_tab description must explicitly state "不会关"/"永远不关" (will not close Chrome)'
);

// --- host/tools.js: ensure_active_tab schema exposes url + browser ---
assert.match(
  tools,
  /name:\s*['"`]ensure_active_tab['"`][\s\S]*?browser:\s*{[\s\S]*?enum:\s*\[\s*['"`]auto['"`]\s*,\s*['"`]chrome['"`]\s*,\s*['"`]edge['"`]\s*,\s*['"`]brave['"`]\s*\]/,
  'ensure_active_tab browser enum must include auto/chrome/edge/brave'
);

// --- host/tools.js: close_managed_tabs schema exposes tabId + allManaged ---
assert.match(
  tools,
  /name:\s*['"`]close_managed_tabs['"`][\s\S]*?allManaged:\s*{[^}]*type:\s*['"`]boolean['"`]/,
  'close_managed_tabs must expose allManaged boolean'
);
assert.match(
  tools,
  /name:\s*['"`]close_managed_tabs['"`][\s\S]*?tabId:\s*{[^}]*type:\s*['"`]integer['"`]/,
  'close_managed_tabs must expose tabId integer'
);

// --- close_managed_tabs description must NOT promise to close Chrome ---
const closeManagedMatch = tools.match(
  /name:\s*['"`]close_managed_tabs['"`][\s\S]*?description:\s*['"`]([^'"`]+)['"`]/
);
assert.ok(closeManagedMatch, 'close_managed_tabs schema missing description');
assert.match(
  closeManagedMatch[1],
  /(不会|永远不|不)\s*关/i,
  'close_managed_tabs description must explicitly state "不会关"/"永远不关" (will not close Chrome)'
);

// --- host/native-host.js + host/tab-lifecycle.js: real production spawn wiring ---
const combined = nativeHost + '\n' + tabLifecycle;
assert.match(
  tabLifecycle,
  /startBrowserProcess\s*\(/,
  'host/tab-lifecycle.js must define startBrowserProcess(...)'
);
assert.match(
  nativeHost,
  /import\s*{[^}]*startBrowserProcess[^}]*}\s*from\s*['"`]\.\/tab-lifecycle\.js['"`]/s,
  'native-host.js must import startBrowserProcess from host/tab-lifecycle.js'
);
assert.match(
  nativeHost,
  /toolName\s*===\s*['"`]ensure_active_tab['"`][\s\S]*?startBrowserProcess\s*\(/,
  'native-host.js must execute startBrowserProcess only for explicit ensure_active_tab tool calls'
);
assert.doesNotMatch(
  tabLifecycle,
  /findOrStartActiveTab\s*\(/,
  'host/tab-lifecycle.js must not pretend to own chrome.tabs lifecycle; extension/background.js is tab authority'
);
assert.doesNotMatch(
  tabLifecycle,
  /closeManagedTabs\s*\(/,
  'host/tab-lifecycle.js must not maintain managed tab close state; extension/background.js is tab authority'
);
assert.match(
  combined,
  /(spawn\s*\(\s*['"`]open['"`]|command\s*=\s*['"`]open['"`])/,
  'macOS branch must use spawn("open", ...) or command = "open" rather than chrome binary directly'
);
assert.match(
  combined,
  /process\.platform\s*===\s*['"`]darwin['"`]/,
  'lifecycle code must branch on process.platform === "darwin"'
);
assert.match(
  combined,
  /process\.platform\s*===\s*['"`]win32['"`]/,
  'lifecycle code must branch on process.platform === "win32"'
);
assert.doesNotMatch(
  tabLifecycle,
  /cmd[\s\S]{0,120}(\/c|start)/i,
  'Windows launch must not use cmd /c start because URL is user-controlled'
);
assert.match(
  tabLifecycle,
  /(rundll32\.exe|explorer\.exe)/,
  'Windows launch must use a non-shell launcher such as rundll32.exe or explorer.exe'
);
for (const metachar of ['&', '|', '>', '<', '^', '%']) {
  assert.doesNotMatch(
    tabLifecycle,
    new RegExp(`cmd[\\s\\S]{0,200}${metachar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    `URL metachar ${metachar} must not be routed through cmd`
  );
}
assert.match(
  combined,
  /process\.platform\s*===\s*['"`]linux['"`]/,
  'lifecycle code must branch on process.platform === "linux"'
);
assert.match(
  combined,
  /BROWSER_LAUNCH_FAILED/,
  'lifecycle code must surface BROWSER_LAUNCH_FAILED error code'
);
assert.match(
  combined,
  /BROWSERPILOT_TEST_NO_SPAWN/,
  'lifecycle code must respect BROWSERPILOT_TEST_NO_SPAWN env to skip spawn'
);
assert.match(
  combined,
  /LAUNCH_DISABLED_BY_TEST_ENV/,
  'lifecycle code must return LAUNCH_DISABLED_BY_TEST_ENV when test env disables spawn'
);
assert.doesNotMatch(
  tabLifecycle,
  /managedTabIds/,
  'host/tab-lifecycle.js must not maintain managedTabIds; extension/background.js is the authority'
);

// --- extension/background.js: must wire chrome.tabs.onRemoved listener ---
assert.match(
  background,
  /chrome\.tabs\.onRemoved\.addListener\s*\(/,
  'extension/background.js must add chrome.tabs.onRemoved listener'
);
assert.match(
  background,
  /managedTabIds/,
  'extension/background.js must reference managedTabIds so the set stays in sync across processes'
);

// Reused user tabs are borrowed, not managed. Only BrowserPilot-created tabs
// may enter managedTabIds and be eligible for close_managed_tabs.
assert.match(
  background,
  /borrowedTabIds:\s*new\s+Set\s*\(/,
  'background.js must track borrowedTabIds separately for reused active/any tabs'
);
assert.match(
  background,
  /active[\s\S]*?borrowedTabIds\.add\s*\(\s*active\.id\s*\)[\s\S]*?source:\s*['"`]active['"`]/,
  'toolEnsureActiveTab must add reused active tabs to borrowedTabIds, not managedTabIds'
);
assert.doesNotMatch(
  background,
  /active[\s\S]{0,260}?managedTabIds\.add\s*\(\s*active\.id\s*\)/,
  'toolEnsureActiveTab must not add reused active tabs to managedTabIds'
);
assert.match(
  background,
  /created[\s\S]*?managedTabIds\.add\s*\(\s*created\.id\s*\)/,
  'toolEnsureActiveTab must add created tabs to managedTabIds'
);

// URL scheme allowlist must be centralized and used by tab lifecycle/navigation tools.
assert.match(
  background,
  /function\s+validateBrowserPilotUrl\s*\(/,
  'background.js must define validateBrowserPilotUrl helper'
);
for (const scheme of ['file:', 'javascript:', 'data:', 'chrome:', 'chrome-extension:', 'devtools:']) {
  assert.match(
    background,
    new RegExp(scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `validateBrowserPilotUrl must explicitly reject ${scheme}`
  );
}
for (const tool of ['toolEnsureActiveTab', 'toolNewPage', 'toolNavigatePage']) {
  assert.match(
    background,
    new RegExp(`async function ${tool}\\s*\\([\\s\\S]*?validateBrowserPilotUrl\\s*\\(`),
    `${tool} must call validateBrowserPilotUrl before navigating/creating tabs`
  );
}
assert.match(
  tabLifecycle,
  /function\s+validateBrowserPilotUrl\s*\(/,
  'host/tab-lifecycle.js must validate URLs before spawning xdg-open/open URL paths'
);

// close_managed_tabs must strictly validate allManaged/tabId.
assert.match(
  background,
  /allManaged\s*!==\s*undefined[\s\S]*?typeof\s+allManaged\s*!==\s*['"`]boolean['"`]/,
  'toolCloseManagedTabs must reject non-boolean allManaged values'
);
assert.match(
  background,
  /!Number\.isInteger\s*\(\s*tabId\s*\)/,
  'toolCloseManagedTabs must reject non-integer tabId values'
);
assert.match(
  background,
  /allManaged\s*===\s*true/,
  'toolCloseManagedTabs must close all only when allManaged === true'
);

// Packaging and safe logging guards.
assert.ok(
  Array.isArray(rootPackage.files) && rootPackage.files.includes('host/tab-lifecycle.js'),
  'package.json files must include host/tab-lifecycle.js'
);
assert.doesNotMatch(
  background,
  /log\s*\(\s*['"`]Received from native:[^\n]*message\s*\)/,
  'background.js must not log complete native messages (params may include secrets/URLs/form text)'
);
assert.match(
  background,
  /log\s*\(\s*['"`]Received from native:[^\n]*message\?\.id[\s\S]*?message\?\.method/,
  'background.js must log only native message id/method metadata'
);

// close_page remains for compatibility but must not close the last browser window.
assert.match(
  background,
  /async function toolClosePage[\s\S]*?wouldCloseLastWindow\s*\(/,
  'toolClosePage must guard against closing the last browser window'
);
assert.match(
  tools,
  /name:\s*['"`]close_page['"`][\s\S]*?description:\s*['"`][^'"`]*(low-level|低层|推荐 close_managed_tabs|close_managed_tabs)/,
  'close_page description must warn it is low-level and recommend close_managed_tabs'
);

// --- explicit guard: no close_browser / quit_browser tool names anywhere ---
assert.doesNotMatch(
  tools,
  /name:\s*['"`]close_browser['"`]/,
  'host/tools.js must not register a close_browser tool'
);
assert.doesNotMatch(
  tools,
  /name:\s*['"`]quit_browser['"`]/,
  'host/tools.js must not register a quit_browser tool'
);
assert.doesNotMatch(
  tools,
  /name:\s*['"`]shutdown_browser['"`]/,
  'host/tools.js must not register a shutdown_browser tool'
);

// --- explicit guard: no process.exit(0) inside the new lifecycle helper logic ---
// The native-host.js shutdown handlers retain their existing process.exit(0)
// calls because the helper module is intentionally side-effect-free. We only
// forbid the call in the new helper code (host/tab-lifecycle.js).
assert.doesNotMatch(
  tabLifecycle,
  /process\.exit\s*\(\s*0\s*\)/,
  'host/tab-lifecycle.js must not call process.exit(0)'
);
assert.doesNotMatch(
  background,
  /process\.exit\s*\(\s*0\s*\)/,
  'extension/background.js must not call process.exit(0); the new lifecycle handlers stay in-process'
);

console.log('extension tab lifecycle checks passed');