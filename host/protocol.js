import { TextDecoder } from 'node:util';

export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_PORT = Number.parseInt(process.env.BROWSERPILOT_DAEMON_PORT || '18765', 10);
export const DEFAULT_DAEMON_HOST = '127.0.0.1';
export const DEFAULT_DAEMON_PORT = 18765;
export const PROTOCOL_NAME = 'browserpilot.daemon';
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const ROLES = new Set(['mcp_adapter', 'native_host', 'admin']);
const TYPES = new Set(['hello', 'hello_ack', 'tool.call', 'tool.result', 'tool.error', 'status', 'shutdown']);
const STATUS_SCOPES = new Set(['summary', 'clients', 'health']);
const SHUTDOWN_MODES = new Set(['graceful']);

export function protocolError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value) {
  return Number.isInteger(value);
}

function isIsoString(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function baseMessage(type, id) {
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type,
    id,
  };
}

export function makeHello({ id, role, name, pid = process.pid, capabilities, authToken }) {
  return { ...baseMessage('hello', id), role, name, pid, capabilities, authToken };
}

export function makeHelloAck({ id, clientId, daemon }) {
  return { ...baseMessage('hello_ack', id), clientId, daemon };
}

export function makeToolCall({ id, toolName, toolArguments = {}, timestamp = new Date().toISOString() }) {
  return { ...baseMessage('tool.call', id), toolName, toolArguments, timestamp };
}

export function makeToolResult({ id, result = {}, timestamp = new Date().toISOString() }) {
  return { ...baseMessage('tool.result', id), result, timestamp };
}

export function makeToolError({ id, code, message, details = undefined, timestamp = new Date().toISOString() }) {
  return {
    ...baseMessage('tool.error', id),
    error: details ? { code, message, details } : { code, message },
    timestamp,
  };
}

export function makeStatusRequest({ id, scope = 'summary' }) {
  return { ...baseMessage('status', id), scope };
}

export function makeShutdownRequest({ id, mode = 'graceful' }) {
  return { ...baseMessage('shutdown', id), mode };
}

export function makeStatusResponse({ id, daemon, clients, health, timestamp = new Date().toISOString() }) {
  return { ...baseMessage('status', id), daemon, clients, health, timestamp };
}

export function makeShutdownAck({ id, accepted, timestamp = new Date().toISOString() }) {
  return { ...baseMessage('shutdown', id), accepted, timestamp };
}

