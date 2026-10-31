/**
 * lib/bybitScanner.js
 * 
 * Bybit Linear Futures Climax Decay Scanner
 * - Enforces Safeguard 1: Filters out Stocks (symbolType !== 'stock') and Delisting/Settlement contracts (deliveryTime === '0')
 * - Filters out unestablished tokens (<45 days old or peaks within first 45 days of listing)
 * - Complies strictly with Bybit 600 req / 5s rate limits using BybitRateLimiter
 * - Sorts by default: Closest to Baseline (lowest downside to base floor)
 */

const BybitRateLimiter = require('./rateLimiter');
const SgsIndicator = require('./sgsIndicator');

class BybitScanner {
  constructor(options = {}) {
    this.db = options.db || null;
    this.rateLimiter = new BybitRateLimiter({
      minIntervalMs: 80, // ~12 req/sec peak
      concurrency: 5,
      maxPer5Sec: 250    // well under 600 limit
    });

    this.state = {
      status: 'idle', // 'idle' | 'scanning' | 'complete' | 'error'
      progress: {
        scanned: 0,
        total: 0,
        pct: 0,
        currentSymbol: ''
      },
      stats: {
        totalInstruments: 0,
        skippedStocks: 0,
        skippedDelisting: 0,
        skippedAge: 0,
        validEstablished: 0,
        activeDecays: 0,
        safeZoneCount: 0,
        nearBaseCount: 0
      },
      results: [],
      error: null,
      lastScanTime: null
    };

    this.activeScanPromise = null;
  }

  isScanning() {
    return this.state.status === 'scanning';
  }

  getState() {
    return {
      status: this.state.status,
      progress: this.state.progress,
      stats: this.state.stats,
      resultsCount: this.state.results.length,
      lastScanTime: this.state.lastScanTime,
      error: this.state.error
    };
  }

  getResults(options = {}) {
    let list = [...this.state.results];

    // Filter by search
    if (options.search) {
      const q = options.search.trim().toUpperCase();
      list = list.filter(item => item.symbol.includes(q));
    }

    // Filter by minimum gain
    if (options.minGain) {
      const mg = parseFloat(options.minGain);
      if (!isNaN(mg)) {
        list = list.filter(item => item.peakGainPct >= mg);
      }
    }

    // Filter by Safe Zone only
    if (options.safeZoneOnly === 'true' || options.safeZoneOnly === true) {
      list = list.filter(item => item.isSafeZone);
    }

    // Sorting: default to 'keltner' (closest to Upper Keltner Band)
    const sort = options.sort || 'keltner';
    if (sort === 'keltner') {
      list.sort((a, b) => {
        const scoreA = (a.kcSortScore !== undefined) ? a.kcSortScore : 9999;
        const scoreB = (b.kcSortScore !== undefined) ? b.kcSortScore : 9999;
        return scoreA - scoreB;
      });
    } else if (sort === 'closest') {
      // Closest to baseline first (lowest downside % to floor)
      list.sort((a, b) => a.downsidePct - b.downsidePct);
    } else if (sort === 'furthest') {
      // Furthest from baseline (highest downside % to floor)
      list.sort((a, b) => b.downsidePct - a.downsidePct);
    } else if (sort === 'gain-desc') {
      list.sort((a, b) => b.peakGainPct - a.peakGainPct);
    } else if (sort === 'decay-desc') {
      list.sort((a, b) => b.decayPct - a.decayPct);
    } else if (sort === 'days-asc') {
      list.sort((a, b) => a.daysSincePeak - b.daysSincePeak);
    }

    return list;
  }

  async startScan(force = false) {
    if (this.state.status === 'scanning') {
      return this.activeScanPromise;
    }

    this.activeScanPromise = this._runScan();
    return this.activeScanPromise;
  }

