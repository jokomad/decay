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
  const { search, minGain, safeZoneOnly, sort } = req.query;
  const pairs = scanner.getResults({ search, minGain, safeZoneOnly, sort });
  res.json({
    total: pairs.length,
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

// Active Grid Bots & History Endpoint
app.get('/api/bots', async (req, res) => {
  const activeBots = await watcher.db.getActiveBots();
  const history = await watcher.db.getBotHistory(20);
  const status = await watcher.botManager.getStatus();
  res.json({
    configured: status.hasApiCredentials,
    hasApiCredentials: status.hasApiCredentials,
    totalActive: activeBots.length,
    activeCount: activeBots.length,
    bots: activeBots,
    activeBots,
    history,
    config: status.config,
    apiKeyMasked: status.apiKeyMasked
  });
});

// Close a running bot
app.post('/api/bots/close', async (req, res) => {
  const { botId, symbol, reason } = req.body;
  if (!botId) return res.status(400).json({ success: false, message: 'Missing botId' });

  const result = await watcher.botManager.closeGridBot(botId, symbol, null, reason || 'USER_REQUEST');
  res.json({ success: true, result });
});

// Force Check Running Bots immediately
app.post('/api/bots/check', async (req, res) => {
  const checkResult = await watcher.botManager.checkRunningBots();
  const activeBots = await watcher.db.getActiveBots();
  res.json({
    success: true,
    activeCount: activeBots.length,
    closedCount: checkResult?.closedCount || 0,
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
app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`  BYBIT DECAY MEAN REVERSION LIVE WATCHER`);
  console.log(`  Listening on: http://localhost:${PORT}`);
  console.log(`  Northflank Port: ${PORT}`);
  console.log(`================================================================`);

  // Start live watcher engine
  watcher.start().catch(err => {
    console.error('[Server] Fatal error starting Live Watcher:', err);
  });
});
