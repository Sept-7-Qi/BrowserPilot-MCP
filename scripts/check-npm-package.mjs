#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const expectedVersion = process.argv[2] ?? (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return '1.1.1';
  }
})();

function relPath(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(relPath(rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(relPath(rel));
}

function isExecutable(rel) {
  try {
    fs.accessSync(relPath(rel), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function hasPackageFile(files, required) {
  return files.includes(required) || files.includes(required.replace(/\/$/, ''));
}

let pkg = null;
try {
  pkg = JSON.parse(read('package.json'));
} catch (error) {
  failures.push(`package.json must be valid JSON: ${error.message}`);
}

if (pkg) {
  assert(pkg.name === 'browserpilot-mcp', 'package.json must keep name browserpilot-mcp');
  assert(pkg.version === expectedVersion, `package.json must keep version ${expectedVersion}`);
  assert(pkg.private === true, 'package.json private must remain true for local npm installation');
  assert(pkg.engines && pkg.engines.node === '>=18.0.0', 'package.json must keep node >=18.0.0 engine');
  assert(pkg.bin && pkg.bin['browserpilot-mcp'] === './bin/browserpilot-mcp.mjs', 'package.json must expose bin.browserpilot-mcp = ./bin/browserpilot-mcp.mjs');
  assert(pkg.scripts && pkg.scripts['check:npm-package'] === 'node scripts/check-npm-package.mjs', 'package.json must add check:npm-package script');
  assert(!pkg.scripts || !Object.prototype.hasOwnProperty.call(pkg.scripts, 'install'), 'package.json must not define scripts.install because npm install must not configure Native Host or MCP');
  assert(pkg.dependencies && pkg.dependencies['@modelcontextprotocol/sdk'], 'root package dependencies must include @modelcontextprotocol/sdk for host/mcp-server.js');

  assert(Array.isArray(pkg.files), 'package.json must define files whitelist');
  if (Array.isArray(pkg.files)) {
    for (const required of [
      'bin/',
      'extension/',
      'scripts/',
      'host/mcp-server.js',
      'host/mcp-adapter.js',
      'host/daemon.js',
      'host/daemon-client.js',
      'host/protocol.js',
      'host/launch-agent.js',
      'host/native-frame.js',
      'host/auth-token.js',
      'host/tools.js',
      'host/native-host.js',
      'host/tab-lifecycle.js',
      'host/package.json',
      'install.sh',
      '一键安装.sh',
      'quick-install.sh',
      'package-extension.sh',
      'uninstall.sh',
      'README.md',
      'package.json',
    ]) {
      assert(hasPackageFile(pkg.files, required), `package.json files must include ${required}`);
    }
    for (const forbidden of [
      'node_modules',
      'node_modules/',
      'dist',
      'dist/',
      'dist-latest',
      'dist-latest/',
      'dist-latest-visual-1.1.1',
      'dist-latest-visual-1.1.1/',
      'dist-latest-visual-2',
      'dist-latest-visual-2/',
      'host/native-host-wrapper.sh',
      '*.pem',
      'browserpilot-mcp-extension.pem',
      'host/',
      'host/.claude',
      'host/.claude/',
      'host/.gstack',
      'host/.gstack/',
    ]) {
      assert(!pkg.files.includes(forbidden), `package.json files must not include ${forbidden}`);
    }
  }
}

const delegatedFiles = ['install.sh', '一键安装.sh', 'quick-install.sh', 'package-extension.sh'];
for (const file of delegatedFiles) {
  assert(exists(file), `${file} must exist`);
  assert(isExecutable(file), `${file} must be executable`);
}
assert(exists('host/mcp-server.js'), 'host/mcp-server.js must exist');

const cliPath = 'bin/browserpilot-mcp.mjs';
assert(exists(cliPath), 'CLI file bin/browserpilot-mcp.mjs must exist');
if (exists(cliPath)) {
  const cli = read(cliPath);
  assert(cli.startsWith('#!/usr/bin/env node'), 'CLI file must have node shebang');
  assert(isExecutable(cliPath), 'CLI file must be executable');

  for (const token of [
    'install',
    'doctor',
    'mcp-only',
    'package-extension',
    'start',
    'daemon',
    'launch-agent',
    '--help',
    'Usage:',
  ]) {
    assert(cli.includes(token), `CLI must support/document ${token}`);
  }

  assert(cli.includes('quick-install.sh') || cli.includes('一键安装.sh'), 'CLI install command must delegate to quick-install.sh or 一键安装.sh for non-dry-run script install work');
  assert(cli.includes('daemonInstall') && cli.includes('daemon install'), 'CLI install --auto must include daemon install/start/status planning');
  assert(cli.includes('--dry-run'), 'CLI install --auto must support --dry-run');
  assert(cli.includes('install --auto --dry-run'), 'CLI must document install --auto --dry-run');
  assert(cli.includes('installDryRun'), 'CLI install --auto --dry-run must not invoke shell installer scripts');
  assert(cli.includes('install.sh') && cli.includes('doctor'), 'CLI doctor command must delegate to install.sh doctor or one-click doctor');
  assert(cli.includes('一键安装.sh') && cli.includes('--mcp-only'), 'CLI mcp-only command must delegate to 一键安装.sh --mcp-only');
  assert(cli.includes('package-extension.sh'), 'CLI package-extension command must delegate to package-extension.sh');
  assert(cli.includes('host/mcp-server.js') && cli.includes('spawn'), 'CLI start command must run node host/mcp-server.js in foreground');
  assert(cli.includes('process.exitCode = 1') || cli.includes('process.exit(1)'), 'CLI unknown command must exit non-zero');

  const forbiddenManifestLogic = [
    'NativeMessagingHosts',
    'allowed_origins',
    'com.openclaudeinchrome.host',
    'native-host-wrapper.sh',
    'create_manifest',
  ];
  for (const token of forbiddenManifestLogic) {
    assert(!cli.includes(token), `CLI must not duplicate Native Messaging manifest logic (${token})`);
  }
  assert(!cli.includes('codex mcp add'), 'CLI must not contain invented codex mcp add command');
  assert(!cli.includes('gemini mcp add'), 'CLI must not contain invented gemini mcp add command');
}

const readme = exists('README.md') ? read('README.md') : '';
assert(readme.includes('本地 npm 安装') || readme.includes('npm link'), 'README must document local npm installation / npm link');
assert(readme.includes('npm install -g .'), 'README must document npm install -g .');
assert(readme.includes('npm link'), 'README must document npm link');
assert(readme.includes('browserpilot-mcp install --auto'), 'README must recommend browserpilot-mcp install --auto');
assert(readme.includes('browserpilot-mcp install --full --cli claude <Extension ID>'), 'README must document install --full --cli claude <Extension ID>');
assert(readme.includes('browserpilot-mcp doctor [Extension ID] --browser Chrome'), 'README must document doctor [Extension ID] --browser Chrome');
assert(readme.includes('browserpilot-mcp mcp-only --cli claude'), 'README must document mcp-only --cli claude');
assert(readme.includes('browserpilot-mcp package-extension [--out DIR]'), 'README must document package-extension [--out DIR]');
assert(readme.includes('browserpilot-mcp start'), 'README must document start');
assert(readme.includes('Node') && readme.includes('absolute') || readme.includes('绝对 Node'), 'README must document Node + absolute package CLI entrypoint fallback for LaunchAgent');
assert(readme.includes('模板导出') && readme.includes('daemon install'), 'README must document launch-agent write as template export and recommend daemon install for real install');
assert(readme.includes('npm install') && readme.includes('不改') && readme.includes('Native Host') && readme.includes('MCP'), 'README must explain npm install only exposes CLI/dependencies and does not modify Native Host or MCP');

if (failures.length) {
  console.error('npm package checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('npm package checks passed');
