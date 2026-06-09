#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  encodeFrame,
  decodeFrames,
  protocolError,
} from '../host/protocol.js';

const hello = {
  protocol: PROTOCOL_NAME,
  version: PROTOCOL_VERSION,
  type: 'hello',
  id: 'hello-1',
  role: 'admin',
  name: 'framing-check',
  pid: process.pid,
  capabilities: { status: true, shutdown: true },
  authToken: 'test-token-for-framing',
};

const encoded = encodeFrame(hello);
const expectedLength = Buffer.byteLength(JSON.stringify(hello), 'utf8');
assert.equal(encoded.readUInt32LE(0), expectedLength, 'frame length prefix must be 4-byte little-endian JSON byte length');
assert.deepEqual(JSON.parse(encoded.subarray(4).toString('utf8')), hello, 'frame payload must be JSON message');

let decoded = decodeFrames(encoded.subarray(0, 3));
assert.deepEqual(decoded.messages, [], 'fragment smaller than prefix must not decode a message');
assert.equal(decoded.remaining.length, 3, 'fragment smaller than prefix must remain buffered');

decoded = decodeFrames(Buffer.concat([decoded.remaining, encoded.subarray(3, 9)]));
assert.deepEqual(decoded.messages, [], 'partial payload must not decode a message');
assert.equal(decoded.remaining.length, 9, 'partial payload must remain buffered');

decoded = decodeFrames(Buffer.concat([decoded.remaining, encoded.subarray(9)]));
assert.equal(decoded.messages.length, 1, 'complete fragmented frame must decode exactly one message');
assert.deepEqual(decoded.messages[0], hello);
assert.equal(decoded.remaining.length, 0);

const second = { ...hello, id: 'hello-2' };
decoded = decodeFrames(Buffer.concat([encodeFrame(hello), encodeFrame(second)]));
assert.deepEqual(decoded.messages.map((m) => m.id), ['hello-1', 'hello-2'], 'multiple frames in one chunk must decode in order');
assert.equal(decoded.remaining.length, 0);

assert.throws(() => decodeFrames(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('{')])), (error) => {
  return error && error.code === 'PROTOCOL_SCHEMA_INVALID' && /Invalid JSON/.test(error.message);
}, 'invalid JSON must throw structured protocol failure');

const oversize = Buffer.alloc(4);
oversize.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
assert.throws(() => decodeFrames(oversize), (error) => {
  return error && error.code === 'PROTOCOL_SCHEMA_INVALID' && /exceeds/.test(error.message);
}, 'oversized frame must throw structured protocol failure');

const err = protocolError('PROTOCOL_SCHEMA_INVALID', 'example');
assert.equal(err.code, 'PROTOCOL_SCHEMA_INVALID');
assert.equal(err.message, 'example');

console.log('daemon framing checks passed');
