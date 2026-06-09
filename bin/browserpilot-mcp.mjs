#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDaemonClient, generateRequestId } from '../host/daemon-client.js';
import { buildInstallPlan, buildUninstallPlan, generateLaunchAgentPlist, launchAgentPaths, resolveDaemonProgramArguments } from '../host/launch-agent.js';
import { DAEMON_HOST, DAEMON_PORT, makeShutdownRequest, makeStatusRequest } from '../host/protocol.js';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

const commandHelp = {
  install: `Usage: browserpilot-mcp install [--auto] [--dry-run] [--full] [--cli claude|codex|gemini|all|none] [--browser Chrome|Edge|Brave|Chromium] [Extension ID]\n\ninstall --auto runs the automatic setup flow and includes daemon install/start/status verification. install --auto --dry-run prints the full dry-run plan, including daemon install --dry-run, without modifying Native Host, MCP config, LaunchAgents, or daemon state. Non-dry-run install delegates existing Native Host/MCP work to quick-install.sh / 一键安装.sh and uses daemon install as the daemon lifecycle boundary.\n`,
  doctor: `Usage: browserpilot-mcp doctor [Extension ID] [--browser Chrome|Edge|Brave|Chromium]\n\nDelegates to install.sh doctor to check Native Messaging configuration without modifying it.\n`,
  'mcp-only': `Usage: browserpilot-mcp mcp-only [--cli claude|codex|gemini|all|none]\n\nDelegates to 一键安装.sh --mcp-only. It configures CLI MCP only and does not modify Native Host allowed origins.\n`,
  'package-extension': `Usage: browserpilot-mcp package-extension [--out DIR]\n\nDelegates to package-extension.sh to create browser extension artifacts.\n`,
  start: `Usage: browserpilot-mcp start\n\nRuns the Claude MCP stdio adapter compatibility entrypoint node host/mcp-server.js. The adapter connects to the BrowserPilot daemon and does not listen on TCP.\n`,
  daemon: `Usage: browserpilot-mcp daemon <start|stop|status|restart|install|uninstall> [--foreground] [--json] [--dry-run] [--force]\n\nDaemon lifecycle for the BrowserPilot loopback daemon at ${DAEMON_HOST}:${DAEMON_PORT} (default 127.0.0.1:18765). daemon install --dry-run prints the macOS LaunchAgent action plan. daemon uninstall --dry-run prints bootout/delete actions only.\n`,
  'launch-agent': `Usage: browserpilot-mcp launch-agent <print|write PATH>\n\nPrint or export a LaunchAgent template for the loopback daemon (default 127.0.0.1:18765). print reuses the daemon install LaunchAgent planner. write exports a template to an explicit PATH, is no-clobber by default, supports --force, and never runs launchctl. Use daemon install for real installation.\n`,
};

