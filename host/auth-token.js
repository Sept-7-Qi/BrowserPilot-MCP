import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_FILE = 'daemon-token';

export function tokenDirectory() {
  return process.env.BROWSERPILOT_AUTH_TOKEN_DIR || path.join(os.homedir(), '.browserpilot-mcp');
}

export function tokenPath() {
  return path.join(tokenDirectory(), TOKEN_FILE);
}

export function readExistingAuthToken() {
  const existing = fs.readFileSync(tokenPath(), 'utf8').trim();
  if (existing.length < 32) throw new Error('Existing BrowserPilot daemon auth token is invalid or too short');
  return existing;
}

export function readOrCreateAuthToken() {
  const dir = tokenDirectory();
  const file = tokenPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    fs.chmodSync(file, 0o600);
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'w' });
  fs.chmodSync(file, 0o600);
  return token;
}

export function constantTimeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    const padded = Buffer.alloc(expectedBuffer.length || 1);
    crypto.timingSafeEqual(padded, Buffer.alloc(padded.length));
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
