#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LAUNCH_AGENT_LABEL,
  buildInstallPlan,
  buildUninstallPlan,
  generateLaunchAgentPlist,
  launchAgentPaths,
  resolveDaemonProgramArguments,
  validateLaunchAgentPaths,
} from '../host/launch-agent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/browserpilot-mcp.mjs');
const realHome = os.homedir();
const realLaunchAgentsDir = path.join(realHome, 'Library', 'LaunchAgents');
const realLogDir = path.join(realHome, 'Library', 'Logs', 'BrowserPilotMCP');
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}

try {
  const redirectedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-home-redirect-'));
  process.env.BROWSERPILOT_HOME = redirectedHome;
  delete process.env.BROWSERPILOT_TEST_HOME;

  const realInstallPlan = buildInstallPlan({ dryRun: false, platform: 'darwin' });
  assert.equal(realInstallPlan.plistPath, path.join(realLaunchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`), 'real install plan must ignore BROWSERPILOT_HOME');
  assert.equal(realInstallPlan.logPaths.stdout, path.join(realLogDir, 'daemon.out.log'), 'real install logs must ignore BROWSERPILOT_HOME');
  const realUninstallPlan = buildUninstallPlan({ dryRun: false, platform: 'darwin' });
  assert.equal(realUninstallPlan.plistPath, path.join(realLaunchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`), 'real uninstall plan must ignore BROWSERPILOT_HOME');

  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-test-home-'));
  process.env.BROWSERPILOT_TEST_HOME = testHome;
  const dryRunPlan = buildInstallPlan({ dryRun: true, platform: 'darwin' });
  assert.equal(dryRunPlan.plistPath, path.join(testHome, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`), 'dry-run test mode may use BROWSERPILOT_TEST_HOME');
  const nonDryRunWithTestHome = buildInstallPlan({ dryRun: false, platform: 'darwin' });
  assert.equal(nonDryRunWithTestHome.plistPath, path.join(realLaunchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`), 'non-dry-run must not use BROWSERPILOT_TEST_HOME unless explicit test mode is requested');

  const realPaths = launchAgentPaths({ testMode: false });
  validateLaunchAgentPaths(realPaths, { testMode: false });
  assert.ok(realPaths.plistPath.startsWith(`${realLaunchAgentsDir}${path.sep}`), 'plist path must be within real LaunchAgents dir');
  assert.ok(realPaths.logDir === realLogDir, 'logDir must be exact BrowserPilotMCP log dir');
  assert.throws(
    () => validateLaunchAgentPaths({ ...realPaths, plistPath: path.join(os.tmpdir(), 'evil.plist') }, { testMode: false }),
    /outside real user LaunchAgents/,
  );
  assert.throws(
    () => validateLaunchAgentPaths({ ...realPaths, logDir: path.join(os.tmpdir(), 'logs'), stdoutLogPath: path.join(os.tmpdir(), 'out'), stderrLogPath: path.join(os.tmpdir(), 'err') }, { testMode: false }),
    /outside real user log directory/,
  );

  for (const shell of ['/bin/bash', '/bin/zsh', '/usr/bin/env', 'env', '/opt/homebrew/bin/fish']) {
    assert.throws(
      () => generateLaunchAgentPlist({ programArguments: [shell, '/tmp/browserpilot-cli.mjs', 'daemon', 'start', '--foreground'], stdoutLogPath: path.join(realLogDir, 'out'), stderrLogPath: path.join(realLogDir, 'err') }),
      /ProgramArguments|Only absolute Node executable/,
      `plist generator must reject shell/env variant ${shell}`,
    );
  }

  const escaped = generateLaunchAgentPlist({
    programArguments: [process.execPath, '/tmp/browserpilot-&-<cli>-"quoted".mjs', 'daemon', 'start', '--foreground'],
    stdoutLogPath: path.join(realLogDir, 'out&<.log'),
    stderrLogPath: path.join(realLogDir, 'err&<.log'),
  });
  assert.ok(escaped.includes('&amp;') && escaped.includes('&lt;') && escaped.includes('&quot;'), 'plist generator must XML-escape inserted values');

  const resolved = resolveDaemonProgramArguments();
  assert.equal(resolved.mode, 'node-entrypoint-fallback', 'current implementation must explicitly use Node + absolute package CLI entrypoint fallback');
  assert.equal(resolved.args[0], process.execPath, 'Node fallback must use current absolute Node executable');
  assert.ok(path.isAbsolute(resolved.args[1]) && resolved.args[1].endsWith('bin/browserpilot-mcp.mjs'), 'Node fallback must use absolute package CLI entrypoint');

  const writeTarget = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-write-')), 'template.plist');
  const write = spawnSync(process.execPath, [cli, 'launch-agent', 'write', writeTarget], { cwd: root, encoding: 'utf8', env: originalEnv });
  assert.equal(write.status, 0, `launch-agent write must succeed for temp target: ${write.stderr || write.stdout}`);
  const written = fs.readFileSync(writeTarget, 'utf8');
  assert.ok(written.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`), 'launch-agent write must use canonical daemon label');
  assert.ok(!written.includes('host/daemon.js'), 'launch-agent write must not use source daemon path');
  assert.ok(written.includes('bin/browserpilot-mcp.mjs'), 'launch-agent write must use package CLI entrypoint fallback');
  const writeAgain = spawnSync(process.execPath, [cli, 'launch-agent', 'write', writeTarget], { cwd: root, encoding: 'utf8', env: originalEnv });
  assert.notEqual(writeAgain.status, 0, 'launch-agent write must no-clobber existing target');
  assert.match(writeAgain.stderr + writeAgain.stdout, /Refusing to overwrite|--force/, 'launch-agent write no-clobber must emit actionable error');

  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-token-'));
  const status = spawnSync(process.execPath, [cli, 'daemon', 'status', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...originalEnv, BROWSERPILOT_AUTH_TOKEN_DIR: tokenDir, BROWSERPILOT_TEST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-status-home-')) },
  });
  assert.equal(status.status, 0, `daemon status --json should report not-running without hard failure: ${status.stderr || status.stdout}`);
  assert.equal(fs.existsSync(path.join(tokenDir, 'daemon-token')), false, 'daemon status must not create auth token file when daemon is unreachable');

  const cliSource = fs.readFileSync(cli, 'utf8');
  assert.ok(cliSource.includes('DAEMON_READINESS_FAILED'), 'daemonInstall must propagate readiness failure as a structured install failure');
  assert.ok(cliSource.includes('BROWSERPILOT_TEST_FAKE_READINESS_FAILURE'), 'CLI must expose a test-only readiness failure injection path without launchctl');
  assert.ok(cliSource.includes('assertDaemonReady'), 'daemonInstall must call a readiness validator, not only check daemon connectivity');
  assert.ok(cliSource.includes('health.ready !== true') && cliSource.includes('health.acceptingToolCalls !== true'), 'readiness validator must require health.ready and health.acceptingToolCalls');
  assert.ok(cliSource.includes("BROWSERPILOT_TEST_FAKE_STATUS_HEALTH"), 'CLI must expose safe fake status health injection for readiness tests');
  assert.ok(cliSource.includes("flag: force ? 'w' : 'wx'"), 'launch-agent write must use atomic wx no-clobber by default');
  assert.ok(!cliSource.includes('fs.existsSync(resolved) && !force'), 'launch-agent write must not use existsSync + writeFileSync no-clobber TOCTOU pattern');

  console.log('daemon install security checks passed');
} finally {
  restoreEnv();
}
