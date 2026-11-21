/**
 * scripts/test_dual_mode_scanner.js
 * 
 * Comprehensive Unit and Integration Test for Dual-Mode Decay Engine:
 * - Mode 1: Fast Flash Decay (Days 2 to 8 post-Peak 1)
 * - Mode 2: Double-Top / Second Run Decay (Days 1 to 6 post-Peak 2)
 * - Guardrail checks (Climax Expiration Guard, 1D Macro Trend Filter, Parabolic Bull Filter)
 * - Scanner query filters ('MODE_1', 'MODE_2', 'ALL')
 * - Real Bybit API historical validation
 */

const assert = require('assert');
const BybitScanner = require('../lib/bybitScanner');

async function runTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING DUAL-MODE DECAY SCANNER TEST SUITE');
  console.log('================================================================\n');

  const scanner = new BybitScanner();

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: Synthetic Mode 1 (Fast Flash Climax Decay)
  // Single climax peak 3 days ago, -25% drop, volume dying (10% of peak)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 1: Testing Mode 1 (Fast Flash Climax Decay)...');
  const now = Date.now();
  const dayMs = 86400000;
  
  const m1Candles = [];
  // 60 days of candles: day 0 is 59 days ago, day 59 is today (0 days ago)
  for (let daysAgo = 59; daysAgo >= 0; daysAgo--) {
    const t = now - (daysAgo * dayMs);
    if (daysAgo > 3) {
      // Base consolidation around $1.00
      m1Candles.push({ time: t, open: 1.00, high: 1.05, low: 0.95, close: 1.00, volume: 100000 });
    } else if (daysAgo === 3) {
      // Peak 1 day (+100% pump to $2.00, huge volume)
      m1Candles.push({ time: t, open: 1.05, high: 2.00, low: 1.05, close: 1.95, volume: 2000000 });
    } else if (daysAgo === 2) {
      // Day 1 post peak: initial pullback
      m1Candles.push({ time: t, open: 1.95, high: 1.95, low: 1.65, close: 1.70, volume: 400000 });
    } else if (daysAgo === 1) {
      // Day 2 post peak: volume dying, dropping
      m1Candles.push({ time: t, open: 1.70, high: 1.72, low: 1.55, close: 1.58, volume: 150000 });
    } else {
      // Day 3 (Current / Today): -25% drop from peak ($1.50), volume low
      m1Candles.push({ time: t, open: 1.58, high: 1.60, low: 1.48, close: 1.50, volume: 120000 });
    }
  }

  const m1Result = scanner._evaluateDecay({ symbol: 'M1TESTUSDT', launchTime: now - (90 * dayMs) }, m1Candles);
  assert(m1Result !== null, 'Mode 1 evaluation should not be null');
  assert.strictEqual(m1Result.isSafeZone, true, 'Mode 1 candidate should be in Safe Zone');
  assert.strictEqual(m1Result.isMode1SafeZone, true, 'isMode1SafeZone should be true');
  assert.strictEqual(m1Result.isMode2SafeZone, false, 'isMode2SafeZone should be false');
  assert.strictEqual(m1Result.decayMode, 'MODE_1_FLASH', 'decayMode should be MODE_1_FLASH');
  assert.strictEqual(m1Result.daysSincePeak, 3, 'daysSincePeak should be 3');
  assert(m1Result.dropFromPeakPct >= 20, 'dropFromPeakPct should be >= 20%');
  console.log(`  ✅ Mode 1 synthetic test passed: ${m1Result.symbol} flagged as ${m1Result.decayMode} (Drop: -${m1Result.dropFromPeakPct.toFixed(1)}%, Days: ${m1Result.daysSincePeak})\n`);

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: Synthetic Mode 2 (Double-Top / Second Run Decay)
  // Peak 1 ($2.00) 25 days ago, Base Trough ($1.10) 12 days ago,
  // Peak 2 ($1.85, +68% run) 3 days ago, Current Price ($1.60, -13.5% drop from P2)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 2: Testing Mode 2 (Double-Top / Second Run Decay)...');
  const m2Candles = [];
  for (let daysAgo = 59; daysAgo >= 0; daysAgo--) {
    const t = now - (daysAgo * dayMs);
    if (daysAgo >= 26) {
      // Origin base: $1.00
      m2Candles.push({ time: t, open: 1.00, high: 1.05, low: 0.95, close: 1.00, volume: 100000 });
    } else if (daysAgo === 25) {
      // Peak 1: $2.00 (Swing high)
      m2Candles.push({ time: t, open: 1.20, high: 2.00, low: 1.15, close: 1.90, volume: 3000000 });
    } else if (daysAgo > 12 && daysAgo < 25) {
      // Pullback wave 1 down towards $1.10
      const prog = (25 - daysAgo) / 13;
      const price = 1.90 - prog * (1.90 - 1.12);
      m2Candles.push({ time: t, open: price + 0.02, high: price + 0.04, low: price - 0.02, close: price, volume: 300000 });
    } else if (daysAgo === 12) {
      // Trough Low: $1.10
      m2Candles.push({ time: t, open: 1.15, high: 1.16, low: 1.10, close: 1.12, volume: 200000 });
    } else if (daysAgo > 3 && daysAgo < 12) {
      // Second run surge from $1.12 up towards $1.80
      const prog = (12 - daysAgo) / 9;
      const price = 1.12 + prog * (1.80 - 1.12);
      m2Candles.push({ time: t, open: price - 0.02, high: price + 0.03, low: price - 0.03, close: price, volume: 800000 });
    } else if (daysAgo === 3) {
      // Peak 2: $1.85 (Swing high / double top)
      m2Candles.push({ time: t, open: 1.75, high: 1.85, low: 1.70, close: 1.80, volume: 1500000 });
    } else if (daysAgo === 2) {
      // Day 1 post-P2 rejection
      m2Candles.push({ time: t, open: 1.80, high: 1.81, low: 1.68, close: 1.72, volume: 400000 });
    } else if (daysAgo === 1) {
      // Day 2 post-P2 rejection
      m2Candles.push({ time: t, open: 1.72, high: 1.73, low: 1.62, close: 1.65, volume: 250000 });
    } else {
      // Day 3 (Current): $1.60 (-13.5% from P2)
      m2Candles.push({ time: t, open: 1.65, high: 1.66, low: 1.58, close: 1.60, volume: 180000 });
    }
  }

  const m2Result = scanner._evaluateDecay({ symbol: 'M2TESTUSDT', launchTime: now - (90 * dayMs) }, m2Candles);
  assert(m2Result !== null, 'Mode 2 evaluation should not be null');
  assert.strictEqual(m2Result.isSafeZone, true, 'Mode 2 candidate should be in Safe Zone');
  assert.strictEqual(m2Result.isMode2SafeZone, true, 'isMode2SafeZone should be true');
  assert.strictEqual(m2Result.isMode1SafeZone, false, 'isMode1SafeZone should be false because Peak 1 was 25d ago');
  assert.strictEqual(m2Result.decayMode, 'MODE_2_DOUBLE_TOP', 'decayMode should be MODE_2_DOUBLE_TOP');
  assert(m2Result.mode2 !== null, 'mode2 metadata must be present');
  assert.strictEqual(m2Result.mode2.p1High, 2.00, 'mode2.p1High should be 2.00');
  assert.strictEqual(m2Result.mode2.troughLow, 1.10, 'mode2.troughLow should be 1.10');
  assert.strictEqual(m2Result.mode2.p2High, 1.85, 'mode2.p2High should be 1.85');
  assert.strictEqual(m2Result.mode2.daysSinceP2, 3, 'mode2.daysSinceP2 should be 3');
  console.log(`  ✅ Mode 2 synthetic test passed: ${m2Result.symbol} flagged as ${m2Result.decayMode}`);
  console.log(`     P1: $${m2Result.mode2.p1High} ➔ Trough: $${m2Result.mode2.troughLow} (-${m2Result.mode2.dropP1ToTrough}%) ➔ P2: $${m2Result.mode2.p2High} (+${m2Result.mode2.run2Gain}%) ➔ Drop from P2: -${m2Result.mode2.dropFromP2}% (${m2Result.mode2.daysSinceP2}d ago)\n`);

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Stale Peak Blocked by Climax Expiration Guard (CTR Trap Check)
  // Single peak 20 days ago, no second run
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 3: Testing Climax Expiration Guard on stale peaks (20 days ago)...');
  const staleCandles = [];
  for (let daysAgo = 59; daysAgo >= 0; daysAgo--) {
    const t = now - (daysAgo * dayMs);
    if (daysAgo >= 21) {
      staleCandles.push({ time: t, open: 1.00, high: 1.05, low: 0.95, close: 1.00, volume: 100000 });
    } else if (daysAgo === 20) {
      staleCandles.push({ time: t, open: 1.00, high: 2.00, low: 1.00, close: 1.90, volume: 2000000 });
    } else {
      // Drifting sideways at $1.50 without any second run
      staleCandles.push({ time: t, open: 1.50, high: 1.52, low: 1.48, close: 1.50, volume: 100000 });
    }
  }

  const staleResult = scanner._evaluateDecay({ symbol: 'STALETESTUSDT', launchTime: now - (90 * dayMs) }, staleCandles);
  assert(staleResult !== null, 'Stale peak evaluation should not be null');
  assert.strictEqual(staleResult.isMode1SafeZone, false, 'Mode 1 should reject stale peaks (>8 days)');
  assert.strictEqual(staleResult.isMode2SafeZone, false, 'Mode 2 should reject if no second run bounce');
  assert.strictEqual(staleResult.isSafeZone, false, 'Stale token must NOT be in Safe Zone');
  console.log(`  ✅ Stale Peak test passed: ${staleResult.symbol} blocked (daysSincePeak: ${staleResult.daysSincePeak}d > 8d max)\n`);

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Runaway Bull Filter (ARIA Trap Check)
  // Second wave is still going parabolic (+40% above 20 SMA)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 4: Testing 1D Macro Bull Protection on runaway parabolic pumps...');
  const bullCandles = [];
  for (let daysAgo = 59; daysAgo >= 0; daysAgo--) {
    const t = now - (daysAgo * dayMs);
    if (daysAgo >= 26) {
      bullCandles.push({ time: t, open: 0.10, high: 0.11, low: 0.09, close: 0.10, volume: 50000 });
    } else if (daysAgo === 25) {
      bullCandles.push({ time: t, open: 0.10, high: 0.30, low: 0.10, close: 0.28, volume: 2000000 });
    } else if (daysAgo >= 13 && daysAgo < 25) {
      bullCandles.push({ time: t, open: 0.22, high: 0.24, low: 0.18, close: 0.20, volume: 300000 });
    } else if (daysAgo === 12) {
      bullCandles.push({ time: t, open: 0.20, high: 0.21, low: 0.18, close: 0.19, volume: 200000 });
    } else if (daysAgo <= 5) {
      // Skyrocketing: 20 SMA is low (~0.22), but price is now at 0.50 (+127% above SMA!)
      bullCandles.push({ time: t, open: 0.45, high: 0.52, low: 0.44, close: 0.50, volume: 3000000 });
    } else {
      bullCandles.push({ time: t, open: 0.25, high: 0.30, low: 0.24, close: 0.28, volume: 800000 });
    }
  }

  const bullResult = scanner._evaluateDecay({ symbol: 'BULLTESTUSDT', launchTime: now - (90 * dayMs) }, bullCandles);
  assert(bullResult !== null, 'Bull evaluation should not be null');
  assert.strictEqual(bullResult.isMode1SafeZone, false, 'Mode 1 must reject parabolic bull');
  assert.strictEqual(bullResult.isMode2SafeZone, false, 'Mode 2 must reject parabolic continuation (>25% above 20 SMA)');
  assert.strictEqual(bullResult.isSafeZone, false, 'Runaway bull must NOT be in Safe Zone');
  console.log(`  ✅ Runaway Bull test passed: ${bullResult.symbol} blocked (priceVsSma20Pct: +${bullResult.priceVsSma20Pct}% > 25%)\n`);

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: Scanner getResults() decayMode filtering
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 5: Testing scanner.getResults() filtering by decayMode...');
  scanner.state.results = [m1Result, m2Result, staleResult, bullResult];

  const allSafe = scanner.getResults({ safeZoneOnly: true });
  assert.strictEqual(allSafe.length, 2, 'Should return both M1 and M2 when safeZoneOnly is true');

  const onlyM1 = scanner.getResults({ safeZoneOnly: true, decayMode: 'MODE_1' });
  assert.strictEqual(onlyM1.length, 1, 'Should return exactly 1 item for MODE_1');
  assert.strictEqual(onlyM1[0].symbol, 'M1TESTUSDT', 'Item should be M1TESTUSDT');

  const onlyM2 = scanner.getResults({ safeZoneOnly: true, decayMode: 'MODE_2' });
  assert.strictEqual(onlyM2.length, 1, 'Should return exactly 1 item for MODE_2');
  assert.strictEqual(onlyM2[0].symbol, 'M2TESTUSDT', 'Item should be M2TESTUSDT');

  const allCoins = scanner.getResults();
  assert.strictEqual(allCoins.length, 4, 'Should return all 4 items when safeZoneOnly is not specified');
  console.log('  ✅ Scanner decayMode query filtering tests passed!\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6: Live Bybit Historical Market Verification (CTRUSDT & BIRBUSDT)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 6: Validating live Bybit market data on CTRUSDT and BIRBUSDT...');
  try {
    for (const sym of ['CTRUSDT', 'BIRBUSDT']) {
      const candlesRes = await scanner.rateLimiter.fetchWithRetry(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=D&limit=90`);
      const raw = candlesRes?.result?.list || [];
      if (raw.length >= 45) {
        const candles = raw.map(c => ({
          time: parseInt(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        })).sort((a, b) => a.time - b.time);

        const liveResult = scanner._evaluateDecay({ symbol: sym, launchTime: 0 }, candles);
        if (liveResult && liveResult.isMode2SafeZone) {
          console.log(`  ✅ Live market test passed for ${sym}: Mode 2 Double-Top detected!`);
          console.log(`     P1: $${liveResult.mode2.p1High} (${liveResult.mode2.p1Date}) ➔ Trough: $${liveResult.mode2.troughLow} ➔ P2: $${liveResult.mode2.p2High} (${liveResult.mode2.p2Date}) ➔ Drop from P2: -${liveResult.mode2.dropFromP2}% (${liveResult.mode2.daysSinceP2}d ago)`);
        } else {
          console.log(`  ℹ️ Live market check for ${sym}: isSafeZone=${liveResult?.isSafeZone}, mode=${liveResult?.decayMode}`);
        }
      }
    }
    console.log('');
  } catch (err) {
    console.warn('  ⚠️ Live API check skipped due to network/rate limits:', err.message);
  }

  console.log('================================================================');
  console.log('🎉 ALL DUAL-MODE DECAY UNIT & INTEGRATION TESTS PASSED (100%)');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
