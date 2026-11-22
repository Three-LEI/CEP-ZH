// Minimal RFC 6455 WebSocket client for Node 18 (CDP only, ws:// loopback).
// Node 22+ has a global WebSocket; we use it when available.
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function createWebSocket(url) {
  if (typeof WebSocket !== 'undefined') return new WebSocket(url);
  return new MiniWebSocket(url);
}

class MiniWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._buf = Buffer.alloc(0);
    this._headersDone = false;
    this._fragments = [];
    this._closed = false;
    this._connect();
  }

  _connect() {
    let u;
    try { u = new URL(this.url); } catch (e) { this._fail(e); return; }
    if (u.protocol !== 'ws:') { this._fail(new Error('only ws:// supported: ' + this.url)); return; }
    this._host = u.hostname;
    this._port = Number(u.port || 80);
    const path = (u.pathname || '/') + (u.search || '');
    const key = crypto.randomBytes(16).toString('base64');

    this._socket = net.connect({ host: this._host, port: this._port }, () => {
      this._socket.write(
        'GET ' + path + ' HTTP/1.1\r\n' +
        'Host: ' + this._host + ':' + this._port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
    });
    this._socket.on('data', (chunk) => this._onData(chunk));
    this._socket.on('error', (err) => this._fail(err));
    this._socket.on('close', () => this._onClose());
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    if (this.onerror) { try { this.onerror({ error: err, message: String(err && err.message || err) }); } catch (e) {} }
    if (this.onclose) { try { this.onclose({ code: 1006, reason: String(err && err.message || err) }); } catch (e) {} }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    if (this.onclose) { try { this.onclose({ code: 1000, reason: '' }); } catch (e) {} }
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._headersDone) {
      const idx = this._buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this._buf.subarray(0, idx).toString('latin1');
      this._buf = this._buf.subarray(idx + 4);
      if (!/^HTTP\/1\.1 101/i.test(head)) { this._fail(new Error('WebSocket handshake failed: ' + head.split('\r\n')[0])); return; }
      this._headersDone = true;
      this.readyState = 1;
      if (this.onopen) { try { this.onopen({}); } catch (e) {} }
      this.emit('open');
    }
    this._parseFrames();
  }

  _parseFrames() {
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const big = this._buf.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) { this._fail(new Error('frame too large')); return; }
        len = Number(big);
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (this._buf.length < off + 4) return;
        mask = this._buf.subarray(off, off + 4);
        off += 4;
      }
      if (this._buf.length < off + len) return;
      let payload = Buffer.from(this._buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this._buf = this._buf.subarray(off + len);

      if (opcode === 0x8) { this._sendFrame(0x8, Buffer.alloc(0)); this._socket.end(); this._onClose(); return; }
      if (opcode === 0x9) { this._sendFrame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this._fragments.push(payload);
        if (fin) {
          const data = Buffer.concat(this._fragments).toString('utf8');
          this._fragments = [];
          if (this.onmessage) { try { this.onmessage({ data }); } catch (e) {} }
          this.emit('message', { data });
        }
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (!this._socket || this._socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._sendFrame(0x1, payload);
  }

  close() {
    if (this.readyState === 1) {
      try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) {}
      this.readyState = 2;
      try { this._socket.end(); } catch (e) {}
    } else {
      try { this._socket.destroy(); } catch (e) {}
      this._onClose();
    }
  }
}
