import { spawn } from 'node:child_process';

const DEFAULT_LAUNCH_URL = 'about:blank';
const ALLOWED_URL_PATTERN = /^https?:\/\//i;
const BLOCKED_SCHEMES = ['file:', 'javascript:', 'data:', 'chrome:', 'chrome-extension:', 'devtools:'];

export function validateBrowserPilotUrl(url, { allowEmpty = true } = {}) {
  if ((url === undefined || url === null || url === '') && allowEmpty) {
    return DEFAULT_LAUNCH_URL;
  }
  if (typeof url !== 'string') {
    const error = new Error('URL must be a string');
    error.code = 'INVALID_URL';
    throw error;
  }

  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === 'about:blank') return trimmed;
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) {
      const error = new Error(`URL scheme is not allowed: ${scheme}`);
      error.code = 'INVALID_URL_SCHEME';
      throw error;
    }
  }
  if (!ALLOWED_URL_PATTERN.test(trimmed)) {
    const error = new Error('Only http://, https://, and about:blank URLs are allowed');
    error.code = 'INVALID_URL_SCHEME';
    throw error;
  }
  return trimmed;
}

function resolveBrowserName(browser) {
  switch (browser) {
    case 'chrome':
      return 'Google Chrome';
    case 'edge':
      return 'Microsoft Edge';
    case 'brave':
      return 'Brave Browser';
    case 'auto':
    case undefined:
    case null:
    case '':
      return null;
    default:
      return null;
  }
}

export function startBrowserProcess({ browser = 'chrome', url } = {}) {
  let safeUrl;
  try {
    safeUrl = validateBrowserPilotUrl(url);
  } catch (error) {
    return {
      started: false,
      code: error.code || 'INVALID_URL',
      message: error.message,
    };
  }

  if (process.env.BROWSERPILOT_TEST_NO_SPAWN === '1') {
    return {
      started: false,
      code: 'LAUNCH_DISABLED_BY_TEST_ENV',
      message: 'BROWSERPILOT_TEST_NO_SPAWN=1 set; real browser spawn skipped.',
    };
  }

  const appName = resolveBrowserName(browser);
  let command;
  let args;

  if (process.platform === 'darwin') {
    command = 'open';
    args = appName ? ['-a', appName] : [safeUrl];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', safeUrl];
  } else if (process.platform === 'linux') {
    command = 'xdg-open';
    args = [safeUrl];
  } else {
    return {
      started: false,
      code: 'BROWSER_LAUNCH_FAILED',
      message: `Unsupported platform: ${process.platform}`,
    };
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return {
      started: true,
      platform: process.platform,
      command,
      args,
    };
  } catch (error) {
    return {
      started: false,
      code: 'BROWSER_LAUNCH_FAILED',
      message: error?.message || String(error),
    };
  }
}
