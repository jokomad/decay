/**
 * crossoverIndicator.js
 *
 * Zero-Liquidation Middle Bollinger Band (20 SMA) Crossover Engine for BybitDecay.
 *
 * Implements:
 * 1. Standard 20-period SMA middle band (and upper/lower bands) calculation.
 * 2. In-memory dynamic aggregation of 1m candles into 3m, 5m, 15m, 30m candles.
 * 3. Exact crossover down detection matching the optimizer engine:
 *    Condition: (Fast_SMA_prev >= Slow_SMA_prev) AND (Fast_SMA_curr < Slow_SMA_curr)
 * 4. Registry and configuration parsing for the mathematically validated
 *    OPTIMAL_12 zero-liquidation portfolio (113 wins, 0 liquidations).
 */

'use strict';

const BB_PERIOD = 20;

/**
 * Standard supported timeframes and durations in minutes
 */
const TIMEFRAME_MINUTES = Object.freeze({
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '12h': 720,
  '1d': 1440,
});

/**
 * The 12 approved zero-liquidation crossover pairs.
 * Evaluated across all safe-zone tokens with single-bot concurrency.
 */
const OPTIMAL_12 = Object.freeze([
  { id: '5m_15m', fast: '5m', slow: '15m', description: 'High-Volume Core Intraday Engine' },
  { id: '30m_12h', fast: '30m', slow: '12h', description: 'Fast Sniper Reversal (5.1h avg TP, 4.4% DD)' },
  { id: '4h_6h', fast: '4h', slow: '6h', description: 'Fast Macro Reversal (4.1h avg TP, 13.3% DD)' },
  { id: '6h_4h', fast: '6h', slow: '4h', description: 'Intraday Macro Reversal (6.6h avg TP, 13.5% DD)' },
  { id: '1h_6h', fast: '1h', slow: '6h', description: 'Flawless Market Anchor (10.5h avg TP, 5.7% DD)' },
  { id: '15m_6h', fast: '15m', slow: '6h', description: 'Intraday Trend Continuation (11.4h avg TP, 8.4% DD)' },
  { id: '15m_1d', fast: '15m', slow: '1d', description: 'Daily Baseline Shield (0 liq market-wide)' },
  { id: '1m_6h', fast: '1m', slow: '6h', description: 'Micro Dip vs Macro Trend (12.2% DD)' },
  { id: '1m_12h', fast: '1m', slow: '12h', description: 'Micro Dip vs 12h Trend (14.2% DD)' },
  { id: '3m_6h', fast: '3m', slow: '6h', description: 'Micro Dip vs 6h Trend (11.9% DD)' },
  { id: '1h_15m', fast: '1h', slow: '15m', description: 'High-Volume Momentum Shift (23.8% DD)' },
  { id: '30m_1h', fast: '30m', slow: '1h', description: 'Intermediate Swing Shift (30.8% DD)' },
]);

/**
 * Compact Core-6 subset for conservative or lower-frequency trading
 */
const CORE_6 = Object.freeze([
  { id: '5m_15m', fast: '5m', slow: '15m', description: 'High-Volume Core Intraday Engine' },
  { id: '30m_12h', fast: '30m', slow: '12h', description: 'Fast Sniper Reversal (5.1h avg TP, 4.4% DD)' },
  { id: '1h_6h', fast: '1h', slow: '6h', description: 'Flawless Market Anchor (10.5h avg TP, 5.7% DD)' },
  { id: '15m_6h', fast: '15m', slow: '6h', description: 'Intraday Trend Continuation (11.4h avg TP, 8.4% DD)' },
  { id: '15m_1d', fast: '15m', slow: '1d', description: 'Daily Baseline Shield (0 liq market-wide)' },
  { id: '1m_6h', fast: '1m', slow: '6h', description: 'Micro Dip vs Macro Trend (12.2% DD)' },
]);

/**
 * Resolves a pair configuration string or array into validated pair objects.
 * Defaults to OPTIMAL_12 if not specified.
 *
 * @param {string|Array} config - e.g. 'OPTIMAL_12', 'CORE_6', or '5m_15m,1h_6h'
 * @returns {Array<{id: string, fast: string, slow: string, description: string}>}
 */
