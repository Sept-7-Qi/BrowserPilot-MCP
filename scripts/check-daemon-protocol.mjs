#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  validateMessage,
  makeHello,
  makeToolCall,
  makeToolResult,
  makeToolError,
  makeStatusRequest,
  makeShutdownRequest,
} from '../host/protocol.js';

function valid(message, context) {
  assert.equal(validateMessage(message, context).ok, true, `${message.type} should be valid`);
}

function invalid(message, context, code = 'PROTOCOL_SCHEMA_INVALID') {
  const result = validateMessage(message, context);
  assert.equal(result.ok, false, `${message.type || '<missing type>'} should be invalid`);
  assert.equal(result.error.code, code, `invalid code for ${message.type || '<missing type>'}`);
}

const authToken = 'test-token-for-schema';
const helloAdmin = makeHello({ id: 'h-admin', role: 'admin', name: 'check', capabilities: { status: true, shutdown: true }, authToken });
const helloAdapter = makeHello({ id: 'h-adapter', role: 'mcp_adapter', name: 'check', capabilities: { tools: true }, authToken });
const helloNative = makeHello({ id: 'h-native', role: 'native_host', name: 'check', capabilities: { extensionBridge: true }, authToken });
valid(helloAdmin);
valid(helloAdapter);
valid(helloNative);

valid({
  protocol: PROTOCOL_NAME,
  version: PROTOCOL_VERSION,
  type: 'hello_ack',
  id: 'h-admin',
  clientId: 'client-1',
  daemon: { pid: process.pid, host: '127.0.0.1', port: 18765, startedAt: new Date().toISOString() },
});

valid(makeToolCall({ id: 'tool-1', toolName: 'list_pages', toolArguments: {} }), { role: 'mcp_adapter' });
valid(makeToolResult({ id: 'tool-1', result: { ok: true } }));
valid(makeToolError({ id: 'tool-1', code: 'NATIVE_HOST_NOT_CONNECTED', message: 'No native host connected' }));
valid(makeStatusRequest({ id: 'status-1', scope: 'summary' }), { role: 'admin' });
valid({
  protocol: PROTOCOL_NAME,
  version: PROTOCOL_VERSION,
  type: 'status',
  id: 'status-1',
  daemon: { pid: process.pid, host: '127.0.0.1', port: 18765, startedAt: new Date().toISOString() },
  clients: { mcpAdapters: 0, nativeHosts: 0, admins: 1, activeNativeHostClientId: null },
  health: { ready: true, acceptingToolCalls: false, lastError: null },
  timestamp: new Date().toISOString(),
});
valid(makeShutdownRequest({ id: 'shutdown-1' }), { role: 'admin' });
valid({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, type: 'shutdown', id: 'shutdown-1', accepted: true, timestamp: new Date().toISOString() });

invalid({ ...helloAdmin, protocol: 'wrong' }, undefined, 'PROTOCOL_VERSION_UNSUPPORTED');
invalid({ ...helloAdmin, version: 2 }, undefined, 'PROTOCOL_VERSION_UNSUPPORTED');
invalid({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, type: 'unknown', id: 'x' });
invalid({ ...helloAdmin, role: 'bogus' });
invalid({ ...helloAdmin, capabilities: {} });
invalid(makeToolCall({ id: 'bad-role', toolName: 'list_pages', toolArguments: {} }), { role: 'native_host' }, 'ROLE_NOT_AUTHORIZED');
invalid(makeShutdownRequest({ id: 'bad-shutdown' }), { role: 'mcp_adapter' }, 'ROLE_NOT_AUTHORIZED');
invalid({ ...makeToolCall({ id: 'missing', toolName: 'list_pages', toolArguments: {} }), toolName: undefined }, { role: 'mcp_adapter' });

console.log('daemon protocol checks passed');
