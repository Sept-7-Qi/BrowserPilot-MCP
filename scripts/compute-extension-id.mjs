#!/usr/bin/env node
/**
 * Compute a fixed Chrome Extension ID from a PEM private key.
 *
 * Chrome derives the extension ID as the first 128 bits of the SHA-256 hash
 * of the public key (SPKI/DER format), encoded with a-p alphabet.
 *
 * Usage:
 *   node scripts/compute-extension-id.mjs <path-to.pem>
 */

import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const pemPath = process.argv[2];

if (!pemPath) {
  console.error('Usage: node compute-extension-id.mjs <path-to.pem>');
  process.exit(1);
}

const pem = readFileSync(pemPath);
const pubKey = createPublicKey(pem).export({ type: 'spki', format: 'der' });
const hash = createHash('sha256').update(pubKey).digest();

const hex = hash.subarray(0, 16).toString('hex');

// Map hex digits to a-p: 0-9 → a-j, a-f → k-p
const id = hex
  .split('')
  .map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) {
      // 0-9 → a-j (add 49)
      return String.fromCharCode(code + 49);
    }
    // a-f → k-p (add 10)
    return String.fromCharCode(code + 10);
  })
  .join('');

console.log(id);
