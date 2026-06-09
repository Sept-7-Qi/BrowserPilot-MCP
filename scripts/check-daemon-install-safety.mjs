#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/browserpilot-mcp.mjs');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-install-home-'));
const env = { ...process.env, BROWSERPILOT_TEST_HOME: testHome };
const plistPath = path.join(testHome, 'Library/LaunchAgents/com.browserpilot.mcp.daemon.plist');
const logDir = path.join(testHome, 'Library/Logs/BrowserPilotMCP');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env });
}
function parseJson(result) {
  assert.equal(result.status, 0, `${result.args?.join(' ') || 'command'} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

try {
  const installDryRun = parseJson(run(['daemon', 'install', '--dry-run', '--json']));
  assert.equal(installDryRun.dryRun, true);
  assert.equal(installDryRun.plistPath, plistPath);
  assert.equal(installDryRun.label, 'com.browserpilot.mcp.daemon');
  assert.ok(Array.isArray(installDryRun.actions), 'install dry-run must include actions');
  assert.ok(installDryRun.actions.some((a) => a.kind === 'writePlist' && a.dryRun === true));
  assert.ok(installDryRun.actions.some((a) => a.kind === 'launchctlBootstrap' && a.dryRun === true));
  assert.ok(installDryRun.actions.some((a) => a.kind === 'launchctlKickstart' && a.dryRun === true));
  assert.ok(installDryRun.actions.some((a) => a.kind === 'readinessCheck' && a.dryRun === true));
  assert.equal(fs.existsSync(plistPath), false, 'daemon install --dry-run must not write plist');
  assert.equal(fs.existsSync(logDir), false, 'daemon install --dry-run must not create log directory');
  assert.doesNotMatch(JSON.stringify(installDryRun), /launchctl\s+(bootstrap|kickstart)/, 'plan must not embed shell launchctl commands');

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, 'existing-plist');

  const noClobber = run(['daemon', 'install', '--dry-run', '--json']);
  assert.notEqual(noClobber.status, 0, 'existing plist without --force must fail deterministically');
  const noClobberPlan = JSON.parse(noClobber.stdout);
  assert.equal(noClobberPlan.code, 'LAUNCH_AGENT_PLIST_EXISTS');
  assert.equal(fs.readFileSync(plistPath, 'utf8'), 'existing-plist', 'no-clobber must not change plist');
  assert.ok(!noClobberPlan.actions.some((a) => a.kind === 'launchctlBootstrap' || a.kind === 'launchctlKickstart'), 'no-clobber must not plan bootstrap/kickstart');

  const forcePlan = parseJson(run(['daemon', 'install', '--force', '--dry-run', '--json']));
  assert.equal(forcePlan.force, true);
  assert.ok(forcePlan.actions.some((a) => a.kind === 'replaceExistingPlist' && a.dryRun === true));
  assert.equal(fs.readFileSync(plistPath, 'utf8'), 'existing-plist', '--force --dry-run must not write plist');

  const uninstallPlan = parseJson(run(['daemon', 'uninstall', '--dry-run', '--json']));
  assert.equal(uninstallPlan.type, 'browserpilot.daemon.uninstallPlan');
  assert.equal(uninstallPlan.label, 'com.browserpilot.mcp.daemon');
  assert.equal(uninstallPlan.plistPath, plistPath);
  assert.ok(uninstallPlan.actions.some((a) => a.kind === 'launchctlBootout' && a.dryRun === true));
  assert.ok(uninstallPlan.actions.some((a) => a.kind === 'deletePlist' && a.dryRun === true));
  assert.equal(fs.existsSync(plistPath), true, 'daemon uninstall --dry-run must not delete plist');

  fs.rmSync(plistPath, { force: true });
  const already = parseJson(run(['daemon', 'uninstall', '--dry-run', '--json']));
  assert.equal(already.code, 'ALREADY_UNINSTALLED');
  assert.ok(already.actions.every((a) => a.dryRun === true), 'already-uninstalled dry-run actions must be dry-run');

  console.log('daemon install safety checks passed');
} finally {
  fs.rmSync(testHome, { recursive: true, force: true });
}
