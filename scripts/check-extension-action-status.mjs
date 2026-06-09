#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backgroundPath = path.join(root, 'extension/background.js');
const source = fs.readFileSync(backgroundPath, 'utf8');

// 1. Must contain an updateActionState helper or function with a clear name.
assert.match(
  source,
  /function\s+updateActionState\s*\(/,
  'background.js must define updateActionState(status) helper'
);

// 2. Must call chrome.action.setBadgeText to render state badge.
assert.match(
  source,
  /chrome\.action\.setBadgeText\s*\(/,
  'background.js must call chrome.action.setBadgeText'
);

// 3. Must call chrome.action.setBadgeBackgroundColor for color signal.
assert.match(
  source,
  /chrome\.action\.setBadgeBackgroundColor\s*\(/,
  'background.js must call chrome.action.setBadgeBackgroundColor'
);

// 4. Must call chrome.action.setTitle to update tooltip text.
assert.match(
  source,
  /chrome\.action\.setTitle\s*\(/,
  'background.js must call chrome.action.setTitle'
);

// 5. State strings must be present in source: connected / connecting / disconnected.
const requiredStates = ['connected', 'connecting', 'disconnected'];
for (const state of requiredStates) {
  assert.match(
    source,
    new RegExp(`['"\`]${state}['"\`]`),
    `background.js must reference status string "${state}"`
  );
}

// 6. Required title fragments (Chinese) must appear at least once.
const requiredTitles = ['已连接', '连接中', '未连接'];
for (const fragment of requiredTitles) {
  assert.match(
    source,
    new RegExp(fragment),
    `background.js must include title fragment "${fragment}"`
  );
}

// 7. updateActionState must be called from at least one trigger site
//    (connectNative / onDisconnect / nativeStatus='connecting' / health_check).
assert.match(
  source,
  /updateActionState\s*\(\s*['"`]?(connected|connecting|disconnected)['"`]?\s*\)/,
  'background.js must invoke updateActionState at least once with a status arg'
);

console.log('extension action status checks passed');