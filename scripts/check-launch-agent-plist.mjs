#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/browserpilot-mcp.mjs');

const env = {
  ...process.env,
  BROWSERPILOT_TEST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-plist-home-')),
};

try {
  const result = spawnSync(process.execPath, [cli, 'daemon', 'install', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, `daemon install --dry-run --json must succeed: ${result.stderr || result.stdout}`);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.type, 'browserpilot.daemon.installPlan');
  assert.equal(plan.label, 'com.browserpilot.mcp.daemon');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.plistPath, path.join(env.BROWSERPILOT_TEST_HOME, 'Library/LaunchAgents/com.browserpilot.mcp.daemon.plist'));
  assert.ok(plan.plist.includes('<key>Label</key>'));
  assert.ok(plan.plist.includes('<string>com.browserpilot.mcp.daemon</string>'));
  assert.ok(plan.plist.includes('<key>ProgramArguments</key>'));
  assert.ok(plan.plist.includes('<key>RunAtLoad</key>'));
  assert.ok(plan.plist.includes('<true/>'));
  assert.ok(plan.plist.includes('<key>KeepAlive</key>'));
  assert.ok(plan.plist.includes('<key>StandardOutPath</key>'));
  assert.ok(plan.plist.includes('<key>StandardErrorPath</key>'));

  const args = plan.programArguments;
  assert.ok(Array.isArray(args), 'ProgramArguments summary must be an array');
  assert.ok(args.length >= 4, 'ProgramArguments must include executable plus daemon start --foreground');
  assert.ok(path.isAbsolute(args[0]), `first ProgramArguments entry must be absolute: ${args[0]}`);
  if (args[0] === process.execPath) {
    assert.ok(path.isAbsolute(args[1]), `node fallback entrypoint must be absolute: ${args[1]}`);
    assert.deepEqual(args.slice(2), ['daemon', 'start', '--foreground']);
  } else {
    assert.deepEqual(args.slice(1), ['daemon', 'start', '--foreground']);
  }
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh', 'bash', 'zsh', 'env', '/usr/bin/env', 'fish']) {
    assert.ok(!args.includes(shell), `ProgramArguments must not use shell/env: ${shell}`);
    assert.ok(!plan.plist.includes(shell), `plist must not contain shell/env: ${shell}`);
  }
  assert.ok(!/\$PATH|<key>EnvironmentVariables<\/key>|\.\/host\/daemon\.js|host\/daemon\.js<\/string>/.test(plan.plist), 'plist must not rely on PATH or source-relative daemon paths');
  assert.ok(path.isAbsolute(plan.logPaths.stdout), 'stdout log path must be absolute');
  assert.ok(path.isAbsolute(plan.logPaths.stderr), 'stderr log path must be absolute');
  assert.ok(plan.logPaths.stdout.startsWith(env.BROWSERPILOT_TEST_HOME), 'stdout log path must be under test home');
  assert.ok(plan.logPaths.stderr.startsWith(env.BROWSERPILOT_TEST_HOME), 'stderr log path must be under test home');

  console.log('launch-agent plist checks passed');
} finally {
  fs.rmSync(env.BROWSERPILOT_TEST_HOME, { recursive: true, force: true });
}