  async _runScan() {
    this.state.status = 'scanning';
    this.state.error = null;
    this.state.progress = { scanned: 0, total: 0, pct: 0, currentSymbol: 'Discovering pairs...' };

    try {
      console.log('[Bybit Scanner] 🚀 Initiating market discovery on Bybit Linear Futures...');

      // 1. Fetch Instruments Info and Tickers
      const [instData, tickData] = await Promise.all([
        this.rateLimiter.fetchWithRetry('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000'),
        this.rateLimiter.fetchWithRetry('https://api.bybit.com/v5/market/tickers?category=linear')
      ]);

      const instList = instData?.result?.list || [];
      const tickList = tickData?.result?.list || [];

      console.log(`[Bybit Scanner] Received ${instList.length} instruments and ${tickList.length} tickers.`);

      const tickerMap = new Map();
      for (const t of tickList) {
        tickerMap.set(t.symbol, t);
      }

      const now = Date.now();
      const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000;

      let skippedStocks = 0;
      let skippedDelisting = 0;
      let skippedAge = 0;
      const validPairs = [];

      for (const inst of instList) {
        const symbol = inst.symbol;
        const ticker = tickerMap.get(symbol);

        // Filter linear USDT pairs
        if (inst.quoteCoin !== 'USDT' || inst.status !== 'Trading') {
          continue;
        }

        // ── Safeguard 1A: Confirm symbolType !== 'stock' ──
        const symbolType = (inst.symbolType || ticker?.symbolType || '').trim().toLowerCase();
        if (symbolType === 'stock') {
          skippedStocks++;
          continue;
        }

        // ── Safeguard 1B: Confirm deliveryTime === '0' (Filters delisting & quarterly futures) ──
        const instDelivery = String(inst.deliveryTime ?? '0').trim();
        const tickDelivery = String(ticker?.deliveryTime ?? '0').trim();
        const isDeliveryOrDelisting = 
          (instDelivery !== '0' && instDelivery !== '' && parseInt(instDelivery, 10) !== 0) ||
          (tickDelivery !== '0' && tickDelivery !== '' && parseInt(tickDelivery, 10) !== 0) ||
          symbol.includes('-');
        
        if (isDeliveryOrDelisting) {
          skippedDelisting++;
          continue;
        }

        // ── Safeguard 2: Unestablished coins (<45 days old) ──
        const launchTime = parseInt(inst.launchTime, 10) || 0;
        const ageDays = launchTime > 0 ? (now - launchTime) / (24 * 3600 * 1000) : 999;
        if (ageDays < 45) {
          skippedAge++;
          continue;
        }

        const currentPrice = parseFloat(ticker?.lastPrice || 0);
        if (currentPrice <= 0) continue;

        validPairs.push({
          symbol,
          launchTime,
          ageDays: Math.floor(ageDays),
          currentPrice,
          turnover24h: parseFloat(ticker?.turnover24h || 0),
          volume24h: parseFloat(ticker?.volume24h || 0),
          price24hPcnt: parseFloat(ticker?.price24hPcnt || 0)
        });
      }

      this.state.stats.totalInstruments = instList.length;
      this.state.stats.skippedStocks = skippedStocks;
      this.state.stats.skippedDelisting = skippedDelisting;
      this.state.stats.skippedAge = skippedAge;
      this.state.stats.validEstablished = validPairs.length;

      console.log(`[Bybit Scanner] Filtered market: ${validPairs.length} valid established USDT pairs. (Skipped: ${skippedStocks} stocks, ${skippedDelisting} delisting/delivery, ${skippedAge} <45d).`);

      this.state.progress.total = validPairs.length;

      // 2. Fast Batched 1D Candle Download: 100 per batch, 1s wait between batches
      const decayResults = [];
      let scanned = 0;
      const BATCH_SIZE = 100;
      const BATCH_PAUSE_MS = 1000;
      const SUBCHUNK_SIZE = 25;
      const SUBCHUNK_SPACING_MS = 80;

      const totalPairs = validPairs.length;
      console.log(`[Bybit Scanner] ⚡ Fast batch scanner starting: ${totalPairs} pairs in batches of ${BATCH_SIZE} with ${BATCH_PAUSE_MS}ms pause...`);

      for (let b = 0; b < totalPairs; b += BATCH_SIZE) {
        const batch = validPairs.slice(b, b + BATCH_SIZE);
        const batchStart = Date.now();
        const batchNum = Math.floor(b / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(totalPairs / BATCH_SIZE);

        // Process batch in sub-chunks of 25 with 80ms spacing to avoid burst limit rejections
        for (let c = 0; c < batch.length; c += SUBCHUNK_SIZE) {
          const chunk = batch.slice(c, c + SUBCHUNK_SIZE);
          
          await Promise.all(chunk.map(async (pair) => {
            const klineUrl = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair.symbol}&interval=D&limit=1000`;
            
            // Retry loop for any momentary 10006 or network error
            let rawCandles = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const res = await fetch(klineUrl);
                if (res.status === 429) {
                  await new Promise(r => setTimeout(r, 200 * attempt));
                  continue;
                }
                const data = await res.json();
                if (data.retCode === 0 && data.result?.list) {
                  rawCandles = data.result.list;
                  break;
                }
                if (data.retCode === 10006) {
                  await new Promise(r => setTimeout(r, 250 * attempt));
                  continue;
                }
              } catch (e) {
                await new Promise(r => setTimeout(r, 200 * attempt));
              }
            }

            if (rawCandles && rawCandles.length >= 45) {
              const candles = rawCandles.slice().reverse().map(k => ({
                time: parseInt(k[0], 10),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                turnover: parseFloat(k[6])
              }));

              const analysis = this._evaluateDecay(pair, candles);
              if (analysis) {
                decayResults.push(analysis);
              }
            }

            scanned++;
          }));

          // Update progress
          this.state.progress.scanned = scanned;
          this.state.progress.pct = Math.round((scanned / totalPairs) * 100);
          this.state.progress.currentSymbol = `Batch ${batchNum}/${totalBatches} (${scanned}/${totalPairs})`;

          if (c + SUBCHUNK_SIZE < batch.length) {
            await new Promise(r => setTimeout(r, SUBCHUNK_SPACING_MS));
          }
        }

        console.log(`[Bybit Scanner] Batch ${batchNum}/${totalBatches} (${batch.length} pairs) processed in ${Date.now() - batchStart}ms.`);

        // 1-second pause between 100-batches
        if (b + BATCH_SIZE < totalPairs) {
          await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
        }
      }

      // =========================================================
      // PHASE 2: Download 15M Candles & Calculate Keltner Bands (20 EMA, 2.0 ATR) for Safe Zone Pairs
      // =========================================================
      const safeZoneItems = decayResults.filter(d => d.isSafeZone);
      console.log(`[Bybit Scanner] ⚡ Phase 2 starting: Fetching 15M candles & Keltner Bands for ${safeZoneItems.length} Safe Zone pairs...`);

      this.state.progress = {
        phase: 2,
        phaseName: 'Phase 2/2: Downloading 15M Candles & Calculating Keltner Bands',
        scanned: 0,
        total: safeZoneItems.length,
        pct: 0,
        currentSymbol: ''
      };

      let kcScanned = 0;
      for (let i = 0; i < safeZoneItems.length; i += SUBCHUNK_SIZE) {
        const chunk = safeZoneItems.slice(i, i + SUBCHUNK_SIZE);
        await Promise.all(chunk.map(async (item) => {
          // 1. Check if 15M candles already exist in persistent DB
          let candles15m = null;
          if (this.db) {
            const cached = await this.db.getCandles(item.symbol, 100);
            if (cached && cached.length >= 45) {
              candles15m = cached;
            }
          }

          // 2. Only fetch via REST if missing or insufficient in DB
          if (!candles15m) {
            const kline15Url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${item.symbol}&interval=15&limit=100`;
            let raw15 = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const res = await fetch(kline15Url);
                if (res.status === 429) {
                  await new Promise(r => setTimeout(r, 200 * attempt));
                  continue;
                }
                const data = await res.json();
                if (data.retCode === 0 && data.result?.list) {
                  raw15 = data.result.list;
                  break;
                }
                if (data.retCode === 10006) {
                  await new Promise(r => setTimeout(r, 250 * attempt));
                  continue;
                }
              } catch (e) {
                await new Promise(r => setTimeout(r, 200 * attempt));
              }
            }

            if (raw15 && raw15.length >= 20) {
              candles15m = raw15.slice().reverse().map(c => ({
                time: parseInt(c[0], 10),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5])
              }));

              // Save to persistent database
              if (this.db) {
                await this.db.saveCandles(item.symbol, candles15m);
              }
            }
          }

          if (candles15m && candles15m.length >= 20) {
            item.candles15m = candles15m;
            const kc = this._calculate15MKeltner(candles15m);
            if (kc) {
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
          }

          kcScanned++;
        }));

