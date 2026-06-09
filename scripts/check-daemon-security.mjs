#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-token-'));
process.env.BROWSERPILOT_AUTH_TOKEN_DIR = tmp;
process.env.BROWSERPILOT_DAEMON_PORT = String(29100 + Math.floor(Math.random() * 1000));

const { readOrCreateAuthToken } = await import('../host/auth-token.js');
const { createDaemonServer } = await import('../host/daemon.js');
const { connectDaemonClient, generateRequestId } = await import('../host/daemon-client.js');
const { decodeFrames, encodeFrame, makeShutdownRequest, makeStatusRequest, makeToolCall, makeToolResult } = await import('../host/protocol.js');

const token = readOrCreateAuthToken();
assert.equal(typeof token, 'string');
assert(token.length >= 32, 'auth token must be high entropy');
const tokenPath = path.join(tmp, 'daemon-token');
const mode = fs.statSync(tokenPath).mode & 0o777;
assert.equal(mode, 0o600, 'auth token file must be mode 0600');

const port = Number(process.env.BROWSERPILOT_DAEMON_PORT);
const server = createDaemonServer({ toolTimeoutMs: 150, maxPendingTotal: 3, maxPendingPerClient: 2 });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const clients = [];
try {
  await assertMissingHelloTokenRejected(port);

  const adapter = await connectDaemonClient({ role: 'mcp_adapter', name: 'adapter', capabilities: { tools: true }, port, timeoutMs: 1000 });
  const adapter2 = await connectDaemonClient({ role: 'mcp_adapter', name: 'adapter2', capabilities: { tools: true }, port, timeoutMs: 1000 });
  const native = await connectDaemonClient({ role: 'native_host', name: 'native', capabilities: { extensionBridge: true }, port, timeoutMs: 1000 });
  clients.push(adapter, adapter2, native);

  const badShutdown = makeShutdownRequest({ id: generateRequestId('bad-shutdown') });
  const unauthShutdownPromise = waitForMessage(adapter, badShutdown.id, 'tool.error', 1000);
  adapter.socket.write(encodeFrame(badShutdown));
  const unauthShutdown = await unauthShutdownPromise;
  assert.equal(unauthShutdown.error.code, 'ROLE_NOT_AUTHORIZED', 'mcp_adapter shutdown must be rejected');

  const badStatus = makeStatusRequest({ id: generateRequestId('bad-status'), scope: 'summary' });
  const unauthStatusPromise = waitForMessage(adapter, badStatus.id, 'tool.error', 1000);
  adapter.socket.write(encodeFrame(badStatus));
  const unauthStatus = await unauthStatusPromise;
  assert.equal(unauthStatus.error.code, 'ROLE_NOT_AUTHORIZED', 'mcp_adapter status must be rejected');

  const nativeCalls = [];
  native.on('tool.call', (message) => nativeCalls.push(message));

  const protectedCall = makeToolCall({ id: generateRequestId('protected'), toolName: 'list_pages', toolArguments: {} });
  const protectedPromise = adapter.request(protectedCall, { timeoutMs: 1000, expectedType: 'tool.result' });
  await waitFor(() => nativeCalls.some((m) => m.id === protectedCall.id), 1000, 'native did not receive protected call');
  adapter2.send(makeToolResult({ id: protectedCall.id, result: { wrong: true } }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  native.send(makeToolResult({ id: protectedCall.id, result: { owner: 'native' } }));
  const protectedResult = await protectedPromise;
  assert.equal(protectedResult.result.owner, 'native', 'tool.result from non-owning client must not satisfy pending request');

  const limitCallA = makeToolCall({ id: generateRequestId('limit-a'), toolName: 'list_pages', toolArguments: {} });
  const limitCallB = makeToolCall({ id: generateRequestId('limit-b'), toolName: 'list_pages', toolArguments: {} });
  const limitCallC = makeToolCall({ id: generateRequestId('limit-c'), toolName: 'list_pages', toolArguments: {} });
  const limitPromiseA = adapter.request(limitCallA, { timeoutMs: 1000, expectedType: 'tool.error' });
  const limitPromiseB = adapter.request(limitCallB, { timeoutMs: 1000, expectedType: 'tool.error' });
  const limitResultC = await adapter.request(limitCallC, { timeoutMs: 1000, expectedType: 'tool.error' });
  assert.equal(limitResultC.error.code, 'TOOL_TIMEOUT', 'pending per-client limit must reject excess tool calls directly');
  assert.match(limitResultC.error.message, /capacity/i);
  assert.equal((await limitPromiseA).error.code, 'TOOL_TIMEOUT');
  assert.equal((await limitPromiseB).error.code, 'TOOL_TIMEOUT');

  const ttlCall = makeToolCall({ id: generateRequestId('ttl'), toolName: 'list_pages', toolArguments: {} });
  const ttlResult = await adapter.request(ttlCall, { timeoutMs: 1000, expectedType: 'tool.error' });
  assert.equal(ttlResult.error.code, 'TOOL_TIMEOUT', 'pending tool call must time out and clean up');

  console.log('daemon security checks passed');
} finally {
  for (const client of clients) client.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function assertMissingHelloTokenRejected(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let buffer = Buffer.alloc(0);
  const messages = [];
  socket.on('data', (chunk) => {
    try {
      const decoded = decodeFrames(Buffer.concat([buffer, chunk]));
      buffer = decoded.remaining;
      messages.push(...decoded.messages);
    } catch {}
  });
  await once(socket, 'connect');
  socket.write(rawFrame({ protocol: 'browserpilot.daemon', version: 1, type: 'hello', id: 'missing-token', role: 'admin', name: 'raw-admin', pid: process.pid, capabilities: { status: true, shutdown: true } }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  socket.destroy();
  assert(!messages.some((message) => message.type === 'hello_ack'), 'daemon must not acknowledge hello without token');
}

function rawFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

function waitForMessage(client, id, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', handler);
      reject(new Error(`Timed out waiting for ${type} ${id}`));
    }, timeoutMs);
    function handler(message) {
      if (message.id === id && message.type === type) {
        clearTimeout(timer);
        client.off('message', handler);
        resolve(message);
      }
    }
    client.on('message', handler);
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
