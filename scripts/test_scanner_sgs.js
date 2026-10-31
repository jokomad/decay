'use strict';

/**
 * Scanner integration smoke test:
 * - _evaluateDecay still uses the last 200 daily candles for the safe-zone
 *   analysis (existing behavior).
 * - sgsDaily is computed from the full fetched history.
 */

const assert = require('assert');
const BybitScanner = require('../lib/bybitScanner');

const DAY = 24 * 3600 * 1000;
const now = Date.now();
const candles = [];

for (let i = 0; i < 1000; i++) {
  let open = 1, high = 1.02, low = 0.98, close = 1, volume = 100;
  if (i >= 840 && i < 850) {
    close = 1 + (i - 839) * 0.111;
    open = close - 0.05;
    high = close + 0.01;
    low = close - 0.06;
    volume = 100;
  } else if (i >= 850) {
    open = 1.5; high = 1.52; low = 1.49; close = 1.5; volume = 1;
  }
  candles.push({
    time: now - (1000 - i) * DAY,
    open, high, low, close, volume,
  });
}

const scanner = new BybitScanner();
const pair = {
  symbol: 'TESTUSDT',
  launchTime: 0,
  currentPrice: 1.5,
  ageDays: 1000,
  turnover24h: 1000000,
  volume24h: 1000000,
};
const analysis = scanner._evaluateDecay(pair, candles);

assert(analysis, 'analysis should not be null');
assert.strictEqual(analysis.isSafeZone, true, 'synthetic setup should be a safe zone');
assert(analysis.sgsDaily, 'sgsDaily should be present');
assert.strictEqual(analysis.sgsDaily.completedBars, 1000, 'SGS should use all completed daily bars');
assert.strictEqual(analysis.sgsDaily.daysSincePeakBars, 150, 'SGS days should come from the full history peak');
console.log('PASS: scanner SGS integration', {
  isSafeZone: analysis.isSafeZone,
  sgsDaily: analysis.sgsDaily,
});
