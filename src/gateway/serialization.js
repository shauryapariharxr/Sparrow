'use strict';

/**
 * Convert an engine reply into a JSON-safe structure, mirroring Upstash
 * semantics: bulk strings become strings (latin1 round-trip keeps raw bytes
 * recoverable), integers stay numbers, errors become { error: "..." }.
 */
function replyToJson(reply) {
  if (reply === null || reply === undefined) return { result: null };
  if (reply instanceof Buffer || ArrayBuffer.isView(reply)) {
    return { result: binaryToJsonString(reply) };
  }
  if (typeof reply === 'number') return { result: reply };
  if (typeof reply === 'string') return { result: reply };
  if (Array.isArray(reply)) return { result: reply.map(replyToJsonValue) };
  if (typeof reply === 'object' && typeof reply.error === 'string') {
    return { error: reply.error };
  }
  return { result: String(reply) };
}

function replyToJsonValue(reply) {
  if (reply === null || reply === undefined) return null;
  if (reply instanceof Buffer || ArrayBuffer.isView(reply)) return binaryToJsonString(reply);
  if (typeof reply === 'number') return reply;
  if (typeof reply === 'string') return reply;
  if (Array.isArray(reply)) return reply.map(replyToJsonValue);
  if (typeof reply === 'object' && typeof reply.error === 'string') return { error: reply.error };
  return String(reply);
}

/**
 * Encode raw bytes into a JSON string losslessly: printable ASCII passes
 * through, everything else becomes \xNN escapes (what redis-cli shows).
 */
function binaryToJsonString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let out = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c >= 0x20 && c <= 0x7e) {
      const ch = String.fromCharCode(c);
      out += ch;
    } else {
      out += `\\x${c.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

module.exports = { replyToJson, binaryToJsonString };
