/**
 * liveWatcher.js
 * 
 * Master Live 15-Minute Watcher and Automated Signal Evaluator.
 * - Precision-scheduled every 15 minutes at :00:03, :15:03, :30:03, :45:03 (Bybit server time).
 * - Real-time synchronization with Bybit server time on every cycle.
 * - Fast 1D batch scanning to filter delistings, detect climax pumps & eliminate baseline breaches.
 * - Incremental 15M candlestick caching in MongoDB (or local fallback).
 * - Real-time WebSocket streaming with auto-reconnect & ping-pong for confirmed finished candles.
 * - Automatic database pruning when tokens breach the origin baseline floor.
 * - Precision entry signal emission for short grid bot deployment.
 */

const EventEmitter = require('events');
const TimeSync = require('./timeSync');
const DbManager = require('./dbManager');
const BybitWebSocket = require('./bybitWebSocket');
const BybitScanner = require('./bybitScanner');
const DailyMaintenance = require('./dailyMaintenance');
const GridBotManager = require('./gridBotManager');
const SgsIndicator = require('./sgsIndicator');
const CrossoverIndicator = require('./crossoverIndicator');
const MultiTfStore = require('./multiTfStore');

class LiveWatcher extends EventEmitter {
  constructor(options = {}) {
    super();

    this.db = new DbManager(options.dbOptions || {});
    this.timeSync = new TimeSync();
    this.ws = new BybitWebSocket(options.wsOptions || {});
    this.scanner = new BybitScanner({ db: this.db, ...options.scannerOptions });
    this.maintenance = new DailyMaintenance({
      db: this.db,
      timeSync: this.timeSync,
      ws: this.ws,
      liveWatcher: this
    });
    this.botManager = new GridBotManager({
      db: this.db,
      timeSync: this.timeSync,
      ...options.botOptions
    });

    // Multi-TF Candle Store & Crossover Engine
    this.multiTfStore = new MultiTfStore(this.db, {
      rateLimiter: this.scanner.rateLimiter
    });
    this.enableBbCrossovers = process.env.ENABLE_BB_CROSSOVERS !== 'false';
    this.bbCrossoverPairs = CrossoverIndicator.resolvePairs(process.env.BB_CROSSOVER_PAIRS || 'OPTIMAL_12');
    this.oneMinuteTimer = null;

    this.isRunning = false;
    this.currentCycle = 0;
    this.lastCycleTime = null;
    this.activeSafeZoneSymbols = [];
    this.latestSignals = [];
    this.maxSignalsKeep = 50;

    // Mutex guards for race condition prevention
    this.isCycleRunning = false;
    this.launchLocks = new Set();
  }

