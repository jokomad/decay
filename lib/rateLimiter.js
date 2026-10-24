/**
 * lib/rateLimiter.js
 * 
 * Strict Bybit API Rate Limiter
 * Bybit Public Limit: 600 requests per 5-second window (~120 req/s).
 * Safe Target: Max 300 requests per 5-second window, concurrency 10.
 */

class BybitRateLimiter {
  constructor(options = {}) {
    this.maxPer5Sec = options.maxPer5Sec || 300; // 50% buffer under 600 limit
    this.windowMs = 5000;
    this.concurrency = options.concurrency || 10;
    this.minIntervalMs = options.minIntervalMs || 25; // ~40 req/sec peak
    
    this.requestTimestamps = [];
    this.activeRequests = 0;
    this.queue = [];
    this.lastRequestTime = 0;
  }

  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.queue.length === 0) return;
    if (this.activeRequests >= this.concurrency) return;

    const now = Date.now();
    // Prune timestamps older than 5000ms
    const windowStart = now - this.windowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < windowStart) {
      this.requestTimestamps.shift();
    }

    // Check 5-second window cap
    if (this.requestTimestamps.length >= this.maxPer5Sec) {
      const waitTime = this.requestTimestamps[0] + this.windowMs - now + 50;
      setTimeout(() => this._processQueue(), Math.max(20, waitTime));
      return;
    }

    // Check minimum interval between requests
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < this.minIntervalMs) {
      setTimeout(() => this._processQueue(), this.minIntervalMs - timeSinceLast);
      return;
    }

    // Dequeue next request
    const nextResolve = this.queue.shift();
    if (!nextResolve) return;

    this.activeRequests++;
    this.lastRequestTime = Date.now();
    this.requestTimestamps.push(this.lastRequestTime);

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.activeRequests--;
        setTimeout(() => this._processQueue(), 5);
      }
    };

    nextResolve(release);
  }

  /**
   * Execute fetch with rate limiting, error catching, and exponential retry on 429
   */
  async fetchWithRetry(url, options = {}, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const release = await this.acquire();
      try {
        const res = await fetch(url, options);
        release();

        if (res.status === 429) {
          console.warn(`[Bybit RateLimiter] ⚠️ Received 429 on ${url}. Backing off...`);
          const delay = attempt * 2000 + Math.random() * 500;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        // Check Bybit retCode 10006 (Too many visits)
        if (data && data.retCode === 10006) {
          console.warn(`[Bybit RateLimiter] ⚠️ retCode 10006 (Too many visits). Backing off...`);
          const delay = attempt * 2500;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        return data;
      } catch (err) {
        release();
        if (attempt === maxRetries) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
}

module.exports = BybitRateLimiter;
