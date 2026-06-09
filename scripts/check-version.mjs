#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const expectedVersion = process.argv[2] ?? null;
const failures = [];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function assertVersion(label, actual, expected) {
  assert(actual === expected, `${label} version must be ${expected}; got ${actual ?? 'missing'}`);
}

const rootPackage = readJson('package.json');
const hostPackage = readJson('host/package.json');
const hostPackageLock = fs.existsSync(path.join(root, 'host/package-lock.json')) ? readJson('host/package-lock.json') : null;
const manifest = readJson('extension/manifest.json');
const mcpServer = readText('host/mcp-adapter.js');
const mcpVersionMatch = mcpServer.match(/version:\s*['"]([^'"]+)['"]/);

const canonicalVersion = expectedVersion ?? rootPackage.version;
assert(canonicalVersion, 'canonical version must be defined');
assertVersion('package.json', rootPackage.version, canonicalVersion);
assertVersion('host/package.json', hostPackage.version, canonicalVersion);
if (hostPackageLock) {
  assertVersion('host/package-lock.json', hostPackageLock.version, canonicalVersion);
  assertVersion('host/package-lock.json root package', hostPackageLock.packages?.['']?.version, canonicalVersion);
}
assertVersion('extension/manifest.json', manifest.version, canonicalVersion);
assert(mcpVersionMatch, 'host/mcp-adapter.js must declare MCP server version');
if (mcpVersionMatch) assertVersion('host/mcp-server.js MCP server', mcpVersionMatch[1], canonicalVersion);

if (failures.length) {
  console.error('Version checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Version checks passed (${canonicalVersion})`);