  /**
   * Start Live Watcher
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`================================================================`);
    console.log(`  BYBIT LIVE 15M DECAY WATCHER & SIGNAL ENGINE`);
    console.log(`================================================================`);

    // 1. Initialize Persistent Database
    await this.db.init();

    // 1b. Initialize Multi-TF Store
    await this.multiTfStore.init();

    // 2. Synchronize with Bybit Server Time
    await this.timeSync.sync();

    // 3. Initialize Daily Maintenance Engine & Post-Boot Database Audit
    await this.maintenance.init();

    // 4. Initialize Grid Bot Manager
    await this.botManager.init();

    // 5. Connect Live WebSocket Stream
    this._setupWebSocketHandlers();
    this.ws.connect();

    // 4. Run Initial Market Discovery & Scan
    console.log(`[LiveWatcher] 🚀 Running initial market discovery & Phase 1/2 scan...`);
    await this.scanner.startScan();

    // 5. Sync Safe Zone Subscriptions & Reconcile DB
    await this._syncSafeZoneAndSubscriptions();

    // 6. Signal Validity Rule: Signals are ONLY valid on the next minute after confirmed 15M candle (:01, :16, :31, :46)
    const currentBybitMinute = new Date(this.timeSync.now()).getUTCMinutes();
    const isCheckMinute = [1, 16, 31, 46].includes(currentBybitMinute);

    if (isCheckMinute) {
      console.log(`[LiveWatcher] 🕒 Startup coincided with signal check window (minute :${String(currentBybitMinute).padStart(2, '0')}). Evaluating previous 15M candle...`);
      await this._evaluateAndExecuteSignals();
    } else {
      console.log(`[LiveWatcher] ℹ️ Initialized at minute :${String(currentBybitMinute).padStart(2, '0')}. Signals are valid ONLY at :01, :16, :31, :46. Waiting for next window...`);
    }

    // 7. Schedule Precision Signal Trigger (:01:03, :16:03, :31:03, :46:03)
    this._scheduleNextCycle();

    // 8. Start Intermediate 1-Minute Ticker for fast BB Crossovers
    this._startOneMinuteTicker();

    this.emit('started', this.getStatus());
  }

  /**
   * Setup WebSocket Event Listeners
   */
  _setupWebSocketHandlers() {
    // When a 15M candle officially finishes/closes (confirm: true)
    this.ws.on('finishedCandle', async ({ symbol, candle }) => {
      // 1. Save finished candle to DB
      await this.db.appendFinishedCandle(symbol, candle);

      // 2. Update real-time indicator cache for UI screener
      await this._updateSymbolIndicators(symbol, candle);
    });

    // When a 1M candle officially finishes/closes (confirm: true)
    this.ws.on('finished1mCandle', async ({ symbol, candle }) => {
      await this.multiTfStore.append1mCandle(symbol, candle);
    });

    this.ws.on('connected', () => {
      this.emit('ws_status', { connected: true });
    });

    this.ws.on('disconnected', () => {
      this.emit('ws_status', { connected: false });
    });
  }

  /**
   * Synchronize Safe Zone pairs with DB and WebSocket subscriptions
   */
  async _syncSafeZoneAndSubscriptions() {
    const results = this.scanner.getResults({ safeZoneOnly: true });
    const currentSafeZoneSymbols = results.map(r => r.symbol);

    console.log(`[LiveWatcher] 🛡️ Currently ${currentSafeZoneSymbols.length} pairs in Zero-Liquidation Safe Zone.`);
    this.activeSafeZoneSymbols = currentSafeZoneSymbols;

    // Sync WebSocket subscriptions to match active Safe Zone symbols
    this.ws.syncSubscriptions(currentSafeZoneSymbols);

    // Prune retired coins from DB (coins that breached baseline or are no longer valid)
    const allDecayResults = this.scanner.getResults();
    const activeSymbolsSet = new Set(allDecayResults.map(r => r.symbol));
    const cachedSymbols = Array.from(this.db.candlesCache.keys());

    for (const cachedSym of cachedSymbols) {
      if (!activeSymbolsSet.has(cachedSym)) {
        console.log(`[LiveWatcher] 🗑️ Pruning ${cachedSym} from DB (baseline breached / cycle completed).`);
        await this.db.removeSymbol(cachedSym);
      }
    }

    // Sync Multi-TF candles for Safe Zone symbols
    if (this.enableBbCrossovers && this.multiTfStore) {
      for (const sym of currentSafeZoneSymbols) {
        await this.multiTfStore.warmupSymbol(sym);
      }
      await this.multiTfStore.pruneInactiveSymbols(currentSafeZoneSymbols);
    }
  }

