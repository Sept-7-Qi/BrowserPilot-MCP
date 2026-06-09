#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient, generateRequestId } from './daemon-client.js';
import { makeToolCall, makeStatusRequest } from './protocol.js';
import { buildLocalHealthCheck, formatMcpToolResult, tools } from './tools.js';

function log(...args) {
  console.error('[MCP Adapter]', ...args);
}

let daemonClient = null;
let daemonConnectError = null;
let adminHealthClient = null;

async function getDaemonClient() {
  if (daemonClient && !daemonClient.closed) return daemonClient;
  const client = new DaemonClient({
    role: 'mcp_adapter',
    name: 'browserpilot-mcp-adapter',
    capabilities: { tools: true },
    timeoutMs: 1000,
  });
  client.on('error', (error) => {
    daemonConnectError = error;
  });
  client.on('close', () => {
    daemonClient = null;
  });
  await client.connect();
  daemonClient = client;
  daemonConnectError = null;
  return daemonClient;
}

async function getAdminHealthClient() {
  if (adminHealthClient && !adminHealthClient.closed) return adminHealthClient;
  const client = new DaemonClient({
    role: 'admin',
    name: 'browserpilot-mcp-adapter-health',
    capabilities: { status: true, shutdown: true },
    timeoutMs: 1000,
  });
  client.on('close', () => {
    adminHealthClient = null;
  });
  await client.connect();
  adminHealthClient = client;
  return adminHealthClient;
}

export async function adapterHealthCheck() {
  try {
    const client = await getAdminHealthClient();
    const status = await client.request(makeStatusRequest({ id: generateRequestId('status'), scope: 'summary' }), { timeoutMs: 1500, expectedType: 'status' });
    client.close();
    adminHealthClient = null;
    return buildLocalHealthCheck({
      daemonConnected: true,
      nativeHostConnected: Boolean(status.clients?.activeNativeHostClientId),
      daemonStatus: status,
      lastError: status.health?.lastError || null,
    });
  } catch (error) {
    daemonConnectError = error;
    return buildLocalHealthCheck({
      daemonConnected: false,
      nativeHostConnected: false,
      lastError: {
        code: 'DAEMON_NOT_CONNECTED',
        message: error.message,
        hint: 'Start the BrowserPilot daemon before using browser tools. health_check remains available for diagnostics.',
      },
    });
  }
}

export function createMcpServer() {
  const server = new Server({ name: 'browserpilot-mcp', version: '1.1.2' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'health_check') {
      const local = await adapterHealthCheck();
      return { content: [{ type: 'text', text: JSON.stringify(local, null, 2) }], isError: false };
    }

    let client;
    try {
      client = await getDaemonClient();
    } catch (error) {
      throw new Error(`BrowserPilot daemon is not connected: ${error.message}`);
    }

    const response = await client.request(makeToolCall({
      id: generateRequestId('tool'),
      toolName: name,
      toolArguments: args || {},
    }), { timeoutMs: 60000 });

    if (response.type === 'tool.error') {
      throw new Error(`${response.error.code}: ${response.error.message}`);
    }

    return formatMcpToolResult(response.result);
  });

  return server;
}

export async function startMcpAdapter() {
  try {
    await getDaemonClient();
  } catch (error) {
    daemonConnectError = error;
    log(`daemon unavailable at startup: ${error.message}; health_check will report diagnostics`);
  }
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  log('stdio adapter started');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpAdapter().catch((error) => {
    log('fatal:', error);
    process.exit(1);
  });
}
