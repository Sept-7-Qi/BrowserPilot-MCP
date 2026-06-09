import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  DAEMON_HOST,
  DAEMON_PORT,
  decodeFrames,
  makeHello,
  sendFrame,
  validateMessage,
} from './protocol.js';
import { readExistingAuthToken, readOrCreateAuthToken } from './auth-token.js';

export function generateRequestId(prefix = 'req') {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class DaemonClient extends EventEmitter {
  constructor({ role, name, capabilities, host = DAEMON_HOST, port = DAEMON_PORT, timeoutMs = 3000, authToken = undefined, createAuthToken = true }) {
    super();
    this.role = role;
    this.name = name;
    this.capabilities = capabilities;
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('BrowserPilot daemon clients may only connect to loopback');
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.authToken = authToken ?? (createAuthToken ? readOrCreateAuthToken() : readExistingAuthToken());
    this.socket = null;
    this.clientId = null;
    this.daemon = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed && this.clientId) return this;
    this.closed = false;
    this.socket = net.connect({ host: this.host, port: this.port });
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (error) => this.handleError(error));
    this.socket.on('close', () => this.handleClose());

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to daemon at ${this.host}:${this.port}`)), this.timeoutMs);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const hello = makeHello({
      id: generateRequestId('hello'),
      role: this.role,
      name: this.name,
      capabilities: this.capabilities,
      authToken: this.authToken,
    });
    const ack = await this.request(hello, { timeoutMs: this.timeoutMs, expectedType: 'hello_ack' });
    this.clientId = ack.clientId;
    this.daemon = ack.daemon;
    this.emit('ready', ack);
    return this;
  }

  handleData(chunk) {
    try {
      const decoded = decodeFrames(Buffer.concat([this.buffer, chunk]));
      this.buffer = decoded.remaining;
      for (const message of decoded.messages) this.handleMessage(message);
    } catch (error) {
      this.emit('protocolError', error);
      this.close();
    }
  }

  handleMessage(message) {
    const pending = message.id ? this.pending.get(message.id) : null;
    if (pending && (!pending.expectedType || pending.expectedType === message.type)) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    this.emit('message', message);
    this.emit(message.type, message);
  }

  handleError(error) {
    this.emit('connectionError', error);
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  handleClose() {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Daemon connection closed while waiting for ${id}`));
    }
    this.pending.clear();
    this.emit('close');
  }

  send(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Daemon client is not connected');
    const validation = validateMessage(message, { role: this.role });
    if (!validation.ok) throw new Error(`${validation.error.code}: ${validation.error.message}`);
    sendFrame(this.socket, message);
  }

  request(message, { timeoutMs = 60000, expectedType } = {}) {
    if (!message.id) throw new Error('Request message must include id');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`Timed out waiting for daemon response to ${message.id}`));
      }, timeoutMs);
      this.pending.set(message.id, { resolve, reject, timer, expectedType });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}

export async function connectDaemonClient(options) {
  const client = new DaemonClient(options);
  await client.connect();
  return client;
}