  /**
   * Execute scheduled Signal Evaluation Cycle (:01:03, :16:03, :31:03, :46:03)
   */
  async runScheduledCycle() {
    // 🛡️ Race Guard: Prevent overlapping cycles if previous cycle took longer
    if (this.isCycleRunning) {
      console.warn(`[LiveWatcher] 🛡️ Race Guard: Scheduled cycle skipped because previous cycle is still in progress.`);
      return;
    }
    this.isCycleRunning = true;

    this.currentCycle++;
    const nowIso = this.timeSync.getIsoTime();
    console.log(`\n================================================================`);
    console.log(`  [LiveWatcher] ⏱️ SIGNAL EVALUATION CYCLE #${this.currentCycle} TRIGGERED AT ${nowIso}`);
    console.log(`  (Validating previous 15M candle finished at :00, :15, :30, :45)`);
    console.log(`================================================================`);

    this.lastCycleTime = nowIso;

    try {
      // 1. Re-sync Bybit Server Time
      await this.timeSync.sync();

      // 2. Run 1D batch scan (identifies delistings, baseline breaches & newly entered coins)
      // Completely awaits all 1D and 15M downloads before moving forward
      await this.scanner.startScan();

      // 3. Sync Safe Zone symbols with DB and WebSocket subscriptions
      await this._syncSafeZoneAndSubscriptions();

      // 4. Memory & Database Retention Pruning (prunes signals >48h, bot history >7d, inactive candles)
      await this.db.pruneDatabase(this.activeSafeZoneSymbols);

      // 5. Evaluate previous 15M candle signals & deploy bots sorted from highest to shortest Keltner band
      // Strictly guaranteed to run AFTER all candles are 100% downloaded and saved!
      await this._evaluateAndExecuteSignals();

      this.emit('cycle_completed', {
        cycle: this.currentCycle,
        time: nowIso,
        safeZoneCount: this.activeSafeZoneSymbols.length
      });
    } catch (err) {
      console.error('[LiveWatcher] ❌ Error in signal cycle:', err);
    } finally {
      this.isCycleRunning = false;
      // 6. Schedule Next Precision Signal Check (:01:03, :16:03, :31:03, :46:03)
      this._scheduleNextCycle();
    }
  }

  _scheduleNextCycle() {
    this.timeSync.scheduleNext(() => {
      this.runScheduledCycle();
    }, 3); // 3 seconds into :01, :16, :31, :46
  }

