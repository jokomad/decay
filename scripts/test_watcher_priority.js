'use strict';

/**
 * SGS-only test:
 * - SGS-1 candidates are the only candidates executed.
 * - Keltner candidates are computed but do not launch bots.
 */

const assert = require('assert');
const LiveWatcher = require('../lib/liveWatcher');

async function main() {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: i * 15 * 60 * 1000,
    open: 1, high: 1.01, low: 0.99, close: 1, volume: 10,
  }));
  const kc = {
    kcUpper: 1,
    kcMiddle: 1,
    kcSpreadPct: 2,
    isChannelWideEnough: true,
    isKeltnerTouch: true,
    isFirstTouch: true,
    isHighVelocitySpread: false,
  };
  const item1 = { symbol: 'AAAUSDT', downsidePct: 30, basePrice: 0.5, peakPrice: 1, daysSincePeak: 30, sgsDaily: {} };
  const item2 = { symbol: 'BBBUSDT', downsidePct: 30, basePrice: 0.5, peakPrice: 1, daysSincePeak: 30, sgsDaily: null };

  const emitted = [];
  const launched = [];
  const fake = {
    scanner: {
      isScanning: () => false,
      getResults: () => [item1, item2],
      _calculate15MKeltner: () => kc,
    },
    db: { getCandles: async () => candles },
    timeSync: { now: () => Date.now(), getIsoTime: () => new Date().toISOString() },
    _evaluateSgs: (item) => item.symbol === 'AAAUSDT'
      ? { pass: true, downside: 30, dropFromPeak: 40, dAtrPct: 8, dRsi: 47, rsi15: 50 }
      : { pass: false },
    _buildSignalObject: (cand) => ({ ...cand, id: `${cand.symbol}-test`, timestamp: new Date().toISOString() }),
    _emitSignal: (signal) => emitted.push(`${signal.signalType}:${signal.symbol}`),
    _handleBotLaunchForSignal: async (signal) => launched.push(`${signal.signalType}:${signal.symbol}`),
  };

  await LiveWatcher.prototype._evaluateAndExecuteSignals.call(fake);

  assert.deepStrictEqual(emitted, ['SGS_1:AAAUSDT'], 'only SGS-1 may be emitted');
  assert.deepStrictEqual(launched, ['SGS_1:AAAUSDT'], 'only SGS-1 may launch a bot');
  assert.strictEqual(emitted.filter(x => x.endsWith(':AAAUSDT')).length, 1, 'no duplicate on AAAUSDT');
  assert.strictEqual(emitted.some(x => x.startsWith('FIRST_TOUCH:') || x.startsWith('EXTENDED_TOUCH:')), false, 'Keltner must not be emitted');
  console.log('PASS: SGS-only signal test');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
