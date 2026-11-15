'use strict';

/**
 * test_crossover_watcher.js
 *
 * Unit test for LiveWatcher dual-cadence scheduling and crossover integration.
 * Tests:
 * 1. Priority Resolution: SGS-1 (Priority 1) overrides BB Crossover on the same coin.
 * 2. Multi-Candidate Ordering: SGS-1 candidates execute first, then BB Crossovers.
 * 3. 1-Minute Intermediate Ticker: Triggers fast crossovers and yields when 15M cycle runs.
 * 4. Duplicate Guard: Skips launch if symbol already has active bot.
 */

const assert = require('assert');
const LiveWatcher = require('../lib/liveWatcher');
const Indicator = require('../lib/crossoverIndicator');

console.log('🧪 Starting LiveWatcher Crossover Integration Tests...\n');

async function testPriorityAndExecution() {
  console.log('Test 1: Signal Priority & Candidate Ordering');

  const itemA = { symbol: 'AAAUSDT', downsidePct: 30, basePrice: 0.5, peakPrice: 1, daysSincePeak: 30, sgsDaily: {} };
  const itemB = { symbol: 'BBBUSDT', downsidePct: 25, basePrice: 0.5, peakPrice: 1, daysSincePeak: 30, sgsDaily: null };

  const emitted = [];
  const launched = [];

  // Mock multiTfStore
  const mockMultiTf = {
    getAllCandles: (sym) => {
      // 5m and 15m series where 5m crosses down 15m
      const fast = [];
      const slow = [];
      for (let i = 0; i < 20; i++) {
        fast.push({ time: 1700000000000 - (21 - i) * 300000, close: 105 });
        slow.push({ time: 1700000000000 - (21 - i) * 900000, close: 100 });
      }
      fast.push({ time: 1700000000000 - 300000, close: 0 });
      slow.push({ time: 1700000000000 - 900000, close: 100 });

      return {
        '1m': [],
        '5m': fast,
        '15m': slow,
        '1h': [],
        '4h': [],
        '6h': [],
        '12h': [],
        '1d': []
      };
    }
  };

  const fakeWatcher = {
    enableBbCrossovers: true,
    bbCrossoverPairs: [Indicator.parsePairId('5m_15m')],
    multiTfStore: mockMultiTf,
    scanner: {
      isScanning: () => false,
      getResults: () => [itemA, itemB],
      _calculate15MKeltner: () => ({ kcUpper: 1, kcMiddle: 1, kcSpreadPct: 2 }),
    },
    db: {
      getCandles: async () => Array.from({ length: 30 }, (_, i) => ({ time: 1700000000000 - (30 - i) * 900000, close: 1 })),
      getActiveBotBySymbol: async () => null,
    },
    timeSync: {
      now: () => 1700000000000,
      getIsoTime: () => new Date(1700000000000).toISOString()
    },
    _evaluateSgs: (item) => {
      // AAAUSDT passes SGS-1, BBBUSDT fails SGS-1
      return item.symbol === 'AAAUSDT'
        ? { pass: true, downside: 30, dropFromPeak: 40, dAtrPct: 8, dRsi: 47, rsi15: 50 }
        : { pass: false };
    },
    _buildSignalObject: (cand) => ({
      ...cand,
      id: `${cand.symbol}-${cand.signalType}`,
      timestamp: new Date().toISOString()
    }),
    _emitSignal: (signal) => emitted.push(`${signal.signalType}:${signal.symbol}`),
    _handleBotLaunchForSignal: async (signal) => launched.push(`${signal.signalType}:${signal.symbol}`),
  };

  await LiveWatcher.prototype._evaluateAndExecuteSignals.call(fakeWatcher);

  // AAAUSDT fired both SGS-1 and BB Crossover, but SGS-1 must take absolute precedence
  assert(launched.includes('SGS_1:AAAUSDT'), 'AAAUSDT must launch as SGS_1');
  assert(!launched.includes('BB_CROSSOVER:AAAUSDT'), 'AAAUSDT must NOT launch as BB_CROSSOVER (SGS-1 overrides it)');

  // BBBUSDT did not pass SGS-1, so it must launch as BB_CROSSOVER
  assert(launched.includes('BB_CROSSOVER:BBBUSDT'), 'BBBUSDT must launch as BB_CROSSOVER');

  // Priority order verification: SGS-1 launched before BB_CROSSOVER
  const idxA = launched.indexOf('SGS_1:AAAUSDT');
  const idxB = launched.indexOf('BB_CROSSOVER:BBBUSDT');
  assert(idxA < idxB, 'SGS-1 candidate must launch before BB_CROSSOVER candidate');

  console.log('  ✅ Priority Resolution & Candidate Ordering Passed.\n');
}