  /**
   * Evaluate Previous Finished 15M Candle Signals for all Safe Zone pairs.
   * If multiple signals exist, sorts them from HIGHEST from Keltner Band to SHORTEST
   * and attempts to open grid bots on all of them in that prioritized order.
   */
  async _evaluateAndExecuteSignals() {
    // 🛡️ Race Guard: Never evaluate or open trades while candles are downloading
    if (this.scanner.isScanning()) {
      console.warn(`[LiveWatcher] 🛡️ Race Guard: Aborting signal evaluation because candles/market scan is actively downloading.`);
      return;
    }

    const safeItems = this.scanner.getResults({ safeZoneOnly: true });
    const bybitNow = this.timeSync.now();
    const sgsCandidates = [];
    const keltnerCandidates = [];

    for (const item of safeItems) {
      // Retrieve candles from DB
      const candles = await this.db.getCandles(item.symbol, 100);
      if (!candles || candles.length < 20) continue;

      // Filter strictly to FINISHED candles that closed at or before the previous 15M mark
      // Candle close time is start time + 15 minutes
      const finishedCandles = candles.filter(c => (c.time + 15 * 60 * 1000) <= bybitNow);
      if (finishedCandles.length < 20) continue;

      const kc = this.scanner._calculate15MKeltner(finishedCandles);
      if (!kc) continue;

      // Update in-memory item
      item.kcUpper = kc.kcUpper;
      item.kcMiddle = kc.kcMiddle;
      item.kcLower = kc.kcLower;
      item.kcDistPct = kc.kcDistPct;
      item.kcSpreadPct = kc.kcSpreadPct;
      item.isChannelWideEnough = kc.isChannelWideEnough;
      item.isHighVelocitySpread = kc.isHighVelocitySpread;
      item.isKeltnerTouch = kc.isKeltnerTouch;
      item.isFirstTouch = kc.isFirstTouch;

      const lastFinishedCandle = finishedCandles[finishedCandles.length - 1];
      const triggerPrice = lastFinishedCandle.close;
      const candleCloseIso = new Date(lastFinishedCandle.time + 15 * 60 * 1000).toISOString();

      // ── SGS-1: standalone safety signal ─────────────────────────────────
      // Evaluated on EVERY safe-zone 15M close, independent of the Keltner touch.
      // finishedCandles includes the trigger candle (last element); the 15M RSI
      // uses that close, matching the backtest.
      const sgs = this._evaluateSgs(item, finishedCandles, triggerPrice);
      if (sgs.pass) {
        sgsCandidates.push({
          item,
          symbol: item.symbol,
          signalType: 'SGS_1',
          triggerPrice,
          kcUpper: null,
          kcMiddle: null,
          kcSpreadPct: 0,
          breachAboveKcPct: 0,
          isHighVelocitySpread: false,
          downsidePct: sgs.downside,
          dropFromPeakPct: sgs.dropFromPeak,
          sgs,
          candleCloseIso
        });
      }

      // ── Existing Keltner signal ─────────────────────────────────────────
      // Rule: Previous 15M candle must have touched Upper KC, spread >= 1.25%, and downside >= 1.50%
      if (kc.isKeltnerTouch && kc.isChannelWideEnough && item.downsidePct >= 1.50) {
        const breachAboveKcPct = Math.max(0, ((lastFinishedCandle.high - kc.kcUpper) / kc.kcUpper) * 100);
        const spreadPct = kc.kcSpreadPct || 0;

        keltnerCandidates.push({
          item,
          symbol: item.symbol,
          signalType: kc.isFirstTouch ? 'FIRST_TOUCH' : 'EXTENDED_TOUCH',
          triggerPrice,
          kcUpper: kc.kcUpper,
          kcMiddle: kc.kcMiddle,
          kcSpreadPct: spreadPct,
          breachAboveKcPct,
          isHighVelocitySpread: kc.isHighVelocitySpread,
          downsidePct: item.downsidePct,
          candleCloseIso
        });
      }
    }

    // ── BB Crossover Signals (Priority 2) ───────────────────────────────
    const crossoverCandidates = [];
    if (this.enableBbCrossovers && this.multiTfStore) {
      const fastTfs = new Set(['1m', '3m', '5m']);
      const fastPairs = this.bbCrossoverPairs.filter(p => fastTfs.has(p.fast) || fastTfs.has(p.slow));
      const macroPairs = this.bbCrossoverPairs.filter(p => !fastTfs.has(p.fast) && !fastTfs.has(p.slow));

      for (const item of safeItems) {
        const candles = this.multiTfStore.getAllCandles(item.symbol, bybitNow);
        if (!candles) continue;

        const crossSignals = [];

        // Macro / 15m+ pairs evaluate across the just-closed 15M boundary (after macro TF refresh)
        if (macroPairs.length > 0) {
          crossSignals.push(...CrossoverIndicator.evaluateSymbolCrossovers({
            symbol: item.symbol,
            candlesByTf: candles,
            pairs: macroPairs,
            referenceTime: bybitNow,
            stepMs: 15 * 60 * 1000
          }));
        }

        // Fast pairs (1m/3m/5m) evaluate with 1M step so :01/:16/:31/:46 1m closes are covered without duplicating :00/:15/:30/:45
        if (fastPairs.length > 0) {
          crossSignals.push(...CrossoverIndicator.evaluateSymbolCrossovers({
            symbol: item.symbol,
            candlesByTf: candles,
            pairs: fastPairs,
            referenceTime: bybitNow,
            stepMs: 60 * 1000
          }));
        }

        for (const sig of crossSignals) {
          crossoverCandidates.push({
            item,
            symbol: item.symbol,
            signalType: 'BB_CROSSOVER',
            triggerPrice: sig.triggerPrice,
            crossover: sig,
            downsidePct: item.downsidePct,
            dropFromPeakPct: item.dropFromPeakPct,
            candleCloseIso: sig.candleCloseIso
          });
        }
      }
    }

    // SGS-1 takes precedence on a symbol. If both signals fire on the same
    // symbol in the same cycle, keep only the SGS-1 candidate. The bot manager
    // still enforces one active grid per symbol across cycles.
    const sgsSymbols = new Set(sgsCandidates.map(c => c.symbol));
    const distinctCross = crossoverCandidates.filter(c => !sgsSymbols.has(c.symbol));

    // Deduplicate BB crossovers per symbol (keep first triggered pair)
    const seenCrossSymbols = new Set();
    const uniqueCross = [];
    for (const c of distinctCross) {
      if (!seenCrossSymbols.has(c.symbol)) {
        seenCrossSymbols.add(c.symbol);
        uniqueCross.push(c);
      }
    }

    const candidateSignals = [...sgsCandidates, ...uniqueCross];

    if (candidateSignals.length === 0) {
      console.log(`[LiveWatcher] ℹ️ Checked Safe Zone: 0 new entry signals on previous finished 15M candle.`);
      return;
    }

    // SGS-1 candidates first (Priority 1), then BB Crossovers (Priority 2).
    // Within each group, prefer more room to base.
    candidateSignals.sort((a, b) => {
      const aSgs = a.signalType === 'SGS_1';
      const bSgs = b.signalType === 'SGS_1';
      if (aSgs !== bSgs) return aSgs ? -1 : 1;
      return (b.downsidePct || 0) - (a.downsidePct || 0);
    });

    const sgsCount = candidateSignals.filter(c => c.signalType === 'SGS_1').length;
    const bbCount = candidateSignals.filter(c => c.signalType === 'BB_CROSSOVER').length;
    console.log(`\n================================================================`);
    console.log(`  [LiveWatcher] 🎯 ${candidateSignals.length} VALID SIGNAL(S) ON PREVIOUS 15M CANDLE`);
    console.log(`  ${sgsCount} SGS-1 signal(s) (Priority 1) | ${bbCount} BB Crossover signal(s) (Priority 2):`);
    candidateSignals.forEach((c, idx) => {
      const modeTag = c.item?.decayMode === 'MODE_2_DOUBLE_TOP' ? '🎯 Mode 2 (Double-Top)' : '⚡ Mode 1 (Flash)';
      if (c.signalType === 'SGS_1') {
        console.log(`   #${idx + 1}: ${c.symbol.padEnd(10)} | ${modeTag} | SGS-1 | D-ATR: ${c.sgs.dAtrPct?.toFixed(2)}% | D-RSI: ${c.sgs.dRsi?.toFixed(1)} | Room: ${c.downsidePct?.toFixed(1)}% | Price: $${c.triggerPrice}`);
      } else if (c.signalType === 'BB_CROSSOVER') {
        console.log(`   #${idx + 1}: ${c.symbol.padEnd(10)} | ${modeTag} | BB Cross: ${c.crossover?.pairId} (${c.crossover?.fastTf} crosses down ${c.crossover?.slowTf}) | Price: $${c.triggerPrice}`);
      } else {
        console.log(`   #${idx + 1}: ${c.symbol.padEnd(10)} | ${modeTag} | Spread: ${c.kcSpreadPct?.toFixed(2)}% | Breach: +${c.breachAboveKcPct?.toFixed(2)}% | Type: ${c.signalType} | Price: $${c.triggerPrice}`);
      }
    });
    console.log(`================================================================\n`);

    // Sequentially attempt to open Short Grid Bots on all candidate signals.
    // SGS-1 first. startShortGridBot() performs the authoritative duplicate
    // check against Bybit and clears stale Mongo records.
    for (const cand of candidateSignals) {
      const signal = this._buildSignalObject(cand);
      this._emitSignal(signal);

      // Deploy Short Grid Bot if not already running
      await this._handleBotLaunchForSignal(signal);
    }
  }

