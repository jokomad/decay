'use strict';

/**
 * Live Bybit data smoke test for SGS-1 daily features.
 * No API keys, no DB, no orders.
 */

const SGS = require('../lib/sgsIndicator');

(async () => {
  const symbol = process.argv[2] || '1000BONKUSDT';
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=1000`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.retCode !== 0 || !data.result?.list?.length) {
    throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  }
  const candles = data.result.list.slice().reverse().map(k => ({
    time: parseInt(k[0], 10),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
  let peakIdx = -1, peak = -Infinity;
  candles.forEach((c, i) => { if (c.high > peak) { peak = c.high; peakIdx = i; } });
  const calc = SGS.calculateDaily(candles, Date.now(), peakIdx);
  console.log(symbol, 'daily bars:', candles.length, 'peakIdx:', peakIdx, 'peak:', peak);
  console.log('SGS daily:', calc);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
