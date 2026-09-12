'use strict';

/**
 * Token-bucket rate limiter, one bucket per API token.
 * capacity  : sustained refill (tokens per second)
 * maxBurst  : extra burst capacity on top of capacity
 */
class RateLimiter {
  constructor({ capacity = 200, refillPerSec = 100, maxBurst = 400 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxBurst = maxBurst;
    this.buckets = new Map(); // key -> { tokens, lastMs }
    this._gcTimer = null;
  }

  /** Try to consume one token. Returns { ok, tokens, resetMs, remaining }. */
  take(key, cost = 1, nowMs = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity + this.maxBurst, lastMs: nowMs };
      this.buckets.set(key, b);
    }
    const elapsedSec = Math.max(0, (nowMs - b.lastMs) / 1000);
    b.tokens = Math.min(this.capacity + this.maxBurst, b.tokens + elapsedSec * this.refillPerSec);
    b.lastMs = nowMs;

    if (b.tokens < cost) {
      const needed = cost - b.tokens;
      return {
        ok: false,
        tokens: b.tokens,
        remaining: Math.max(0, Math.floor(b.tokens)),
        resetMs: (needed / this.refillPerSec) * 1000,
      };
    }
    b.tokens -= cost;
    return {
      ok: true,
      tokens: b.tokens,
      remaining: Math.max(0, Math.floor(b.tokens)),
      resetMs: ((this.capacity + this.maxBurst - b.tokens) / this.refillPerSec) * 1000,
    };
  }

  startGc(intervalMs = 60_000) {
    if (this._gcTimer) return;
    this._gcTimer = setInterval(() => {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, b] of this.buckets) {
        if (b.lastMs < cutoff) this.buckets.delete(k);
      }
    }, intervalMs);
    this._gcTimer.unref();
  }

  stopGc() {
    if (this._gcTimer) { clearInterval(this._gcTimer); this._gcTimer = null; }
  }

  get size() { return this.buckets.size; }
}

module.exports = { RateLimiter };