  /**
   * Evaluate SGS-1 for one safe-zone symbol.
   * 1D features come from item.sgsDaily (previous completed daily bar).
   * finishedCandles must include the trigger candle; the 15M RSI uses it.
   */
  _evaluateSgs(item, finishedCandles, triggerPrice) {
    if (!item || !item.sgsDaily) {
      return { pass: false, reason: 'insufficient completed 1D history' };
    }

    const closes = finishedCandles.map(c => c.close);
    const rsiSeries = SgsIndicator.rsiSeries(closes, 14);
    const rsi15 = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : null;

    return SgsIndicator.evaluate({
      daily: item.sgsDaily,
      basePrice: item.basePrice,
      peakPrice: item.peakPrice,
      triggerPrice,
      rsi15,
      fallbackDownside: item.downsidePct,
      fallbackDrop: item.dropFromPeakPct,
      fallbackDays: item.daysSincePeak
    });
  }

  /**
   * Update individual symbol indicators upon receiving a finished candle via WebSocket
   */
  async _updateSymbolIndicators(symbol, finishedCandle) {
    const item = this.scanner.state.results.find(r => r.symbol === symbol);
    if (!item || !item.isSafeZone) return;

    const candles = await this.db.getCandles(symbol, 100);
    if (!candles || candles.length < 20) return;

    const kc = this.scanner._calculate15MKeltner(candles);
    if (!kc) return;

    item.kcUpper = kc.kcUpper;
    item.kcMiddle = kc.kcMiddle;
    item.kcLower = kc.kcLower;
    item.kcDistPct = kc.kcDistPct;
    item.kcSpreadPct = kc.kcSpreadPct;
    item.isChannelWideEnough = kc.isChannelWideEnough;
    item.isHighVelocitySpread = kc.isHighVelocitySpread;
    item.isKeltnerTouch = kc.isKeltnerTouch;
    item.isFirstTouch = kc.isFirstTouch;
    item.kcSortScore = kc.kcSortScore;
  }