function resolvePairs(config) {
  if (!config || config === 'OPTIMAL_12' || config === 'DEFAULT') {
    return [...OPTIMAL_12];
  }
  if (config === 'CORE_6') {
    return [...CORE_6];
  }
  if (Array.isArray(config)) {
    return config.map(item => {
      if (typeof item === 'string') return parsePairId(item);
      return item;
    }).filter(Boolean);
  }
  if (typeof config === 'string') {
    return config.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(id => parsePairId(id))
      .filter(Boolean);
  }
  return [...OPTIMAL_12];
}

/**
 * Parses pair identifier like '5m_15m' or '5m crosses down 15m'
 */
function parsePairId(str) {
  if (!str) return null;
  // Match '5m_15m' or '5m crosses down 15m'
  const match = str.match(/([0-9]+[mhd])[_ \ta-zA-Z]+([0-9]+[mhd])/i);
  if (!match) return null;
  const fast = match[1].toLowerCase();
  const slow = match[2].toLowerCase();
  if (!TIMEFRAME_MINUTES[fast] || !TIMEFRAME_MINUTES[slow]) return null;
  const canonicalId = `${fast}_${slow}`;
  const known = OPTIMAL_12.find(p => p.id === canonicalId);
  return {
    id: canonicalId,
    fast,
    slow,
    description: known ? known.description : `${fast} crosses down ${slow}`
  };
}

/**
 * Normalizes candle object to standard { time, open, high, low, close, volume }
 */
function normalizeCandle(c) {
  if (!c) return null;
  const time = Number(c.time ?? c.t);
  const open = Number(c.open ?? c.o);
  const high = Number(c.high ?? c.h);
  const low = Number(c.low ?? c.l);
  const close = Number(c.close ?? c.c);
  const volume = Number(c.volume ?? c.v ?? 0);

  if (!Number.isFinite(time) || !Number.isFinite(close)) return null;

  return { time, open, high, low, close, volume };
}

/**
 * Aggregates an array of 1m candles into higher-timeframe candles (3m, 5m, 15m, 30m).
 *
 * @param {Array} candles1m - Raw 1m candles
 * @param {number} targetTfMinutes - Target interval in minutes (e.g. 5 for 5m)
 * @param {Object} [options]
 * @param {boolean} [options.completedOnly=true] - Only return completed candles
 * @param {number} [options.referenceTime] - Optional reference timestamp (defaults to Date.now())
 * @returns {Array<{time: number, open: number, high: number, low: number, close: number, volume: number}>}
 */
function aggregate1mCandles(candles1m, targetTfMinutes, options = {}) {
  if (!Array.isArray(candles1m) || candles1m.length === 0) return [];

  const targetMinutes = Number(targetTfMinutes);
  if (!targetMinutes || targetMinutes <= 0) return [];
  const intervalMs = targetMinutes * 60 * 1000;
  const completedOnly = options.completedOnly !== false;
  const refTime = options.referenceTime != null ? Number(options.referenceTime) : null;

  // Filter and normalize
  const valid = [];
  for (let i = 0; i < candles1m.length; i++) {
    const norm = normalizeCandle(candles1m[i]);
    if (norm) valid.push(norm);
  }
  valid.sort((a, b) => a.time - b.time);

  if (valid.length === 0) return [];

  const buckets = new Map();

  for (let i = 0; i < valid.length; i++) {
    const c = valid[i];
    const bucketTime = Math.floor(c.time / intervalMs) * intervalMs;

    let b = buckets.get(bucketTime);
    if (!b) {
      b = {
        time: bucketTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        lastTime: c.time
      };
      buckets.set(bucketTime, b);
    } else {
      if (c.high > b.high) b.high = c.high;
      if (c.low < b.low) b.low = c.low;
      b.close = c.close; // updated by chronological order
      b.volume += c.volume;
      if (c.time > b.lastTime) b.lastTime = c.time;
    }
  }

  const result = Array.from(buckets.values());
  result.sort((a, b) => a.time - b.time);

  if (completedOnly) {
    if (refTime != null) {
      // Completed strictly before or at refTime
      return result.filter(b => (b.time + intervalMs) <= refTime);
    } else {
      // If no refTime provided, drop the latest bucket if it could still be in-progress
      const now = Date.now();
      return result.filter(b => (b.time + intervalMs) <= now);
    }
  }

  return result.map(({ lastTime, ...rest }) => rest);
}

