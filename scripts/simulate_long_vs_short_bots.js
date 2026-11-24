/**
 * scripts/simulate_long_vs_short_bots.js
 * 
 * Empirical Investigation: SHORT Grid Bot vs LONG Grid Bot
 * Evaluates all active and completed Northflank bots:
 * - At the exact moment of signal trigger (entryPrice, createdAt timestamp)
 * - Simulates SHORT bot (TP: -1.25% drop)
 * - Simulates LONG bot (TP: +1.25% rise)
 * 
 * Computes:
 * - Time to TP for Short vs Long
 * - Did Long hit TP faster, slower, or fail?
 * - Max Adverse Drawdown for Short (max pump above entry) vs Long (max dump below entry)
 * - Trapped / liquidation risks on decay tokens dumping to baseline
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

async function fetchKlinesFromTime(symbol, interval, startTimeMs, limit = 1000) {
  // Bybit kline allows start parameter
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${startTimeMs}&limit=${limit}`;
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

function evaluateBot(candles, entryPrice, entryTime) {
  const shortTp = entryPrice * (1 - 0.0125); // -1.25% drop
  const longTp  = entryPrice * (1 + 0.0125); // +1.25% rise

  let shortHit = false;
  let shortTimeMinutes = null;
  let shortMaxDdPct = 0; // max % price rose above entry

  let longHit = false;
  let longTimeMinutes = null;
  let longMaxDdPct = 0; // max % price dumped below entry

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.time < entryTime) continue;

    // --- SHORT EVALUATION ---
    if (!shortHit) {
      const adversePump = ((c.high - entryPrice) / entryPrice) * 100;
      if (adversePump > shortMaxDdPct) shortMaxDdPct = adversePump;

      if (c.low <= shortTp) {
        shortHit = true;
        shortTimeMinutes = Math.round((c.time - entryTime) / 60000);
      }
    }

    // --- LONG EVALUATION ---
    if (!longHit) {
      const adverseDump = ((entryPrice - c.low) / entryPrice) * 100;
      if (adverseDump > longMaxDdPct) longMaxDdPct = adverseDump;

      if (c.high >= longTp) {
        longHit = true;
        longTimeMinutes = Math.round((c.time - entryTime) / 60000);
      }
    }

    if (shortHit && longHit) break;
  }

  return {
    entryPrice,
    shortTp: Number(shortTp.toFixed(6)),
    longTp: Number(longTp.toFixed(6)),
    short: {
      hit: shortHit,
      minutes: shortTimeMinutes,
      hours: shortTimeMinutes !== null ? Number((shortTimeMinutes / 60).toFixed(1)) : null,
      maxDrawdownPct: Number(shortMaxDdPct.toFixed(2))
    },
    long: {
      hit: longHit,
      minutes: longTimeMinutes,
      hours: longTimeMinutes !== null ? Number((longTimeMinutes / 60).toFixed(1)) : null,
      maxDrawdownPct: Number(longMaxDdPct.toFixed(2))
    }
  };
}

async function run() {
  console.log('================================================================');
  console.log('🔬 EMPIRICAL SIMULATION: SHORT GRID BOT vs LONG GRID BOT');
  console.log('   Testing across all Northflank Active & Finished Bot Records');
  console.log('================================================================\n');

  // Fetch full bot list from Northflank
  const botData = await fetchBybit('https://site--decay--yx97lk2d86b5.code.run/api/bots');
  const activeBots = botData.bots || [];
  const historyBots = (botData.history || []).filter(b => b.symbol);

  const allBots = [
    ...activeBots.map(b => ({ ...b, category: 'ACTIVE' })),
    ...historyBots.map(b => ({ ...b, category: 'FINISHED' }))
  ];

  console.log(`Loaded ${allBots.length} bot records (${activeBots.length} Active, ${historyBots.length} Finished)\n`);

  const results = [];

  for (const bot of allBots) {
    const sym = bot.symbol;
    const entryTime = bot.createdAt;
    const entryPrice = bot.entryPrice;
    if (!sym || !entryTime || !entryPrice) continue;

    try {
      // Fetch 1m candles first (up to 1000m = ~16.6h)
      // and 5m candles (up to 1000 * 5m = ~3.5 days)
      const [c1m, c5m] = await Promise.all([
        fetchKlinesFromTime(sym, '1', entryTime, 1000),
        fetchKlinesFromTime(sym, '5', entryTime, 1000)
      ]);

      const combined = c5m.length > c1m.length ? c5m : c1m;
      if (!combined.length) {
        console.log(`⚠️ No candle data for ${sym} at ${bot.createdAtIso}`);
        continue;
      }

      const res = evaluateBot(combined, entryPrice, entryTime);
      results.push({
        symbol: sym,
        category: bot.category,
        createdAtIso: bot.createdAtIso,
        signalType: bot.signalType,
        pairId: bot.crossover?.pairId || 'SGS_1',
        actualPnl: bot.pnl,
        ...res
      });
    } catch (e) {
      console.warn(`Error analyzing ${sym}:`, e.message);
    }
  }

  // Display Table
  console.log('-----------------------------------------------------------------------------------------------------------------');
  console.log('SYMBOL    | TYPE     | STRAT    | ENTRY     | SHORT TP (Time / MaxDD)     | LONG TP (Time / MaxDD)      | WINNER');
  console.log('-----------------------------------------------------------------------------------------------------------------');

  let shortWins = 0;
  let longWins = 0;
  let ties = 0;
  let shortFaster = 0;
  let longFaster = 0;

  let totalShortMinutes = 0;
  let totalLongMinutes = 0;

  for (const r of results) {
    const sDesc = r.short.hit ? `✅ in ${r.short.hours}h (DD +${r.short.maxDrawdownPct}%)` : `❌ OPEN (DD +${r.short.maxDrawdownPct}%)`;
    const lDesc = r.long.hit  ? `✅ in ${r.long.hours}h (DD -${r.long.maxDrawdownPct}%)` : `❌ FAILED (DD -${r.long.maxDrawdownPct}%)`;

    let winner = 'TIE';
    if (r.short.hit && !r.long.hit) {
      winner = 'SHORT (Long Failed)';
      shortWins++;
    } else if (!r.short.hit && r.long.hit) {
      winner = 'LONG (Short Open)';
      longWins++;
    } else if (r.short.hit && r.long.hit) {
      if (r.short.minutes < r.long.minutes) {
        winner = `SHORT (${(r.long.minutes - r.short.minutes)}m faster)`;
        shortFaster++;
      } else if (r.long.minutes < r.short.minutes) {
        winner = `LONG (${(r.short.minutes - r.long.minutes)}m faster)`;
        longFaster++;
      } else {
        winner = 'TIE (same candle)';
        ties++;
      }
      totalShortMinutes += r.short.minutes;
      totalLongMinutes += r.long.minutes;
    } else {
      winner = 'NEITHER HIT';
    }

    console.log(
      r.symbol.padEnd(9) + ' | ' +
      r.category.padEnd(8) + ' | ' +
      r.pairId.padEnd(8) + ' | ' +
      ('$' + r.entryPrice).padEnd(9) + ' | ' +
      sDesc.padEnd(27) + ' | ' +
      lDesc.padEnd(27) + ' | ' +
      winner
    );
  }

  console.log('-----------------------------------------------------------------------------------------------------------------\n');

  console.log('================================================================');
  console.log('📊 HEAD-TO-HEAD SUMMARY STATISTICS:');
  console.log('================================================================');
  const totalEvaluated = results.length;
  const shortTotalHits = results.filter(r => r.short.hit).length;
  const longTotalHits = results.filter(r => r.long.hit).length;

  console.log(`Total Bots Evaluated:      ${totalEvaluated}`);
  console.log(`Short TP Hit Rate:         ${shortTotalHits}/${totalEvaluated} (${Math.round(shortTotalHits / totalEvaluated * 100)}%)`);
  console.log(`Long TP Hit Rate:          ${longTotalHits}/${totalEvaluated} (${Math.round(longTotalHits / totalEvaluated * 100)}%)`);
  console.log(`Cases where Long FAILED:   ${totalEvaluated - longTotalHits}`);
  console.log(`Cases Short took TP faster: ${shortFaster}`);
  console.log(`Cases Long took TP faster:  ${longFaster}`);
  console.log(`Ties (Hit on same candle): ${ties}`);

  const avgShortTime = shortTotalHits ? (results.filter(r => r.short.hit).reduce((a, b) => a + b.short.minutes, 0) / shortTotalHits / 60).toFixed(1) : '--';
  const avgLongTime  = longTotalHits  ? (results.filter(r => r.long.hit).reduce((a, b) => a + b.long.minutes, 0) / longTotalHits / 60).toFixed(1) : '--';

  console.log(`Average Time to TP (Short): ${avgShortTime} hours`);
  console.log(`Average Time to TP (Long):  ${avgLongTime} hours`);

  // Max Drawdown comparison
  const avgShortDd = (results.reduce((a, b) => a + b.short.maxDrawdownPct, 0) / totalEvaluated).toFixed(2);
  const avgLongDd  = (results.reduce((a, b) => a + b.long.maxDrawdownPct, 0) / totalEvaluated).toFixed(2);
  const maxShortDd = Math.max(...results.map(r => r.short.maxDrawdownPct)).toFixed(2);
  const maxLongDd  = Math.max(...results.map(r => r.long.maxDrawdownPct)).toFixed(2);

  console.log(`Average Adverse Drawdown:  Short: +${avgShortDd}%  vs  Long: -${avgLongDd}%`);
  console.log(`Worst-Case Max Drawdown:   Short: +${maxShortDd}%  vs  Long: -${maxLongDd}%`);
  console.log('================================================================');
}

run().catch(console.error);