  /**
   * Build complete Signal object for database persistence and bot execution
   */
  _buildSignalObject(cand) {
    const item = cand.item;
    const p0 = cand.triggerPrice || item.currentPrice;
    const upperLimit = p0 * 1.35; // +35% upper limit
    const lowerLimit = p0 * 0.80; // -20% lower limit

    return {
      id: `${item.symbol}-${Date.now()}`,
      symbol: item.symbol,
      signalType: cand.signalType,
      crossover: cand.crossover || null,
      currentPrice: p0,
      kcUpper: cand.kcUpper ?? null,
      kcMiddle: cand.kcMiddle ?? null,
      kcSpreadPct: cand.kcSpreadPct ?? 0,
      breachAboveKcPct: cand.breachAboveKcPct ?? 0,
      isHighVelocitySpread: !!cand.isHighVelocitySpread,
      dropFromPeakPct: cand.dropFromPeakPct ?? item.dropFromPeakPct,
      downsidePct: cand.downsidePct ?? item.downsidePct,
      peakPrice: item.peakPrice,
      basePrice: item.basePrice,
      daysSincePeak: cand.sgs?.days ?? item.daysSincePeak,
      decayMode: item.decayMode || 'NONE',
      mode2: item.mode2 || null,
      sgs: cand.sgs || null,
      candleCloseIso: cand.candleCloseIso,
      suggestedGrid: {
        leverage: 2.0,
        grids: 80,
        range: '[-20%, +35%]',
        upperLimit,
        lowerLimit,
        takeProfitUsdt: 1.00,
        requiredDropPct: 1.25
      },
      timestamp: this.timeSync.getIsoTime()
    };
  }

