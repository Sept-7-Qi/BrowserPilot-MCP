import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCH_AGENT_LABEL = 'com.browserpilot.mcp.daemon';
export const LAUNCH_AGENT_FILENAME = `${LAUNCH_AGENT_LABEL}.plist`;

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), '..');
const packageCliEntrypoint = path.join(packageRoot, 'bin/browserpilot-mcp.mjs');

function realHomeDir() {
  return os.homedir();
}

function planHomeDir({ dryRun = false, testMode = false, home } = {}) {
  if (testMode || (dryRun && process.env.BROWSERPILOT_TEST_HOME)) {
    return home || process.env.BROWSERPILOT_TEST_HOME || realHomeDir();
  }
  return realHomeDir();
}

function assertAbsolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  return value;
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateLaunchAgentPaths(paths, { testMode = false } = {}) {
  for (const [label, value] of Object.entries({ plistPath: paths.plistPath, logDir: paths.logDir, stdoutLogPath: paths.stdoutLogPath, stderrLogPath: paths.stderrLogPath })) {
    assertAbsolute(value, label);
  }
  if (testMode) return true;
  const realHome = realHomeDir();
  const realLaunchAgentsDir = path.join(realHome, 'Library', 'LaunchAgents');
  const realLogDir = path.join(realHome, 'Library', 'Logs', 'BrowserPilotMCP');
  if (!isPathInside(paths.plistPath, realLaunchAgentsDir) || path.basename(paths.plistPath) !== LAUNCH_AGENT_FILENAME) {
    throw new Error(`LaunchAgent plist path is outside real user LaunchAgents directory: ${paths.plistPath}`);
  }
  if (paths.logDir !== realLogDir || !isPathInside(paths.stdoutLogPath, realLogDir) || !isPathInside(paths.stderrLogPath, realLogDir)) {
    throw new Error(`LaunchAgent log path is outside real user log directory: ${realLogDir}`);
  }
  return true;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function launchAgentPaths({ home, dryRun = false, testMode = false } = {}) {
  const resolvedHome = assertAbsolute(path.resolve(planHomeDir({ home, dryRun, testMode })), 'home');
  const launchAgentsDir = path.join(resolvedHome, 'Library', 'LaunchAgents');
  const logDir = path.join(resolvedHome, 'Library', 'Logs', 'BrowserPilotMCP');
  const paths = {
    home: resolvedHome,
    launchAgentsDir,
    plistPath: path.join(launchAgentsDir, LAUNCH_AGENT_FILENAME),
    logDir,
    stdoutLogPath: path.join(logDir, 'daemon.out.log'),
    stderrLogPath: path.join(logDir, 'daemon.err.log'),
  };
  validateLaunchAgentPaths(paths, { testMode: testMode || Boolean(dryRun && process.env.BROWSERPILOT_TEST_HOME) });
  return paths;
}

export function resolveDaemonProgramArguments({ cliEntrypoint = packageCliEntrypoint, nodePath = process.execPath } = {}) {
  const absoluteNode = assertAbsolute(nodePath, 'node executable');
  const absoluteEntrypoint = assertAbsolute(cliEntrypoint, 'CLI entrypoint');
  if (!fs.existsSync(absoluteEntrypoint)) throw new Error(`CLI entrypoint does not exist: ${absoluteEntrypoint}`);
  return {
    mode: 'node-entrypoint-fallback',
    executable: absoluteNode,
    entrypoint: absoluteEntrypoint,
    args: [absoluteNode, absoluteEntrypoint, 'daemon', 'start', '--foreground'],
    diagnostics: {
      reason: 'using absolute Node executable plus absolute package CLI entrypoint; does not depend on shell PATH or source-relative daemon paths',
      nodePath: absoluteNode,
      cliEntrypoint: absoluteEntrypoint,
    },
  };
}

export function generateLaunchAgentPlist({ programArguments, stdoutLogPath, stderrLogPath, label = LAUNCH_AGENT_LABEL }) {
  if (!Array.isArray(programArguments) || programArguments.length !== 5) throw new Error('ProgramArguments must be [node, cliEntrypoint, daemon, start, --foreground]');
  const [nodeExecutable, cliEntrypoint, daemonArg, startArg, foregroundArg] = programArguments;
  assertAbsolute(nodeExecutable, 'ProgramArguments[0]');
  assertAbsolute(cliEntrypoint, 'ProgramArguments[1]');
  const shellNames = new Set(['sh', 'bash', 'zsh', 'fish', 'env']);
  for (const arg of programArguments) {
    const base = path.basename(arg);
    if (shellNames.has(base) || arg === '/bin/sh' || arg === '/usr/bin/env') throw new Error(`ProgramArguments must not use shell/env: ${arg}`);
  }
  if (!path.basename(nodeExecutable).startsWith('node')) throw new Error(`Only absolute Node executable is allowed in ProgramArguments[0]: ${nodeExecutable}`);
  if (!cliEntrypoint.endsWith('.mjs')) throw new Error(`Only absolute package CLI .mjs entrypoint is allowed in ProgramArguments[1]: ${cliEntrypoint}`);
  if (daemonArg !== 'daemon' || startArg !== 'start' || foregroundArg !== '--foreground') throw new Error('ProgramArguments must invoke daemon start --foreground');
  assertAbsolute(stdoutLogPath, 'StandardOutPath');
  assertAbsolute(stderrLogPath, 'StandardErrorPath');
  const argXml = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrLogPath)}</string>
