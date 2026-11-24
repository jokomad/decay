/**
 * scripts/test_crossover_direction_deepdive.js
 * 
 * In-depth comparative analysis of "Crossed UP" vs "Crossed DOWN"
 * specifically answering:
 * 1. For active bots (NIGHT, MAGIC, SOON, ZAMA, SOXS):
 *    - Would Crossed UP have finished faster?
 *    - Would Crossed UP have failed or suffered worse drawdowns?
 * 2. For completed bots (SKR, SHELL, SENT, SQQQ, ARIA):
 *    - Did Crossed UP give higher entry prices and faster exits?
 * 3. For the catastrophic traps (CTR on Nov 16, ARIA on Nov 17):
 *    - What happened when Fast crossed UP Slow during an aggressive pump?
 *    - Did Crossed UP trigger at the start of the pump, causing massive liquidation risk?
 */

const https = require('https');

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

const TF_MAP = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D'
};

async function fetchNativeKlines(symbol, tf, limit = 200, endTime = null) {
  const bybitTf = TF_MAP[tf] || tf;
  let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitTf}&limit=${limit}`;
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

function computeSma(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Simulate Short Grid Bot execution against 1m or 5m price action
function simulateShortGrid(candles, startIdx, entryPrice) {
  const targetTpPrice = entryPrice * (1 - 0.0125); // -1.25% drop to capture +$1.00 USDT profit
  let maxPumpPct = 0;
  let hitTp = false;
  let timeToTpMinutes = 0;

  for (let i = startIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    const pumpPct = ((c.high - entryPrice) / entryPrice) * 100;
    if (pumpPct > maxPumpPct) maxPumpPct = pumpPct;

    if (c.low <= targetTpPrice) {
      hitTp = true;
      timeToTpMinutes = Math.round((c.time - candles[startIdx].time) / 60000);
      break;
    }
  }

  const durationHours = (timeToTpMinutes / 60).toFixed(1);
  return {
    hitTp,
    timeToTpMinutes,
    durationHours: Number(durationHours),
    maxPumpPct: Number(maxPumpPct.toFixed(2)),
    entryPrice,
    targetTpPrice: Number(targetTpPrice.toFixed(6))
  };
}

async function analyzePair(symbol, fastTf, slowTf, endTime = null) {
  const [fastCandles, slowCandles, m1Candles] = await Promise.all([
    fetchNativeKlines(symbol, fastTf, 250, endTime),
    fetchNativeKlines(symbol, slowTf, 250, endTime),
    fetchNativeKlines(symbol, '1m', 1000, endTime)
  ]);

  if (fastCandles.length < 25 || slowCandles.length < 25) {
    return { error: 'Insufficient candles' };
  }

  // Pre-calculate 20 SMA series for fast and slow timeframes
  const fastSmas = fastCandles.map((c, i) => {
    const slice = fastCandles.slice(0, i + 1);
    return { time: c.time, close: c.close, sma: computeSma(slice.map(x => x.close), 20) };
  });

  const slowSmas = slowCandles.map((c, i) => {
    const slice = slowCandles.slice(0, i + 1);
    return { time: c.time, close: c.close, sma: computeSma(slice.map(x => x.close), 20) };
  });

  // Step through fast candles and match slow SMA at each close
  const downSignals = [];
  const upSignals = [];

  for (let i = 21; i < fastSmas.length; i++) {
    const fCurr = fastSmas[i];
    const fPrev = fastSmas[i - 1];
    if (!fCurr.sma || !fPrev.sma) continue;

    // Find the latest completed slow SMA at or before fCurr.time and fPrev.time
    const sCurrMatch = slowSmas.filter(s => s.time <= fCurr.time && s.sma !== null).pop();
    const sPrevMatch = slowSmas.filter(s => s.time <= fPrev.time && s.sma !== null).pop();

    if (!sCurrMatch || !sPrevMatch) continue;

    const fastPrev = fPrev.sma;
    const fastCurr = fCurr.sma;
    const slowPrev = sPrevMatch.sma;
    const slowCurr = sCurrMatch.sma;

    // 1. Crossed DOWN: Fast drops below Slow
    if (fastPrev >= slowPrev && fastCurr < slowCurr) {
      downSignals.push({
        time: fCurr.time,
        timeIso: new Date(fCurr.time).toISOString(),
        price: fCurr.close,
        fastSma: fastCurr,
        slowSma: slowCurr
      });
    }

    // 2. Crossed UP: Fast rises above Slow
    if (fastPrev <= slowPrev && fastCurr > slowCurr) {
      upSignals.push({
        time: fCurr.time,
        timeIso: new Date(fCurr.time).toISOString(),
        price: fCurr.close,
        fastSma: fastCurr,
        slowSma: slowCurr
      });
    }
  }

  // Simulate execution of all signals
  const evalSignals = (signals) => {
    let tpCount = 0;
    let totalMinutes = 0;
    let maxDrawdown = 0;
    const records = [];

    signals.forEach(sig => {
      // Find candle in m1 or fastCandles
      const startIdx = m1Candles.findIndex(c => c.time >= sig.time);
      if (startIdx !== -1) {
        const sim = simulateShortGrid(m1Candles, startIdx, sig.price);
        if (sim.hitTp) {
          tpCount++;
          totalMinutes += sim.timeToTpMinutes;
        }
        if (sim.maxPumpPct > maxDrawdown) maxDrawdown = sim.maxPumpPct;
        records.push({
          timeIso: sig.timeIso,
          price: sig.price,
          ...sim
        });
      }
    });

    return {
      total: signals.length,
      tpCount,
      winRatePct: signals.length ? Math.round((tpCount / signals.length) * 100) : 0,
      avgDurationHours: tpCount ? Number((totalMinutes / tpCount / 60).toFixed(1)) : null,
      maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
      records
    };
  };

  return {
    down: evalSignals(downSignals),
    up: evalSignals(upSignals)
  };
}

async function main() {
  console.log('================================================================');
  console.log('📊 EMPIRICAL COMPARISON: CROSSED DOWN vs CROSSED UP ON BYBIT DATA');
  console.log('================================================================\n');

  // 1. Current Active Bots
  console.log('>>> 1. CURRENT RUNNING BOTS ON NORTHFLANK:');
  const activeBots = [
    { symbol: 'NIGHTUSDT', fast: '5m', slow: '15m' },
    { symbol: 'MAGICUSDT', fast: '4h', slow: '6h' },
    { symbol: 'SOXSUSDT',  fast: '5m', slow: '15m' }
  ];

  for (const b of activeBots) {
    const res = await analyzePair(b.symbol, b.fast, b.slow);
    console.log(`\n🔹 ${b.symbol} (${b.fast} vs ${b.slow}):`);
    console.log(`   📉 CROSSED DOWN: ${res.down.tpCount}/${res.down.total} TP (${res.down.winRatePct}%) | Avg Duration: ${res.down.avgDurationHours ?? '--'}h | Max Drawdown: +${res.down.maxDrawdownPct}%`);
    console.log(`   📈 CROSSED UP:   ${res.up.tpCount}/${res.up.total} TP (${res.up.winRatePct}%) | Avg Duration: ${res.up.avgDurationHours ?? '--'}h | Max Drawdown: +${res.up.maxDrawdownPct}%`);
    
    // Compare latest signal
    const lastDown = res.down.records.slice(-1)[0];
    const lastUp = res.up.records.slice(-1)[0];
    if (lastDown) console.log(`      Latest DOWN: Entry $${lastDown.price} (${lastDown.timeIso.substring(11, 16)}) -> ${lastDown.hitTp ? `TP in ${lastDown.durationHours}h` : `Open (Max DD +${lastDown.maxPumpPct}%)`}`);
    if (lastUp)   console.log(`      Latest UP:   Entry $${lastUp.price} (${lastUp.timeIso.substring(11, 16)}) -> ${lastUp.hitTp ? `TP in ${lastUp.durationHours}h` : `Open (Max DD +${lastUp.maxPumpPct}%)`}`);
  }

  // 2. Finished Completed Bots
  console.log('\n\n>>> 2. COMPLETED PROFITABLE BOTS ON NORTHFLANK:');
  const finishedBots = [
    { symbol: 'SKRUSDT',   fast: '5m', slow: '15m' },
    { symbol: 'SHELLUSDT', fast: '5m', slow: '15m' },
    { symbol: 'SENTUSDT',  fast: '15m', slow: '1h' },
    { symbol: 'SQQQUSDT',  fast: '5m', slow: '15m' },
    { symbol: 'ARIAUSDT',  fast: '5m', slow: '15m' }
  ];

  for (const b of finishedBots) {
    const res = await analyzePair(b.symbol, b.fast, b.slow);
    console.log(`\n🔹 ${b.symbol} (${b.fast} vs ${b.slow}):`);
    console.log(`   📉 CROSSED DOWN: ${res.down.tpCount}/${res.down.total} TP (${res.down.winRatePct}%) | Avg Duration: ${res.down.avgDurationHours ?? '--'}h | Max Drawdown: +${res.down.maxDrawdownPct}%`);
    console.log(`   📈 CROSSED UP:   ${res.up.tpCount}/${res.up.total} TP (${res.up.winRatePct}%) | Avg Duration: ${res.up.avgDurationHours ?? '--'}h | Max Drawdown: +${res.up.maxDrawdownPct}%`);
  }

  // 3. The Dangerous Pump Traps (CTR & ARIA on Nov 16-18)
  console.log('\n\n>>> 3. THE HISTORICAL PUMP TRAPS (CTR & ARIA SQUEEZES):');
  const trapEndTime = new Date('2026-11-18T00:00:00Z').getTime();
  for (const b of [{ symbol: 'CTRUSDT', fast: '5m', slow: '15m' }, { symbol: 'ARIAUSDT', fast: '5m', slow: '15m' }]) {
    const res = await analyzePair(b.symbol, b.fast, b.slow, trapEndTime);
    console.log(`\n⚠️  ${b.symbol} DURING NOV 16-18 SQUEEZE:`);
    console.log(`   📉 CROSSED DOWN: ${res.down.tpCount}/${res.down.total} TP (${res.down.winRatePct}%) | Avg Duration: ${res.down.avgDurationHours ?? '--'}h | Max Drawdown: +${res.down.maxDrawdownPct}%`);
    console.log(`   📈 CROSSED UP:   ${res.up.tpCount}/${res.up.total} TP (${res.up.winRatePct}%) | Avg Duration: ${res.up.avgDurationHours ?? '--'}h | Max Drawdown: +${res.up.maxDrawdownPct}%`);
  }
}

main().catch(console.error);