  /**
   * Emit and persist Entry Signal
   */
  _emitSignal(signal) {
    // Avoid duplicate signals of the same type for the same symbol within the
    // same 15M cycle. SGS-1 and Keltner are separate signal types; if both fire
    // on one symbol, the candidate builder keeps only SGS-1.
    const recent = this.latestSignals.find(s =>
      s.symbol === signal.symbol &&
      s.signalType === signal.signalType &&
      (Date.now() - new Date(s.timestamp).getTime()) < 14 * 60 * 1000
    );
    if (recent) return;

    const label = signal.signalType === 'SGS_1'
      ? '🛡️ SGS-1 SAFETY'
      : signal.signalType === 'BB_CROSSOVER'
        ? `📈 BB CROSSOVER (${signal.crossover?.pairId || ''})`
        : signal.signalType === 'FIRST_TOUCH'
          ? '🔥 FRESH FIRST TOUCH'
          : '⚡ EXTENDED TOUCH';

    console.log(`\n🚨 [ENTRY SIGNAL] ${label} ON ${signal.symbol}!`);
    if (signal.signalType === 'SGS_1') {
      const s = signal.sgs || {};
      console.log(`   Price: $${signal.currentPrice} | Room to Base: ${signal.downsidePct?.toFixed(1)}% | Drop: ${signal.dropFromPeakPct?.toFixed(1)}%`);
      console.log(`   SGS-1: D-ATR ${s.dAtrPct?.toFixed(2)}% | D-RSI ${s.dRsi?.toFixed(1)} | EMA200 dist ${s.distE200D?.toFixed(1)}% | 20D-low dist ${s.dCloseVsLl20?.toFixed(1)}% | 15M RSI ${s.rsi15?.toFixed(1)}`);
    } else if (signal.signalType === 'BB_CROSSOVER') {
      const co = signal.crossover || {};
      console.log(`   Price: $${signal.currentPrice} | Crossover: ${co.pairId} (${co.fastTf} crosses down ${co.slowTf})`);
      console.log(`   Fast SMA: ${co.fastSma?.toFixed(4)} | Slow SMA: ${co.slowSma?.toFixed(4)} | Room to Base: ${signal.downsidePct?.toFixed(1)}%`);
    } else {
      console.log(`   Price: $${signal.currentPrice} | Upper KC: $${signal.kcUpper?.toFixed(4)} | Spread: ${signal.kcSpreadPct?.toFixed(2)}% | Room to Base: ${signal.downsidePct?.toFixed(1)}%`);
    }
    console.log(`   Grid Blueprint: 2.0x | 80 Grids | Upper: $${signal.suggestedGrid?.upperLimit?.toFixed(4)} | Lower: $${signal.suggestedGrid?.lowerLimit?.toFixed(4)} | TP: +$1.00 USDT (1%)\n`);

    this.latestSignals.unshift(signal);
    if (this.latestSignals.length > this.maxSignalsKeep) this.latestSignals.pop();

    this.db.saveSignal(signal);
    this.emit('signal', signal);
  }

  /**
   * Handle bot launching for a newly triggered signal
   */
  async _handleBotLaunchForSignal(signal) {
    if (!this.botManager) return;

    // 🛡️ Race Guard 1: Never open trade while candles/market scan is downloading
    if (this.scanner.isScanning()) {
      console.warn(`[LiveWatcher] 🛡️ Race Guard: Blocked trade launch for ${signal.symbol} because candle download is currently active.`);
      return;
    }

    // 🛡️ Race Guard 2: Symbol-level launch mutex to prevent concurrent double-launches
    if (this.launchLocks.has(signal.symbol)) {
      console.log(`[LiveWatcher] 🔒 Launch mutex active for ${signal.symbol}. Skipping concurrent launch attempt.`);
      return;
    }
    this.launchLocks.add(signal.symbol);

    try {
      // The authoritative duplicate check lives inside startShortGridBot():
      // it verifies the existing bot against Bybit before skipping, so a stale
      // Mongo RUNNING record cannot block a symbol after an exchange-side TP.
      console.log(`[LiveWatcher] 🎯 Firing Short Grid Bot for ${signal.symbol} on signal [${signal.signalType}]...`);
      const result = await this.botManager.startShortGridBot(signal);

      if (result && result.success) {
        console.log(`[LiveWatcher] 🚀 Successfully deployed Short Grid Bot ${result.botId} for ${signal.symbol}!`);
      } else if (result && result.skipped) {
        console.log(`[LiveWatcher] ℹ️ Bot launch skipped: ${result.reason}`);
      } else {
        console.warn(`[LiveWatcher] ⚠️ Bot launch failed for ${signal.symbol}: ${result?.reason || 'Unknown error'}`);
      }
    } finally {
      this.launchLocks.delete(signal.symbol);
    }
  }

