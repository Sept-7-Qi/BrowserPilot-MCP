#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-token-'));
process.env.BROWSERPILOT_AUTH_TOKEN_DIR = tmp;
process.env.BROWSERPILOT_DAEMON_PORT = String(30200 + Math.floor(Math.random() * 1000));

const { createDaemonServer } = await import('../host/daemon.js');
const { connectDaemonClient } = await import('../host/daemon-client.js');
const { adapterHealthCheck } = await import('../host/mcp-adapter.js');

const port = Number(process.env.BROWSERPILOT_DAEMON_PORT);
const server = createDaemonServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const clients = [];
try {
  const native = await connectDaemonClient({ role: 'native_host', name: 'health-native', capabilities: { extensionBridge: true }, port, timeoutMs: 1000 });
  clients.push(native);

  const health = await adapterHealthCheck();
  assert.equal(health.mcpServer.mode, 'stdio-adapter');
  assert.equal(health.mcpServer.daemonConnected, true, 'health_check must connect to running daemon');
  assert.equal(health.nativeHost.connected, true, 'health_check must report connected native host from daemon status');
  assert.equal(health.daemon.type, 'status', 'health_check must include daemon admin status response');
  assert.equal(health.daemon.clients.nativeHosts, 1, 'health_check must include native host count');
  assert.equal(health.lastError, null, 'health_check must not misreport admin-only status as daemon unavailable');

  console.log('mcp adapter health checks passed');
} finally {
  for (const client of clients) client.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