/**
 * Computes Middle Bollinger Band (20 SMA) and standard deviation upper/lower bands.
 * Matches optimizer logic 1:1.
 *
 * @param {Array} candles - Array of candles
 * @param {number} [period=20] - SMA period
 * @returns {Array<null|{time: number, mean: number, middle: number, upper: number, lower: number, stdDev: number}>}
 */
function computeBollinger(candles, period = BB_PERIOD) {
  if (!Array.isArray(candles)) return [];
  const n = candles.length;
  const bands = new Array(n).fill(null);
  if (n < period) return bands;

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const c = normalizeCandle(candles[j]);
      if (!c) {
        sum = NaN;
        break;
      }
      sum += c.close;
    }
    if (Number.isNaN(sum)) continue;

    const mean = sum / period;

    // Standard deviation
    let varianceSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const c = normalizeCandle(candles[j]);
      const diff = c.close - mean;
      varianceSum += diff * diff;
    }
    const stdDev = Math.sqrt(varianceSum / period);
    const time = (candles[i].time != null) ? candles[i].time : (candles[i].t || 0);

    bands[i] = {
      time,
      mean,
      middle: mean,
      upper: mean + 2 * stdDev,
      lower: mean - 2 * stdDev,
      stdDev
    };
  }

  return bands;
}

/**
 * Aligns higher-timeframe Bollinger Bands to a 1m candle timeline.
 * Ported 1:1 from grid_bot_optimizer.js.
 *
 * @param {Array} candles1m - 1m timeline candles
 * @param {Array} candlesHigher - Higher-TF candles
 * @param {Array} rawBandsHigher - Precomputed Bollinger Bands for candlesHigher
 * @param {number} intervalMs - Higher-TF interval in milliseconds
 * @returns {Array<null|object>} Aligned band at each 1m candle index
 */
function alignTfBandsTo1m(candles1m, candlesHigher, rawBandsHigher, intervalMs) {
  const n = candles1m.length;
  const aligned = new Array(n).fill(null);
  if (!candles1m.length || !candlesHigher.length || !rawBandsHigher.length) return aligned;

  const bandMap = new Map();
  for (let k = 0; k < candlesHigher.length; k++) {
    const b = rawBandsHigher[k];
    if (b) {
      const t = candlesHigher[k].time != null ? candlesHigher[k].time : candlesHigher[k].t;
      bandMap.set(t, b);
    }
  }

  let kIdx = 0;
  for (let i = 0; i < n; i++) {
    const t = candles1m[i].time != null ? candles1m[i].time : candles1m[i].t;
    const bucketT = Math.floor(t / intervalMs) * intervalMs;
    if (bandMap.has(bucketT)) {
      aligned[i] = bandMap.get(bucketT);
    } else {
      while (kIdx + 1 < candlesHigher.length) {
        const nextT = candlesHigher[kIdx + 1].time != null ? candlesHigher[kIdx + 1].time : candlesHigher[kIdx + 1].t;
        if (nextT <= t) kIdx++;
        else break;
      }
      const curT = candlesHigher[kIdx].time != null ? candlesHigher[kIdx].time : candlesHigher[kIdx].t;
      if (candlesHigher[kIdx] && curT <= t) {
        aligned[i] = rawBandsHigher[kIdx] || null;
      } else {
        aligned[i] = null;
      }
    }
  }
  return aligned;
}

/**
 * Evaluates whether Fast TF crossed DOWN Slow TF at a specific point in time.
 *
 * Mathematical condition:
 * (Fast_SMA_prev >= Slow_SMA_prev) AND (Fast_SMA_curr < Slow_SMA_curr)
 *
 * @param {Object} params
 * @param {Array} params.fastCandles - Completed candles for Fast timeframe
 * @param {Array} params.slowCandles - Completed candles for Slow timeframe
 * @param {number} [params.period=20]
 * @returns {null|{crossed: boolean, fastPrev: number, fastCurr: number, slowPrev: number, slowCurr: number, triggerPrice: number}}
 */
