import { TextDecoder } from 'node:util';

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'number' || (typeof value === 'string' && value.length > 0);
}

export function validateNativeMessage(message) {
  if (!isPlainObject(message)) return { ok: false, error: 'Native message must be an object' };
  if (message.protocol === 'browserpilot.daemon' || typeof message.type === 'string') {
    return { ok: false, error: 'Daemon protocol messages are not valid Native Messaging legacy messages' };
  }
  if (!validId(message.id)) return { ok: false, error: 'Native message id is required' };

  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
  const isRequest = typeof message.method === 'string' && message.method.length > 0 && (message.params === undefined || isPlainObject(message.params));
  const isResponse = hasResult !== hasError;
  if (!isRequest && !isResponse) return { ok: false, error: 'Native message must be a request or response' };
  if (isRequest && (hasResult || hasError)) return { ok: false, error: 'Native message cannot be both request and response' };
  if (hasResult && hasError) return { ok: false, error: 'Native response must include exactly one of result or error' };
  return { ok: true };
}

export function encodeNativeMessage(message) {
  const validation = validateNativeMessage(message);
  if (!validation.ok) throw new Error(validation.error);
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export function decodeNativeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error(`Native message length ${length} exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
    if (buffer.length - offset < 4 + length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    let parsed;
    try {
      parsed = JSON.parse(utf8Decoder.decode(payload));
    } catch (error) {
      throw new Error(`Invalid native message JSON: ${error.message}`);
    }
    const validation = validateNativeMessage(parsed);
    if (!validation.ok) throw new Error(validation.error);
    messages.push(parsed);
    offset += 4 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
}
