#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function abs(rel) { return path.join(root, rel); }
function exists(rel) { return fs.existsSync(abs(rel)); }
function read(rel) { return fs.readFileSync(abs(rel), 'utf8'); }
function assert(condition, message) { if (!condition) failures.push(message); }

function tcpServerSignals(src) {
  return [
    /net\.createServer\s*\(/,
    /\.listen\s*\(/,
    /createServer\s*\(/,
  ].filter((re) => re.test(src)).map((re) => re.source);
}

for (const rel of [
  'host/protocol.js',
  'host/native-frame.js',
  'host/auth-token.js',
  'host/daemon.js',
  'host/daemon-client.js',
  'host/mcp-adapter.js',
  'host/mcp-server.js',
  'host/native-host.js',
]) {
  assert(exists(rel), `${rel} must exist`);
}

if (exists('host/mcp-server.js')) {
  const src = read('host/mcp-server.js');
  assert(src.startsWith('#!/usr/bin/env node'), 'host/mcp-server.js must remain executable compatibility entrypoint');
  assert(src.includes('mcp-adapter.js') || src.includes('./mcp-adapter.js'), 'host/mcp-server.js must delegate to host/mcp-adapter.js');
  assert(tcpServerSignals(src).length === 0, 'host/mcp-server.js must not create/listen on a TCP server');
}

if (exists('host/mcp-adapter.js')) {
  const src = read('host/mcp-adapter.js');
  assert(src.includes('@modelcontextprotocol/sdk'), 'host/mcp-adapter.js must own MCP stdio server startup');
  assert(src.includes('daemon-client.js') || src.includes('./daemon-client.js'), 'host/mcp-adapter.js must connect through host/daemon-client.js');
  assert(tcpServerSignals(src).length === 0, 'host/mcp-adapter.js must not create/listen on a TCP server');
}

if (exists('host/native-host.js')) {
  const src = read('host/native-host.js');
  assert(src.includes('daemon-client.js') || src.includes('./daemon-client.js'), 'host/native-host.js must use host/daemon-client.js');
  assert(src.includes('native_host'), 'host/native-host.js must register daemon role native_host');
  assert(tcpServerSignals(src).length === 0, 'host/native-host.js must not create/listen on a TCP server');
}

if (exists('host/daemon.js')) {
  const src = read('host/daemon.js');
  assert(src.includes('127.0.0.1'), 'host/daemon.js must bind loopback only');
  assert(/\.listen\s*\(/.test(src), 'host/daemon.js must own daemon TCP listen behavior');
  assert(src.includes('protocol.js') || src.includes('./protocol.js'), 'host/daemon.js must use host/protocol.js');
}

if (exists('host/protocol.js')) {
  const src = read('host/protocol.js');
  for (const token of ['DAEMON_HOST', 'DAEMON_PORT', 'PROTOCOL_NAME', 'PROTOCOL_VERSION', 'MAX_FRAME_BYTES', 'encodeFrame', 'decodeFrames', 'validateMessage']) {
    assert(src.includes(token), `host/protocol.js must export/define ${token}`);
  }
  assert(!src.includes('@modelcontextprotocol/sdk'), 'host/protocol.js must not import MCP SDK');
  assert(!/net\.createServer|\.listen\s*\(/.test(src), 'host/protocol.js must not open sockets');
}

for (const rel of ['host/mcp-server.js', 'host/native-host.js', 'host/mcp-adapter.js']) {
  if (!exists(rel)) continue;
  const src = read(rel);
  assert(!/const\s+TCP_PORT\s*=\s*18765/.test(src), `${rel} must not duplicate daemon port constant`);
}

if (failures.length) {
  console.error('daemon contract checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('daemon contract checks passed');