function evaluatePairCrossover({ fastCandles, slowCandles, period = BB_PERIOD }) {
  if (!Array.isArray(fastCandles) || !Array.isArray(slowCandles)) return null;
  if (fastCandles.length < period + 1 || slowCandles.length < period + 1) return null;

  const fastBands = computeBollinger(fastCandles, period);
  const slowBands = computeBollinger(slowCandles, period);

  const fastCurrBand = fastBands[fastBands.length - 1];
  const fastPrevBand = fastBands[fastBands.length - 2];
  const slowCurrBand = slowBands[slowBands.length - 1];
  const slowPrevBand = slowBands[slowBands.length - 2];

  if (!fastCurrBand || !fastPrevBand || !slowCurrBand || !slowPrevBand) return null;

  const fastPrev = fastPrevBand.mean;
  const fastCurr = fastCurrBand.mean;
  const slowPrev = slowPrevBand.mean;
  const slowCurr = slowCurrBand.mean;

  const crossed = (fastPrev >= slowPrev) && (fastCurr < slowCurr);
  const lastFast = normalizeCandle(fastCandles[fastCandles.length - 1]);
  const triggerPrice = lastFast ? lastFast.close : fastCurr;

  return {
    crossed,
    fastPrev,
    fastCurr,
    slowPrev,
    slowCurr,
    triggerPrice
  };
}

/**
 * Returns the Bollinger Band of the most recently COMPLETED candle for a timeframe
 * as of evaluation timestamp `evalTimeMs` (i.e. candle.time + intervalMs <= evalTimeMs).
 *
 * @param {Array} candles - Chronologically sorted candles for the timeframe
 * @param {Array} rawBands - Precomputed Bollinger Bands aligned 1:1 with `candles`
 * @param {number} intervalMs - Timeframe duration in milliseconds
 * @param {number} evalTimeMs - Evaluation timestamp (close-time boundary)
 * @returns {null|object}
 */
function getBandAtCloseTime(candles, rawBands, intervalMs, evalTimeMs) {
  if (!Array.isArray(candles) || !Array.isArray(rawBands) || candles.length === 0) return null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const t = candles[i].time != null ? candles[i].time : candles[i].t;
    if ((t + intervalMs) <= evalTimeMs) {
      return rawBands[i] || null;
    }
  }
  return null;
}

/**
 * Checks all active pairs for a symbol against multi-TF candle store.
 *
 * Uses close-time synchronized sampling: compares the latest COMPLETED candle of
 * both Fast and Slow timeframes as of `evalCurr` against their state one `stepMs`
 * earlier (`evalPrev = evalCurr - stepMs`). This guarantees every timeframe
 * (1m, 3m, 5m, 15m, 30m, 1h, 4h, 6h, 12h, 1d) transitions cleanly on its exact
 * close boundary without lookahead or duplicate fires.
 *
 * @param {Object} params
 * @param {string} params.symbol - e.g. 'KMNOUSDT'
 * @param {Object<string, Array>} params.candlesByTf - Map of timeframe label to candles array
 * @param {Array|string} [params.pairs] - Portfolio config (defaults to OPTIMAL_12)
 * @param {number} [params.period=20]
 * @param {number} [params.referenceTime] - Evaluation timestamp (defaults to latest 1m close or Date.now())
 * @param {number} [params.stepMs=60000] - Comparison step window in ms (60000 for 1m ticker, 900000 for 15m cycle)
 * @returns {Array<object>} Array of triggered crossover signals
 */
