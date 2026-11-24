/**
 * scripts/simulate_crossover_direction.js
 * 
 * Local simulation & comparative backtest:
 * Compares "Crossed DOWN" (Fast SMA crosses below Slow SMA)
 * vs "Crossed UP" (Fast SMA crosses above Slow SMA)
 * for Short Grid Bot entries.
 * 
 * Analyzes:
 * 1. The exact live and finished Northflank bots:
 *    - NIGHTUSDT, MAGICUSDT, SKRUSDT, SHELLUSDT, SENTUSDT, SQQQUSDT, ARIAUSDT, CTRUSDT
 * 2. Metrics per strategy:
 *    - Average Time to TP (-1.25% price drop)
 *    - Win Rate (% reaching TP)
 *    - Maximum Adverse Excursion (Max Drawdown / pump against short)
 *    - Trade frequency & entry price advantage (did Cross UP sell higher?)
 */

const https = require('https');
const CrossoverIndicator = require('../lib/crossoverIndicator');

function fetchBybit(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetchKlines(symbol, interval, limit = 1000, endTime = null) {
  let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (endTime) url += `&end=${endTime}`;
  const res = await fetchBybit(url);
  const raw = res?.result?.list || [];
  return raw.map(c => ({
    time: parseInt(c[0]),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  })).sort((a, b) => a.time - b.time);
}

// Synthesize larger timeframe candles from smaller timeframe candles
function aggregateCandles(candles, factor) {
  const result = [];
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    if (chunk.length < factor) continue;
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((a, c) => a + c.volume, 0)
    });
  }
  return result;
}