  /**
   * Get Live Watcher System Status
   */
  async getStatus() {
    return {
      watcherRunning: this.isRunning,
      currentCycle: this.currentCycle,
      lastCycleTime: this.lastCycleTime,
      activeSafeZonePairs: this.activeSafeZoneSymbols.length,
      timeSync: this.timeSync.getStatus(),
      webSocket: this.ws.getStatus(),
      db: this.db.getStats(),
      maintenance: this.maintenance.getStatus(),
      gridBots: await this.botManager.getStatus(),
      scanner: this.scanner.getState(),
      crossovers: {
        enabled: this.enableBbCrossovers,
        portfolio: process.env.BB_CROSSOVER_PAIRS || 'OPTIMAL_12',
        pairsCount: this.bbCrossoverPairs.length,
        cachedSymbols: this.multiTfStore ? this.multiTfStore.cache.size : 0
      },
      latestSignalsCount: this.latestSignals.length
    };
  }

  /**
   * Schedule 1-minute ticker for fast-timeframe BB Crossovers
   */
  _startOneMinuteTicker() {
    if (this.oneMinuteTimer) {
      clearTimeout(this.oneMinuteTimer);
      this.oneMinuteTimer = null;
    }
    if (!this.isRunning) return;

    const next = this.timeSync.getNext1mTrigger(3);
    this.oneMinuteTimer = setTimeout(async () => {
      try {
        await this._run1mIntermediateCheck();
      } catch (err) {
        console.error('[LiveWatcher] Error in 1m intermediate check:', err.message);
      } finally {
        if (this.isRunning) this._startOneMinuteTicker();
      }
    }, next.delayMs);
  }

  /**
   * Run lightweight 1m intermediate check on in-memory multi-TF cache (0 Bybit REST calls)
   */
  async _run1mIntermediateCheck() {
    if (!this.enableBbCrossovers || this.isCycleRunning) return;
    if (this.scanner.isScanning()) return;
    if (!this.multiTfStore) return;

    const bybitNow = this.timeSync.now();
    const currentMinute = new Date(bybitNow).getUTCMinutes();

    // 15M cycle triggers at :01, :16, :31, :46; intermediate ticker runs on other minutes
    if ([1, 16, 31, 46].includes(currentMinute)) return;

    const safeItems = this.scanner.getResults({ safeZoneOnly: true });
    for (const item of safeItems) {
      if (this.launchLocks.has(item.symbol)) continue;

      // Check if bot already exists in DB
      const existing = await this.db.getActiveBotBySymbol(item.symbol);
      if (existing) continue;

      const candles = this.multiTfStore.getAllCandles(item.symbol, bybitNow);
      if (!candles) continue;

      // In the intermediate 1m ticker, evaluate fast-cycle pairs (any TF <= 5m)
      const fastTfs = new Set(['1m', '3m', '5m']);
      const fastPairs = this.bbCrossoverPairs.filter(p => fastTfs.has(p.fast) || fastTfs.has(p.slow));
      if (fastPairs.length === 0) continue;

      const crossSignals = CrossoverIndicator.evaluateSymbolCrossovers({
        symbol: item.symbol,
        candlesByTf: candles,
        pairs: fastPairs,
        referenceTime: bybitNow,
        stepMs: 60 * 1000
      });

      if (crossSignals.length > 0) {
        const sig = crossSignals[0];
        console.log(`[LiveWatcher] ⚡ Intermediate 1M Signal: ${item.symbol} triggered ${sig.pairId} at $${sig.triggerPrice}`);

        const candidate = {
          item,
          symbol: item.symbol,
          signalType: 'BB_CROSSOVER',
          triggerPrice: sig.triggerPrice,
          crossover: sig,
          downsidePct: item.downsidePct,
          dropFromPeakPct: item.dropFromPeakPct,
          candleCloseIso: sig.candleCloseIso
        };

        const signalObj = this._buildSignalObject(candidate);
        this._emitSignal(signalObj);
        await this._handleBotLaunchForSignal(signalObj);
      }
    }
  }

  /**
   * Stop watcher and cleanup timers & WebSocket
   */
  stop() {
    this.isRunning = false;
    if (this.oneMinuteTimer) {
      clearTimeout(this.oneMinuteTimer);
      this.oneMinuteTimer = null;
    }
    if (this.ws) {
      this.ws.disconnect();
    }
  }

  /**
   * Get recent signals
   */
  getSignals(limit = 50) {
    return this.latestSignals.slice(0, limit);
  }
}

module.exports = LiveWatcher;
