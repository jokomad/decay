/**
 * timeSync.js
 * 
 * Bybit Server Time Synchronization & Precision Real-Time Clock Scheduler.
 * Synchronizes local system clock with Bybit server time to guarantee exact
 * execution at :00:03, :15:03, :30:03, :45:03 (3 seconds after 15M candle close).
 */

class TimeSync {
  constructor() {
    this.serverOffsetMs = 0;
    this.lastSyncTime = 0;
    this.scheduledTimer = null;
    this.isSyncing = false;
  }

  /**
   * Synchronize with Bybit Server Time via REST API
   */
  async sync() {
    try {
      this.isSyncing = true;
      const t0 = Date.now();
      const res = await fetch('https://api.bybit.com/v5/market/time');
      const t1 = Date.now();
      const data = await res.json();

      if (data.retCode === 0 && data.time) {
        const serverTime = Number(data.time);
        // Estimate round-trip latency (half RTT adjustment)
        const halfRtt = Math.round((t1 - t0) / 2);
        this.serverOffsetMs = serverTime - (t1 - halfRtt);
        this.lastSyncTime = Date.now();

        console.log(`[TimeSync] 🕒 Synchronized with Bybit server time! Offset: ${this.serverOffsetMs}ms (RTT: ${t1 - t0}ms) | Bybit UTC: ${this.getIsoTime()}`);
        return true;
      }
    } catch (err) {
      console.warn(`[TimeSync] ⚠️ Time sync failed (${err.message}). Using local system clock.`);
    } finally {
      this.isSyncing = false;
    }
    return false;
  }

  /**
   * Get current timestamp in Bybit server time
   */
  now() {
    return Date.now() + this.serverOffsetMs;
  }

  /**
   * Get current Bybit server time as ISO string
   */
  getIsoTime() {
    return new Date(this.now()).toISOString();
  }

  /**
   * Get human-readable UTC time string (HH:MM:SS)
   */
  getFormattedTime() {
    const d = new Date(this.now());
    return d.toISOString().substring(11, 19);
  }

  /**
   * Calculate next Signal Evaluation trigger (:01:03, :16:03, :31:03, :46:03)
   * Exactly on the next minute after the confirmed 15M candle has closed.
   */
  getNext15mTrigger(afterSeconds = 3) {
    const bybitNow = this.now();
    const d = new Date(bybitNow);
    const checkMinutes = [1, 16, 31, 46];

    for (let offsetHour = 0; offsetHour <= 2; offsetHour++) {
      for (const m of checkMinutes) {
        const candidate = new Date(d);
        candidate.setUTCHours(d.getUTCHours() + offsetHour, m, afterSeconds, 0);
        if (candidate.getTime() > bybitNow) {
          const delayMs = Math.max(100, candidate.getTime() - bybitNow);
          return {
            targetTimestamp: candidate.getTime(),
            delayMs,
            targetTimeFormatted: candidate.toISOString().substring(11, 19) + ' UTC',
            secondsRemaining: Math.round(delayMs / 1000)
          };
        }
      }
    }

    // Fallback if loop completes
    const fallbackMs = bybitNow + 15 * 60 * 1000;
    return {
      targetTimestamp: fallbackMs,
      delayMs: 15 * 60 * 1000,
      targetTimeFormatted: new Date(fallbackMs).toISOString().substring(11, 19) + ' UTC',
      secondsRemaining: 900
    };
  }

  /**
   * Schedule precision callback targeting exact :01:03, :16:03, :31:03, :46:03
   */
  scheduleNext(callback, afterSeconds = 3) {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }

    const next = this.getNext15mTrigger(afterSeconds);
    console.log(`[TimeSync] ⏱️ Next signal cycle scheduled for ${next.targetTimeFormatted} (in ${next.secondsRemaining}s).`);

    this.scheduledTimer = setTimeout(async () => {
      // Re-sync server time immediately prior to cycle execution
      await this.sync();
      try {
        callback();
      } catch (err) {
        console.error('[TimeSync] Error in scheduled cycle execution:', err);
      }
    }, next.delayMs);

    return next;
  }

  /**
   * Get synchronization status
   */
  getStatus() {
    const next = this.getNext15mTrigger(3);
    return {
      serverOffsetMs: this.serverOffsetMs,
      lastSyncTime: this.lastSyncTime ? new Date(this.lastSyncTime).toISOString() : null,
      bybitTimeIso: this.getIsoTime(),
      bybitTimeFormatted: this.getFormattedTime() + ' UTC',
      nextTriggerTime: next.targetTimeFormatted,
      secondsRemaining: next.secondsRemaining
    };
  }
}

module.exports = TimeSync;
