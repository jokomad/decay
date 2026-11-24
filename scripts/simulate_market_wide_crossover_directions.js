/**
 * scripts/simulate_market_wide_crossover_directions.js
 * 
 * Multi-Symbol Statistical Comparison:
 * Evaluates 10 liquid volatile Bybit linear pairs across 500+ candles:
 * 1. Strategy A: CROSSED DOWN (Current: Fast crosses below Slow)
 * 2. Strategy B: CROSSED UP (User's Theory: Fast crosses above Slow)
 * 3. Strategy C: HYBRID (Crossed UP, but only when Macro Trend is Bearish/Flat)
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

async function fetchKlines(symbol, interval, limit = 1000) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
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

function simulateTrade(candles1m, startIdx, entryPrice) {
  const tpPrice = entryPrice * (1 - 0.0125); // 1.25% drop for Take Profit
  let maxPumpPct = 0;
  let hitTp = false;
  let timeMinutes = 0;

  for (let i = startIdx + 1; i < candles1m.length; i++) {
    const c = candles1m[i];
    const pump = ((c.high - entryPrice) / entryPrice) * 100;
    if (pump > maxPumpPct) maxPumpPct = pump;

    if (c.low <= tpPrice) {
      hitTp = true;
      timeMinutes = Math.round((c.time - candles1m[startIdx].time) / 60000);
      break;
    }
  }

  return { hitTp, timeMinutes, maxPumpPct };
}

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

async function testSymbol5m15m(sym) {
  const [c5m, c1m] = await Promise.all([
    fetchKlines(sym, '5', 1000),
    fetchKlines(sym, '1', 1000)
  ]);

  if (c5m.length < 100 || c1m.length < 500) return null;

  const c15m = aggregateCandles(c5m, 3);
  const c1h = aggregateCandles(c5m, 12);

  const minLen = Math.min(c5m.length, c15m.length * 3);

  const downTrades = [];
  const upTrades = [];
  const hybridTrades = [];

  for (let i = 25; i < c5m.length - 20; i++) {
    const fCurr = computeSma(c5m.slice(0, i + 1).map(c => c.close), 20);
    const fPrev = computeSma(c5m.slice(0, i).map(c => c.close), 20);

    const m15Slice = c15m.filter(c => c.time <= c5m[i].time);
    const m15PrevSlice = c15m.filter(c => c.time <= c5m[i - 1].time);

    const sCurr = computeSma(m15Slice.map(c => c.close), 20);
    const sPrev = computeSma(m15PrevSlice.map(c => c.close), 20);

    if (!fCurr || !fPrev || !sCurr || !sPrev) continue;

    const candle = c5m[i];
    const m1Idx = c1m.findIndex(c => c.time >= candle.time);
    if (m1Idx === -1) continue;

    // Macro check for Hybrid (1H SMA slope or price vs 1H SMA)
    const h1Slice = c1h.filter(c => c.time <= candle.time);
    const h1Sma = computeSma(h1Slice.map(c => c.close), 20);
    const isMacroBearish = h1Sma ? (candle.close < h1Sma) : true;

    // 1. Crossed DOWN
    if (fPrev >= sPrev && fCurr < sCurr) {
      downTrades.push(simulateTrade(c1m, m1Idx, candle.close));
    }

    // 2. Crossed UP
    if (fPrev <= sPrev && fCurr > sCurr) {
      upTrades.push(simulateTrade(c1m, m1Idx, candle.close));
      if (isMacroBearish) {
        hybridTrades.push(simulateTrade(c1m, m1Idx, candle.close));
      }
    }
  }

  return { sym, downTrades, upTrades, hybridTrades };
}

async function run() {
  const symbols = ['SKRUSDT', 'SHELLUSDT', 'SENTUSDT', 'NIGHTUSDT', 'ARIAUSDT', 'CTRUSDT', 'SOONUSDT', 'MAGICUSDT', 'TAUSDT', 'BEAMUSDT'];
  console.log(`Analyzing 5m_15m across 10 altcoins (500-1000 candles each)...`);

  let aggDown = { total: 0, wins: 0, totalMinutes: 0, maxPump: 0 };
  let aggUp = { total: 0, wins: 0, totalMinutes: 0, maxPump: 0 };
  let aggHybrid = { total: 0, wins: 0, totalMinutes: 0, maxPump: 0 };

  for (const s of symbols) {
    const res = await testSymbol5m15m(s);
    if (!res) continue;

    const summarize = (trades) => {
      const wins = trades.filter(t => t.hitTp).length;
      const totalMinutes = trades.filter(t => t.hitTp).reduce((a, b) => a + b.timeMinutes, 0);
      const maxPump = trades.length ? Math.max(...trades.map(t => t.maxPumpPct)) : 0;
      return { total: trades.length, wins, totalMinutes, maxPump };
    };

    const d = summarize(res.downTrades);
    const u = summarize(res.upTrades);
    const h = summarize(res.hybridTrades);

    aggDown.total += d.total; aggDown.wins += d.wins; aggDown.totalMinutes += d.totalMinutes;
    if (d.maxPump > aggDown.maxPump) aggDown.maxPump = d.maxPump;

    aggUp.total += u.total; aggUp.wins += u.wins; aggUp.totalMinutes += u.totalMinutes;
    if (u.maxPump > aggUp.maxPump) aggUp.maxPump = u.maxPump;

    aggHybrid.total += h.total; aggHybrid.wins += h.wins; aggHybrid.totalMinutes += h.totalMinutes;
    if (h.maxPump > aggHybrid.maxPump) aggHybrid.maxPump = h.maxPump;

    console.log(`${s.padEnd(12)} | DOWN: ${d.wins}/${d.total} (${d.total ? Math.round(d.wins/d.total*100) : 0}%) [Avg ${d.wins ? (d.totalMinutes/d.wins/60).toFixed(1) : '-'}h, MaxDD +${d.maxPump.toFixed(1)}%] | UP: ${u.wins}/${u.total} (${u.total ? Math.round(u.wins/u.total*100) : 0}%) [Avg ${u.wins ? (u.totalMinutes/u.wins/60).toFixed(1) : '-'}h, MaxDD +${u.maxPump.toFixed(1)}%]`);
  }

  console.log('\n================================================================');
  console.log('🏆 AGGREGATE RESULTS ACROSS ALL 10 SYMBOLS:');
  console.log('================================================================');
  
  const dWinRate = (aggDown.wins / aggDown.total * 100).toFixed(1);
  const dAvgH = (aggDown.totalMinutes / aggDown.wins / 60).toFixed(1);
  console.log(`📉 STRATEGY A (CROSSED DOWN):`);
  console.log(`   Trades: ${aggDown.total} | Win Rate: ${dWinRate}% (${aggDown.wins}/${aggDown.total}) | Avg TP Time: ${dAvgH} hours | Worst Drawdown: +${aggDown.maxPump.toFixed(2)}%`);

  const uWinRate = (aggUp.wins / aggUp.total * 100).toFixed(1);
  const uAvgH = (aggUp.totalMinutes / aggUp.wins / 60).toFixed(1);
  console.log(`\n📈 STRATEGY B (CROSSED UP):`);
  console.log(`   Trades: ${aggUp.total} | Win Rate: ${uWinRate}% (${aggUp.wins}/${aggUp.total}) | Avg TP Time: ${uAvgH} hours | Worst Drawdown: +${aggUp.maxPump.toFixed(2)}%`);

  const hWinRate = (aggHybrid.wins / aggHybrid.total * 100).toFixed(1);
  const hAvgH = (aggHybrid.totalMinutes / aggHybrid.wins / 60).toFixed(1);
  console.log(`\n💎 STRATEGY C (HYBRID: Crossed UP under Bearish/Decay Macro):`);
  console.log(`   Trades: ${aggHybrid.total} | Win Rate: ${hWinRate}% (${aggHybrid.wins}/${aggHybrid.total}) | Avg TP Time: ${hAvgH} hours | Worst Drawdown: +${aggHybrid.maxPump.toFixed(2)}%`);
  console.log('================================================================');
}

run().catch(console.error);
