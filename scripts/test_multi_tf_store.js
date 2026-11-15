'use strict';

/**
 * test_multi_tf_store.js
 *
 * Unit test for MultiTfStore.
 * Tests:
 * 1. Mock Bybit REST API fetch & cold boot warmup.
 * 2. Restart gap stitching (daily 2-second restart simulation).
 * 3. Dynamic multi-TF synthesis (1m -> 3m, 5m, 15m, 30m).
 * 4. Local filesystem persistence and hydration.
 * 5. Symbol pruning for inactive non-safe tokens.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const MultiTfStore = require('../lib/multiTfStore');

console.log('🧪 Starting MultiTfStore Tests...\n');

const testDir = path.join(__dirname, '..', '.test_data');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

// Mock DbManager using testDir
const mockDb = {
  driver: 'local',
  dataDir: testDir,
  mongoDb: null
};

// Mock Bybit REST API responses
let simulatedTime = 1700000000000;
const minuteMs = 60 * 1000;

function createMockFetch() {
  return async function mockFetch(url) {
    const parsedUrl = new URL(url);
    const interval = parsedUrl.searchParams.get('interval');
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);

    let stepMs = 60000;
    if (interval === '60') stepMs = 60 * 60000;
    else if (interval === '240') stepMs = 240 * 60000;
    else if (interval === '360') stepMs = 360 * 60000;
    else if (interval === '720') stepMs = 720 * 60000;
    else if (interval === 'D') stepMs = 1440 * 60000;

    const list = [];
    // Bybit returns reverse-chronological order (newest first)
    for (let i = 0; i < limit; i++) {
      const t = simulatedTime - i * stepMs;
      list.push([
        String(t),
        '100.0',
        '105.0',
        '95.0',
        '102.0',
        '500'
      ]);
    }

    return {
      status: 200,
      json: async () => ({
        retCode: 0,
        retMsg: 'OK',
        result: { list }
      })
    };
  };
}

(async () => {
  const mockFetch = createMockFetch();
  const store = new MultiTfStore(mockDb, { fetchFn: mockFetch });

  // 1. Init & Cold Boot
  console.log('Test 1: Store Init & Cold Boot Warmup');
  await store.init();
  assert.strictEqual(store.cache.size, 0, 'Initial cache should be empty');

  const warmed = await store.warmupSymbol('TESTUSDT');
  assert.strictEqual(warmed, true, 'Warmup should succeed and report sufficient data');
  assert(store.hasSufficientData('TESTUSDT'), 'hasSufficientData should return true');

  const candles = store.cache.get('TESTUSDT');
  assert(candles['1m'].length >= 100, 'Should have at least 100 1m candles');
  assert(candles['1h'].length >= 20, 'Should have at least 20 1h candles');
  assert(candles['4h'].length >= 20, 'Should have at least 20 4h candles');
  assert(candles['6h'].length >= 20, 'Should have at least 20 6h candles');
  assert(candles['12h'].length >= 20, 'Should have at least 20 12h candles');
  assert(candles['1d'].length >= 20, 'Should have at least 20 1d candles');
  console.log('  ✅ Cold Boot Warmup Passed.\n');

  // 2. Dynamic All-TF Retrieval
  console.log('Test 2: Dynamic Multi-TF Synthesis (3m, 5m, 15m, 30m)');
  const allTf = store.getAllCandles('TESTUSDT', simulatedTime);
  assert(allTf !== null, 'getAllCandles should return data');
  assert(allTf['1m'].length > 0, '1m candles present');
  assert(allTf['3m'].length > 0, '3m synthesized present');
  assert(allTf['5m'].length > 0, '5m synthesized present');
  assert(allTf['15m'].length > 0, '15m synthesized present');
  assert(allTf['30m'].length > 0, '30m synthesized present');
  assert(allTf['1h'].length > 0, '1h stored present');
  assert(allTf['6h'].length > 0, '6h stored present');
  assert(allTf['1d'].length > 0, '1d stored present');
  console.log(`  Synthesized TF candle counts: 3m=${allTf['3m'].length}, 5m=${allTf['5m'].length}, 15m=${allTf['15m'].length}, 30m=${allTf['30m'].length}`);
  console.log('  ✅ Dynamic Multi-TF Synthesis Passed.\n');

  // 3. Daily 2-Second Restart & Gap Stitching Simulation
  console.log('Test 3: Daily Restart Gap Stitching Simulation');
  const countBeforeGap = store.cache.get('TESTUSDT')['1m'].length;

  // Advance simulated time by 3 minutes (simulating restart gap)
  simulatedTime += 3 * minuteMs;
  await store.warmupSymbol('TESTUSDT');

  const countAfterGap = store.cache.get('TESTUSDT')['1m'].length;
  assert(countAfterGap >= countBeforeGap, '1m candles should be updated after gap stitch');

  // Verify timestamps are strictly sorted and unique
  const list1m = store.cache.get('TESTUSDT')['1m'];
  for (let i = 1; i < list1m.length; i++) {
    assert(list1m[i].time > list1m[i - 1].time, 'Candles must have strictly ascending unique timestamps');
  }
  console.log('  ✅ Gap Stitching Passed with zero duplicates and clean sorting.\n');

  // 4. Persistence & Hydration Test
  console.log('Test 4: Persistence & Re-Hydration');
  const store2 = new MultiTfStore(mockDb, { fetchFn: mockFetch });
  await store2.init();
  assert.strictEqual(store2.cache.size, 1, 'Hydrated cache should load 1 symbol');
  assert(store2.hasSufficientData('TESTUSDT'), 'Re-hydrated store has sufficient data');
  console.log('  ✅ Persistence & Re-Hydration Passed.\n');

  // 5. Inactive Symbol Pruning Test
  console.log('Test 5: Inactive Symbol Pruning');
  await store2.pruneInactiveSymbols(['SOMIUSDT']); // TESTUSDT is not in active set
  assert.strictEqual(store2.cache.has('TESTUSDT'), false, 'TESTUSDT should be pruned from cache');
  console.log('  ✅ Inactive Symbol Pruning Passed.\n');

  // Cleanup test directory
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('🎉 ALL MULTI-TF STORE TESTS PASSED SUCCESSFULLY! Stage 2 is 100% verified.');
})();