function printUsage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`BrowserPilot MCP CLI\n\nUsage:\n  browserpilot-mcp --help\n  browserpilot-mcp install --auto\n  browserpilot-mcp install --auto --dry-run\n  browserpilot-mcp doctor [Extension ID] --browser Chrome\n  browserpilot-mcp mcp-only --cli claude\n  browserpilot-mcp package-extension [--out DIR]\n  browserpilot-mcp start\n  browserpilot-mcp daemon start --foreground\n  browserpilot-mcp daemon status [--json]\n  browserpilot-mcp daemon stop\n  browserpilot-mcp daemon restart\n  browserpilot-mcp daemon install [--force] [--dry-run]\n  browserpilot-mcp daemon uninstall [--dry-run]\n  browserpilot-mcp launch-agent print\n  browserpilot-mcp launch-agent write PATH\n\nNotes:\n  browserpilot-mcp start is a Claude MCP stdio adapter, not a TCP server.\n  Only host/daemon.js listens on ${DAEMON_HOST}:${DAEMON_PORT}.\n  npm install -g . and npm link only expose this CLI and install dependencies.\n  browserpilot-mcp install --auto --dry-run prints the full plan and does not invoke shell scripts.\n`);
  process.exitCode = exitCode;
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, ...options });
  child.on('error', (error) => {
    console.error(`Failed to run ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`${command} terminated by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

function scriptPath(name) {
  return path.join(rootDir, name);
}

async function adminClient() {
  return connectDaemonClient({ role: 'admin', name: 'browserpilot-cli', capabilities: { status: true, shutdown: true }, timeoutMs: 1000, createAuthToken: false });
}

function launchAgentStatusSummary() {
  const paths = launchAgentPaths();
  return {
    label: 'com.browserpilot.mcp.daemon',
    plistPath: paths.plistPath,
    plistExists: fs.existsSync(paths.plistPath),
    loaded: null,
    running: null,
  };
}

async function requestStatus({ json = false } = {}) {
  const launchAgent = launchAgentStatusSummary();
  try {
    let status;
    if (process.env.BROWSERPILOT_TEST_FAKE_STATUS_HEALTH === 'not-ready') {
      status = {
        daemon: { pid: process.pid, host: DAEMON_HOST, port: DAEMON_PORT, startedAt: new Date().toISOString() },
        clients: { mcpAdapters: 0, nativeHosts: 0, admins: 1, activeNativeHostClientId: null },
        health: { ready: false, acceptingToolCalls: false, lastError: { code: 'TEST_NOT_READY', message: 'fake not-ready status' } },
      };
    } else {
      const client = await adminClient();
      status = await client.request(makeStatusRequest({ id: generateRequestId('status'), scope: 'summary' }), { timeoutMs: 1500, expectedType: 'status' });
      client.close();
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ daemon: { reachable: true, ...status.daemon, readiness: status.health }, clients: status.clients, launchAgent, errors: [] }, null, 2)}\n`);
    } else {
      process.stdout.write(`BrowserPilot daemon running\n`);
      process.stdout.write(`  pid: ${status.daemon.pid}\n  bind: ${status.daemon.host}:${status.daemon.port}\n  startedAt: ${status.daemon.startedAt}\n  clients: mcp=${status.clients.mcpAdapters} native=${status.clients.nativeHosts} admin=${status.clients.admins}\n  activeNativeHost: ${status.clients.activeNativeHostClientId || 'none'}\n  ready: ${status.health.ready}\n  launchAgent: ${launchAgent.label} (${launchAgent.plistExists ? 'plist exists' : 'plist missing'})\n`);
    }
    return status;
  } catch (error) {
    const payload = { daemon: { reachable: false, host: DAEMON_HOST, port: DAEMON_PORT, readiness: { ready: false, acceptingToolCalls: false, lastError: null } }, launchAgent, errors: [{ code: 'DAEMON_NOT_REACHABLE', message: error.message }] };
    if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`BrowserPilot daemon not running at ${DAEMON_HOST}:${DAEMON_PORT}: ${error.message}\nLaunchAgent: ${launchAgent.label} (${launchAgent.plistExists ? 'plist exists' : 'plist missing'})\n`);
    return null;
  }
}

async function stopDaemon() {
  try {
    const client = await adminClient();
    const result = await client.request(makeShutdownRequest({ id: generateRequestId('shutdown') }), { timeoutMs: 1500, expectedType: 'shutdown' });
    client.close();
    process.stdout.write(`BrowserPilot daemon shutdown accepted: ${result.accepted}\n`);
  } catch (error) {
    process.stdout.write(`BrowserPilot daemon not running at ${DAEMON_HOST}:${DAEMON_PORT}: ${error.message}\n`);
  }
}

async function startDaemon(args) {
  const existing = await requestStatus({ json: false });
  if (existing) return;
  if (!args.includes('--foreground')) {
    process.stderr.write('Usage: browserpilot-mcp daemon start --foreground\n');
    process.exitCode = 1;
    return;
  }
  run(process.execPath, [scriptPath('host/daemon.js')]);
}

async function restartDaemon(args) {
  await stopDaemon();
  await startDaemon(args.includes('--foreground') ? args : [...args, '--foreground']);
}

function parseFlags(args) {
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    json: args.includes('--json'),
    testMode: process.env.BROWSERPILOT_INTERNAL_TEST_MODE === '1',
  };
}

function printPlan(plan) {
  if (plan.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${plan.type}\n`);
  process.stdout.write(`  label: ${plan.label}\n  plistPath: ${plan.plistPath}\n  dryRun: ${plan.dryRun}\n  code: ${plan.code}\n`);
  if (plan.message) process.stdout.write(`  message: ${plan.message}\n`);
  if (plan.programArguments) process.stdout.write(`  ProgramArguments: ${JSON.stringify(plan.programArguments)}\n`);
  if (plan.logPaths) process.stdout.write(`  logs: ${plan.logPaths.stdout} / ${plan.logPaths.stderr}\n`);
  if (plan.actions) {
    process.stdout.write('  actions:\n');
    for (const action of plan.actions) process.stdout.write(`    - ${action.kind}${action.dryRun ? ' (dry-run)' : ''}${action.path ? ` ${action.path}` : ''}\n`);
  }
  if (plan.plist) process.stdout.write(`\n${plan.plist}`);
}

async function runLaunchctl(args) {
  if (process.env.BROWSERPILOT_TEST_FAKE_LAUNCHCTL === '1') return;
  const child = spawn('launchctl', args, { stdio: 'inherit' });
  await new Promise((resolve, reject) => child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`launchctl ${args[0]} exited ${code}`))));
}

