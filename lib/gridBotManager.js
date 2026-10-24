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
 * 4. 1-Minute Live Bot Watcher:
 *    - Runs every 60 seconds (outside the 15M candle scan) without interfering with candle fetches.
 *    - Queries /v5/fgridbot/detail for every active bot.
 *    - If bot reaches >= 1.00 USDT profit (1% TP), executes /v5/fgridbot/close and removes from active DB.
 *    - If terminated, completed, or closed on Bybit, removes from active DB and archives to history.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

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
  }

  /**
   * Initialize Grid Bot Manager & start 60s PnL watcher
   */
  async init() {
    const hasKeys = !!(this.apiKey && this.apiSecret);
    console.log(`[GridBotManager] 🤖 Initializing Bybit Grid Bot Manager...`);
    console.log(`   API Key Configured: ${hasKeys ? 'YES (***' + this.apiKey.slice(-4) + ')' : 'NO (Read-only mode until configured)'}`);
    console.log(`   Base URL: ${this.baseUrl} | Leverage: ${this.leverage}x | Grids: ${this.cellNumber} | TP: ${this.takeProfitPer}% (+$${this.targetPnlCloseUsdt} USDT)`);

    // Start 60-second periodic running bot watcher
    this._startBotWatcher();

    // Immediately verify and sync active bots from database on startup/restart
    this.checkRunningBots().catch(err => {
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
   * Launch Short Grid Bot (Called on verified signal)
   */
  async startShortGridBot(signal) {
    const symbol = signal.symbol;
    const currentPrice = Number(signal.currentPrice);

    if (!symbol || !currentPrice || currentPrice <= 0) {
      console.warn(`[GridBotManager] ⚠️ Invalid signal data for ${symbol}: price=${currentPrice}`);
      return { success: false, reason: 'Invalid price' };
    }

    // ── 1. Duplicate Running Bot Check ──────────────────────────────────────
    const runningBot = await this.db.getActiveBotBySymbol(symbol);
    if (runningBot) {
      console.log(`[GridBotManager] ℹ️ Symbol ${symbol} already has an active running bot (ID: ${runningBot.botId}). Skipping duplicate launch.`);
      return {
        success: false,
        skipped: true,
        reason: 'Symbol already has an active running bot',
        existingBotId: runningBot.botId
      };
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
          downsidePct: signal.downsidePct || 0
        };

        // Save to Database only upon confirmed creation!
        await this.db.saveActiveBot(newBot);

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

      // Remove from active database & archive to history
      await this.db.removeActiveBot(botId, {
        status: reason === 'TAKE_PROFIT' ? 'CLOSED_TAKE_PROFIT' : 'CLOSED',
        pnl: pnl !== null ? pnl : 0,
        closedAt: Date.now(),
        closeReason: reason
      });

      this.emit('bot_closed', { botId, symbol, pnl, reason });
      return res;
    } catch (err) {
      console.error(`[GridBotManager] Error closing bot ${botId}:`, err.message);
      return null;
    } finally {
      this.closingBotIds.delete(botId);
    }
  }

  /**
   * 60-Second Active Running Bots Checker
   * Runs independently every minute when no 15M candle scan is executing.
   */
  async checkRunningBots() {
    if (this.isCheckingBots) return;
    this.isCheckingBots = true;

    try {
      const runningBots = await this.db.getActiveBots();
      if (!runningBots || runningBots.length === 0) {
        return;
      }

      console.log(`[GridBotManager] 🔎 Checking ${runningBots.length} active running grid bots...`);

      for (const bot of runningBots) {
        if (!bot.botId) continue;
        if (this.closingBotIds.has(String(bot.botId))) continue; // Skip in-flight closes

        try {
          const res = await this._signedRequest('/v5/fgridbot/detail', { bot_id: String(bot.botId) }, 'POST');

          if (res && res.retCode === 0) {
            const detail = res.result?.detail;
            if (!detail) continue;

            // 1. Check if bot terminated/closed on Bybit
            const isTerminated = (
              detail.status === 'FUTURE_GRID_STATUS_TERMINATED' || 
              detail.status === 'FUTURE_GRID_STATUS_CLOSED' || 
              detail.status === 'FUTURE_GRID_STATUS_COMPLETED' ||
              detail.status === 'TERMINATED' ||
              detail.status === 'CLOSED'
            );

            if (isTerminated) {
              const finalPnl = (parseFloat(detail.realised_pnl || 0) + parseFloat(detail.unrealised_pnl || 0)) || parseFloat(detail.pnl || 0) || bot.pnl;
              console.log(`[GridBotManager] 🛑 Bot ${bot.botId} (${bot.symbol}) finished on Bybit (Status: ${detail.status}, PnL: ${finalPnl} USDT). Removing from active DB.`);

              await this.db.removeActiveBot(bot.botId, {
                status: detail.status,
                pnl: Number(finalPnl.toFixed(4)),
                endedAt: Date.now()
              });
              continue;
            }

            // 2. Calculate current individual bot PnL in USDT (Realised + Unrealised)
            const realisedPnl = parseFloat(detail.realised_pnl || 0);
            const unrealisedPnl = parseFloat(detail.unrealised_pnl || 0);
            const combinedPnl = realisedPnl + unrealisedPnl;
            const currentPnl = !isNaN(combinedPnl) ? combinedPnl : parseFloat(detail.pnl || 0);

            bot.pnl = Number(currentPnl.toFixed(4));
            bot.lastCheckedAt = Date.now();
            console.log(`   [Active Bot] ${bot.symbol} (ID: ${bot.botId}): Status=${detail.status} | Live PnL=${currentPnl >= 0 ? '+' : ''}${currentPnl.toFixed(4)} USDT`);

            // 3. Take Profit Target Check (+1.00 USDT = 1% on 100 USDT investment)
            if (currentPnl >= this.targetPnlCloseUsdt) {
              console.log(`\n🎯 [TAKE PROFIT REACHED] Bot ${bot.botId} (${bot.symbol}) reached +${currentPnl.toFixed(2)} USDT (>= $${this.targetPnlCloseUsdt} target)! Closing bot...`);
              await this.closeGridBot(bot.botId, bot.symbol, currentPnl, 'TAKE_PROFIT');
            } else {
              // Update in database
              await this.db.saveActiveBot(bot);
            }
          }
        } catch (botErr) {
          console.warn(`[GridBotManager] Error checking bot ${bot.botId} (${bot.symbol}):`, botErr.message);
        }
      }
    } catch (err) {
      console.error('[GridBotManager] Error during bot check cycle:', err.message);
    } finally {
      this.isCheckingBots = false;
    }
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
        targetPnlUsdt: this.targetPnlCloseUsdt
      }
    };
  }
}

module.exports = GridBotManager;