function fail(code, message, details) {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function requireFields(message, fields) {
  for (const [field, predicate] of fields) {
    if (!predicate(message[field])) {
      return `${field} is required or invalid`;
    }
  }
  return null;
}

function validateCapabilities(role, capabilities) {
  if (!isPlainObject(capabilities)) return false;
  if (role === 'mcp_adapter') return capabilities.tools === true;
  if (role === 'native_host') return capabilities.extensionBridge === true;
  if (role === 'admin') return capabilities.status === true && capabilities.shutdown === true;
  return false;
}

function validateDaemonInfo(value) {
  return isPlainObject(value)
    && isInteger(value.pid)
    && value.host === DEFAULT_DAEMON_HOST
    && isInteger(value.port)
    && isIsoString(value.startedAt);
}

function validateClients(value) {
  return isPlainObject(value)
    && isInteger(value.mcpAdapters)
    && isInteger(value.nativeHosts)
    && isInteger(value.admins)
    && (value.activeNativeHostClientId === null || isNonEmptyString(value.activeNativeHostClientId));
}

function validateHealth(value) {
  return isPlainObject(value)
    && typeof value.ready === 'boolean'
    && typeof value.acceptingToolCalls === 'boolean'
    && (value.lastError === null || isPlainObject(value.lastError));
}

export function validateMessage(message, context = {}) {
  if (!isPlainObject(message)) return fail('PROTOCOL_SCHEMA_INVALID', 'Message must be a JSON object');
  if (message.protocol !== PROTOCOL_NAME || message.version !== PROTOCOL_VERSION) {
    return fail('PROTOCOL_VERSION_UNSUPPORTED', 'Unsupported daemon protocol or version');
  }
  if (!TYPES.has(message.type)) return fail('PROTOCOL_SCHEMA_INVALID', 'Unsupported message type');
  const baseMissing = requireFields(message, [['type', isNonEmptyString]]);
  if (baseMissing) return fail('PROTOCOL_SCHEMA_INVALID', baseMissing);

  switch (message.type) {
    case 'hello': {
      const missing = requireFields(message, [
        ['id', isNonEmptyString], ['role', (v) => ROLES.has(v)], ['name', isNonEmptyString],
        ['pid', isInteger], ['capabilities', (v) => validateCapabilities(message.role, v)], ['authToken', isNonEmptyString],
      ]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    case 'hello_ack': {
      const missing = requireFields(message, [
        ['id', isNonEmptyString], ['clientId', isNonEmptyString], ['daemon', validateDaemonInfo],
      ]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    case 'tool.call': {
      if (context.role && context.role !== 'mcp_adapter') {
        return fail('ROLE_NOT_AUTHORIZED', 'Only mcp_adapter clients may send tool.call');
      }
      const missing = requireFields(message, [
        ['id', isNonEmptyString], ['toolName', isNonEmptyString], ['toolArguments', isPlainObject], ['timestamp', isIsoString],
      ]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    case 'tool.result': {
      const missing = requireFields(message, [
        ['id', isNonEmptyString], ['result', isPlainObject], ['timestamp', isIsoString],
      ]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    case 'tool.error': {
      const missing = requireFields(message, [
        ['id', isNonEmptyString], ['error', (v) => isPlainObject(v) && isNonEmptyString(v.code) && isNonEmptyString(v.message)], ['timestamp', isIsoString],
      ]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    case 'status': {
      if (context.role && context.role !== 'admin') return fail('ROLE_NOT_AUTHORIZED', 'Only admin clients may request status');
      if ('scope' in message) {
        const missing = requireFields(message, [['id', isNonEmptyString], ['scope', (v) => STATUS_SCOPES.has(v)]]);
        return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
      }
      const missing = requireFields(message, [
        ['id', isNonEmptyString], ['daemon', validateDaemonInfo], ['clients', validateClients], ['health', validateHealth], ['timestamp', isIsoString],
      ]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    case 'shutdown': {
      if (context.role && context.role !== 'admin') return fail('ROLE_NOT_AUTHORIZED', 'Only admin clients may request shutdown');
      if ('mode' in message) {
        const missing = requireFields(message, [['id', isNonEmptyString], ['mode', (v) => SHUTDOWN_MODES.has(v)]]);
        return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
      }
      const missing = requireFields(message, [['id', isNonEmptyString], ['accepted', (v) => typeof v === 'boolean'], ['timestamp', isIsoString]]);
      return missing ? fail('PROTOCOL_SCHEMA_INVALID', missing) : { ok: true };
    }
    default:
      return fail('PROTOCOL_SCHEMA_INVALID', 'Unsupported message type');
  }
}

export function encodeFrame(message) {
  const validation = validateMessage(message);
  if (!validation.ok) throw protocolError(validation.error.code, validation.error.message, validation.error.details);
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw protocolError('PROTOCOL_SCHEMA_INVALID', `Frame payload exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_FRAME_BYTES) {
      throw protocolError('PROTOCOL_SCHEMA_INVALID', `Frame payload length ${length} exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`);
    }
    if (buffer.length - offset < 4 + length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    let text;
    try {
      text = utf8Decoder.decode(payload);
    } catch {
      throw protocolError('PROTOCOL_SCHEMA_INVALID', 'Invalid UTF-8 frame payload');
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      throw protocolError('PROTOCOL_SCHEMA_INVALID', `Invalid JSON frame payload: ${error.message}`);
    }
    const validation = validateMessage(message);
    if (!validation.ok) throw protocolError(validation.error.code, validation.error.message, validation.error.details);
    messages.push(message);
    offset += 4 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

export function sendFrame(socket, message) {
  socket.write(encodeFrame(message));
}
