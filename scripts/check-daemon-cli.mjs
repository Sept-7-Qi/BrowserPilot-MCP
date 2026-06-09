#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function assert(condition, message) { if (!condition) failures.push(message); }

const cli = read('bin/browserpilot-mcp.mjs');
const pkg = JSON.parse(read('package.json'));

assert(pkg.bin && pkg.bin['browserpilot-mcp'] === './bin/browserpilot-mcp.mjs', 'package bin must expose browserpilot-mcp CLI');
assert(cli.includes('host/mcp-server.js'), 'browserpilot-mcp start must keep compatibility path host/mcp-server.js');
assert(cli.includes('start'), 'CLI must support start command');
assert(cli.includes('daemon'), 'CLI must support daemon command group');
for (const sub of ['start', 'stop', 'status', 'restart', 'install', 'uninstall']) {
  assert(cli.includes(sub), `CLI daemon group must support ${sub}`);
}
assert(cli.includes('host/daemon.js'), 'CLI daemon start must resolve to host/daemon.js');
assert(cli.includes('daemon-client.js') || cli.includes('daemonClient') || cli.includes('requestStatus'), 'CLI admin commands must use daemon client/admin path');
assert(cli.includes('buildInstallPlan') && cli.includes('daemonInstall'), 'CLI daemon install must use LaunchAgent install planner');
assert(cli.includes('buildUninstallPlan') && cli.includes('daemonUninstall'), 'CLI daemon uninstall must use LaunchAgent uninstall planner');
assert(cli.includes('generateLaunchAgentPlist') && cli.includes('resolveDaemonProgramArguments'), 'CLI launch-agent write/print must reuse safe plist planner/generator');
assert(cli.includes('DAEMON_READINESS_FAILED'), 'CLI daemon install must fail when readiness check fails');
assert(cli.includes('assertDaemonReady'), 'CLI daemon install must validate status health readiness');
assert(cli.includes('refusing to continue automatic Native Host/MCP install'), 'install --auto must stop after daemon install/readiness failure');
assert(cli.includes('createAuthToken: false'), 'CLI daemon status must be read-only and must not create auth token files');
assert(cli.includes('launchAgentStatusSummary') && cli.includes('launchAgent'), 'CLI daemon status --json must include LaunchAgent state');
assert(cli.includes('daemon install --dry-run'), 'CLI help must document daemon install --dry-run');
assert(cli.includes('daemon uninstall --dry-run'), 'CLI help must document daemon uninstall --dry-run');
assert(cli.includes('install --auto --dry-run'), 'CLI help must document install --auto --dry-run');
assert(cli.includes('launch-agent'), 'CLI must support launch-agent command group');
assert(cli.includes('print'), 'CLI launch-agent group must support print');
assert(cli.includes('write'), 'CLI launch-agent group must support write');
assert(cli.includes('127.0.0.1') && cli.includes('18765'), 'CLI launch-agent print/status help must mention loopback daemon bind');
assert(!/launchctl\s+load/.test(cli), 'CLI must not use legacy launchctl load');
assert(!/\.claude\.json/.test(cli), 'CLI must not modify Claude config');
assert(!/com\.openclaudeinchrome\.host\.json/.test(cli), 'CLI launch-agent write must not modify Native Messaging manifest');

if (failures.length) {
  console.error('daemon CLI checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('daemon CLI checks passed');
