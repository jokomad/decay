'use strict';

/**
 * Unit + integration smoke test for SGS-1.
 * - threshold boundaries
 * - calculateDaily history guard
 * - LiveWatcher._evaluateSgs integration
 * - LiveWatcher._buildSignalObject SGS shape
 */

const assert = require('assert');
const fs = require('fs');
const SGS = require('../lib/sgsIndicator');
const LiveWatcher = require('../lib/liveWatcher');

function daily(overrides = {}) {
  return {
    dAtrPct: 8,
    distE200D: 5,
    dRsi: 47,
    dCloseVsLl20: 15,
    dVolRatio: 0.5,
    daysSincePeakBars: 30,
    ...overrides,
  };
}

function evalWith(overrides = {}, basePrice = 0.8, peakPrice = 2, triggerPrice = 1.2, rsi15 = 50) {
  return SGS.evaluate({
    daily: daily(overrides),
    basePrice,
    peakPrice,
    triggerPrice,
    rsi15,
    fallbackDownside: null,
    fallbackDrop: null,
    fallbackDays: null,
  });
}

// Baseline pass
assert.strictEqual(evalWith().pass, true, 'baseline should pass');

// Each condition must fail when pushed outside its band.
const fails = [
  ['dAtrPct low', { dAtrPct: 6.5 }],
  ['dAtrPct high', { dAtrPct: 11.9 }],
  ['distE200D low', { distE200D: -20.1 }],
  ['distE200D high', { distE200D: 23.7 }],
  ['dRsi low', { dRsi: 41.3 }],
  ['dRsi high', { dRsi: 53.4 }],
  ['dCloseVsLl20 low', { dCloseVsLl20: 7.8 }],
  ['dVolRatio high', { dVolRatio: 1.26 }],
  ['days low', { daysSincePeakBars: 14 }],
  ['days high', { daysSincePeakBars: 108 }],
  ['rsi15 low', {}, 0.8, 2, 1.2, 35],
];
for (const [name, overrides, base, peak, trigger, rsi] of fails) {
  const res = evalWith(overrides, base ?? 0.8, peak ?? 2, trigger ?? 1.2, rsi ?? 50);
  assert.strictEqual(res.pass, false, `${name} should fail`);
}

// downside and drop boundaries
assert.strictEqual(evalWith({}, 0.98, 2, 1.2).pass, false, 'downside too small should fail');
assert.strictEqual(evalWith({}, 0.8, 1.3, 1.2).pass, false, 'drop too small should fail');

// calculateDaily history guard
assert.strictEqual(SGS.calculateDaily([], Date.now(), -1), null, 'empty history should be null');
const short = Array.from({ length: 199 }, (_, i) => ({
  time: i * 86400000, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10,
}));
assert.strictEqual(SGS.calculateDaily(short, 200 * 86400000, 10), null, '199 bars should be null');

// Synthetic 250-bar series produces finite features
const series = Array.from({ length: 250 }, (_, i) => ({
  time: i * 86400000,
  open: 1 + i * 0.001,
  high: 1.01 + i * 0.001,
  low: 0.99 + i * 0.001,
  close: 1 + i * 0.001,
  volume: 100 + (i % 10),
}));
const calc = SGS.calculateDaily(series, 250 * 86400000, 200);
assert(calc && Number.isFinite(calc.dAtrPct), 'synthetic dAtrPct should be finite');
assert(Number.isFinite(calc.dRsi), 'synthetic dRsi should be finite');

// LiveWatcher._evaluateSgs integration on the known 1000BONK row.
// This needs the local backtest candles; skip cleanly on a deployment host.
const parityDailyPath = 'D:/BinanceCandles/1D/1000BONKUSDT.json';
const parityM15Path = 'D:/BinanceCandles/15M/1000BONKUSDT.json';
if (!fs.existsSync(parityDailyPath) || !fs.existsSync(parityM15Path)) {
  console.log('SKIP: live parity candles not found; unit tests passed.');
  process.exit(0);
}
const dailyJSON = JSON.parse(fs.readFileSync(parityDailyPath, 'utf8'));
const m15JSON = JSON.parse(fs.readFileSync(parityM15Path, 'utf8'));
const dailyCandles = dailyJSON.map(c => ({
  time: Number(c.startTime), open: Number(c.open), high: Number(c.high),
  low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
})).sort((a, b) => a.time - b.time);
const m15 = m15JSON.map(c => ({
  time: Number(c.startTime), open: Number(c.open), high: Number(c.high),
  low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
})).sort((a, b) => a.time - b.time);
const signalStart = Date.parse('2025-01-06T00:00:00Z');
const now = signalStart + 15 * 60 * 1000 + 1000;
const window = dailyCandles.filter(c => c.time <= now).slice(-1000);
let peakIdx = -1, peak = -Infinity;
window.forEach((c, i) => { if (c.high > peak) { peak = c.high; peakIdx = i; } });
const sgsDaily = SGS.calculateDaily(window, now, peakIdx);
const finished = m15.filter(c => c.time <= signalStart);
const trigger = m15.find(c => c.time === signalStart).close;
const item = {
  sgsDaily,
  basePrice: 0.021577,
  peakPrice: 0.061029,
  downsidePct: 37.117128,
  dropFromPeakPct: 43.77591,
  daysSincePeak: 46,
};
const watcherResult = LiveWatcher.prototype._evaluateSgs.call({}, item, finished, trigger);
assert.strictEqual(watcherResult.pass, true, 'LiveWatcher._evaluateSgs should pass the parity row');
assert(Math.abs(watcherResult.rsi15 - 49.060371) < 1e-4, 'SGS 15M RSI should match the backtest');
assert.strictEqual(watcherResult.checks.daysSincePeak, true, 'days check should pass');

// _buildSignalObject shape for SGS
const fakeWatcher = { timeSync: { getIsoTime: () => '2025-01-06T00:01:00.000Z' } };
const signal = LiveWatcher.prototype._buildSignalObject.call(fakeWatcher, {
  item,
  symbol: '1000BONKUSDT',
  signalType: 'SGS_1',
  triggerPrice: trigger,
  kcUpper: null,
  kcMiddle: null,
  kcSpreadPct: 0,
  breachAboveKcPct: 0,
  isHighVelocitySpread: false,
  downsidePct: watcherResult.downside,
  dropFromPeakPct: watcherResult.dropFromPeak,
  sgs: watcherResult,
  candleCloseIso: '2025-01-06T00:15:00.000Z',
});
assert.strictEqual(signal.signalType, 'SGS_1');
assert.strictEqual(signal.kcUpper, null);
assert(signal.sgs && signal.sgs.pass === true);
assert(Number.isFinite(signal.suggestedGrid.upperLimit));

console.log('PASS: SGS-1 unit + integration tests');