function evaluateSymbolCrossovers({
  symbol,
  candlesByTf,
  pairs = OPTIMAL_12,
  period = BB_PERIOD,
  referenceTime = null,
  stepMs = 60 * 1000
}) {
  if (!symbol || !candlesByTf) return [];

  const activePairs = resolvePairs(pairs);
  const signals = [];
  const c1m = candlesByTf['1m'];

  if (Array.isArray(c1m) && c1m.length >= 25) {
    const last1m = normalizeCandle(c1m[c1m.length - 1]);
    const refMs = referenceTime != null ? Number(referenceTime) : (last1m ? last1m.time + 60 * 1000 : Date.now());
    const step = Math.max(60 * 1000, Number(stepMs) || 60 * 1000);
    const evalCurr = Math.floor(refMs / step) * step;
    const evalPrev = evalCurr - step;

    // Precompute Bollinger Bands once per needed timeframe
    const rawBandsByTf = {};
    const neededTfs = new Set();
    for (const p of activePairs) {
      neededTfs.add(p.fast);
      neededTfs.add(p.slow);
    }

    for (const tf of neededTfs) {
      const cList = candlesByTf[tf];
      if (Array.isArray(cList) && cList.length >= period) {
        rawBandsByTf[tf] = computeBollinger(cList, period);
      }
    }

    // Trigger price = close of most recently completed 1m candle at or before evalCurr
    let triggerCandle = last1m;
    for (let i = c1m.length - 1; i >= 0; i--) {
      const nc = normalizeCandle(c1m[i]);
      if (nc && (nc.time + 60 * 1000) <= evalCurr) {
        triggerCandle = nc;
        break;
      }
    }

    for (const pair of activePairs) {
      const fastCandles = candlesByTf[pair.fast];
      const slowCandles = candlesByTf[pair.slow];
      const fastBands = rawBandsByTf[pair.fast];
      const slowBands = rawBandsByTf[pair.slow];
      if (!fastBands || !slowBands) continue;

      const fastIntMs = (TIMEFRAME_MINUTES[pair.fast] || 1) * 60 * 1000;
      const slowIntMs = (TIMEFRAME_MINUTES[pair.slow] || 1) * 60 * 1000;

      const fastCurrBand = getBandAtCloseTime(fastCandles, fastBands, fastIntMs, evalCurr);
      const fastPrevBand = getBandAtCloseTime(fastCandles, fastBands, fastIntMs, evalPrev);
      const slowCurrBand = getBandAtCloseTime(slowCandles, slowBands, slowIntMs, evalCurr);
      const slowPrevBand = getBandAtCloseTime(slowCandles, slowBands, slowIntMs, evalPrev);

      if (fastCurrBand && fastPrevBand && slowCurrBand && slowPrevBand) {
        const fastPrev = fastPrevBand.mean;
        const slowPrev = slowPrevBand.mean;
        const fastCurr = fastCurrBand.mean;
        const slowCurr = slowCurrBand.mean;

        if (fastPrev >= slowPrev && fastCurr < slowCurr) {
          const triggerPrice = triggerCandle ? triggerCandle.close : fastCurr;
          signals.push({
            symbol,
            signalType: 'BB_CROSSOVER',
            pairId: pair.id,
            fastTf: pair.fast,
            slowTf: pair.slow,
            description: pair.description,
            fastSma: fastCurr,
            slowSma: slowCurr,
            fastSmaPrev: fastPrev,
            slowSmaPrev: slowPrev,
            triggerPrice,
            candleCloseIso: new Date(evalCurr).toISOString(),
            timestamp: refMs
          });
        }
      }
    }

    return signals;
  }

  const refMs = referenceTime || Date.now();
  // Fallback if 1m is not provided (e.g. legacy synthetic unit tests)
  for (const pair of activePairs) {
    const fastCandles = candlesByTf[pair.fast];
    const slowCandles = candlesByTf[pair.slow];

    if (!fastCandles || !slowCandles) continue;

    const evalResult = evaluatePairCrossover({
      fastCandles,
      slowCandles,
      period
    });

    if (evalResult && evalResult.crossed) {
      signals.push({
        symbol,
        signalType: 'BB_CROSSOVER',
        pairId: pair.id,
        fastTf: pair.fast,
        slowTf: pair.slow,
        description: pair.description,
        fastSma: evalResult.fastCurr,
        slowSma: evalResult.slowCurr,
        fastSmaPrev: evalResult.fastPrev,
        slowSmaPrev: evalResult.slowPrev,
        triggerPrice: evalResult.triggerPrice,
        candleCloseIso: new Date(refMs).toISOString(),
        timestamp: refMs
      });
    }
  }

  return signals;
}

module.exports = {
  BB_PERIOD,
  TIMEFRAME_MINUTES,
  OPTIMAL_12,
  CORE_6,
  resolvePairs,
  parsePairId,
  normalizeCandle,
  aggregate1mCandles,
  computeBollinger,
  alignTfBandsTo1m,
  getBandAtCloseTime,
  evaluatePairCrossover,
  evaluateSymbolCrossovers,
};
