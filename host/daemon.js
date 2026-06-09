#!/usr/bin/env node
import net from 'node:net';
import {
  DAEMON_HOST,
  DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  decodeFrames,
  makeHelloAck,
  makeStatusResponse,
  makeShutdownAck,
  makeToolError,
  sendFrame,
  validateMessage,
} from './protocol.js';
import { constantTimeTokenEqual, readOrCreateAuthToken } from './auth-token.js';

const startedAt = new Date().toISOString();
let nextClientId = 1;
let acceptingToolCalls = true;
let shuttingDown = false;
let lastError = null;

const clients = new Map();
const pendingTools = new Map();
let activeNativeHostClientId = null;
let server = null;
let daemonAuthToken = null;

const DEFAULT_TOOL_TIMEOUT_MS = 60000;
const DEFAULT_MAX_PENDING_TOTAL = 256;
const DEFAULT_MAX_PENDING_PER_CLIENT = 32;
const DEFAULT_MAX_CLIENTS = 128;
const DEFAULT_MAX_UNAUTHENTICATED_CLIENTS = 16;
const DEFAULT_PRE_AUTH_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PRE_AUTH_BUFFER_BYTES = 64 * 1024;

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

let toolTimeoutMs = boundedInteger(process.env.BROWSERPILOT_TOOL_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, { min: 10, max: 10 * 60 * 1000 });
let maxPendingTotal = boundedInteger(process.env.BROWSERPILOT_MAX_PENDING_TOTAL, DEFAULT_MAX_PENDING_TOTAL, { min: 1, max: 10000 });
let maxPendingPerClient = boundedInteger(process.env.BROWSERPILOT_MAX_PENDING_PER_CLIENT, DEFAULT_MAX_PENDING_PER_CLIENT, { min: 1, max: 1000 });
let maxClients = DEFAULT_MAX_CLIENTS;
let maxUnauthenticatedClients = DEFAULT_MAX_UNAUTHENTICATED_CLIENTS;
let preAuthTimeoutMs = DEFAULT_PRE_AUTH_TIMEOUT_MS;
let maxPreAuthBufferBytes = DEFAULT_MAX_PRE_AUTH_BUFFER_BYTES;
let unauthenticatedClients = 0;

function log(...args) {
  console.error('[BrowserPilot Daemon]', ...args);
}

function daemonInfo() {
  return { pid: process.pid, host: DEFAULT_DAEMON_HOST, port: DAEMON_PORT || DEFAULT_DAEMON_PORT, startedAt };
}

function counts() {
  let mcpAdapters = 0;
  let nativeHosts = 0;
  let admins = 0;
  for (const client of clients.values()) {
    if (client.role === 'mcp_adapter') mcpAdapters++;
    if (client.role === 'native_host') nativeHosts++;
    if (client.role === 'admin') admins++;
  }
  return { mcpAdapters, nativeHosts, admins, activeNativeHostClientId };
}

function health() {
  return {
    ready: Boolean(activeNativeHostClientId),
    acceptingToolCalls: Boolean(acceptingToolCalls && activeNativeHostClientId),
    lastError,
  };
}

function send(socket, message) {
  sendFrame(socket, message);
}

function clientById(clientId) {
  return clients.get(clientId);
}

function pendingCountForAdapter(clientId) {
  let count = 0;
  for (const pending of pendingTools.values()) {
    if (pending.adapterClientId === clientId) count++;
  }
  return count;
}

function removeClient(client) {
  if (!client.clientId && !client.unauthCountedDone) {
    client.unauthCountedDone = true;
    unauthenticatedClients = Math.max(0, unauthenticatedClients - 1);
  }
  clearTimeout(client.preAuthTimer);
  clients.delete(client.clientId);
  if (activeNativeHostClientId === client.clientId) activeNativeHostClientId = null;
  for (const [id, pending] of pendingTools) {
    if (pending.adapterClientId === client.clientId || pending.nativeClientId === client.clientId) {
      pendingTools.delete(id);
      clearTimeout(pending.timer);
      const adapter = clientById(pending.adapterClientId);
      if (adapter) {
        send(adapter.socket, makeToolError({ id, code: 'MCP_ADAPTER_DISCONNECTED', message: 'Client disconnected before tool call completed' }));
      }
    }
  }
}