async function test1mIntermediateTicker() {
  console.log('Test 2: Intermediate 1-Minute Ticker Execution');

  const item = { symbol: 'CCCUSDT', downsidePct: 20, basePrice: 0.5, peakPrice: 1, daysSincePeak: 30 };
  const launched = [];

  // Mock multiTfStore with active crossover
  const mockMultiTf = {
    getAllCandles: (sym) => {
      const fast = [];
      const slow = [];
      for (let i = 0; i < 20; i++) {
        fast.push({ time: i * 300000, close: 105 });
        slow.push({ time: i * 900000, close: 100 });
      }
      fast.push({ time: 20 * 300000, close: 0 }); // fast crosses below slow
      slow.push({ time: 20 * 900000, close: 100 });
      return { '5m': fast, '15m': slow, '1m': [] };
    }
  };

  const fakeTicker = {
    enableBbCrossovers: true,
    isCycleRunning: false,
    bbCrossoverPairs: [Indicator.parsePairId('5m_15m')],
    multiTfStore: mockMultiTf,
    launchLocks: new Set(),
    scanner: {
      isScanning: () => false,
      getResults: () => [item]
    },
    db: {
      getActiveBotBySymbol: async () => null // no existing bot
    },
    timeSync: {
      // Simulate minute :05 (intermediate minute)
      now: () => new Date('2026-11-15T12:05:03.000Z').getTime(),
      getIsoTime: () => '2026-11-15T12:05:03.000Z'
    },
    _buildSignalObject: (cand) => cand,
    _emitSignal: () => {},
    _handleBotLaunchForSignal: async (sig) => launched.push(sig.symbol)
  };

  // 1. Should fire on minute :05
  await LiveWatcher.prototype._run1mIntermediateCheck.call(fakeTicker);
  assert.strictEqual(launched.length, 1, '1m ticker should launch bot on minute :05');
  assert.strictEqual(launched[0], 'CCCUSDT');

  // 2. Should yield/skip on minute :01 (which belongs to 15M cycle)
  launched.length = 0;
  fakeTicker.timeSync.now = () => new Date('2026-11-15T12:01:03.000Z').getTime();
  await LiveWatcher.prototype._run1mIntermediateCheck.call(fakeTicker);
  assert.strictEqual(launched.length, 0, '1m ticker must yield on minute :01');

  // 3. Should yield if 15M cycle is currently running
  fakeTicker.timeSync.now = () => new Date('2026-11-15T12:05:03.000Z').getTime();
  fakeTicker.isCycleRunning = true;
  await LiveWatcher.prototype._run1mIntermediateCheck.call(fakeTicker);
  assert.strictEqual(launched.length, 0, '1m ticker must yield when isCycleRunning is true');

  // 4. Duplicate bot guard
  fakeTicker.isCycleRunning = false;
  fakeTicker.db.getActiveBotBySymbol = async () => ({ botId: 'EXISTING_1' });
  await LiveWatcher.prototype._run1mIntermediateCheck.call(fakeTicker);
  assert.strictEqual(launched.length, 0, '1m ticker must not launch if active bot exists');

  console.log('  ✅ Intermediate 1-Minute Ticker Execution Passed.\n');
}

(async () => {
  await testPriorityAndExecution();
  await test1mIntermediateTicker();
  console.log('🎉 ALL WATCHER CROSSOVER INTEGRATION TESTS PASSED! Stage 3 is 100% verified.');
})();
