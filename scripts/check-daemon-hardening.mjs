#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-token-'));
process.env.BROWSERPILOT_AUTH_TOKEN_DIR = tmp;
process.env.BROWSERPILOT_DAEMON_PORT = String(31300 + Math.floor(Math.random() * 1000));
process.env.BROWSERPILOT_TOOL_TIMEOUT_MS = 'abc';
process.env.BROWSERPILOT_MAX_PENDING_TOTAL = 'abc';
process.env.BROWSERPILOT_MAX_PENDING_PER_CLIENT = 'abc';

const { createDaemonServer } = await import('../host/daemon.js');
const { connectDaemonClient, generateRequestId } = await import('../host/daemon-client.js');
const { makeToolCall } = await import('../host/protocol.js');

const port = Number(process.env.BROWSERPILOT_DAEMON_PORT);
const server = createDaemonServer({
  preAuthTimeoutMs: 60,
  maxClients: 3,
  maxUnauthenticatedClients: 1,
  maxPreAuthBufferBytes: 1024,
  maxPendingTotal: 'bad-option',
  maxPendingPerClient: 'bad-option',
  toolTimeoutMs: 'bad-option',
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const sockets = [];
const clients = [];
try {
  const idle = net.connect({ host: '127.0.0.1', port });
  sockets.push(idle);
  await once(idle, 'connect');
  await waitFor(() => idle.destroyed, 1000, 'pre-auth idle socket must be closed by timeout');

  const first = net.connect({ host: '127.0.0.1', port });
  sockets.push(first);
  await once(first, 'connect');
  const second = net.connect({ host: '127.0.0.1', port });
  sockets.push(second);
  await once(second, 'connect');
  await waitFor(() => second.destroyed, 1000, 'max unauthenticated clients must close excess pre-auth sockets');
  first.destroy();

  const oversized = net.connect({ host: '127.0.0.1', port });
  sockets.push(oversized);
  await once(oversized, 'connect');
  oversized.write(Buffer.alloc(2048, 1));
  await waitFor(() => oversized.destroyed, 1000, 'pre-auth incomplete buffer over limit must be closed');

  const adapter = await connectDaemonClient({ role: 'mcp_adapter', name: 'hardening-adapter', capabilities: { tools: true }, port, timeoutMs: 1000 });
  const native = await connectDaemonClient({ role: 'native_host', name: 'hardening-native', capabilities: { extensionBridge: true }, port, timeoutMs: 1000 });
  clients.push(adapter, native);
  const nativeCalls = [];
  native.on('tool.call', (message) => nativeCalls.push(message));

  const pending = [];
  for (let i = 0; i < 40; i++) {
    const call = makeToolCall({ id: generateRequestId(`hardening-${i}`), toolName: 'list_pages', toolArguments: {} });
    pending.push(adapter.request(call, { timeoutMs: 1500 }).then((message) => message).catch((error) => error));
  }
  const settled = await Promise.all(pending);
  assert(settled.some((message) => message?.type === 'tool.error' && (message.error.code === 'TOOL_TIMEOUT')), 'invalid env/options must fall back to finite pending limits/timeouts instead of disabling protection');
  assert(nativeCalls.length < 40, 'pending limit fallback must prevent forwarding every request to native host');

  console.log('daemon hardening checks passed');
} finally {
  for (const client of clients) client.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
