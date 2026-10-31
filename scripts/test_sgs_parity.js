'use strict';

/**
 * Parity test for the SGS-1 indicator port.
 * Compares the live lib/sgsIndicator.js calculations with the backtest row:
 *   1000BONKUSDT 2025-01-06 00:00 UTC (TP, SGS-1 pass)
 * This row is live-compatible: the scanner's global daily peak equals the
 * backtest's safe-zone peak.
 * Backtest values come from backtest/universal_entry.csv.
 */

const fs = require('fs');
const SGS = require('../lib/sgsIndicator');

const SIGNAL_START = Date.parse('2025-01-06T00:00:00Z');
const NOW = SIGNAL_START + 15 * 60 * 1000 + 1000;
const ZONE_BASE = 0.021577;
const ZONE_PEAK = 0.061029;

const EXPECT = {
  dAtrPct: 11.330717,
  distE200D: 20.827095,
  dRsi: 50.451636,
  dCloseVsLl20: 38.373918,
  dVolRatio: 0.586988,
  daysSincePeakBars: 46,
  rsi15: 49.060371,
  downside: 37.117128,
  dropFromPeak: 43.77591,
};

function loadDaily(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).map(c => ({
    time: Number(c.startTime),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  })).sort((a, b) => a.time - b.time);
}

function load15(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).map(c => ({
    time: Number(c.startTime),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  })).sort((a, b) => a.time - b.time);
}

const daily = loadDaily('D:/BinanceCandles/1D/1000BONKUSDT.json');
const m15 = load15('D:/BinanceCandles/15M/1000BONKUSDT.json');

const window = daily.filter(c => c.time <= NOW).slice(-1000);
let peakIdx = -1, peak = -Infinity;
window.forEach((c, i) => { if (c.high > peak) { peak = c.high; peakIdx = i; } });

const calc = SGS.calculateDaily(window, NOW, peakIdx);
const upTo = m15.filter(c => c.time <= SIGNAL_START);
const rs = SGS.rsiSeries(upTo.map(c => c.close), 14);
const rsi15 = rs[rs.length - 1];
const signalCandle = m15.find(c => c.time === SIGNAL_START);
const triggerPrice = signalCandle ? signalCandle.close : null;

const evalResult = SGS.evaluate({
  daily: calc,
  basePrice: ZONE_BASE,
  peakPrice: ZONE_PEAK,
  triggerPrice,
  rsi15,
  fallbackDownside: null,
  fallbackDrop: null,
  fallbackDays: null,
});

console.log('window daily bars:', window.length, 'peakIdx:', peakIdx, 'peak:', peak);
console.log('calc:', calc);
console.log('triggerPrice:', triggerPrice, 'rsi15:', rsi15);
console.log('eval.pass:', evalResult.pass, 'checks:', evalResult.checks);
console.log('eval downside:', evalResult.downside, 'drop:', evalResult.dropFromPeak, 'days:', evalResult.days);

const fields = ['dAtrPct','distE200D','dRsi','dCloseVsLl20','dVolRatio','daysSincePeakBars'];
let maxDiff = 0;
for (const f of fields) {
  const got = calc[f];
  const exp = EXPECT[f];
  const diff = got != null ? Math.abs(got - exp) : Infinity;
  maxDiff = Math.max(maxDiff, diff);
  console.log(`${f}: live=${got} expected=${exp} diff=${diff}`);
}
console.log(`rsi15: live=${rsi15} expected=${EXPECT.rsi15} diff=${Math.abs(rsi15 - EXPECT.rsi15)}`);
console.log(`downside: live=${evalResult.downside} expected=${EXPECT.downside} diff=${Math.abs(evalResult.downside - EXPECT.downside)}`);
console.log(`drop: live=${evalResult.dropFromPeak} expected=${EXPECT.dropFromPeak} diff=${Math.abs(evalResult.dropFromPeak - EXPECT.dropFromPeak)}`);
console.log('max daily feature diff:', maxDiff);

if (!evalResult.pass) {
  console.error('FAIL: SGS-1 did not pass on the known backtest row');
  process.exit(1);
}
if (maxDiff > 0.01) {
  console.error('FAIL: daily feature parity diff too large');
  process.exit(1);
}
console.log('PASS: SGS-1 parity test');
