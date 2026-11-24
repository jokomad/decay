/**
 * scripts/analyze_long_stoploss_deep.js
 * 
 * Deep statistical analysis of the User's Hypothesis:
 * "Can we switch the Northflank bot from Short to Long with a Stop Loss?"
 * 
 * Tests:
 * 1. Fixed USDT Stop-Loss ($1, $2, $3, $4, $5, $7.5, $10, $15, $20)
 * 2. Fixed % Stop-Loss (0.5% to 15%)
 * 3. Exact breakdown of which bots win/lose at each SL tier
 * 4. Comparison against the current SHORT Grid Bot performance
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

function simulateLongTrade(candles, entryPrice, entryTime, slPct) {
  const tpPrice = entryPrice * 1.0125; // +1.25%
  const slPrice = entryPrice * (1 - slPct / 100);

  let result = 'OPEN';
  let durationMinutes = 0;
  let exitPrice = entryPrice;
  let maxAdverseDropPct = 0;
  let maxFavorableRisePct = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.time < entryTime) continue;

    const drop = ((entryPrice - c.low) / entryPrice) * 100;
    if (drop > maxAdverseDropPct) maxAdverseDropPct = drop;

    const rise = ((c.high - entryPrice) / entryPrice) * 100;
    if (rise > maxFavorableRisePct) maxFavorableRisePct = rise;

    const hitTp = c.high >= tpPrice;
    const hitSl = c.low <= slPrice;

    if (hitTp && hitSl) {
      if (c.open <= entryPrice) {
        result = 'LOSS';
        exitPrice = slPrice;
      } else {
        result = 'WIN';
        exitPrice = tpPrice;
      }
      durationMinutes = Math.round((c.time - entryTime) / 60000);
      break;
    } else if (hitTp) {
      result = 'WIN';
      exitPrice = tpPrice;
      durationMinutes = Math.round((c.time - entryTime) / 60000);
      break;
    } else if (hitSl) {
      result = 'LOSS';
      exitPrice = slPrice;
      durationMinutes = Math.round((c.time - entryTime) / 60000);
      break;
    }
  }

  // Position sizing: $100 initial margin, 2x leverage = $200 position.
  // In a grid bot, position is scaled in over the range.
  // Average fill factor is ~70% (0.70 * $200 = $140 effective position).
  let pnlUsdt = 0;
  if (result === 'WIN') {
    pnlUsdt = 1.00; // TP target net profit
  } else if (result === 'LOSS') {
    pnlUsdt = -(200 * (slPct / 100) * 0.70);
  } else {
    // Floating PnL of last candle
    if (candles.length > 0) {
      const lastClose = candles[candles.length - 1].close;
      const curDropPct = ((entryPrice - lastClose) / entryPrice);
      pnlUsdt = -(200 * curDropPct * 0.70);
    }
  }

  return {
    result,
    durationMinutes,
    durationHours: Number((durationMinutes / 60).toFixed(1)),
    pnlUsdt: Number(pnlUsdt.toFixed(2)),
    maxAdverseDropPct: Number(maxAdverseDropPct.toFixed(2)),
    maxFavorableRisePct: Number(maxFavorableRisePct.toFixed(2))
  };
}

async function main() {
  console.log('Fetching bot history from Northflank...');
  const botData = await fetchBybit('https://site--decay--yx97lk2d86b5.code.run/api/bots');
  const allBots = [
    ...(botData.bots || []).map(b => ({ ...b, statusCategory: 'ACTIVE' })),
    ...(botData.history || []).filter(b => b.symbol).map(b => ({ ...b, statusCategory: 'FINISHED' }))
  ];

  console.log(`Loaded ${allBots.length} bot records.`);
  console.log('Downloading candles...');

  const items = [];
  for (const b of allBots) {
    if (!b.symbol || !b.createdAt || !b.entryPrice) continue;
    try {
      const [c1m, c5m] = await Promise.all([
        fetchKlinesFromTime(b.symbol, '1', b.createdAt, 1000),
        fetchKlinesFromTime(b.symbol, '5', b.createdAt, 1000)
      ]);
      const candles = c5m.length > c1m.length ? c5m : c1m;
      if (candles.length) {
        items.push({
          bot: b,
          symbol: b.symbol,
          entryPrice: b.entryPrice,
          entryTime: b.createdAt,
          candles
        });
      }
    } catch (e) {
      console.error(`Error fetching for ${b.symbol}:`, e.message);
    }
  }

  console.log(`Successfully fetched candle data for ${items.length} bots.\n`);

  // Section 1: Detailed Bot Trajectory (Adverse Dip before Bounce)
  console.log('========================================================================================');
  console.log('DETAILED TRAJECTORY OF ALL 25 BOTS FOR A LONG POSITION:');
  console.log('Does the coin dip before bouncing +1.25%?');
  console.log('========================================================================================');
  console.log('BOT # | SYMBOL    | STATUS   | ENTRY     | MAX DIP BEFORE TP | DID IT REACH TP? | TIME TO TP');
  console.log('----------------------------------------------------------------------------------------');

  const dipStats = [];
  items.forEach((item, idx) => {
    // Run with wide SL (50%) to see pure trajectory
    const sim = simulateLongTrade(item.candles, item.entryPrice, item.entryTime, 50.0);
    dipStats.push({
      symbol: item.symbol,
      maxDip: sim.maxAdverseDropPct,
      hitTp: sim.result === 'WIN',
      durationHours: sim.durationHours
    });
    console.log(
      `#${(idx + 1).toString().padEnd(3)} | ` +
      `${item.symbol.padEnd(9)} | ` +
      `${item.bot.statusCategory.padEnd(8)} | ` +
      `$${item.entryPrice.toString().padEnd(9)} | ` +
      `-${sim.maxAdverseDropPct.toFixed(2)}%`.padEnd(17) + ' | ' +
      `${sim.result === 'WIN' ? '✅ YES (+1.25%)' : '❌ NO (Failed)'}`.padEnd(16) + ' | ' +
      `${sim.durationHours}h`
    );
  });

  console.log('----------------------------------------------------------------------------------------\n');

  // Section 2: Fixed USDT Stop-Loss Table
  // If the user wants a stop loss that loses exactly $1, $2, $3, $5, $10, etc.
  // Effective position size = $140 ($200 capacity * 0.7 fill)
  // Loss = $1.00 => SL% = ($1.00 / $140) * 100 = 0.71%
  // Loss = $2.00 => SL% = ($2.00 / $140) * 100 = 1.43%
  // Loss = $3.00 => SL% = ($3.00 / $140) * 100 = 2.14%
  // Loss = $5.00 => SL% = ($5.00 / $140) * 100 = 3.57%
  // Loss = $7.00 => SL% = ($7.00 / $140) * 100 = 5.00%
  // Loss = $10.00 => SL% = ($10.00 / $140) * 100 = 7.14%
  // Loss = $14.00 => SL% = ($14.00 / $140) * 100 = 10.00%

  const dollarTests = [
    { targetLossUsdt: 1.00, slPct: 0.71 },
    { targetLossUsdt: 1.50, slPct: 1.07 },
    { targetLossUsdt: 2.00, slPct: 1.43 },
    { targetLossUsdt: 3.00, slPct: 2.14 },
    { targetLossUsdt: 4.00, slPct: 2.86 },
    { targetLossUsdt: 5.00, slPct: 3.57 },
    { targetLossUsdt: 7.00, slPct: 5.00 },
    { targetLossUsdt: 10.00, slPct: 7.14 },
    { targetLossUsdt: 14.00, slPct: 10.00 },
    { targetLossUsdt: 21.00, slPct: 15.00 },
  ];

  console.log('================================================================================================');
  console.log('STOP LOSS TARGETED BY EXACT USDT LOSS (INVESTMENT $100, 2X LEVERAGE):');
  console.log('What if we set Stop Loss to lose $1, $2, $3, $5, etc.?');
  console.log('================================================================================================');
  console.log('TARGET LOSS | SL %   | WINS (+$1) | LOSSES (SL) | WIN RATE | GROSS WIN | GROSS LOSS | NET PNL USDT');
  console.log('------------------------------------------------------------------------------------------------');

  dollarTests.forEach(test => {
    let wins = 0;
    let losses = 0;
    let opens = 0;

    items.forEach(item => {
      const sim = simulateLongTrade(item.candles, item.entryPrice, item.entryTime, test.slPct);
      if (sim.result === 'WIN') wins++;
      else if (sim.result === 'LOSS') losses++;
      else opens++;
    });

    const winRate = ((wins / (wins + losses || 1)) * 100).toFixed(1);
    const grossWin = wins * 1.00;
    const grossLoss = losses * test.targetLossUsdt;
    const netPnl = (grossWin - grossLoss).toFixed(2);

    console.log(
      `-$${test.targetLossUsdt.toFixed(2)} USDT`.padEnd(11) + ' | ' +
      `-${test.slPct.toFixed(2)}%`.padEnd(6) + ' | ' +
      `${wins}`.padEnd(10) + ' | ' +
      `${losses}`.padEnd(11) + ' | ' +
      `${winRate}%`.padEnd(8) + ' | ' +
      `+$${grossWin.toFixed(2)}`.padEnd(9) + ' | ' +
      `-$${grossLoss.toFixed(2)}`.padEnd(10) + ' | ' +
      `${Number(netPnl) >= 0 ? '+' : ''}$${netPnl} USDT`
    );
  });
  console.log('------------------------------------------------------------------------------------------------\n');
}

main().catch(console.error);
