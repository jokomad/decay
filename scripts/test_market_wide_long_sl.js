/**
 * scripts/test_market_wide_long_sl.js
 */
const https = require('https');

function fetchBybit(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function testMarketWide() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'APTUSDT', 'NEARUSDT', 'AVAXUSDT'];
  console.log('Testing market-wide Long with Stop Loss across major pairs (1000 5m candles each)...');
  
  let totalTrades = 0;
  const slStats = {
    '1.0%': { wins: 0, losses: 0 },
    '2.0%': { wins: 0, losses: 0 },
    '3.5%': { wins: 0, losses: 0 },
    '5.0%': { wins: 0, losses: 0 }
  };

  for (const sym of symbols) {
    const res = await fetchBybit('https://api.bybit.com/v5/market/kline?category=linear&symbol=' + sym + '&interval=5&limit=1000');
    const list = (res?.result?.list || []).map(c => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4])
    })).sort((a,b) => a.time - b.time);

    const closes = list.map(c => c.close);
    for (let i = 25; i < list.length - 50; i++) {
      const smaPrev = closes.slice(i-21, i-1).reduce((a,b)=>a+b,0)/20;
      const smaCur = closes.slice(i-20, i).reduce((a,b)=>a+b,0)/20;
      if (closes[i-1] >= smaPrev && closes[i] < smaCur) {
        totalTrades++;
        const entry = closes[i];
        const tp = entry * 1.0125;
        
        for (const [slKey, slVal] of [['1.0%', 0.01], ['2.0%', 0.02], ['3.5%', 0.035], ['5.0%', 0.05]]) {
          const sl = entry * (1 - slVal);
          let resTrade = 'OPEN';
          for (let j = i + 1; j < Math.min(i + 100, list.length); j++) {
            if (list[j].low <= sl) { resTrade = 'LOSS'; break; }
            if (list[j].high >= tp) { resTrade = 'WIN'; break; }
          }
          if (resTrade === 'WIN') slStats[slKey].wins++;
          if (resTrade === 'LOSS') slStats[slKey].losses++;
        }
      }
    }
  }

  console.log('Total Crossover Events Tested:', totalTrades);
  for (const [k, v] of Object.entries(slStats)) {
    const wr = ((v.wins / (v.wins + v.losses || 1)) * 100).toFixed(1);
    console.log(`SL ${k}: Wins: ${v.wins}, Losses: ${v.losses}, Win Rate: ${wr}%`);
  }
}

testMarketWide().catch(console.error);
