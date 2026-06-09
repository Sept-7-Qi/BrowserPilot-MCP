#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/browserpilot-mcp.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpilot-cli-'));
try {
  const target = path.join(tmp, 'daemon.plist');
  fs.writeFileSync(target, 'keep-me');

  const noClobber = spawnSync(process.execPath, [cli, 'launch-agent', 'write', target], { cwd: root, encoding: 'utf8' });
  assert.notEqual(noClobber.status, 0, 'launch-agent write must fail for existing file by default');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep-me', 'launch-agent write must not clobber existing files without --force');
  assert.match(noClobber.stderr + noClobber.stdout, /exists|--force/i, 'no-clobber failure must explain --force');

  const forced = spawnSync(process.execPath, [cli, 'launch-agent', 'write', '--force', target], { cwd: root, encoding: 'utf8' });
  assert.equal(forced.status, 0, `launch-agent write --force must succeed: ${forced.stderr}`);
  assert.notEqual(fs.readFileSync(target, 'utf8'), 'keep-me', '--force must replace existing file');
  assert.doesNotMatch(forced.stdout + forced.stderr, /launchctl\s+(load|bootstrap)/, 'launch-agent write must not run launchctl');

  console.log('daemon CLI safety checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
