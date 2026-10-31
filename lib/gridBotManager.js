/**
 * gridBotManager.js
 * 
 * Production Bybit Futures Short Grid Bot Manager.
 * 
 * Rules:
 * 1. Launches Short Grid Bots upon verified entry signal:
 *    - Short Direction: grid_mode = 3, direction = 2
 *    - Leverage: 2.0x (Cross)
 *    - Grids Count: 40 (cell_number = 40)
 *    - Spacing: Geometric (grid_type = 2)
 *    - Range: Lower = Entry -30%, Upper = Entry +70%
 *    - Investment: 100 USDT (total_investment = '100')
 *    - Take Profit: 1% (tp_sl_type = 1, take_profit_per = '1')
 * 2. Duplicate Prevention:
 *    - Always checks database before launching. If symbol already has a RUNNING bot, skips launch!
 * 3. Funds & Rejection Safety:
 *    - Only adds bot to database if Bybit successfully returns retCode === 0 and valid bot_id.
 *    - If insufficient funds or rejected, logs reason and does NOT add to database.
 * 4. 1-Minute Live Bot Observer:
 *    - Runs every 60 seconds (outside the 15M candle scan) without interfering with candle fetches.
 *    - Queries /v5/fgridbot/detail for every active bot and records live PnL.
 *    - Archives a bot only when Bybit reports a terminal status.
 *    - Does NOT close bots on PnL; the exchange-side 1% PnL TP is the exit.
 *    - On startup, reconciles active_bots before signal evaluation so stale
 *      Mongo records cannot block a symbol or allow a duplicate.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// Bybit has used several terminal status spellings across bot types. Treat all
// of them as finished so a canceled/failed bot does not stay "RUNNING" forever.
const TERMINAL_GRID_STATUSES = new Set([
  'FUTURE_GRID_STATUS_TERMINATED',
  'FUTURE_GRID_STATUS_CLOSED',
  'FUTURE_GRID_STATUS_COMPLETED',
  'FUTURE_GRID_STATUS_CANCELED',
  'FUTURE_GRID_STATUS_CANCELLED',
  'FUTURE_GRID_STATUS_FAILED',
  'FUTURE_GRID_STATUS_STOPPED',
  'TERMINATED',
  'CLOSED',
  'COMPLETED',
  'CANCELED',
  'CANCELLED',
  'FAILED',
  'STOPPED'
]);

function isTerminalStatus(status) {
  return TERMINAL_GRID_STATUSES.has(String(status || ''));
}

function isAlreadyClosedMessage(res) {
  if (!res) return false;
  const msg = String(res.retMsg || '').toLowerCase();
  return /(not found|not exist|does not exist|already closed|closed|terminated|completed|canceled|cancelled)/.test(msg);
}

class GridBotManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.db = options.db;
    this.timeSync = options.timeSync;

    // Credentials from environment variables
    this.apiKey = process.env.BYBIT_BOT_API_KEY || process.env.BYBIT_API_KEY || '';
    this.apiSecret = process.env.BYBIT_BOT_API_SECRET || process.env.BYBIT_API_SECRET || '';
    this.isTestnet = process.env.BYBIT_TESTNET === 'true' || process.env.BYBIT_TESTNET === '1';

    this.baseUrl = this.isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    this.recvWindow = 20000;

    // Default Bot Configuration
    this.gridMode = 3;            // 3 = Short
    this.direction = 2;           // 2 = Short
    this.gridType = 2;            // 2 = Geometric
    this.cellNumber = parseInt(process.env.BOT_GRIDS || '40', 10);
    this.leverage = String(process.env.BOT_LEVERAGE || '2');
    this.totalInvestment = String(process.env.BOT_INVESTMENT || '100');
    this.tpSlType = 1;            // 1 = Percentage based TP/SL
    this.takeProfitPer = String(process.env.BOT_TP_PERCENT || '1');
    // Target close USDT: (takeProfitPer% * totalInvestment) / 100
    this.targetPnlCloseUsdt = (parseFloat(this.takeProfitPer) / 100) * parseFloat(this.totalInvestment);

    // Instrument info cache (tickSize, minOrderQty)
    this.instrumentCache = new Map();

    // 1-minute bot watcher interval
    this.watcherInterval = null;
    this.isCheckingBots = false;

    // Mutex set to prevent duplicate close race conditions
    this.closingBotIds = new Set();

    // Mutex set to prevent two concurrent startShortGridBot calls for the
    // same symbol (the watcher also has a per-symbol launch lock).
    this.creatingSymbols = new Set();

    // Journal reconciliation throttle
    this.lastJournalReconcileAt = 0;
  }

  /**
   * Initialize Grid Bot Manager & start 60s PnL watcher
   */
  async init() {
    const hasKeys = !!(this.apiKey && this.apiSecret);
    console.log(`[GridBotManager] 🤖 Initializing Bybit Grid Bot Manager...`);
    console.log(`   API Key Configured: ${hasKeys ? 'YES (***' + this.apiKey.slice(-4) + ')' : 'NO (Read-only mode until configured)'}`);
    console.log(`   Base URL: ${this.baseUrl} | Leverage: ${this.leverage}x | Grids: ${this.cellNumber} | TP: ${this.takeProfitPer}% (+$${this.targetPnlCloseUsdt} USDT)`);

    // Recover bots that were created on Bybit but whose active-bot write
    // failed before the previous process stopped.
    await this.reconcileBotJournal();

    // Start 60-second periodic running bot watcher
    this._startBotWatcher();

    // Reconcile active records BEFORE returning to the watcher startup. This
    // prevents a stale RUNNING record from blocking a symbol after a restart.
    // The watcher only observes/archives; it does not close at a PnL target.
    await this.checkRunningBots().catch(err => {
      console.error('[GridBotManager] Error in initial startup bot check:', err.message);
    });
  }

  /**
   * Start 60-second running bot check loop
   */
  _startBotWatcher() {
    if (this.watcherInterval) clearInterval(this.watcherInterval);

    this.watcherInterval = setInterval(() => {
      this.checkRunningBots().catch(err => {
        console.error('[GridBotManager] Error in 60s bot check loop:', err.message);
      });
    }, 60000); // Exactly once every 60 seconds
  }

  /**
   * Generate Bybit V5 HMAC-SHA256 signature
   */
  _generateSignature(timestamp, payloadStr) {
    const message = timestamp + this.apiKey + this.recvWindow + payloadStr;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
  }

  /**
   * Signed Bybit REST request
   */
  async _signedRequest(endpoint, params = {}, method = 'POST') {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Bybit Bot API Key and Secret are not configured in environment variables.');
    }

    const timestamp = String(this.timeSync ? this.timeSync.now() : Date.now());
    let url = `${this.baseUrl}${endpoint}`;
    let bodyStr = '';

    const headers = {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': String(this.recvWindow)
    };

    if (method === 'GET') {
      const qs = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`).join('&');
      if (qs) url += `?${qs}`;
      headers['X-BAPI-SIGN'] = this._generateSignature(timestamp, qs);
    } else {
      bodyStr = JSON.stringify(params);
      headers['X-BAPI-SIGN'] = this._generateSignature(timestamp, bodyStr);
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(method !== 'GET' && { body: bodyStr }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Get instrument tick size and price formatting
   */
  async getInstrumentInfo(symbol) {
    if (this.instrumentCache.has(symbol)) {
      return this.instrumentCache.get(symbol);
    }

    try {
      const res = await fetch(`${this.baseUrl}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
      const data = await res.json();
      if (data.retCode === 0 && data.result?.list?.[0]) {
        const info = data.result.list[0];
        this.instrumentCache.set(symbol, info);
        return info;
      }
    } catch (e) {
      console.warn(`[GridBotManager] Failed to fetch instrument info for ${symbol}:`, e.message);
    }
    return null;
  }

  _formatPrice(price, tickSize) {
    if (!tickSize || tickSize <= 0) return price.toString();
    const s = tickSize.toString();
    const dec = s.includes('.') ? s.split('.')[1].length : 0;
    const stepped = Math.round(price / tickSize) * tickSize;
    return stepped.toFixed(dec);
  }

  /**
   * Read the authoritative exchange state of one bot. Used by the launch guard
   * so a stale Mongo RUNNING record cannot block a symbol after the exchange TP
   * has already closed the bot.
   */
  async _getBotStatus(botId) {
    try {
      const res = await this._signedRequest('/v5/fgridbot/detail', { bot_id: String(botId) }, 'POST');
      if (!res || res.retCode !== 0) {
        return { state: 'UNKNOWN', reason: res ? (res.retMsg || `retCode ${res.retCode}`) : 'No response' };
      }
      const detail = res.result?.detail;
      if (!detail) return { state: 'UNKNOWN', reason: 'detail null' };
      if (isTerminalStatus(detail.status)) return { state: 'TERMINAL', detail };
      return { state: 'RUNNING', detail };
    } catch (err) {
      return { state: 'UNKNOWN', reason: err.message };
    }
  }

  /**
   * Launch Short Grid Bot (Called on verified signal)
   */
  async startShortGridBot(signal) {
    const symbol = signal && signal.symbol;
    if (!symbol) return { success: false, reason: 'Invalid symbol' };

    if (this.creatingSymbols.has(symbol)) {
      console.log(`[GridBotManager] 🔒 Creation already in progress for ${symbol}. Skipping duplicate start.`);
      return { success: false, skipped: true, reason: 'Creation already in progress for symbol' };
    }

    this.creatingSymbols.add(symbol);
    try {
      return await this._startShortGridBotInner(signal);
    } finally {
      this.creatingSymbols.delete(symbol);
    }
  }

  async _startShortGridBotInner(signal) {
    const symbol = signal.symbol;
    const currentPrice = Number(signal.currentPrice);

    if (!symbol || !currentPrice || currentPrice <= 0) {
      console.warn(`[GridBotManager] ⚠️ Invalid signal data for ${symbol}: price=${currentPrice}`);
      return { success: false, reason: 'Invalid price' };
    }

    // Never create a bot when the persistent store is unavailable. On
    // Northflank the container filesystem is ephemeral; a local-only active
    // record would disappear on restart and could allow a duplicate.
    if (this.db && this.db.persistenceHealthy === false) {
      console.warn(`[GridBotManager] ⛔ Persistent Mongo is unavailable. Refusing to open ${symbol}.`);
      return {
        success: false,
        skipped: true,
        reason: 'Persistent Mongo storage unavailable; refusing new grid bot'
      };
    }

    // ── 1. Duplicate Running Bot Check (verified against Bybit) ────────────
    const runningBot = await this.db.getActiveBotBySymbol(symbol);
    if (runningBot) {
      const status = await this._getBotStatus(runningBot.botId);

      if (status.state === 'RUNNING') {
        console.log(`[GridBotManager] ℹ️ Symbol ${symbol} already has an active running bot (ID: ${runningBot.botId}). Skipping duplicate launch.`);
        return {
          success: false,
          skipped: true,
          reason: 'Symbol already has an active running bot',
          existingBotId: runningBot.botId
        };
      }

      if (status.state === 'TERMINAL') {
        // The exchange-side 1% TP (or a cancel) already closed it. Clear the
        // stale Mongo record so this signal may open a new bot.
        console.log(`[GridBotManager] 🧹 Existing bot ${runningBot.botId} (${symbol}) is ${status.detail.status}; clearing stale active record.`);
        await this.db.removeActiveBot(runningBot.botId, {
          status: status.detail.status,
          pnl: parseFloat(status.detail.realised_pnl || 0) + parseFloat(status.detail.unrealised_pnl || 0) || parseFloat(status.detail.pnl || 0) || 0,
          endedAt: Date.now(),
          closeReason: 'EXCHANGE_TERMINAL'
        });
        await this.db.removeBotJournal(runningBot.botId).catch(() => {});
        // Continue to launch a new bot for this signal.
      } else {
        // Unknown exchange state: do not risk a second bot on the same symbol.
        console.warn(`[GridBotManager] ⚠️ Existing bot ${runningBot.botId} (${symbol}) state is unknown (${status.reason}); refusing duplicate launch.`);
        return {
          success: false,
          skipped: true,
          reason: `Existing bot status unknown: ${status.reason || 'unknown'}`,
          existingBotId: runningBot.botId
        };
      }
    }

    // Check API credentials
    if (!this.apiKey || !this.apiSecret) {
      console.warn(`[GridBotManager] ⚠️ Cannot fire bot for ${symbol}: BYBIT_BOT_API_KEY / SECRET not configured.`);
      return { success: false, reason: 'API credentials missing' };
    }

    // ── 2. Fetch Tick Size & Format Grid Bounds ─────────────────────────────
    const info = await this.getInstrumentInfo(symbol);
    const tickSize = parseFloat(info?.priceFilter?.tickSize || 0.01);

    // Range [-30%, +70%]
    const rawMinPrice = currentPrice * 0.70; // -30% lower limit
    const rawMaxPrice = currentPrice * 1.70; // +70% upper limit

    const minPriceStr = this._formatPrice(rawMinPrice, tickSize);
    const maxPriceStr = this._formatPrice(rawMaxPrice, tickSize);

    // Take Profit Price (1.25% drop for short bot)
    const rawTpPrice = currentPrice * (1 - 0.0125);
    const tpPriceStr = this._formatPrice(rawTpPrice, tickSize);

    // Bybit V5 Futures Grid Bot payload:
    const payload = {
      symbol: symbol,
      grid_mode: this.gridMode,          // 3 = Short
      direction: this.direction,         // 2 = Short
      min_price: minPriceStr,            // -30% lower limit
      max_price: maxPriceStr,            // +70% upper limit
      cell_number: this.cellNumber,      // 40 grids
      leverage: this.leverage,           // 2x leverage
      grid_type: this.gridType,          // 2 = Geometric
      total_investment: this.totalInvestment, // 100 USDT
      tp_sl_type: this.tpSlType,         // 1 = Percentage TP
      take_profit_per: this.takeProfitPer // 1% Take Profit
    };

    console.log(`\n[GridBotManager] 🚀 Submitting Short Grid Bot to Bybit for ${symbol}...`);
    console.log(`   Entry: $${currentPrice} | Range: [-$${minPriceStr}, +$${maxPriceStr}] | 40 Grids | 2x Lev | TP: 1%`);

    try {
      const res = await this._signedRequest('/v5/fgridbot/create', payload, 'POST');

      // ── 3. Handle Bybit Response ──────────────────────────────────────────
      if (res && res.retCode === 0 && res.result?.bot_id) {
        const botId = String(res.result.bot_id);
        const timeIso = this.timeSync ? this.timeSync.getIsoTime() : new Date().toISOString();

        const newBot = {
          botId,
          symbol,
          direction: 'Short',
          gridMode: this.gridMode,
          entryPrice: currentPrice,
          minPrice: minPriceStr,
          maxPrice: maxPriceStr,
          cellNumber: this.cellNumber,
          leverage: this.leverage,
          investment: Number(this.totalInvestment),
          takeProfitPercent: Number(this.takeProfitPer),
          takeProfitPrice: tpPriceStr,
          status: 'RUNNING',
          pnl: 0.00,
          createdAt: Date.now(),
          createdAtIso: timeIso,
          lastCheckedAt: Date.now(),
          signalType: signal.signalType || 'FIRST_TOUCH',
          kcSpreadPct: signal.kcSpreadPct || 0,
          downsidePct: signal.downsidePct || 0,
          sgs: signal.sgs || null
        };

        // Journal the bot before persisting it. If the process dies between
        // Bybit creation and the active-bot write, startup reconciliation can
        // still find and close it.
        const journalEntry = {
          botId,
          symbol,
          reason: 'TRACKING_SAVE_PENDING',
          createdAt: Date.now(),
          attempts: 0,
          entryPrice: currentPrice
        };
        try {
          await this.db.addBotJournal(journalEntry);
        } catch (journalErr) {
          console.warn(`[GridBotManager] ⚠️ Could not write orphan journal for ${botId}: ${journalErr.message}`);
        }

        // Save to Database only upon confirmed creation. A persistence
        // failure must NOT be reported as a successful launch: the bot is
        // live on Bybit but invisible to the PnL watcher.
        try {
          await this.db.saveActiveBot(newBot);
        } catch (saveErr) {
          console.error(`[GridBotManager] ❌ Bot ${botId} (${symbol}) was created on Bybit but tracking persistence failed: ${saveErr.message}`);
          const closeResult = await this._closeOrphanBot(journalEntry);
          return {
            success: false,
            botId,
            reason: `Bot created on Bybit but tracking save failed: ${saveErr.message}`,
            closeResult
          };
        }

        try {
          await this.db.removeBotJournal(botId);
        } catch (journalErr) {
          console.warn(`[GridBotManager] ⚠️ Could not clear orphan journal for ${botId}: ${journalErr.message}`);
        }

        console.log(`[GridBotManager] ✅ Short Grid Bot SUCCESSFULLY CREATED on Bybit!`);
        console.log(`   Bot ID: ${botId} | Symbol: ${symbol} | Time: ${timeIso}\n`);

        this.emit('bot_started', newBot);

        return {
          success: true,
          botId,
          bot: newBot
        };
      } else {
        // Rejection handling (e.g. insufficient funds, min balance)
        const errMsg = res ? (res.retMsg || `Code ${res.retCode}`) : 'No response from Bybit';
        console.warn(`[GridBotManager] ⚠️ Bybit rejected bot creation for ${symbol} (Code: ${res?.retCode}): ${errMsg}`);
        console.warn(`   Bot was NOT created and NOT added to database.\n`);

        return {
          success: false,
          code: res?.retCode,
          reason: errMsg
        };
      }
    } catch (err) {
      console.error(`[GridBotManager] ❌ Exception creating grid bot for ${symbol}:`, err.message);
      return { success: false, reason: err.message };
    }
  }

  /**
   * Close a specific grid bot on Bybit
   */
  async closeGridBot(botId, symbol, pnl = null, reason = 'TAKE_PROFIT') {
    botId = String(botId);
    if (this.closingBotIds.has(botId)) {
      console.log(`[GridBotManager] 🔒 Bot ${botId} (${symbol}) is already being closed. Skipping duplicate request.`);
      return { success: false, reason: 'Already closing' };
    }
    this.closingBotIds.add(botId);

    try {
      console.log(`[GridBotManager] 🛑 Closing bot ${botId} (${symbol}) on Bybit (Reason: ${reason})...`);
      const res = await this._signedRequest('/v5/fgridbot/close', {
        bot_id: botId,
        close_type: 1 // 1 = Market close
      }, 'POST');

      console.log(`[GridBotManager] Close response for ${symbol}:`, JSON.stringify(res));

      // NEVER remove the tracking record unless Bybit explicitly confirms the
      // close. A rejected close must stay in active_bots so the 60s watcher
      // can retry and the operator can still see the bot.
      if (!res || res.retCode !== 0) {
        const retMsg = res ? (res.retMsg || `retCode ${res.retCode}`) : 'No response from Bybit';
        console.warn(`[GridBotManager] ⚠️ Close NOT confirmed for ${symbol} (${botId}): ${retMsg}. Bot remains tracked.`);
        return { success: false, retCode: res?.retCode, retMsg, reason: retMsg };
      }

      // Confirmed close: now archive and remove.
      await this.db.removeActiveBot(botId, {
        status: reason === 'TAKE_PROFIT' ? 'CLOSED_TAKE_PROFIT' : 'CLOSED',
        pnl: pnl !== null ? pnl : 0,
        closedAt: Date.now(),
        closeReason: reason
      });
      await this.db.removeBotJournal(botId).catch(() => {});

      this.emit('bot_closed', { botId, symbol, pnl, reason });
      return { success: true, retCode: 0, pnl: pnl !== null ? pnl : 0, result: res.result };
    } catch (err) {
      console.error(`[GridBotManager] Error closing bot ${botId}:`, err.message);
      // Network/timeout exception: keep the bot tracked for retry.
      return { success: false, reason: err.message };
    } finally {
      this.closingBotIds.delete(botId);
    }
  }

  /**
   * Close a bot that was created on Bybit but could not be persisted in the
   * active-bot store. This is the last-resort orphan path. It never removes the
   * journal entry unless Bybit confirms the bot is closed or no longer exists.
   */
  async _closeOrphanBot(entry) {
    const botId = String(entry.botId);
    const symbol = entry.symbol;

    let detail = null;
    let detailError = null;

    try {
      const detailRes = await this._signedRequest('/v5/fgridbot/detail', { bot_id: botId }, 'POST');
      if (detailRes && detailRes.retCode === 0) {
        detail = detailRes.result?.detail || null;
      } else {
        detailError = detailRes?.retMsg || `detail retCode ${detailRes?.retCode}`;
      }
    } catch (err) {
      detailError = err.message;
    }

    if (detail && isTerminalStatus(detail.status)) {
      await this.db.removeBotJournal(botId).catch(() => {});
      console.log(`[GridBotManager] 🧹 Orphan bot ${botId} (${symbol}) already finished (${detail.status}). Journal cleared.`);
      return { success: true, alreadyClosed: true, status: detail.status };
    }

    // This bot was created on Bybit but not persisted in active_bots. Do not
    // leave it unmanaged: attempt the close even when detail is null or the
    // detail call failed. The exchange-side TP is profit-only, so an underwater
    // or untracked bot could otherwise run indefinitely.
    try {
      const closeRes = await this._signedRequest('/v5/fgridbot/close', { bot_id: botId, close_type: 1 }, 'POST');

      if (closeRes && closeRes.retCode === 0) {
        await this.db.removeBotJournal(botId).catch(() => {});
        await this.db.removeActiveBot(botId, {
          status: 'CLOSED_ORPHAN',
          pnl: parseFloat(detail?.pnl || 0) || 0,
          closedAt: Date.now(),
          closeReason: 'TRACKING_SAVE_FAILED'
        }).catch(() => {});
        console.log(`[GridBotManager] ✅ Orphan bot ${botId} (${symbol}) closed on Bybit. Journal cleared.`);
        return { success: true, closed: true, retCode: 0 };
      }

      if (isAlreadyClosedMessage(closeRes)) {
        await this.db.removeBotJournal(botId).catch(() => {});
        console.log(`[GridBotManager] 🧹 Orphan bot ${botId} (${symbol}) was already closed: ${closeRes.retMsg}. Journal cleared.`);
        return { success: true, alreadyClosed: true, retCode: closeRes.retCode };
      }

      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastAttemptAt = Date.now();
      entry.lastError = closeRes?.retMsg || `close retCode ${closeRes?.retCode}`;
      if (detailError) entry.lastDetailError = detailError;
      await this.db.addBotJournal(entry).catch(() => {});
      console.warn(`[GridBotManager] ⚠️ Orphan close not confirmed for ${botId}: ${entry.lastError}`);
      return { success: false, reason: entry.lastError };
    } catch (err) {
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastAttemptAt = Date.now();
      entry.lastError = err.message;
      if (detailError) entry.lastDetailError = detailError;
      await this.db.addBotJournal(entry).catch(() => {});
      console.warn(`[GridBotManager] ⚠️ Orphan bot ${botId} close attempt failed: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }

  /**
   * Retry all journaled orphan bots. Called at startup and once per watcher
   * cycle. If the bot is already in active_bots (a crash after the DB write but
   * before the journal cleanup), just drop the journal entry.
   */
  async reconcileBotJournal() {
    if (!this.db || typeof this.db.getBotJournal !== 'function') return;
    let entries = [];
    try {
      entries = await this.db.getBotJournal();
    } catch (err) {
      console.warn(`[GridBotManager] ⚠️ Could not read bot journal: ${err.message}`);
      return;
    }
    if (!entries || entries.length === 0) return;

    let active = [];
    try {
      active = await this.db.getActiveBots();
    } catch (err) {
      console.warn(`[GridBotManager] ⚠️ Could not read active bots during journal reconcile: ${err.message}`);
      return;
    }
    const activeIds = new Set((active || []).map(b => String(b.botId)));

    for (const entry of entries) {
      if (activeIds.has(String(entry.botId))) {
        await this.db.removeBotJournal(entry.botId).catch(() => {});
        continue;
      }
      await this._closeOrphanBot(entry);
    }
    this.lastJournalReconcileAt = Date.now();
  }

  /**
   * 60-Second Active Running Bots Checker
   * Runs independently every minute when no 15M candle scan is executing.
   */
  async checkRunningBots() {
    if (this.isCheckingBots) return;
    this.isCheckingBots = true;
    const summary = { checked: 0, closed: 0, stale: 0, errors: 0, active: 0 };

    try {
      // Recover orphaned creations before checking normal active bots.
      await this.reconcileBotJournal();

      const runningBots = await this.db.getActiveBots();
      if (!runningBots || runningBots.length === 0) {
        return summary;
      }

      summary.checked = runningBots.length;
      summary.active = runningBots.length;
      console.log(`[GridBotManager] 🔎 Checking ${runningBots.length} active running grid bots...`);

      for (const bot of runningBots) {
        if (!bot.botId) continue;
        if (this.closingBotIds.has(String(bot.botId))) continue; // Skip in-flight closes

        try {
          const res = await this._signedRequest('/v5/fgridbot/detail', { bot_id: String(bot.botId) }, 'POST');

          if (!res || res.retCode !== 0) {
            const msg = res ? (res.retMsg || `retCode ${res.retCode}`) : 'No response from Bybit';
            bot.lastCheckError = msg;
            bot.lastCheckErrorAt = Date.now();
            bot.missingChecks = 0;
            try { await this.db.saveActiveBot(bot); } catch (_) {}
            console.warn(`[GridBotManager] ⚠️ Detail check failed for ${bot.symbol} (${bot.botId}): ${msg}. Keeping bot tracked.`);
            summary.errors++;
            continue;
          }

          const detail = res.result?.detail;

          if (!detail) {
            bot.missingChecks = (bot.missingChecks || 0) + 1;
            bot.lastCheckError = 'detail null';
            bot.lastCheckErrorAt = Date.now();
            try { await this.db.saveActiveBot(bot); } catch (_) {}
            console.warn(`[GridBotManager] ⚠️ Bot ${bot.botId} (${bot.symbol}) returned no detail (${bot.missingChecks}/3).`);
            if (bot.missingChecks >= 3) {
              // Do NOT remove an active record just because detail is null.
              // A running bot can return a transient empty detail; removing
              // the record would let a later signal open a duplicate on the
              // same symbol. Keep it as a blocker until Bybit reports a
              // terminal status or an operator clears it.
              summary.stale++;
              console.warn(`[GridBotManager] ⚠️ Bot ${bot.botId} (${bot.symbol}) has returned no detail 3+ times; keeping it tracked to prevent a duplicate.`);
            }
            continue;
          }

          // Any known terminal status is final. This includes CANCELED and
          // FAILED, not only COMPLETED/CLOSED/TERMINATED.
          if (isTerminalStatus(detail.status)) {
            const finalPnl = (parseFloat(detail.realised_pnl || 0) + parseFloat(detail.unrealised_pnl || 0)) || parseFloat(detail.pnl || 0) || bot.pnl;
            console.log(`[GridBotManager] 🛑 Bot ${bot.botId} (${bot.symbol}) finished on Bybit (Status: ${detail.status}, PnL: ${finalPnl} USDT). Removing from active DB.`);

            await this.db.removeActiveBot(bot.botId, {
              status: detail.status,
              pnl: Number(finalPnl.toFixed(4)),
              endedAt: Date.now(),
              closeReason: 'EXCHANGE_TERMINAL'
            });
            await this.db.removeBotJournal(bot.botId).catch(() => {});
            summary.closed++;
            continue;
          }

          // Calculate current individual bot PnL in USDT (Realised + Unrealised)
          const realisedPnl = parseFloat(detail.realised_pnl || 0);
          const unrealisedPnl = parseFloat(detail.unrealised_pnl || 0);
          const combinedPnl = realisedPnl + unrealisedPnl;
          const currentPnl = !isNaN(combinedPnl) ? combinedPnl : parseFloat(detail.pnl || 0);

          bot.pnl = Number(currentPnl.toFixed(4));
          bot.lastCheckedAt = Date.now();
          bot.missingChecks = 0;
          bot.lastCheckError = null;
          console.log(`   [Active Bot] ${bot.symbol} (ID: ${bot.botId}): Status=${detail.status} | Live PnL=${currentPnl >= 0 ? '+' : ''}${currentPnl.toFixed(4)} USDT`);

          // Observability only. The exchange-side 1% PnL TP closes the bot;
          // the watcher must never close on its own. If this write fails, the
          // bot is already in the active store; keep it and retry next cycle.
          try {
            await this.db.saveActiveBot(bot);
          } catch (saveErr) {
            summary.errors++;
            console.warn(`[GridBotManager] ⚠️ Could not update PnL for ${bot.symbol} (${bot.botId}): ${saveErr.message}`);
          }
        } catch (botErr) {
          summary.errors++;
          console.warn(`[GridBotManager] Error checking bot ${bot.botId} (${bot.symbol}):`, botErr.message);
        }
      }
    } catch (err) {
      summary.errors++;
      console.error('[GridBotManager] Error during bot check cycle:', err.message);
    } finally {
      this.isCheckingBots = false;
    }

    return summary;
  }

  /**
   * Get Manager Status
   */
  async getStatus() {
    const activeBots = await this.db.getActiveBots();
    const hasKeys = !!(this.apiKey && this.apiSecret);

    return {
      hasApiCredentials: hasKeys,
      apiKeyMasked: hasKeys ? '***' + this.apiKey.slice(-4) : 'NONE',
      persistenceHealthy: this.db ? this.db.persistenceHealthy : null,
      storageDriver: this.db ? this.db.driver : null,
      activeBotsCount: activeBots.length,
      activeBots: activeBots.map(b => ({
        botId: b.botId,
        symbol: b.symbol,
        direction: b.direction,
        entryPrice: b.entryPrice,
        pnl: b.pnl,
        createdAtIso: b.createdAtIso,
        status: b.status
      })),
      config: {
        gridMode: this.gridMode,
        direction: this.direction,
        leverage: this.leverage,
        cellNumber: this.cellNumber,
        totalInvestment: this.totalInvestment,
        takeProfitPer: this.takeProfitPer,
        watcherClosesOnPnl: false
      }
    };
  }
}

module.exports = GridBotManager;