</dict>
</plist>
`;
}

export function buildInstallPlan({ dryRun = false, force = false, json = false, home = undefined, platform = process.platform, testMode = false } = {}) {
  const effectiveTestMode = testMode || Boolean(dryRun && process.env.BROWSERPILOT_TEST_HOME);
  const paths = launchAgentPaths({ home, dryRun, testMode: effectiveTestMode });
  const resolved = resolveDaemonProgramArguments();
  const plistExists = fs.existsSync(paths.plistPath);
  const base = {
    type: 'browserpilot.daemon.installPlan',
    label: LAUNCH_AGENT_LABEL,
    plistPath: paths.plistPath,
    logPaths: { stdout: paths.stdoutLogPath, stderr: paths.stderrLogPath },
    programArguments: resolved.args,
    cliResolution: resolved,
    dryRun,
    force,
    platform,
    json,
    testMode: effectiveTestMode,
    actions: [],
  };
  if (platform !== 'darwin') {
    return { ...base, ok: false, code: 'UNSUPPORTED_PLATFORM', message: 'BrowserPilot daemon LaunchAgent install is supported only on macOS.' };
  }
  if (plistExists && !force) {
    return {
      ...base,
      ok: false,
      code: 'LAUNCH_AGENT_PLIST_EXISTS',
      message: `LaunchAgent plist already exists: ${paths.plistPath}. Re-run with --force to replace it.`,
      actions: [{ kind: 'noClobber', path: paths.plistPath, dryRun: true }],
    };
  }
  if (plistExists && force) base.actions.push({ kind: 'replaceExistingPlist', path: paths.plistPath, dryRun });
  base.plist = generateLaunchAgentPlist({ programArguments: resolved.args, stdoutLogPath: paths.stdoutLogPath, stderrLogPath: paths.stderrLogPath });
  base.actions.push(
    { kind: 'createLogDirectory', path: paths.logDir, dryRun },
    { kind: 'writePlist', path: paths.plistPath, mode: '0644', dryRun },
    { kind: 'launchctlBootstrap', domain: `gui/${process.getuid?.() ?? 'USER'}`, label: LAUNCH_AGENT_LABEL, plistPath: paths.plistPath, dryRun },
    { kind: 'launchctlKickstart', service: `gui/${process.getuid?.() ?? 'USER'}/${LAUNCH_AGENT_LABEL}`, dryRun },
    { kind: 'readinessCheck', command: 'browserpilot-mcp daemon status --json', host: '127.0.0.1', port: 18765, dryRun },
  );
  return { ...base, ok: true, code: 'INSTALL_PLAN_READY' };
}

export function buildUninstallPlan({ dryRun = false, json = false, home = undefined, platform = process.platform, testMode = false } = {}) {
  const effectiveTestMode = testMode || Boolean(dryRun && process.env.BROWSERPILOT_TEST_HOME);
  const paths = launchAgentPaths({ home, dryRun, testMode: effectiveTestMode });
  const plistExists = fs.existsSync(paths.plistPath);
  const base = {
    type: 'browserpilot.daemon.uninstallPlan',
    label: LAUNCH_AGENT_LABEL,
    plistPath: paths.plistPath,
    dryRun,
    platform,
    json,
    testMode: effectiveTestMode,
    actions: [],
  };
  if (platform !== 'darwin') {
    return { ...base, ok: false, code: 'UNSUPPORTED_PLATFORM', message: 'BrowserPilot daemon LaunchAgent uninstall is supported only on macOS.' };
  }
  if (!plistExists) {
    return {
      ...base,
      ok: true,
      code: 'ALREADY_UNINSTALLED',
      message: 'BrowserPilot daemon LaunchAgent plist is already absent.',
      actions: [
        { kind: 'launchctlBootout', service: `gui/${process.getuid?.() ?? 'USER'}/${LAUNCH_AGENT_LABEL}`, skipped: true, reason: 'plist is absent', dryRun },
        { kind: 'deletePlist', path: paths.plistPath, skipped: true, reason: 'plist is absent', dryRun },
      ],
    };
  }
  base.actions.push(
    { kind: 'launchctlBootout', service: `gui/${process.getuid?.() ?? 'USER'}/${LAUNCH_AGENT_LABEL}`, dryRun },
    { kind: 'deletePlist', path: paths.plistPath, dryRun },
  );
  return { ...base, ok: true, code: 'UNINSTALL_PLAN_READY' };
}