function computeSma(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Simulate Short Grid Bot execution from a given entry timestamp and price
function simulateShortGrid(candles1m, entryIdx, entryPrice) {
  const targetTpPrice = entryPrice * (1 - 0.0125); // -1.25% drop to hit Take Profit (+$1.00 USDT)
  let maxPumpAboveEntryPct = 0;
  let hitTp = false;
  let timeToTpMinutes = 0;
  let exitPrice = null;

  for (let i = entryIdx + 1; i < candles1m.length; i++) {
    const c = candles1m[i];
    const pumpPct = ((c.high - entryPrice) / entryPrice) * 100;
    if (pumpPct > maxPumpAboveEntryPct) {
      maxPumpAboveEntryPct = pumpPct;
    }

    // Check if candle low reached or breached TP
    if (c.low <= targetTpPrice) {
      hitTp = true;
      timeToTpMinutes = Math.round((c.time - candles1m[entryIdx].time) / 60000);
      exitPrice = targetTpPrice;
      break;
    }
  }

  const durationHours = (timeToTpMinutes / 60).toFixed(1);
  return {
    hitTp,
    timeToTpMinutes,
    durationHours: Number(durationHours),
    maxPumpAboveEntryPct: Number(maxPumpAboveEntryPct.toFixed(2)),
    entryPrice,
    targetTpPrice: Number(targetTpPrice.toFixed(6))
  };
}

async function runInvestigation() {
  console.log('================================================================');
  console.log('🔬 DEEP-DIVE EXPERIMENT: CROSSED DOWN vs CROSSED UP FOR SHORT GRIDS');
  console.log('================================================================\n');

  // Symbols from live Northflank bots:
  const testCases = [
    { symbol: 'NIGHTUSDT', pairId: '5m_15m', fastTf: '5m', slowTf: '15m', liveEntry: 0.04419, liveTimeIso: '2026-11-22T05:45:03Z', status: 'RUNNING (PnL: -4.74)' },
    { symbol: 'MAGICUSDT', pairId: '4h_6h',  fastTf: '4h', slowTf: '6h',  liveEntry: 0.06462, liveTimeIso: '2026-11-21T08:01:36Z', status: 'RUNNING (PnL: -0.72)' },
    { symbol: 'SKRUSDT',   pairId: '5m_15m', fastTf: '5m', slowTf: '15m', liveEntry: 0.009994, liveTimeIso: '2026-11-21T10:30:03Z', status: 'COMPLETED (1d 3h, +$1.01)' },
    { symbol: 'SHELLUSDT', pairId: '5m_15m', fastTf: '5m', slowTf: '15m', liveEntry: 0.02392, liveTimeIso: '2026-11-21T13:55:03Z', status: 'COMPLETED (15h 48m, +$1.03)' },
    { symbol: 'SENTUSDT',  pairId: '15m_1h', fastTf: '15m', slowTf: '1h', liveEntry: 0.020546, liveTimeIso: '2026-11-21T10:01:31Z', status: 'COMPLETED (14h 44m, +$1.17)' },
    { symbol: 'SQQQUSDT',  pairId: '5m_15m', fastTf: '5m', slowTf: '15m', liveEntry: 55.84, liveTimeIso: '2026-11-21T07:30:03Z', status: 'COMPLETED (6h 9m, +$1.00)' },
    { symbol: 'ARIAUSDT',  pairId: '5m_15m', fastTf: '5m', slowTf: '15m', liveEntry: 0.22553, liveTimeIso: '2026-11-21T10:00:04Z', status: 'COMPLETED (27m 37s, +$1.03)' }
  ];

  for (const tc of testCases) {
    console.log(`----------------------------------------------------------------`);
    console.log(`📌 CASE: ${tc.symbol} | Pair: ${tc.pairId} (${tc.fastTf} vs ${tc.slowTf})`);
    console.log(`   Live Bot Status: ${tc.status} | Entry: $${tc.liveEntry} at ${tc.liveTimeIso}`);
    console.log(`----------------------------------------------------------------`);

    // Fetch 1m candles covering the last 3-4 days (up to 1000 candles of 5m = 3.5 days)
    const candles5m = await fetchKlines(tc.symbol, '5', 1000);
    const candles1m = await fetchKlines(tc.symbol, '1', 1000);

    if (candles5m.length < 50) {
      console.log(`   ⚠️ Insufficient candle data for ${tc.symbol}`);
      continue;
    }

    // Synthesize TF candles from 5m or 1m
    let fastCandles = [];
    let slowCandles = [];

    if (tc.fastTf === '5m') fastCandles = candles5m;
    else if (tc.fastTf === '15m') fastCandles = aggregateCandles(candles5m, 3);
    else if (tc.fastTf === '4h') fastCandles = aggregateCandles(candles5m, 48);

    if (tc.slowTf === '15m') slowCandles = aggregateCandles(candles5m, 3);
    else if (tc.slowTf === '1h') slowCandles = aggregateCandles(candles5m, 12);
    else if (tc.slowTf === '6h') slowCandles = aggregateCandles(candles5m, 72);

    // Scan for both CROSSED DOWN and CROSSED UP events across the series
    const eventsDown = [];
    const eventsUp = [];

    // Step through candles with 20-period lookback
    const period = 20;
    const minLen = Math.min(fastCandles.length, slowCandles.length);

    for (let i = period + 2; i < minLen; i++) {
      const fastCurrSlice = fastCandles.slice(0, i);
      const fastPrevSlice = fastCandles.slice(0, i - 1);
      const slowCurrSlice = slowCandles.slice(0, i);
      const slowPrevSlice = slowCandles.slice(0, i - 1);

      const fastCurr = computeSma(fastCurrSlice.map(c => c.close), period);
      const fastPrev = computeSma(fastPrevSlice.map(c => c.close), period);
      const slowCurr = computeSma(slowCurrSlice.map(c => c.close), period);
      const slowPrev = computeSma(slowPrevSlice.map(c => c.close), period);

      if (!fastCurr || !fastPrev || !slowCurr || !slowPrev) continue;

      const candle = fastCandles[i - 1];
      const timeIso = new Date(candle.time).toISOString();

      // Condition 1: Crossed DOWN (Current system)
      // Fast was >= Slow, now Fast < Slow
      if (fastPrev >= slowPrev && fastCurr < slowCurr) {
        eventsDown.push({
          time: candle.time,
          timeIso,
          price: candle.close,
          fastCurr,
          slowCurr
        });
      }

      // Condition 2: Crossed UP (User's hypothesis)
      // Fast was <= Slow, now Fast > Slow
      if (fastPrev <= slowPrev && fastCurr > slowCurr) {
        eventsUp.push({
          time: candle.time,
          timeIso,
          price: candle.close,
          fastCurr,
          slowCurr
        });
      }
    }

    console.log(`   Events detected in history: ${eventsDown.length} Crossed DOWN | ${eventsUp.length} Crossed UP\n`);

    // Evaluate performance of Crossed DOWN signals
    console.log(`   👉 STRATEGY A: CROSSED DOWN (Fast < Slow) [Current Engine]:`);
    let downWins = 0;
    let downTotalTime = 0;
    let downMaxDd = 0;

    eventsDown.forEach((ev, idx) => {
      // Find matching 1m candle index
      const m1Idx = candles1m.findIndex(c => c.time >= ev.time);
      if (m1Idx !== -1) {
        const sim = simulateShortGrid(candles1m, m1Idx, ev.price);
        if (sim.hitTp) {
          downWins++;
          downTotalTime += sim.timeToTpMinutes;
        }
        if (sim.maxPumpAboveEntryPct > downMaxDd) downMaxDd = sim.maxPumpAboveEntryPct;
        if (idx < 3 || idx === eventsDown.length - 1) {
          console.log(`      #${idx + 1} [${ev.timeIso.substring(11, 16)}] Entry: $${ev.price} ➔ ${sim.hitTp ? `✅ TP in ${sim.durationHours}h (${sim.timeToTpMinutes}m)` : '⏳ Still Open'} | Max Drawdown: +${sim.maxPumpAboveEntryPct}%`);
        }
      }
    });

    const avgDownTime = downWins > 0 ? (downTotalTime / downWins / 60).toFixed(1) : '--';
    console.log(`      📊 Summary: ${downWins}/${eventsDown.length} TP Hits (${eventsDown.length ? Math.round(downWins / eventsDown.length * 100) : 0}%) | Avg Duration: ${avgDownTime}h | Peak Drawdown: +${downMaxDd}%\n`);

    // Evaluate performance of Crossed UP signals
    console.log(`   👉 STRATEGY B: CROSSED UP (Fast > Slow) [User Hypothesis]:`);
    let upWins = 0;
    let upTotalTime = 0;
    let upMaxDd = 0;

    eventsUp.forEach((ev, idx) => {
      const m1Idx = candles1m.findIndex(c => c.time >= ev.time);
      if (m1Idx !== -1) {
        const sim = simulateShortGrid(candles1m, m1Idx, ev.price);
        if (sim.hitTp) {
          upWins++;
          upTotalTime += sim.timeToTpMinutes;
        }
        if (sim.maxPumpAboveEntryPct > upMaxDd) upMaxDd = sim.maxPumpAboveEntryPct;
        if (idx < 3 || idx === eventsUp.length - 1) {
          console.log(`      #${idx + 1} [${ev.timeIso.substring(11, 16)}] Entry: $${ev.price} ➔ ${sim.hitTp ? `✅ TP in ${sim.durationHours}h (${sim.timeToTpMinutes}m)` : '⏳ Still Open'} | Max Drawdown: +${sim.maxPumpAboveEntryPct}%`);
        }
      }
    });

    const avgUpTime = upWins > 0 ? (upTotalTime / upWins / 60).toFixed(1) : '--';
    console.log(`      📊 Summary: ${upWins}/${eventsUp.length} TP Hits (${eventsUp.length ? Math.round(upWins / eventsUp.length * 100) : 0}%) | Avg Duration: ${avgUpTime}h | Peak Drawdown: +${upMaxDd}%\n`);
  }

  console.log('================================================================');
  console.log('🏁 COMPARISON COMPLETE');
  console.log('================================================================');
}

runInvestigation().catch(err => {
  console.error('Error in simulation:', err);
});
