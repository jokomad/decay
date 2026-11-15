'use strict';

/**
 * smoke_crossover_bybit.js
 *
 * Live Bybit data smoke test for MultiTfStore & OPTIMAL_12 Crossovers.
 * Uses public market endpoints (no API keys, read-only, 0 orders).
 */

const MultiTfStore = require('../lib/multiTfStore');
const Indicator = require('../lib/crossoverIndicator');

const mockDb = {
  driver: 'local',
  dataDir: require('path').join(__dirname, '..', '.test_data'),
  mongoDb: null
};

(async () => {
  const symbols = ['KMNOUSDT', 'BEAMUSDT', 'RUNEUSDT'];
  console.log(`📡 Connecting to live Bybit public REST API for symbols: ${symbols.join(', ')}...`);

  const store = new MultiTfStore(mockDb);
  await store.init();

  for (const symbol of symbols) {
    console.log(`\nTesting ${symbol}:`);
    const success = await store.warmupSymbol(symbol);
    console.log(`  Warmup completed: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    const allCandles = store.getAllCandles(symbol);
    if (!allCandles) {
      console.error(`  ❌ Failed to retrieve candles for ${symbol}`);
      continue;
    }

    console.log(`  Candle counts: 1m=${allCandles['1m'].length}, 5m=${allCandles['5m'].length}, 15m=${allCandles['15m'].length}, 1h=${allCandles['1h'].length}, 6h=${allCandles['6h'].length}, 1d=${allCandles['1d'].length}`);

    // Evaluate OPTIMAL_12 crossovers
    const signals = Indicator.evaluateSymbolCrossovers({
      symbol,
      candlesByTf: allCandles,
      pairs: Indicator.OPTIMAL_12
    });

    console.log(`  OPTIMAL_12 evaluation: ${signals.length} active crossover signal(s)`);
    for (const s of signals) {
      console.log(`    🎯 Signal: ${s.pairId} (${s.fastTf} crosses down ${s.slowTf}) | Price: $${s.triggerPrice} | Fast SMA: ${s.fastSma?.toFixed(4)} | Slow SMA: ${s.slowSma?.toFixed(4)}`);
    }
  }

  // Cleanup test directory
  try {
    require('fs').rmSync(mockDb.dataDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n🎉 Live Bybit Smoke Test completed successfully!');
})().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