async function daemonInstall(args) {
  const flags = parseFlags(args);
  const plan = buildInstallPlan(flags);
  printPlan(plan);
  if (!plan.ok) {
    process.exitCode = 1;
    return plan;
  }
  if (flags.dryRun) return plan;
  fs.mkdirSync(plan.logPaths.stdout ? path.dirname(plan.logPaths.stdout) : launchAgentPaths().logDir, { recursive: true });
  fs.mkdirSync(path.dirname(plan.plistPath), { recursive: true });
  fs.writeFileSync(plan.plistPath, plan.plist, { mode: 0o644, flag: flags.force ? 'w' : 'wx' });
  await runLaunchctl(['bootstrap', `gui/${process.getuid()}`, plan.plistPath]);
  await runLaunchctl(['kickstart', '-k', `gui/${process.getuid()}/${plan.label}`]);
  if (process.env.BROWSERPILOT_TEST_FAKE_READINESS_FAILURE === '1') {
    const error = new Error('BrowserPilot daemon readiness check failed after LaunchAgent install');
    error.code = 'DAEMON_READINESS_FAILED';
    throw error;
  }
  const status = await requestStatus({ json: false });
  if (!status) {
    const error = new Error('BrowserPilot daemon readiness check failed after LaunchAgent install');
    error.code = 'DAEMON_READINESS_FAILED';
    process.exitCode = 1;
    throw error;
  }
  assertDaemonReady(status);
  return plan;
}

async function daemonUninstall(args) {
  const flags = parseFlags(args);
  const plan = buildUninstallPlan(flags);
  printPlan(plan);
  if (!plan.ok) {
    process.exitCode = 1;
    return plan;
  }
  if (flags.dryRun || plan.code === 'ALREADY_UNINSTALLED') return plan;
  try { await runLaunchctl(['bootout', `gui/${process.getuid()}/${plan.label}`]); } catch {}
  fs.rmSync(plan.plistPath, { force: true });
  return plan;
}

function assertDaemonReady(status) {
  const health = status?.health;
  if (!health || health.ready !== true || health.acceptingToolCalls !== true) {
    const error = new Error(`BrowserPilot daemon is reachable but not ready for tool calls (ready=${health?.ready}, acceptingToolCalls=${health?.acceptingToolCalls})`);
    error.code = 'DAEMON_READINESS_FAILED';
    throw error;
  }
}

