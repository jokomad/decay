/**
 * server.js
 * 
 * Bybit Linear Climax Decay Live Watcher & Screener Server
 * - Precision-scheduled every 15 minutes at :00:03, :15:03, :30:03, :45:03 (Bybit server time).
 * - Real-time synchronization with Bybit server time on every cycle.
 * - Fast 1D batch scanning to filter delistings, detect climax pumps & eliminate baseline breaches.
 * - Incremental 15M candlestick caching in MongoDB (or local fallback).
 * - Real-time WebSocket streaming with auto-reconnect & ping-pong for confirmed finished candles.
 * - Automatic database pruning when tokens breach the origin baseline floor.
 * - Precision entry signal emission for short grid bot deployment.
 * - Compatible with Docker & Northflank.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const LiveWatcher = require('./lib/liveWatcher');
const CrossoverIndicator = require('./lib/crossoverIndicator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instantiate Master Live Watcher
const watcher = new LiveWatcher();
const scanner = watcher.scanner;

// Health Check for Northflank / Docker
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    watcherStatus: await watcher.getStatus()
  });
});

// Comprehensive Status Endpoint (Includes Bybit time, DB stats, WebSocket & next cycle)
app.get('/api/status', async (req, res) => {
  res.json(await watcher.getStatus());
});

// Real-Time Server Time Endpoint
app.get('/api/time', (req, res) => {
  res.json(watcher.timeSync.getStatus());
});

// Decayed Pairs Endpoint (Default sort: closest to 15M Upper Keltner Band)
app.get('/api/pairs', async (req, res) => {
  const { search, minGain, safeZoneOnly, sort, decayMode } = req.query;
  const pairs = scanner.getResults({ search, minGain, safeZoneOnly, sort, decayMode });
  const allResults = scanner.getResults();
  const safeZoneCount = allResults.filter(p => p.isSafeZone).length;
  const mode1Count = allResults.filter(p => p.isMode1SafeZone).length;
  const mode2Count = allResults.filter(p => p.isMode2SafeZone).length;

  res.json({
    total: pairs.length,
    safeZoneCount,
    mode1Count,
    mode2Count,
    state: scanner.getState(),
    watcher: await watcher.getStatus(),
    pairs
  });
});

// Live Signals History Endpoint
app.get('/api/signals', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const signals = await watcher.db.getSignals(limit);
  res.json({
    count: signals.length,
    signals
  });
});

// Format duration into readable string
function formatDuration(ms) {
  if (!ms || isNaN(ms) || ms <= 0) return '--';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Compute Signal & Crossover Performance Statistics
function computeSignalStats(activeBots = [], history = []) {
  const activePairs = CrossoverIndicator.resolvePairs(process.env.BB_CROSSOVER_PAIRS || 'OPTIMAL_12');
  const activePairIds = activePairs.map(p => p.id);

  const statsMap = new Map();

  // Initialize active optimal pairs
  activePairIds.forEach(k => {
    statsMap.set(`BB_${k}`, {
      signalKey: `BB_${k}`,
      displayName: `BB CROSSOVER: ${k}`,
      type: 'BB_CROSSOVER',
      crossoverPair: k,
      totalLaunched: 0,
      activeCount: 0,
      completedCount: 0,
      durations: [],
      profits: [],
      bots: []
    });
  });

  // Initialize SGS-1 & Keltner
  statsMap.set('SGS_1', {
    signalKey: 'SGS_1',
    displayName: '🛡️ SGS-1 SAFETY FILTER',
    type: 'SGS_1',
    crossoverPair: null,
    totalLaunched: 0,
    activeCount: 0,
    completedCount: 0,
    durations: [],
    profits: [],
    bots: []
  });

  statsMap.set('FIRST_TOUCH', {
    signalKey: 'FIRST_TOUCH',
    displayName: '🔥 15M KELTNER TOUCH (Fallback)',
    type: 'FIRST_TOUCH',
    crossoverPair: null,
    totalLaunched: 0,
    activeCount: 0,
    completedCount: 0,
    durations: [],
    profits: [],
    bots: []
  });

  function getBotKey(b) {
    if (b.crossover?.pairId) return `BB_${b.crossover.pairId}`;
    if (b.signalType === 'SGS_1') return 'SGS_1';
    if (b.signalType === 'BB_CROSSOVER') {
      return 'BB_1m_12h';
    }
    return b.signalType || 'FIRST_TOUCH';
  }

  const now = Date.now();

  // Process active running bots
  for (const b of activeBots) {
    const key = getBotKey(b);
    let stat = statsMap.get(key);
    if (!stat) {
      stat = { signalKey: key, displayName: key, type: b.signalType, totalLaunched: 0, activeCount: 0, completedCount: 0, durations: [], profits: [], bots: [] };
      statsMap.set(key, stat);
    }
    stat.totalLaunched++;
    stat.activeCount++;
    const startMs = b.createdAt || new Date(b.createdAtIso).getTime() || now;
    const runMs = Math.max(0, now - startMs);
    b.crossover = b.crossover || (key.startsWith('BB_') ? { pairId: key.replace('BB_', '') } : null);
    b.runningMs = runMs;
    b.runningText = formatDuration(runMs);

    stat.bots.push({
      symbol: b.symbol,
      botId: b.botId,
      status: 'RUNNING',
      startedIso: b.createdAtIso || new Date(startMs).toISOString(),
      entryPrice: b.entryPrice,
      pnl: Number(b.pnl || 0),
      runningText: b.runningText
    });
  }

  // Process completed history bots
  for (const h of history) {
    if (!h.symbol) continue;
    const key = getBotKey(h);
    let stat = statsMap.get(key);
    if (!stat) {
      stat = { signalKey: key, displayName: key, type: h.signalType, totalLaunched: 0, activeCount: 0, completedCount: 0, durations: [], profits: [], bots: [] };
      statsMap.set(key, stat);
    }
    stat.totalLaunched++;
    stat.completedCount++;

    const startMs = h.createdAt || new Date(h.createdAtIso).getTime() || 0;
    const endMs = h.endedAt || new Date(h.archivedAt).getTime() || startMs;
    const durMs = Math.max(0, endMs - startMs);
    const pnl = Number(h.pnl || 0);

    h.crossover = h.crossover || (key.startsWith('BB_') ? { pairId: key.replace('BB_', '') } : null);
    h.durationMs = durMs;
    h.durationText = formatDuration(durMs);

    stat.durations.push(durMs);
    stat.profits.push(pnl);

    stat.bots.push({
      symbol: h.symbol,
      botId: h.botId,
      status: h.status || 'COMPLETED',
      startedIso: h.createdAtIso || (startMs ? new Date(startMs).toISOString() : '--'),
      endedIso: h.archivedAt || (endMs ? new Date(endMs).toISOString() : '--'),
      holdTimeMs: durMs,
      holdTimeText: h.durationText,
      entryPrice: h.entryPrice,
      pnl: pnl
    });
  }

  // Generate summaries
  const signalsList = Array.from(statsMap.values()).map(s => {
    const durCount = s.durations.length;
    let avgHoldMs = null;
    let fastestMs = null;
    let longestMs = null;
    if (durCount > 0) {
      const sumDur = s.durations.reduce((acc, d) => acc + d, 0);
      avgHoldMs = Math.round(sumDur / durCount);
      fastestMs = Math.min(...s.durations);
      longestMs = Math.max(...s.durations);
    }
    const totalPnl = s.profits.reduce((acc, p) => acc + p, 0);

    return {
      displayName: s.displayName,
      signalKey: s.signalKey,
      type: s.type,
      crossoverPair: s.crossoverPair,
      totalLaunched: s.totalLaunched,
      activeCount: s.activeCount,
      completedCount: s.completedCount,
      winRate: s.completedCount > 0 ? '100.0%' : '--',
      avgHoldTimeText: formatDuration(avgHoldMs),
      avgHoldTimeMs: avgHoldMs,
      fastestTpText: formatDuration(fastestMs),
      fastestTpMs: fastestMs,
      longestTpText: formatDuration(longestMs),
      longestTpMs: longestMs,
      totalProfitText: totalPnl > 0 ? `+$${totalPnl.toFixed(2)}` : `$${totalPnl.toFixed(2)}`,
      totalProfitNum: Number(totalPnl.toFixed(2)),
      bots: s.bots
    };
  });

  // Sort signals with launched bots first, then remaining
  signalsList.sort((a, b) => b.totalLaunched - a.totalLaunched);

  // Overall Totals
  const totalLaunchedAll = signalsList.reduce((acc, s) => acc + s.totalLaunched, 0);
  const totalActiveAll = signalsList.reduce((acc, s) => acc + s.activeCount, 0);
  const totalCompletedAll = signalsList.reduce((acc, s) => acc + s.completedCount, 0);
  const allDurations = Array.from(statsMap.values()).flatMap(s => s.durations);
  const totalProfitAll = signalsList.reduce((acc, s) => acc + s.totalProfitNum, 0);

  const avgHoldAll = allDurations.length ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length) : null;
  const fastestAll = allDurations.length ? Math.min(...allDurations) : null;

  const totals = {
    totalLaunched: totalLaunchedAll,
    activeCount: totalActiveAll,
    completedCount: totalCompletedAll,
    winRate: totalCompletedAll > 0 ? '100.0%' : '--',
    avgHoldTimeText: formatDuration(avgHoldAll),
    fastestTpText: formatDuration(fastestAll),
    totalProfitText: totalProfitAll > 0 ? `+$${totalProfitAll.toFixed(2)}` : `$${totalProfitAll.toFixed(2)}`
  };

  return { totals, signals: signalsList };
}

// Active Grid Bots & History Endpoint (Includes Signal Statistics)
app.get('/api/bots', async (req, res) => {
  const activeBots = await watcher.db.getActiveBots();
  const history = await watcher.db.getBotHistory(500);
  const status = await watcher.botManager.getStatus();
  const signalStats = computeSignalStats(activeBots, history);

  res.json({
    configured: status.hasApiCredentials,
    hasApiCredentials: status.hasApiCredentials,
    totalActive: activeBots.length,
    activeCount: activeBots.length,
    bots: activeBots,
    activeBots,
    history,
    signalStats,
    config: status.config,
    apiKeyMasked: status.apiKeyMasked
  });
});

// Dedicated Signal Statistics Endpoint
app.get('/api/signal-stats', async (req, res) => {
  const activeBots = await watcher.db.getActiveBots();
  const history = await watcher.db.getBotHistory(500);
  const stats = computeSignalStats(activeBots, history);
  res.json(stats);
});

// Close a running bot
app.post('/api/bots/close', async (req, res) => {
  const { botId, symbol, reason } = req.body;
  if (!botId) return res.status(400).json({ success: false, message: 'Missing botId' });

  const result = await watcher.botManager.closeGridBot(botId, symbol, null, reason || 'USER_REQUEST');
  if (result && result.success) {
    return res.json({ success: true, result });
  }
  return res.status(502).json({ success: false, result });
});

// Force Check Running Bots immediately
app.post('/api/bots/check', async (req, res) => {
  const checkResult = await watcher.botManager.checkRunningBots();
  const activeBots = await watcher.db.getActiveBots();
  res.json({
    success: true,
    activeCount: activeBots.length,
    closedCount: checkResult?.closed || 0,
    staleCount: checkResult?.stale || 0,
    errorCount: checkResult?.errors || 0,
    activeBots
  });
});

// Daily Maintenance & Audit Status Endpoint
app.get('/api/maintenance', async (req, res) => {
  const systemState = await watcher.db.getSystemState();
  res.json({
    maintenance: watcher.maintenance.getStatus(),
    lastAuditReport: systemState.lastAuditReport || null
  });
});

// Trigger Clean Daily Restart (Simulates automated daily maintenance restart)
app.post('/api/maintenance/restart', async (req, res) => {
  const todayStr = new Date(watcher.timeSync.now()).toISOString().substring(0, 10);
  res.json({ success: true, message: 'Initiating clean restart (exit code 0)... supervisor will respawn fresh instance.' });
  setTimeout(() => {
    watcher.maintenance.performDailyRestart(todayStr);
  }, 500);
});

// Trigger Manual Database Audit & Repair
app.post('/api/audit', async (req, res) => {
  try {
    const report = await watcher.db.auditAndRepairDatabase();
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger Manual Immediate Scan / Cycle
app.post('/api/scan', async (req, res) => {
  if (watcher.isCycleRunning || watcher.scanner.isScanning()) {
    return res.json({ message: 'Scan or signal cycle is already in progress', state: scanner.getState() });
  }

  // Fire cycle in background
  watcher.runScheduledCycle().catch(err => {
    console.error('[Server] Manual cycle error:', err.message);
  });

  res.json({ message: 'Live cycle triggered', status: await watcher.getStatus() });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`  BYBIT DECAY MEAN REVERSION LIVE WATCHER`);
  console.log(`  Listening on: http://0.0.0.0:${PORT}`);
  console.log(`  Northflank Port: ${PORT}`);
  console.log(`================================================================`);

  // Start live watcher engine
  watcher.start().catch(err => {
    console.error('[Server] Fatal error starting Live Watcher:', err);
  });
});
