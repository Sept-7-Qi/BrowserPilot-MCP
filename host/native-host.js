#!/usr/bin/env node
import { DaemonClient } from './daemon-client.js';
import { makeToolError, makeToolResult } from './protocol.js';
import { decodeNativeMessages, encodeNativeMessage } from './native-frame.js';
import { startBrowserProcess } from './tab-lifecycle.js';

const RECONNECT_DELAY = 1000;
const EXTENSION_TIMEOUT_MS = 60000;

let daemonClient = null;
let reconnectTimer = null;
let stdinBuffer = Buffer.alloc(0);
let extensionRequestId = 1;
const pendingExtensionRequests = new Map();

function log(...args) {
  console.error('[Native Host]', ...args);
}

function sendToStdout(message) {
  try {
    process.stdout.write(encodeNativeMessage(message));
  } catch (error) {
    log('Error sending to stdout:', error);
  }
}

function sendLegacyToExtension(message) {
  sendToStdout(message);
}

function connectDaemon() {
  if (daemonClient && !daemonClient.closed) return;
  const client = new DaemonClient({
    role: 'native_host',
    name: 'browserpilot-native-host',
    capabilities: { extensionBridge: true },
    timeoutMs: 1000,
  });
  client.on('message', (message) => {
    if (message.type === 'tool.call') forwardToolCallToExtension(message);
  });
  client.on('error', (error) => {
    log('Daemon connection error:', error.message);
  });
  client.on('close', () => {
    daemonClient = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectDaemon, RECONNECT_DELAY);
  });
  client.connect().then(() => {
    daemonClient = client;
    log('Connected to BrowserPilot daemon as native_host');
  }).catch((error) => {
    log('Failed to connect to daemon:', error.message);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectDaemon, RECONNECT_DELAY);
  });
}

function forwardToolCallToExtension(message) {
  const legacyId = extensionRequestId++;
  const legacyMessage = { id: legacyId, method: message.toolName, params: message.toolArguments || {} };
  const timer = setTimeout(() => {
    pendingExtensionRequests.delete(legacyId);
    try {
      daemonClient?.send(makeToolError({ id: message.id, code: 'TOOL_TIMEOUT', message: 'Request timed out waiting for extension response' }));
    } catch (error) {
      log('Failed to send timeout to daemon:', error.message);
    }
  }, EXTENSION_TIMEOUT_MS);
  pendingExtensionRequests.set(legacyId, { daemonRequestId: message.id, timer, toolName: message.toolName, toolArguments: message.toolArguments || {} });
  sendLegacyToExtension(legacyMessage);
}

function handleExtensionResponse(message) {
  const pending = pendingExtensionRequests.get(message.id);
  if (!pending) {
    log('Received extension response with no pending daemon request:', message.id);
    return;
  }
  pendingExtensionRequests.delete(message.id);
  clearTimeout(pending.timer);
  try {
    if (message.error) {
      const errorMessage = typeof message.error === 'string' ? message.error : (message.error.message || JSON.stringify(message.error));
      daemonClient?.send(makeToolError({ id: pending.daemonRequestId, code: 'EXTENSION_TOOL_ERROR', message: errorMessage }));
    } else {
      const result = message.result || {};
      if (pending.toolName === 'ensure_active_tab' && result.delegatedTo === 'native-host') {
        const launch = startBrowserProcess(pending.toolArguments || {});
        if (!launch.started) {
          daemonClient?.send(makeToolError({
            id: pending.daemonRequestId,
            code: launch.code || 'BROWSER_LAUNCH_FAILED',
            message: launch.message || 'Failed to start browser',
          }));
          return;
        }
        daemonClient?.send(makeToolResult({
          id: pending.daemonRequestId,
          result: {
            tabId: null,
            source: 'browser-launched',
            browserStarted: true,
            launch,
            message: 'Browser launch requested by explicit ensure_active_tab call. Retry ensure_active_tab after the browser finishes launching.',
          },
        }));
        return;
      }
      daemonClient?.send(makeToolResult({ id: pending.daemonRequestId, result }));
    }
  } catch (error) {
    log('Failed to forward extension response to daemon:', error.message);
  }
}

function handleExtensionMessage(message) {
  if (message && typeof message === 'object' && !message.method && ('result' in message || 'error' in message)) {
    handleExtensionResponse(message);
    return;
  }
  log('Ignoring unsolicited extension message:', message?.method || message?.id || '<unknown>');
}

function setupStdin() {
  process.stdin.on('data', (data) => {
    try {
      const decoded = decodeNativeMessages(Buffer.concat([stdinBuffer, data]));
      stdinBuffer = decoded.remaining;
      for (const message of decoded.messages) handleExtensionMessage(message);
    } catch (error) {
      log('Failed to parse message from Chrome:', error.message);
    }
  });
  process.stdin.on('error', (error) => {
    log('Stdin error:', error);
    process.exit(1);
  });
  process.stdin.on('end', () => {
    log('Stdin closed, exiting');
    process.exit(0);
  });
}

function setupSignals() {
  const shutdown = () => {
    clearTimeout(reconnectTimer);
    daemonClient?.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

log('Native host starting');
setupStdin();
setupSignals();
connectDaemon();
