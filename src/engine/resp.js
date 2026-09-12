'use strict';

/**
 * RESP (REdis Serialization Protocol) encoder/decoder.
 *
 * Replies are plain JS values:
 *   string            -> Simple String (+OK\r\n)
 *   Buffer            -> Bulk String
 *   number            -> Integer (:123\r\n)
 *   null              -> Null Bulk ($-1\r\n)
 *   Array             -> Array of replies
 *   { error: '...' }  -> Error (-ERR ...\r\n)
 */

function encode(value) {
  const chunks = [];
  _encode(value, chunks);
  return Buffer.concat(chunks);
}

function _encode(value, out) {
  if (value === null || value === undefined) {
    out.push(Buffer.from('$-1\r\n'));
  } else if (value instanceof Buffer) {
    out.push(Buffer.from(`$${value.length}\r\n`));
    out.push(value);
    out.push(Buffer.from('\r\n'));
  } else if (typeof value === 'number') {
    out.push(Buffer.from(`:${Math.trunc(value)}\r\n`));
  } else if (typeof value === 'string') {
    out.push(Buffer.from(`+${value}\r\n`));
  } else if (Array.isArray(value)) {
    out.push(Buffer.from(`*${value.length}\r\n`));
    for (const item of value) _encode(item, out);
  } else if (typeof value === 'object' && typeof value.error === 'string') {
    out.push(Buffer.from(`-${value.error}\r\n`));
  } else {
    // Fallback: stringify
    const s = String(value);
    out.push(Buffer.from(`$${Buffer.byteLength(s)}\r\n${s}\r\n`));
  }
}

/**
 * Incremental RESP array-of-bulk-strings parser.
 * Feed via push(chunk); when a full command is available it is returned
 * (as an array of Buffers) and removed from the internal buffer.
 */
class RespParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Returns an array of Buffers when a complete command is buffered, else null. */
  next() {
    const buf = this.buffer;
    if (buf.length < 2 || buf[0] !== 0x2a) return null; // '*'
    const lineEnd = buf.indexOf('\r\n', 1);
    if (lineEnd === -1) return null;
    const countStr = buf.slice(1, lineEnd).toString('utf8');
    if (!/^\d+$/.test(countStr)) return { error: 'ERR Protocol error: invalid multibulk length' };
    const count = Number.parseInt(countStr, 10);
    if (count > 1024 * 1024) return { error: 'ERR Protocol error: invalid multibulk length' };
    if (count === 0) return [];

    let pos = lineEnd + 2;
    const parts = new Array(count);
    for (let i = 0; i < count; i++) {
      if (pos + 1 >= buf.length || buf[pos] !== 0x24) { // '$'
        return { error: 'ERR Protocol error: expected $, got something else' };
      }
      const lenEnd = buf.indexOf('\r\n', pos + 1);
      if (lenEnd === -1) return null;
      const lenStr = buf.slice(pos + 1, lenEnd).toString('utf8');
      if (!/^[-+]?\d+$/.test(lenStr)) return { error: 'ERR Protocol error: invalid bulk length' };
      const len = Number.parseInt(lenStr, 10);
      if (len < 0 || len > 512 * 1024 * 1024) return { error: 'ERR Protocol error: invalid bulk length' };
      const dataStart = lenEnd + 2;
      if (buf.length < dataStart + len + 2) return null;
      parts[i] = buf.slice(dataStart, dataStart + len);
      pos = dataStart + len + 2;
    }
    this.buffer = buf.slice(pos);
    return parts;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

/** Parse an inline command like "SET foo bar" into argv (naive whitespace split). */
function parseInline(line) {
  return line.toString('utf8').trim().split(/\s+/).filter(Boolean).map((s) => Buffer.from(s, 'utf8'));
}

module.exports = { encode, RespParser, parseInline };