function handleHello(socketState, message) {
  const validation = validateMessage(message);
  if (!validation.ok) throw Object.assign(new Error(validation.error.message), { code: validation.error.code });
  if (!constantTimeTokenEqual(message.authToken, daemonAuthToken || readOrCreateAuthToken())) {
    throw Object.assign(new Error('Invalid daemon auth token'), { code: 'ROLE_NOT_AUTHORIZED' });
  }
  if (clients.size >= maxClients) {
    throw Object.assign(new Error('Maximum daemon clients reached'), { code: 'ROLE_NOT_AUTHORIZED' });
  }
  if (!socketState.unauthCountedDone) {
    socketState.unauthCountedDone = true;
    unauthenticatedClients = Math.max(0, unauthenticatedClients - 1);
  }
  clearTimeout(socketState.preAuthTimer);
  socketState.clientId = `client-${nextClientId++}`;
  socketState.role = message.role;
  socketState.name = message.name;
  clients.set(socketState.clientId, socketState);
  if (message.role === 'native_host') {
    const oldNative = activeNativeHostClientId ? clientById(activeNativeHostClientId) : null;
    activeNativeHostClientId = socketState.clientId;
    if (oldNative && oldNative.socket !== socketState.socket) oldNative.socket.destroy();
  }
  send(socketState.socket, makeHelloAck({ id: message.id, clientId: socketState.clientId, daemon: daemonInfo() }));
}

function handleToolCall(client, message) {
  const validation = validateMessage(message, { role: client.role });
  if (!validation.ok) {
    send(client.socket, makeToolError({ id: message.id || 'unknown', code: validation.error.code, message: validation.error.message }));
    return;
  }
  if (!acceptingToolCalls || shuttingDown) {
    send(client.socket, makeToolError({ id: message.id, code: 'DAEMON_SHUTTING_DOWN', message: 'Daemon is shutting down' }));
    return;
  }
  const nativeClient = activeNativeHostClientId ? clientById(activeNativeHostClientId) : null;
  if (!nativeClient) {
    send(client.socket, makeToolError({ id: message.id, code: 'NATIVE_HOST_NOT_CONNECTED', message: 'No native host is connected to the BrowserPilot daemon' }));
    return;
  }
  if (pendingTools.has(message.id)) {
    send(client.socket, makeToolError({ id: message.id, code: 'PROTOCOL_SCHEMA_INVALID', message: `Duplicate outstanding tool.call id ${message.id}` }));
    return;
  }
  if (pendingTools.size >= maxPendingTotal || pendingCountForAdapter(client.clientId) >= maxPendingPerClient) {
    send(client.socket, makeToolError({ id: message.id, code: 'TOOL_TIMEOUT', message: 'Daemon pending tool call capacity exceeded' }));
    return;
  }
  const timer = setTimeout(() => {
    const pending = pendingTools.get(message.id);
    if (!pending) return;
    pendingTools.delete(message.id);
    const adapter = clientById(pending.adapterClientId);
    if (adapter) send(adapter.socket, makeToolError({ id: message.id, code: 'TOOL_TIMEOUT', message: 'Tool call timed out waiting for native host response' }));
  }, toolTimeoutMs);
  pendingTools.set(message.id, { adapterClientId: client.clientId, nativeClientId: nativeClient.clientId, timer });
  send(nativeClient.socket, message);
}

function handleToolResponse(client, message) {
  const pending = pendingTools.get(message.id);
  if (!pending) return;
  if (client.role !== 'native_host' || client.clientId !== pending.nativeClientId) {
    send(client.socket, makeToolError({ id: message.id, code: 'ROLE_NOT_AUTHORIZED', message: 'Only the native_host assigned to this pending request may send its result' }));
    return;
  }
  pendingTools.delete(message.id);
  clearTimeout(pending.timer);
  const adapter = clientById(pending.adapterClientId);
  if (adapter) send(adapter.socket, message);
}

function handleStatus(client, message) {
  const validation = validateMessage(message, { role: client.role });
  if (!validation.ok) {
    send(client.socket, makeToolError({ id: message.id || 'unknown', code: validation.error.code, message: validation.error.message }));
    return;
  }
  send(client.socket, makeStatusResponse({ id: message.id, daemon: daemonInfo(), clients: counts(), health: health() }));
}

function handleShutdown(client, message) {
  const validation = validateMessage(message, { role: client.role });
  if (!validation.ok) {
    send(client.socket, makeToolError({ id: message.id || 'unknown', code: validation.error.code, message: validation.error.message }));
    return;
  }
  acceptingToolCalls = false;
  shuttingDown = true;
  send(client.socket, makeShutdownAck({ id: message.id, accepted: true }));
  setTimeout(() => {
    for (const c of clients.values()) c.socket.destroy();
    server?.close(() => process.exit(0));
  }, 50);
}

