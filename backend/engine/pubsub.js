'use strict';

/**
 * Per-database pub/sub hub. Subscribe returns an unsubscribe() function.
 * This is intentionally tiny: fanout is synchronous in-process.
 */
class PubSub {
  constructor() {
    this.channels = new Map(); // channel -> Set<subscriberFn>
    this.pmonitor = new Set(); // psubscribe subscribers: fn(pattern, channel, message)
  }

  subscribe(channel, fn) {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(fn);
    return () => {
      const s = this.channels.get(channel);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this.channels.delete(channel);
      }
    };
  }

  psubscribe(pattern, fn) {
    const entry = { pattern: globToRegex(pattern), fn };
    this.pmonitor.add(entry);
    return () => this.pmonitor.delete(entry);
  }

  publish(channel, message) {
    let delivered = 0;
    const set = this.channels.get(channel);
    if (set) {
      for (const fn of set) {
        try { fn(channel, message); delivered++; } catch { /* subscriber died */ }
      }
    }
    for (const entry of this.pmonitor) {
      if (entry.pattern.test(channel)) {
        try { entry.fn(channel, channel, message); delivered++; } catch { /* ignore */ }
      }
    }
    return delivered;
  }

  clear() {
    this.channels.clear();
    this.pmonitor.clear();
  }
}

function globToRegex(pattern) {
  const out = [];
  const plain = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; if (i < pattern.length) out.push(plain(pattern[i])); }
    else if (ch === '*') out.push('.*');
    else if (ch === '?') out.push('.');
    else out.push(plain(ch));
  }
  return new RegExp('^' + out.join('') + '$');
}

module.exports = { PubSub };
