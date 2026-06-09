#!/usr/bin/env node
import { startMcpAdapter } from './mcp-adapter.js';

startMcpAdapter().catch((error) => {
  console.error('[MCP Server Compatibility Entrypoint] Fatal error:', error);
  process.exit(1);
});