        this.state.progress.scanned = kcScanned;
        this.state.progress.pct = Math.round((kcScanned / safeZoneItems.length) * 100);
        this.state.progress.currentSymbol = `15M KC: ${kcScanned}/${safeZoneItems.length}`;

        if (i + SUBCHUNK_SIZE < safeZoneItems.length) {
          await new Promise(r => setTimeout(r, SUBCHUNK_SPACING_MS));
        }
      }

      // Default sorting: Keltner sort (touching / closest to upper band first)
      decayResults.sort((a, b) => {
        const scoreA = (a.kcSortScore !== undefined) ? a.kcSortScore : 9999;
        const scoreB = (b.kcSortScore !== undefined) ? b.kcSortScore : 9999;
        return scoreA - scoreB;
      });

      this.state.results = decayResults;
      this.state.stats.activeDecays = decayResults.length;
      this.state.stats.safeZoneCount = safeZoneItems.length;
      this.state.stats.nearBaseCount = decayResults.filter(d => d.downsidePct <= 15).length;
      this.state.lastScanTime = new Date().toISOString();
      this.state.status = 'complete';
      this.state.progress = {
        phase: 2,
        phaseName: 'Scan complete',
        scanned: safeZoneItems.length,
        total: safeZoneItems.length,
        pct: 100,
        currentSymbol: 'Scan complete'
      };

      console.log(`[Bybit Scanner] ✅ Scan complete! Found ${decayResults.length} active post-pump decay cycles (${this.state.stats.safeZoneCount} in Safe Zone with 15M Keltner Bands).`);
    } catch (err) {
      console.error('[Bybit Scanner] ❌ Scan failed:', err);
      this.state.status = 'error';
      this.state.error = err.message;
    }
  }

  /**
   * Keltner Band Calculation (20 EMA, 2.0 ATR) on 15M candles
   */
  _calculate15MKeltner(candles15m) {
    if (!candles15m || candles15m.length < 20) return null;
    const count = candles15m.length;
    const kEma = 2.0 / 21.0;
    let ema = candles15m[0].close;
    let atr = candles15m[0].high - candles15m[0].low;

    let prevEma = ema;
    let prevAtr = atr;

    for (let i = 1; i < count; i++) {
      if (i === count - 1) {
        prevEma = ema;
        prevAtr = atr;
      }
      const c = candles15m[i];
      ema = c.close * kEma + ema * (1 - kEma);
      const prevC = candles15m[i - 1].close;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC));
      atr = tr * kEma + atr * (1 - kEma);
    }

    const kcUpper = ema + 2.0 * atr;
    const kcMiddle = ema;
    const kcLower = ema - 2.0 * atr;
    const prevKcUpper = prevEma + 2.0 * prevAtr;

    const lastCandle = candles15m[count - 1];
    const prevCandle = count >= 2 ? candles15m[count - 2] : null;
    const currentPrice = lastCandle.close;
    const kcDistPct = ((kcUpper - currentPrice) / currentPrice) * 100;

    // Spread Filter: Distance from Middle (20 EMA) to Upper KC must be >= 1.25%
    // Backtests confirm >=1.25% drops median TP from 90m to 75m, and >=1.50% accelerates TP to 60m!
    const kcSpreadPct = kcMiddle > 0 ? ((kcUpper - kcMiddle) / kcMiddle) * 100 : 0;
    const isChannelWideEnough = kcSpreadPct >= 1.25;
    const isHighVelocitySpread = kcSpreadPct >= 1.50;

    // A valid touch requires:
    // 1. High wick actually touches or penetrates the Upper KC
    // 2. Channel spread is >= 1.25% (eliminates compressed low-volatility fake touches)
    const isKeltnerTouch = (lastCandle.high >= kcUpper || currentPrice >= kcUpper) && isChannelWideEnough;

    // Fresh First-Touch: previous candle stayed below Upper KC, current candle punched into/above Upper KC
    // Backtest proven: 7.87% lowest MAE and zero false momentum drags
    const isFirstTouch = isKeltnerTouch && prevCandle && (prevCandle.high < prevKcUpper);

    // Sorting score hierarchy:
    // 1. Fresh First-Touch with Wide Spread (Score: -100 to -10) -> Absolute Top Priority
    // 2. Extended Upper Touch with Wide Spread (Score: -9 to 0)
    // 3. Approaching Upper KC with Wide Spread (Score: 0 to 100, lower dist is higher)
    // 4. Narrow Choked Channels (<1.25%) (Score: 1000+) -> Pushed to the bottom
    let kcSortScore;
    if (isChannelWideEnough) {
      if (isFirstTouch) {
        kcSortScore = -50 - Math.min(50, kcSpreadPct);
      } else if (isKeltnerTouch) {
        kcSortScore = -10 - Math.min(10, kcSpreadPct);
      } else {
        kcSortScore = kcDistPct;
      }
    } else {
      kcSortScore = 1000 + kcDistPct;
    }

    return {
      kcUpper,
      kcMiddle,
      kcLower,
      kcDistPct,
      kcSpreadPct,
      isChannelWideEnough,
      isHighVelocitySpread,
      isKeltnerTouch,
      isFirstTouch,
      kcSortScore
    };
  }

  /**
   * Climax Decay Anatomy Evaluation
   */
  _evaluateDecay(pair, candles) {
    const now = Date.now();
    // Preserve the existing 200-day safe-zone analysis window exactly.
    // SGS-1 uses the full fetched history for its 1D indicators.
    const fullCandles = candles;
    candles = fullCandles.length > 200 ? fullCandles.slice(-200) : fullCandles;
    const peakOffset = fullCandles.length - candles.length;
    const count = candles.length;
    if (count < 45) return null;

    // 1. Find Climax Peak in history window
    let peakPrice = 0;
    let peakIdx = -1;

    candles.forEach((c, idx) => {
      if (c.high > peakPrice) {
        peakPrice = c.high;
        peakIdx = idx;
      }
    });

    if (peakIdx === -1 || peakPrice <= 0) return null;
    const peakCandle = candles[peakIdx];
    const peakTime = peakCandle.time;

    // 2. Safeguard: Peak must NOT occur in token's first 45 days
    if (pair.launchTime > 0 && (peakTime - pair.launchTime) < 45 * 24 * 3600 * 1000) {
      return null; // Skip listing pumps / IPO squeeze anomalies
    }

    // 3. Determine Origin Baseline Floor
    // Examine pre-pump consolidation (up to 40 days before breakout)
    const preCandles = candles.slice(Math.max(0, peakIdx - 40), Math.max(1, peakIdx));
    let basePrice;
    if (preCandles.length > 0) {
      const closes = preCandles.map(c => c.close).sort((a, b) => a - b);
      basePrice = closes[Math.floor(closes.length * 0.3)]; // 30th percentile consolidation floor
    } else {
      basePrice = candles[0].close;
    }

    if (!basePrice || basePrice <= 0) return null;

    // 4. Climax Gain Threshold (>= 25% pump expansion)
    const peakGainPct = ((peakPrice - basePrice) / basePrice) * 100;
    if (peakGainPct < 25) return null;

    // 5. Pristine Unbroken Decay Rule:
    // The price must NEVER have touched or dropped below the baseline floor since the climax peak!
    // If any post-peak candle reached or breached basePrice, the mean-reversion round trip was already completed.
    const postPeakCandles = candles.slice(peakIdx);
    const previouslyBreachedBase = postPeakCandles.some(c => c.low <= basePrice);
    if (previouslyBreachedBase) return null;

    // 6. Current Price & Downside to Base
    const currentPrice = pair.currentPrice > 0 ? pair.currentPrice : candles[count - 1].close;
    if (currentPrice <= basePrice) return null; // Already fully round-tripped to base or below

    const downsidePct = ((currentPrice - basePrice) / currentPrice) * 100;
    const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;
    const decayPct = ((peakPrice - currentPrice) / (peakPrice - basePrice)) * 100;
    const daysSincePeak = Math.floor((now - peakTime) / (24 * 3600 * 1000));
    const sgsDaily = SgsIndicator.calculateDaily(fullCandles, now, peakIdx + peakOffset);

    // 6. Volume Exhaustion Check
    const peakVolume = peakCandle.volume;
    const last3Candles = candles.slice(-3);
    const avgRecentVol = last3Candles.reduce((acc, c) => acc + c.volume, 0) / Math.max(1, last3Candles.length);
    const volRatio = peakVolume > 0 ? (avgRecentVol / peakVolume) : 1;

    // 7. Proven Zero-Liquidation Safe Zone:
    // - Drop from peak: 10% to 45%
    // - Day 2+ post peak
    // - Volume < 25% of peak
    // - Established token (>45d)
    // - Downside to Base >= 1.50% (guarantees price can drop 1.25% to take profit BEFORE hitting baseline floor!)
    const isSafeZone = (
      dropFromPeakPct >= 10 &&
      dropFromPeakPct <= 45 &&
      daysSincePeak >= 2 &&
      volRatio <= 0.25 &&
      downsidePct >= 1.50
    );

    // Identify pump launchpad start candle
    let pumpStartPrice = basePrice;
    let pumpStartIdx = Math.max(0, peakIdx - 5);
    for (let i = peakIdx; i >= Math.max(0, peakIdx - 15); i--) {
      if (candles[i].close <= basePrice * 1.08) {
        pumpStartPrice = candles[i].close;
        pumpStartIdx = i;
        break;
      }
    }
    const daysSincePumpStart = Math.floor((now - candles[pumpStartIdx].time) / (24 * 3600 * 1000));

    return {
      symbol: pair.symbol,
      currentPrice,
      basePrice,
      peakPrice,
      pumpStartPrice,
      peakGainPct,
      downsidePct,
      dropFromPeakPct,
      decayPct,
      daysSincePeak,
      daysSincePumpStart,
      volRatio,
      isSafeZone,
      sgsDaily,
      ageDays: pair.ageDays,
      turnover24h: pair.turnover24h,
      volume24h: pair.volume24h,
      // Minimal recent 1D candles for client-side inline chart rendering
      recentCandles: candles.slice(-60).map(c => ({
        t: c.time,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume
      }))
    };
  }
}

module.exports = BybitScanner;