function handleMessage(client, message) {
  if (!client.clientId) {
    if (message.type !== 'hello') throw Object.assign(new Error('First daemon message must be hello'), { code: 'PROTOCOL_SCHEMA_INVALID' });
    handleHello(client, message);
    return;
  }
  switch (message.type) {
    case 'tool.call': return handleToolCall(client, message);
    case 'tool.result':
    case 'tool.error': return handleToolResponse(client, message);
    case 'status': return handleStatus(client, message);
    case 'shutdown': return handleShutdown(client, message);
    default:
      send(client.socket, makeToolError({ id: message.id || 'unknown', code: 'PROTOCOL_SCHEMA_INVALID', message: `Unsupported daemon message type ${message.type}` }));
  }
}

export function createDaemonServer(options = {}) {
  daemonAuthToken = options.authToken || readOrCreateAuthToken();
  toolTimeoutMs = boundedInteger(options.toolTimeoutMs ?? process.env.BROWSERPILOT_TOOL_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, { min: 10, max: 10 * 60 * 1000 });
  maxPendingTotal = boundedInteger(options.maxPendingTotal ?? process.env.BROWSERPILOT_MAX_PENDING_TOTAL, DEFAULT_MAX_PENDING_TOTAL, { min: 1, max: 10000 });
  maxPendingPerClient = boundedInteger(options.maxPendingPerClient ?? process.env.BROWSERPILOT_MAX_PENDING_PER_CLIENT, DEFAULT_MAX_PENDING_PER_CLIENT, { min: 1, max: 1000 });
  maxClients = boundedInteger(options.maxClients, DEFAULT_MAX_CLIENTS, { min: 1, max: 10000 });
  maxUnauthenticatedClients = boundedInteger(options.maxUnauthenticatedClients, DEFAULT_MAX_UNAUTHENTICATED_CLIENTS, { min: 1, max: 10000 });
  preAuthTimeoutMs = boundedInteger(options.preAuthTimeoutMs, DEFAULT_PRE_AUTH_TIMEOUT_MS, { min: 10, max: 60000 });
  maxPreAuthBufferBytes = boundedInteger(options.maxPreAuthBufferBytes, DEFAULT_MAX_PRE_AUTH_BUFFER_BYTES, { min: 8, max: 10 * 1024 * 1024 });
  unauthenticatedClients = 0;
  return net.createServer((socket) => {
    if (clients.size + unauthenticatedClients >= maxClients || unauthenticatedClients >= maxUnauthenticatedClients) {
      socket.destroy();
      return;
    }
    unauthenticatedClients++;
    const client = { socket, buffer: Buffer.alloc(0), clientId: null, role: null, name: null, unauthCountedDone: false, preAuthTimer: null };
    client.preAuthTimer = setTimeout(() => socket.destroy(), preAuthTimeoutMs);
    socket.on('data', (chunk) => {
      try {
        if (!client.clientId && client.buffer.length + chunk.length > maxPreAuthBufferBytes) {
          socket.destroy();
          return;
        }
        const decoded = decodeFrames(Buffer.concat([client.buffer, chunk]));
        client.buffer = decoded.remaining;
        for (const message of decoded.messages) handleMessage(client, message);
      } catch (error) {
        lastError = { code: error.code || 'PROTOCOL_SCHEMA_INVALID', message: error.message };
        try { send(socket, makeToolError({ id: 'protocol-error', code: lastError.code, message: lastError.message })); } catch {}
        socket.destroy();
      }
    });
    socket.on('close', () => removeClient(client));
    socket.on('error', (error) => { lastError = { code: 'INTERNAL_DAEMON_ERROR', message: error.message }; });
  });
}

export async function startDaemon() {
  if (DAEMON_HOST !== DEFAULT_DAEMON_HOST) {
    throw new Error('BrowserPilot daemon must bind to 127.0.0.1 only');
  }
  server = createDaemonServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DAEMON_PORT, DEFAULT_DAEMON_HOST, resolve);
  });
  log(`listening on ${DEFAULT_DAEMON_HOST}:${DAEMON_PORT}`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon().catch((error) => {
    log('fatal:', error.message);
    process.exit(1);
  });
}
