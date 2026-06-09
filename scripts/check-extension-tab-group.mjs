#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BrowserPilot MCP surfaces its native-host connection state as a colored
// Chrome Tab Group on the active tab. This script enforces the structural
// wiring that makes that visual indicator reliable across browsers.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backgroundPath = path.join(root, 'extension/background.js');
const contentPath = path.join(root, 'extension/content.js');
const manifestPath = path.join(root, 'extension/manifest.json');

const background = fs.readFileSync(backgroundPath, 'utf8');
const content = fs.readFileSync(contentPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// --- content.js: must be free of border / setBorderStatus surface ---
const contentBanned = [
  /applyBorderStatus/,
  /setBorderStatus/,
  /BORDER_ELEMENT_ID/,
  /browserpilot-mcp-border/
];
for (const pattern of contentBanned) {
  assert.doesNotMatch(
    content,
    pattern,
    `content.js must not contain legacy border code matching ${pattern}`
  );
}

// --- background.js: must implement applyTabGroupState ---
assert.match(
  background,
  /function\s+applyTabGroupState\s*\(/,
  'background.js must define applyTabGroupState(status) helper'
);

// --- background.js: must call the right Tab Groups APIs ---
assert.match(
  background,
  /chrome\.tabs\.group\s*\(/,
  'background.js must call chrome.tabs.group to create a tab group'
);
assert.match(
  background,
  /chrome\.tabGroups\.update\s*\(/,
  'background.js must call chrome.tabGroups.update to color/title the group'
);
assert.match(
  background,
  /chrome\.tabs\.ungroup\s*\(/,
  'background.js must call chrome.tabs.ungroup to clear the marker on disconnect'
);

// --- background.js: must carry the state strings used by the marker ---
const requiredStates = ['connected', 'connecting', 'disconnected'];
for (const state of requiredStates) {
  assert.match(
    background,
    new RegExp(`['"\`]${state}['"\`]`),
    `background.js must reference status string "${state}"`
  );
}

// --- background.js: must declare TAB_GROUP_COLORS / TAB_GROUP_TITLES maps ---
assert.match(
  background,
  /TAB_GROUP_COLORS/,
  'background.js must declare TAB_GROUP_COLORS mapping'
);
assert.match(
  background,
  /TAB_GROUP_TITLES/,
  'background.js must declare TAB_GROUP_TITLES mapping'
);

// --- background.js: must call applyTabGroupState from updateActionState ---
assert.match(
  background,
  /applyTabGroupState\s*\(\s*status\s*\)/,
  'updateActionState must delegate the visual marker to applyTabGroupState(status)'
);

// --- background.js: must guard tabGroups calls against missing APIs ---
assert.match(
  background,
  /chrome\.tabGroups/,
  'background.js must feature-detect chrome.tabGroups before calling it'
);

// --- background.js: must have a grey fallback when the color is unsupported ---
assert.match(
  background,
  /['"`]grey['"`]/,
  'background.js must fall back to grey when the requested color is unsupported'
);

// --- background.js: must swallow lastError to avoid noisy disconnect logs ---
assert.match(
  background,
  /chrome\.runtime\.lastError/,
  'background.js must read chrome.runtime.lastError to swallow benign failures'
);

// --- manifest.json: must declare the tabGroups permission ---
const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
assert.ok(
  permissions.includes('tabGroups'),
  'manifest.json must declare the "tabGroups" permission'
);

console.log('extension tab group checks passed');