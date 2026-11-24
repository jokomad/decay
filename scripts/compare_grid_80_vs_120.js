/**
 * scripts/compare_grid_80_vs_120.js
 */

const https = require('https');

function fetchBybit(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function fetchKlines(symbol, interval, startTime, limit = 1000) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${startTime}&limit=${limit}`;
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

function simulateGridBot(candles, entryPrice, numGrids, totalInvestment = 100, leverage = 2) {
  const minPrice = entryPrice * 0.70; // -30%
  const maxPrice = entryPrice * 1.70; // +70%
  const totalCapacity = totalInvestment * leverage; // $200
  const orderCapital = totalCapacity / numGrids; // capital per grid

  const ratio = Math.pow(maxPrice / minPrice, 1 / numGrids);
  const gridLevels = [];
  for (let i = 0; i <= numGrids; i++) {
    gridLevels.push(minPrice * Math.pow(ratio, i));
  }

  const gridStepPct = (ratio - 1) * 100;

  let shortQty = 0;
  let shortNotional = 0;
  let realizedGridProfit = 0;
  let totalGridTrades = 0;

  const levels = gridLevels.map(p => ({
    price: p,
    state: p > entryPrice ? 'SELL_SHORT_OPEN' : 'BUY_COVER_OPEN'
  }));

  const levelsBelow = levels.filter(l => l.price <= entryPrice);
  levelsBelow.forEach(l => {
    const qty = orderCapital / l.price;
    shortQty += qty;
    shortNotional += orderCapital;
  });

  let hitTp = false;
  let tpTimeMinutes = null;
  let maxPumpPct = 0;
  let finalPnl = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const pump = ((c.high - entryPrice) / entryPrice) * 100;
    if (pump > maxPumpPct) maxPumpPct = pump;

    for (const l of levels) {
      if (l.state === 'SELL_SHORT_OPEN' && c.high >= l.price) {
        const qty = orderCapital / l.price;
        shortQty += qty;
        shortNotional += orderCapital;
        l.state = 'BUY_COVER_OPEN';
        totalGridTrades++;
      }
    }

    for (const l of levels) {
      if (l.state === 'BUY_COVER_OPEN' && c.low <= l.price) {
        const buyPrice = l.price;
        const sellPrice = l.price * ratio;
        const qty = orderCapital / sellPrice;
        const profit = qty * (sellPrice - buyPrice) - (orderCapital * 0.0004);
        realizedGridProfit += Math.max(0, profit);
        shortQty = Math.max(0, shortQty - qty);
        shortNotional = Math.max(0, shortNotional - (qty * sellPrice));
        l.state = 'SELL_SHORT_OPEN';
        totalGridTrades++;
      }
    }

    const curPrice = c.close;
    const avgCost = shortQty > 0 ? shortNotional / shortQty : curPrice;
    const unrealizedPnl = shortQty * (avgCost - curPrice);
    const totalPnl = realizedGridProfit + unrealizedPnl;

    if (totalPnl >= 1.00) {
      hitTp = true;
      tpTimeMinutes = Math.round((c.time - candles[0].time) / 60000);
      finalPnl = totalPnl;
      break;
    }

    finalPnl = totalPnl;
  }

  return {
    numGrids,
    gridStepPct: Number(gridStepPct.toFixed(3)),
    orderCapitalUsdt: Number(orderCapital.toFixed(2)),
    hitTp,
    tpTimeMinutes,
    tpHours: tpTimeMinutes !== null ? Number((tpTimeMinutes / 60).toFixed(1)) : null,
    totalGridTrades,
    realizedGridProfit: Number(realizedGridProfit.toFixed(3)),
    finalPnl: Number(finalPnl.toFixed(2)),
    maxPumpPct: Number(maxPumpPct.toFixed(2))
  };
}

async function run() {
  console.log('================================================================');
  console.log('🔬 DEEP COMPARISON: 80 GRIDS vs 120 GRIDS ACROSS ALL 25 BOTS');
  console.log('================================================================\n');

  const botData = await fetchBybit('https://site--decay--yx97lk2d86b5.code.run/api/bots');
  const allBots = [
    ...(botData.bots || []).map(b => ({ ...b, category: 'ACTIVE' })),
    ...(botData.history || []).filter(b => b.symbol).map(b => ({ ...b, category: 'FINISHED' }))
  ];

  console.log(`Loaded ${allBots.length} bots from Northflank.\n`);

  console.log('-----------------------------------------------------------------------------------------------------------------');
  console.log('BOT # | SYMBOL    | STATUS   | 80 GRIDS TP | 120 GRIDS TP | 80 TRADES | 120 TRADES | VERDICT');
  console.log('-----------------------------------------------------------------------------------------------------------------');

  let faster80Count = 0;
  let faster120Count = 0;
  let tiedCount = 0;

  for (let idx = 0; idx < allBots.length; idx++) {
    const bot = allBots[idx];
    const sym = bot.symbol;
    const entryTime = bot.createdAt;
    const entryPrice = bot.entryPrice;

    const [c1m, c5m] = await Promise.all([
      fetchKlines(sym, '1', entryTime, 1000),
      fetchKlines(sym, '5', entryTime, 1000)
    ]);
    const candles = c5m.length > c1m.length ? c5m : c1m;
    if (!candles.length) continue;

    const res80 = simulateGridBot(candles, entryPrice, 80);
    const res120 = simulateGridBot(candles, entryPrice, 120);

    const time80 = res80.hitTp ? `${res80.tpHours}h` : 'STILL OPEN';
    const time120 = res120.hitTp ? `${res120.tpHours}h` : 'STILL OPEN';

    let verdict = 'TIED';
    if (res80.hitTp && !res120.hitTp) {
      verdict = '80 FASTER';
      faster80Count++;
    } else if (!res80.hitTp && res120.hitTp) {
      verdict = '120 FASTER';
      faster120Count++;
    } else if (res80.hitTp && res120.hitTp) {
      const diff = Math.abs(res120.tpTimeMinutes - res80.tpTimeMinutes);
      if (diff < 5) {
        verdict = 'IDENTICAL';
        tiedCount++;
      } else if (res80.tpTimeMinutes < res120.tpTimeMinutes) {
        verdict = `80 FASTER (-${diff}m)`;
        faster80Count++;
      } else {
        verdict = `120 FASTER (-${diff}m)`;
        faster120Count++;
      }
    } else {
      verdict = 'BOTH OPEN (TIE)';
      tiedCount++;
    }

    console.log(
      `#${(idx + 1).toString().padEnd(3)} | ` +
      `${sym.padEnd(9)} | ` +
      `${bot.category.padEnd(8)} | ` +
      `${time80.padEnd(11)} | ` +
      `${time120.padEnd(12)} | ` +
      `${res80.totalGridTrades.toString().padEnd(9)} | ` +
      `${res120.totalGridTrades.toString().padEnd(10)} | ` +
      `${verdict}`
    );
  }

  console.log('-----------------------------------------------------------------------------------------------------------------\n');
  console.log(`SUMMARY: 80 Grids Faster: ${faster80Count} | 120 Grids Faster: ${faster120Count} | Tied/Identical: ${tiedCount}\n`);
}

run().catch(console.error);
