#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The orange page-border visual indicator has been retired in favour of a
// colored Chrome Tab Group applied by the background service worker. This
// script enforces that the legacy border code is fully gone from
// content.js / background.js so we don't accidentally regress to injecting
// a DOM overlay.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backgroundPath = path.join(root, 'extension/background.js');
const contentPath = path.join(root, 'extension/content.js');

const background = fs.readFileSync(backgroundPath, 'utf8');
const content = fs.readFileSync(contentPath, 'utf8');

// --- content.js: must NOT contain any border-related code ---
const contentBanned = [
  /applyBorderStatus/,
  /setBorderStatus/,
  /BORDER_ELEMENT_ID/,
  /BORDER_COLOR/,
  /BORDER_WIDTH/,
  /browserpilot-mcp-border/,
  /ensureBorderElement/,
  /getBorderElement/
];
for (const pattern of contentBanned) {
  assert.doesNotMatch(
    content,
    pattern,
    `content.js must no longer reference ${pattern}; legacy border code should be deleted`
  );
}

// --- background.js: must NOT contain any border-related code ---
const backgroundBanned = [
  /broadcastBorderStatus/,
  /setBorderStatus/,
  /BORDER_COLOR/,
  /#ff8800/i,
  /browserpilot-mcp-border/
];
for (const pattern of backgroundBanned) {
  assert.doesNotMatch(
    background,
    pattern,
    `background.js must no longer reference ${pattern}; legacy border code should be deleted`
  );
}

// --- background.js: must NOT inject setBorderStatus messages into tabs ---
assert.doesNotMatch(
  background,
  /chrome\.tabs\.sendMessage[^)]*setBorderStatus/,
  'background.js must no longer send setBorderStatus to content scripts'
);

console.log('extension page border removal checks passed');