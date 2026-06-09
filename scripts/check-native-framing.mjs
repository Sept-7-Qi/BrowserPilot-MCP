#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  encodeNativeMessage,
  decodeNativeMessages,
  validateNativeMessage,
  MAX_NATIVE_MESSAGE_BYTES,
} from '../host/native-frame.js';

const request = { id: 7, method: 'list_pages', params: {} };
const response = { id: 7, result: { pages: [] } };
const errorResponse = { id: 8, error: { message: 'failed' } };

for (const message of [request, response, errorResponse]) {
  assert.equal(validateNativeMessage(message).ok, true, `${JSON.stringify(message)} must be a valid native message`);
}
assert.equal(validateNativeMessage({ id: 1, type: 'tool.call', protocol: 'browserpilot.daemon' }).ok, false, 'daemon protocol messages must not be accepted as native legacy messages');
assert.equal(validateNativeMessage({ method: 'missing id' }).ok, false, 'native message id is required');
assert.equal(validateNativeMessage({ id: 9, result: {}, error: { message: 'ambiguous' } }).ok, false, 'native legacy response must not include both result and error');

const encoded = encodeNativeMessage(request);
assert.equal(encoded.readUInt32LE(0), Buffer.byteLength(JSON.stringify(request), 'utf8'), 'native frame prefix must be 4-byte little-endian JSON byte length');
assert.deepEqual(JSON.parse(encoded.subarray(4).toString('utf8')), request);

let decoded = decodeNativeMessages(encoded.subarray(0, 2));
assert.equal(decoded.messages.length, 0, 'fragmented native prefix must remain buffered');
assert.equal(decoded.remaining.length, 2);
decoded = decodeNativeMessages(Buffer.concat([decoded.remaining, encoded.subarray(2)]));
assert.deepEqual(decoded.messages, [request], 'fragmented native frame must decode');
assert.equal(decoded.remaining.length, 0);

decoded = decodeNativeMessages(Buffer.concat([encodeNativeMessage(request), encodeNativeMessage(response)]));
assert.deepEqual(decoded.messages, [request, response], 'multiple native frames in one chunk must decode in order');

const oversized = Buffer.alloc(4);
oversized.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
assert.throws(() => decodeNativeMessages(oversized), /exceeds/, 'oversized native messages must be rejected');

console.log('native framing checks passed');
