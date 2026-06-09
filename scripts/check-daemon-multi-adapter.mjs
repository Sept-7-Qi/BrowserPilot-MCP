#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-token-'));
process.env.BROWSERPILOT_AUTH_TOKEN_DIR = tmp;
process.env.BROWSERPILOT_DAEMON_PORT = String(28000 + Math.floor(Math.random() * 1000));

const { createDaemonServer } = await import('../host/daemon.js');
const { connectDaemonClient, generateRequestId } = await import('../host/daemon-client.js');
const { makeToolCall, makeToolResult } = await import('../host/protocol.js');

const port = Number(process.env.BROWSERPILOT_DAEMON_PORT);
const server = createDaemonServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const clients = [];
try {
  const adapterA = await connectDaemonClient({ role: 'mcp_adapter', name: 'adapter-a', capabilities: { tools: true }, port, timeoutMs: 1000 });
  const adapterB = await connectDaemonClient({ role: 'mcp_adapter', name: 'adapter-b', capabilities: { tools: true }, port, timeoutMs: 1000 });
  const native = await connectDaemonClient({ role: 'native_host', name: 'fake-native', capabilities: { extensionBridge: true }, port, timeoutMs: 1000 });
  clients.push(adapterA, adapterB, native);

  const nativeCalls = [];
  native.on('tool.call', (message) => nativeCalls.push(message));

  const callA = makeToolCall({ id: generateRequestId('adapter-a-tool'), toolName: 'list_pages', toolArguments: { source: 'A' } });
  const callB = makeToolCall({ id: generateRequestId('adapter-b-tool'), toolName: 'navigate_page', toolArguments: { source: 'B', url: 'https://example.invalid' } });

  const responseAPromise = adapterA.request(callA, { timeoutMs: 2000, expectedType: 'tool.result' });
  const responseBPromise = adapterB.request(callB, { timeoutMs: 2000, expectedType: 'tool.result' });

  await waitFor(() => nativeCalls.length === 2, 2000, 'native host did not receive both tool calls');
  assert.deepEqual(nativeCalls.map((m) => m.id).sort(), [callA.id, callB.id].sort(), 'daemon must forward both globally unique adapter request ids to native host');

  native.send(makeToolResult({ id: callB.id, result: { owner: 'adapter-b', sequence: 1 } }));
  native.send(makeToolResult({ id: callA.id, result: { owner: 'adapter-a', sequence: 2 } }));

  const [responseA, responseB] = await Promise.all([responseAPromise, responseBPromise]);
  assert.equal(responseA.id, callA.id, 'adapter A must receive response for its own request id');
  assert.equal(responseA.result.owner, 'adapter-a');
  assert.equal(responseB.id, callB.id, 'adapter B must receive response for its own request id');
  assert.equal(responseB.result.owner, 'adapter-b');

  adapterA.close();
  await waitFor(() => adapterA.closed === true, 1000, 'adapter A did not close');

  const callBAfterDisconnect = makeToolCall({ id: generateRequestId('adapter-b-after-disconnect'), toolName: 'list_pages', toolArguments: { source: 'B2' } });
  const responseBAfterPromise = adapterB.request(callBAfterDisconnect, { timeoutMs: 2000, expectedType: 'tool.result' });
  await waitFor(() => nativeCalls.some((m) => m.id === callBAfterDisconnect.id), 2000, 'native host did not receive adapter B request after adapter A disconnect');
  native.send(makeToolResult({ id: callBAfterDisconnect.id, result: { owner: 'adapter-b', afterDisconnect: true } }));
  const responseBAfter = await responseBAfterPromise;
  assert.equal(responseBAfter.result.owner, 'adapter-b', 'adapter A disconnect must not affect adapter B pending/routing');

  console.log('daemon multi-adapter checks passed');
} finally {
  for (const client of clients) client.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
