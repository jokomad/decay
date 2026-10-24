/**
 * dailyMaintenance.js
 * 
 * Automated Daily Clean Restart & Database Integrity Maintenance.
 * 
 * Rules:
 * 1. Executes once per day strictly between minute 1 and 14 of the designated hour (default: 04:05 UTC).
 * 2. Guaranteed non-repetition: Persists `lastDailyRestartDate` in DB state ("YYYY-MM-DD") to prevent repeating.
 * 3. Clean Graceful Restart: Closes WebSockets, flushes DB, exits with code 0 for Docker / Northflank supervisor auto-restart.
 * 4. Post-Restart Health Check: Automatically runs complete database audit, cleans corrupted records & backfills missing 15M candles via Bybit REST API.
 */

const EventEmitter = require('events');

class DailyMaintenance extends EventEmitter {
  constructor(options = {}) {
    super();

    this.db = options.db;
    this.timeSync = options.timeSync;
    this.ws = options.ws;
    this.liveWatcher = options.liveWatcher;

    // Default: 04:05 UTC (quietest market hour, strictly between minute 1 and 14)
    this.targetHour = parseInt(process.env.DAILY_RESTART_HOUR, 10) || 4;
    this.targetMinute = parseInt(process.env.DAILY_RESTART_MINUTE, 10) || 5;

    // Safety: ensure minute is strictly between 1 and 14
    if (this.targetMinute < 1 || this.targetMinute > 14) {
      this.targetMinute = 5;
    }

    this.lastDailyRestartDate = null;
    this.lastDailyRestartTime = null;
    this.checkInterval = null;
    this.isRestarting = false;
  }

  /**
   * Initialize Maintenance Engine & Run Post-Boot Database Audit
   */
  async init() {
    console.log(`[DailyMaintenance] 🛡️ Initializing Daily Maintenance Engine...`);

    // 1. Load system state from DB
    const state = await this.db.getSystemState();
    this.lastDailyRestartDate = state.lastDailyRestartDate || null;
    this.lastDailyRestartTime = state.lastDailyRestartTime || null;

    const bybitNow = new Date(this.timeSync.now());
    const todayStr = bybitNow.toISOString().substring(0, 10);

    if (this.lastDailyRestartDate === todayStr) {
      console.log(`[DailyMaintenance] ℹ️ Daily clean restart for today (${todayStr}) was already completed at ${this.lastDailyRestartTime}.`);
    } else {
      console.log(`[DailyMaintenance] 🕒 Next daily clean restart scheduled for ${String(this.targetHour).padStart(2, '0')}:${String(this.targetMinute).padStart(2, '0')} UTC.`);
    }

    // 2. Perform Comprehensive Post-Boot Database Integrity Audit & Pruning
    try {
      await this.db.auditAndRepairDatabase();
      await this.db.pruneDatabase(this.liveWatcher ? this.liveWatcher.activeSafeZoneSymbols : []);
    } catch (err) {
      console.error('[DailyMaintenance] Database audit/pruning error on boot:', err.message);
    }

    // 3. Start minute checker
    this._startScheduler();
  }

  _startScheduler() {
    if (this.checkInterval) clearInterval(this.checkInterval);

    // Check once every 30 seconds
    this.checkInterval = setInterval(() => {
      this.checkScheduledRestart();
    }, 30000);
  }

  /**
   * Check if current time falls inside the daily restart window
   */
  async checkScheduledRestart() {
    if (this.isRestarting) return;

    const bybitNow = new Date(this.timeSync.now());
    const hour = bybitNow.getUTCHours();
    const minute = bybitNow.getUTCMinutes();
    const todayStr = bybitNow.toISOString().substring(0, 10);

    // Rule: Must be within designated hour, between minute 1 and 14, and NOT already completed today
    const isTargetHour = (hour === this.targetHour);
    const isSafeWindow = (minute >= 1 && minute <= 14);
    const isMinuteReached = (minute >= this.targetMinute);
    const notCompletedToday = (this.lastDailyRestartDate !== todayStr);

    if (isTargetHour && isSafeWindow && isMinuteReached && notCompletedToday) {
      console.log(`\n================================================================`);
      console.log(`  [DailyMaintenance] 🧹 DAILY CLEAN RESTART WINDOW REACHED (${hour}:${minute} UTC)`);
      console.log(`  Target: ${String(this.targetHour).padStart(2, '0')}:${String(this.targetMinute).padStart(2, '0')} UTC | Date: ${todayStr}`);
      console.log(`================================================================`);

      await this.performDailyRestart(todayStr);
    }
  }

  /**
   * Execute Graceful Clean Restart
   */
  async performDailyRestart(todayStr) {
    this.isRestarting = true;

    // 1. Mark completed today in DB immediately to prevent duplicate triggers
    this.lastDailyRestartDate = todayStr;
    const nowIso = new Date(this.timeSync.now()).toISOString();
    this.lastDailyRestartTime = nowIso;

    await this.db.saveSystemState({
      lastDailyRestartDate: todayStr,
      lastDailyRestartTime: nowIso,
      lastRestartTrigger: 'scheduled_daily_clean'
    });

    console.log(`[DailyMaintenance] 💾 Persisted daily restart record in DB: date=${todayStr}`);

    // 2. Perform database retention pruning before restart
    try {
      await this.db.pruneDatabase(this.liveWatcher ? this.liveWatcher.activeSafeZoneSymbols : []);
    } catch (e) {
      console.error('[DailyMaintenance] Pruning error before restart:', e.message);
    }

    // 3. Close active WebSocket connections cleanly
    if (this.ws) {
      console.log(`[DailyMaintenance] 🔌 Closing WebSocket connections gracefully...`);
      this.ws.close();
    }

    // 4. Emit event for any external listeners
    this.emit('restarting', { date: todayStr, time: nowIso });

    // 5. Trigger process exit with code 0 (Northflank/Docker/Launcher auto-restarts clean process)
    console.log(`[DailyMaintenance] 🔄 Initiating clean exit (code 0) in 2 seconds... Northflank will cleanly restart fresh container.\n`);

    setTimeout(() => {
      process.exit(0);
    }, 2000);
  }

  /**
   * Get Maintenance Status
   */
  getStatus() {
    const bybitNow = new Date(this.timeSync.now());
    const todayStr = bybitNow.toISOString().substring(0, 10);
    const isDoneToday = (this.lastDailyRestartDate === todayStr);

    return {
      scheduledHourUtc: this.targetHour,
      scheduledMinuteUtc: this.targetMinute,
      windowDescription: `Between :01 and :14 at ${String(this.targetHour).padStart(2, '0')}:${String(this.targetMinute).padStart(2, '0')} UTC`,
      lastDailyRestartDate: this.lastDailyRestartDate,
      lastDailyRestartTime: this.lastDailyRestartTime,
      isCompletedToday: isDoneToday,
      nextScheduledWindow: isDoneToday ? `Tomorrow at ${String(this.targetHour).padStart(2, '0')}:${String(this.targetMinute).padStart(2, '0')} UTC` : `Today at ${String(this.targetHour).padStart(2, '0')}:${String(this.targetMinute).padStart(2, '0')} UTC`
    };
  }
}

module.exports = DailyMaintenance;