function installDryRun(args) {
  const daemonPlan = buildInstallPlan({ dryRun: true, force: args.includes('--force') });
  const plan = {
    type: 'browserpilot.install.autoPlan',
    dryRun: true,
    actions: [
      { kind: 'nativeHostInstall', command: 'quick-install.sh/一键安装.sh', dryRun: true },
      { kind: 'mcpConfigure', command: '一键安装.sh --full --cli claude', dryRun: true },
      { kind: 'daemonInstall', command: 'browserpilot-mcp daemon install --dry-run', dryRun: true, plan: daemonPlan },
      { kind: 'daemonStatusVerify', command: 'browserpilot-mcp daemon status --json', dryRun: true },
    ],
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

function launchAgentPrint() {
  const paths = launchAgentPaths();
  const resolution = resolveDaemonProgramArguments();
  const plist = generateLaunchAgentPlist({ programArguments: resolution.args, stdoutLogPath: paths.stdoutLogPath, stderrLogPath: paths.stderrLogPath });
  process.stdout.write(`BrowserPilot daemon launch-agent template\nCommand: ${resolution.args.join(' ')}\nBind: ${DAEMON_HOST}:${DAEMON_PORT} (loopback only)\nLifecycle: external service manager should keep this foreground process alive.\nDo not run launchctl automatically from this CLI.\n\n${plist}`);
}

function launchAgentWrite(args) {
  const force = args.includes('--force');
  const target = args.find((arg) => !arg.startsWith('-'));
  if (!target) {
    process.stderr.write('Usage: browserpilot-mcp launch-agent write [--force] PATH\n');
    process.exitCode = 1;
    return;
  }
  const resolved = path.resolve(process.cwd(), target);
  const paths = launchAgentPaths();
  const resolution = resolveDaemonProgramArguments();
  const content = generateLaunchAgentPlist({ programArguments: resolution.args, stdoutLogPath: paths.stdoutLogPath, stderrLogPath: paths.stderrLogPath });
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    fs.writeFileSync(resolved, content, { mode: 0o644, flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST' && !force) {
      process.stderr.write(`Refusing to overwrite existing file: ${resolved}. Re-run with --force to replace it.\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  process.stdout.write(`Wrote launch-agent template export: ${resolved}\nRecommended real install command: browserpilot-mcp daemon install\nManual verification: browserpilot-mcp launch-agent print\nManual load is intentionally not performed by this command.\n`);
}

const [command, ...args] = process.argv.slice(2);

if (!command || command === '-h' || command === '--help') {
  printUsage(0);
} else if (Object.prototype.hasOwnProperty.call(commandHelp, command) && args.some((arg) => arg === '-h' || arg === '--help')) {
  process.stdout.write(commandHelp[command]);
} else if (command === 'install') {
  if (args.includes('--auto') && args.includes('--dry-run')) installDryRun(args);
  else if (args.includes('--auto')) {
    try {
      await daemonInstall(args.filter((arg) => arg === '--force'));
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ code: error.code || 'DAEMON_INSTALL_FAILED', message: error.message }, null, 2)}\n`);
      process.exitCode = 1;
    }
    if (process.exitCode) {
      process.stderr.write('Daemon install failed; refusing to continue automatic Native Host/MCP install.\n');
    } else {
      run(scriptPath('quick-install.sh'), args.filter((arg) => arg !== '--force'));
    }
  } else run(scriptPath('quick-install.sh'), args);
} else if (command === 'doctor') {
  run(scriptPath('install.sh'), ['doctor', ...args]);
} else if (command === 'mcp-only') {
  run(scriptPath('一键安装.sh'), ['--mcp-only', ...args]);
} else if (command === 'package-extension') {
  run(scriptPath('package-extension.sh'), args);
} else if (command === 'start') {
  if (args.length > 0) {
    console.error('Usage: browserpilot-mcp start');
    process.exitCode = 1;
  } else {
    run(process.execPath, [scriptPath('host/mcp-server.js')]);
  }
} else if (command === 'daemon') {
  const [sub, ...subArgs] = args;
  if (sub === 'start') await startDaemon(subArgs);
  else if (sub === 'status') await requestStatus({ json: subArgs.includes('--json') });
  else if (sub === 'stop') await stopDaemon();
  else if (sub === 'restart') await restartDaemon(subArgs);
  else if (sub === 'install') {
    try { await daemonInstall(subArgs); }
    catch (error) {
      process.stderr.write(`${JSON.stringify({ code: error.code || 'DAEMON_INSTALL_FAILED', message: error.message }, null, 2)}\n`);
      process.exitCode = 1;
    }
  }
  else if (sub === 'uninstall') await daemonUninstall(subArgs);
  else { console.error(commandHelp.daemon); process.exitCode = 1; }
} else if (command === 'launch-agent') {
  const [sub, ...subArgs] = args;
  if (sub === 'print') launchAgentPrint();
  else if (sub === 'write') launchAgentWrite(subArgs);
  else { console.error(commandHelp['launch-agent']); process.exitCode = 1; }
} else {
  console.error(`Unknown command: ${command}`);
  printUsage(1);
}
