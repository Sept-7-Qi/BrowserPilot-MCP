#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function isExecutable(rel) {
  try {
    fs.accessSync(path.join(root, rel), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const cnScript = '一键安装.sh';
assert(exists(cnScript), '一键安装.sh must exist');
assert(isExecutable(cnScript), '一键安装.sh must be executable');

if (exists(cnScript)) {
  const script = read(cnScript);
  assert(script.startsWith('#!/usr/bin/env bash') || script.startsWith('#!/bin/bash'), '一键安装.sh must have a bash shebang');
  assert(script.includes('install.sh'), '一键安装.sh must call existing install.sh');
  assert(script.includes('doctor'), '一键安装.sh must run doctor verification');
  assert(script.includes('--full'), '一键安装.sh must support --full');
  assert(script.includes('--mcp-only'), '一键安装.sh must support --mcp-only');
  assert(script.includes('--cli'), '一键安装.sh must support --cli selection');
  assert(script.includes('claude|codex|gemini|all|none'), '一键安装.sh must document supported --cli values');
  assert(script.includes('选择要配置 MCP 的 CLI AI'), '一键安装.sh must include interactive CLI AI selection prompt');
  assert(script.includes('read -t 15') || script.includes('read -r -t 15'), '一键安装.sh interactive prompt must timeout after 15 seconds');
  assert(script.includes('默认 Claude Code'), '一键安装.sh must state default CLI selection is Claude Code');
  assert(script.includes('Claude Code') && script.includes('Codex') && script.includes('Gemini'), '一键安装.sh must mention Claude Code, Codex, and Gemini');
  assert(script.includes('claude mcp add'), '一键安装.sh must configure Claude Code MCP with claude mcp add');
  assert(script.includes('claude mcp list'), '一键安装.sh must verify Claude Code MCP with claude mcp list');
  assert(script.includes('claude mcp remove'), '一键安装.sh must avoid duplicate MCP add failures by removing existing server first');
  assert(script.includes('browserpilot-mcp'), '一键安装.sh must use canonical MCP server name');
  assert(script.includes('mcp-server.js'), '一键安装.sh must point Claude Code MCP at host/mcp-server.js');
  assert(script.includes('command -v node'), '一键安装.sh must use absolute node path');
  assert(script.includes('command -v claude'), '一键安装.sh must check Claude Code CLI availability');
  assert(script.includes('command -v codex'), '一键安装.sh must detect Codex CLI availability');
  assert(script.includes('command -v gemini'), '一键安装.sh must detect Gemini CLI availability');
  assert(script.includes('生成配置片段') && script.includes('请查阅该 CLI 的 MCP 配置文档'), '一键安装.sh must use safe config snippet fallback for unknown CLI MCP commands');
  assert(script.includes('server name') && script.includes('command') && script.includes('args'), '一键安装.sh must output MCP config snippet fields');
  assert(!script.includes('codex mcp add'), '一键安装.sh must not invent codex mcp add command');
  assert(!script.includes('gemini mcp add'), '一键安装.sh must not invent gemini mcp add command');
  assert(script.includes('安装成功') && script.includes('诊断通过'), '一键安装.sh must print Chinese success/doctor summary');
  assert(script.includes('重启') && script.includes('中文状态面板'), '一键安装.sh must prompt restart/reload and Chinese status panel');
  assert(script.includes('chrome://extensions') && script.includes('手动加载'), '一键安装.sh help must clarify Chrome extension still needs manual load/reload');
  assert(script.includes('--browser') && script.includes('Chrome') && script.includes('Edge') && script.includes('Brave') && script.includes('Chromium'), '一键安装.sh must support browser selection');
  assert(script.includes('^[a-p]{32}$'), '一键安装.sh must validate Chrome extension ID shape');
  assert(script.includes('Extension ID') || script.includes('扩展 ID'), '一键安装.sh must explain extension ID errors');
  const forbiddenManifestLogic = [
    'NativeMessagingHosts',
    'allowed_origins',
    'com.openclaudeinchrome.host',
    'native-host-wrapper.sh',
    'native-host.js',
  ];
  for (const token of forbiddenManifestLogic) {
    assert(!script.includes(token), `一键安装.sh must not duplicate Native Messaging manifest logic (${token})`);
  }
}

if (exists('quick-install.sh')) {
  assert(isExecutable('quick-install.sh'), 'quick-install.sh must be executable when present');
  const alias = read('quick-install.sh');
  assert(alias.includes('一键安装.sh'), 'quick-install.sh must delegate to 一键安装.sh');
}

const readme = read('README.md');
assert(readme.includes('./一键安装.sh <Extension ID>'), 'README must recommend 一键安装.sh <Extension ID>');
assert(readme.includes('./一键安装.sh --full <Extension ID>'), 'README must recommend --full for Native Host + Claude Code MCP');
assert(readme.includes('./一键安装.sh --mcp-only'), 'README must document --mcp-only usage');
assert(readme.includes('--cli claude') && readme.includes('--cli codex') && readme.includes('--cli gemini') && readme.includes('--cli all') && readme.includes('--cli none'), 'README must document --cli values');
assert(readme.includes('选择要配置 MCP 的 CLI AI'), 'README must document interactive CLI AI selection');
assert(readme.includes('Claude Code') && readme.includes('Codex') && readme.includes('Gemini'), 'README must mention Claude Code, Codex, and Gemini support status');
assert(readme.includes('生成配置片段') && readme.includes('不伪造'), 'README must document Codex/Gemini safe fallback and no fake commands');
assert(readme.includes('./一键安装.sh --browser Chrome <Extension ID>'), 'README must document --browser usage');
assert(readme.includes('./一键安装.sh doctor <Extension ID>'), 'README must document doctor usage');
assert(readme.includes('chrome://extensions') && readme.includes('手动加载') && readme.includes('复制 ID'), 'README must clarify extension manual load/reload and ID copy');
assert((readme.includes('Claude Code MCP') || readme.includes('Claude Code')) && readme.includes('claude mcp'), 'README must document Claude Code MCP configuration');
assert(readme.includes('高级') && readme.includes('./install.sh'), 'README must keep install.sh as advanced option');

if (failures.length) {
  console.error('Quick install checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Quick install checks passed');
