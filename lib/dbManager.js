/**
 * dbManager.js
 * 
 * Persistent Database Manager for 15M Candlesticks and Decay Signals.
 * Dual-Driver:
 * 1. Connects to MongoDB when available (e.g. Northflank MONGODB_URI or local Mongo).
 * 2. Automatically falls back to persistent local disk JSON storage (.data/candles_15m.json)
 *    when MongoDB is not reachable (ideal for local development without configuration).
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

class DbManager {
  constructor(options = {}) {
    this.mongoUri = options.mongoUri || process.env.MONGODB_URI || process.env.MONGO_URI || '';
    this.dbName = options.dbName || process.env.MONGODB_DB_NAME || '';
    this.mongoConfigured = !!this.mongoUri;
    this.persistenceHealthy = false;
    this.driver = 'local'; // 'mongo' or 'local'
    this.mongoClient = null;
    this.mongoDb = null;

    // Local fallback paths
    this.dataDir = path.join(__dirname, '..', '.data');
    this.candlesFile = path.join(this.dataDir, 'candles_15m.json');
    this.signalsFile = path.join(this.dataDir, 'decay_signals.json');
    this.systemStateFile = path.join(this.dataDir, 'system_state.json');
    this.botsFile = path.join(this.dataDir, 'active_bots.json');
    this.botHistoryFile = path.join(this.dataDir, 'bot_history.json');
    // Crash-recovery journal for bots that were created on Bybit but could not
    // be written to the active-bot store. Kept outside Mongo on purpose.
    this.botJournalFile = path.join(this.dataDir, 'pending_bot_journal.json');

    // In-memory cache for ultra-fast access
    this.candlesCache = new Map();
    this.signalsCache = [];
    this.activeBotsCache = new Map();
    this.botHistoryCache = [];
    this.botJournalCache = [];

    // Per-symbol write queue to prevent overlapping write race conditions
    this.symbolQueues = new Map();
  }

  /**
   * Enqueue symbol operation to guarantee strictly sequential execution
   */
  _enqueueSymbol(symbol, fn) {
    const queue = this.symbolQueues.get(symbol) || Promise.resolve();
    const next = queue.then(() => fn()).catch(err => {
      console.error(`[DB Queue] Error processing symbol ${symbol}:`, err.message);
    });
    this.symbolQueues.set(symbol, next);
    next.finally(() => {
      if (this.symbolQueues.get(symbol) === next) {
        this.symbolQueues.delete(symbol);
      }
    });
    return next;
  }

  /**
   * Initialize Database connection or fallback store
   */
  async init() {
    // Ensure local data directory exists for fallback
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Load the local orphan-bot journal before any storage driver is chosen.
    this._loadBotJournal();

    // Try MongoDB first with a short timeout (only if URI is configured or local)
    const effectiveUri = this.mongoUri || 'mongodb://127.0.0.1:27017/bybit_decay';
    try {
      console.log(`[DB] Attempting connection to MongoDB at ${effectiveUri.replace(/:[^:]*@/, ':****@')}...`);
      this.mongoClient = new MongoClient(effectiveUri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });

      await this.mongoClient.connect();

      // Extract database from URI path if present (e.g. /6b2b99b2f5e4).
      // Northflank and managed cloud MongoDB addons strictly enforce permissions only on the URI database.
      const urlMatch = effectiveUri.match(/mongodb(?:\+srv)?:\/\/[^\/]+\/([^?]+)/);
      const uriDbName = urlMatch ? urlMatch[1] : null;

      if (uriDbName) {
        this.mongoDb = this.mongoClient.db(uriDbName);
      } else if (this.dbName) {
        this.mongoDb = this.mongoClient.db(this.dbName);
      } else {
        this.mongoDb = this.mongoClient.db();
      }
      this.driver = 'mongo';
      this.persistenceHealthy = true;

      console.log(`[DB] ✅ Connected to MongoDB successfully. Using database: "${this.mongoDb.databaseName}" (TTL Retention Indices active).`);

      // Create compound index for fast symbol candle lookups
      await this.mongoDb.collection('candles_15m').createIndex({ symbol: 1 }, { unique: true });
      await this.mongoDb.collection('decay_signals').createIndex({ timestamp: -1 });
      await this.mongoDb.collection('active_bots').createIndex({ symbol: 1 });
      await this.mongoDb.collection('active_bots').createIndex({ botId: 1 }, { unique: true });
      // Durable orphan-bot journal. This must live in Mongo on Northflank
      // because the container filesystem is ephemeral.
      await this.mongoDb.collection('pending_bot_journal').createIndex({ botId: 1 }, { unique: true });

      // Automatic MongoDB TTL Indices for retention pruning:
      // 1. decay_signals: auto-expires documents older than 48 hours (172800s)
      await this.mongoDb.collection('decay_signals').createIndex({ createdAtDate: 1 }, { expireAfterSeconds: 48 * 3600 });
      // 2. bot_history: auto-expires documents older than 7 days (604800s)
      await this.mongoDb.collection('bot_history').createIndex({ archivedAtDate: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
      // 3. candles_15m: index on updatedAt for fast pruning of inactive symbols
      await this.mongoDb.collection('candles_15m').createIndex({ updatedAt: 1 });


      return;
    } catch (err) {
      this.driver = 'local';
      // If a persistent Mongo URI was configured, local storage is only a
      // development fallback. Bot creation must fail closed rather than open
      // an untracked bot on a fresh Northflank container.
      this.persistenceHealthy = !this.mongoConfigured;
      console.warn(`[DB] ⚠️ MongoDB connection skipped (${err.message}). Using local persistent disk storage: ${this.candlesFile}`);
      if (this.mongoConfigured) {
        console.error('[DB] 🛑 Persistent Mongo is configured but unavailable. New grid-bot creation will be BLOCKED until persistence is healthy.');
      }
    }

    // Load existing local storage if present
    this._loadLocalStorage();
  }

  _loadLocalStorage() {
    try {
      if (fs.existsSync(this.candlesFile)) {
        const raw = fs.readFileSync(this.candlesFile, 'utf8');
        const data = JSON.parse(raw);
        for (const [sym, cList] of Object.entries(data)) {
          this.candlesCache.set(sym, cList);
        }
        console.log(`[DB] Loaded ${this.candlesCache.size} symbols from local storage.`);
      }
      if (fs.existsSync(this.signalsFile)) {
        const raw = fs.readFileSync(this.signalsFile, 'utf8');
        this.signalsCache = JSON.parse(raw);
      }
      if (fs.existsSync(this.botsFile)) {
        const raw = fs.readFileSync(this.botsFile, 'utf8');
        const bots = JSON.parse(raw);
        if (Array.isArray(bots)) {
          for (const b of bots) {
            this.activeBotsCache.set(b.botId, b);
          }
        }
        console.log(`[DB] Loaded ${this.activeBotsCache.size} active bots from local storage.`);
      }
      if (fs.existsSync(this.botHistoryFile)) {
        const raw = fs.readFileSync(this.botHistoryFile, 'utf8');
        this.botHistoryCache = JSON.parse(raw);
      }
    } catch (e) {
      console.error('[DB] Failed to load local storage:', e.message);
    }
  }

  _saveLocalStorage(strict = false) {
    try {
      const obj = {};
      for (const [sym, cList] of this.candlesCache.entries()) {
        obj[sym] = cList;
      }
      fs.writeFileSync(this.candlesFile, JSON.stringify(obj, null, 2), 'utf8');
      fs.writeFileSync(this.signalsFile, JSON.stringify(this.signalsCache.slice(0, 50), null, 2), 'utf8');

      const botsArr = Array.from(this.activeBotsCache.values());
      fs.writeFileSync(this.botsFile, JSON.stringify(botsArr, null, 2), 'utf8');
      fs.writeFileSync(this.botHistoryFile, JSON.stringify(this.botHistoryCache.slice(0, 50), null, 2), 'utf8');
    } catch (e) {
      console.error('[DB] Failed to save local storage:', e.message);
      if (strict) throw e;
    }
  }

  /**
   * Load the local orphan-bot journal fallback. When Mongo is available the
   * durable journal is the pending_bot_journal collection; the local file is
   * only used if Mongo is unavailable.
   */
  _loadBotJournal() {
    try {
      if (!fs.existsSync(this.botJournalFile)) return;
      const raw = fs.readFileSync(this.botJournalFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.botJournalCache = Array.isArray(parsed) ? parsed : [];
      console.log(`[DB] Loaded ${this.botJournalCache.length} pending bot journal entr${this.botJournalCache.length === 1 ? 'y' : 'ies'}.`);
    } catch (e) {
      console.error('[DB] Failed to load bot journal:', e.message);
      this.botJournalCache = [];
    }
  }

  _saveBotJournal() {
    const tmp = `${this.botJournalFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.botJournalCache, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, this.botJournalFile);
    } catch (e) {
      // Windows can refuse to rename over an existing file. Copying is not
      // atomic, but the journal is tiny and this is only the fallback path.
      fs.copyFileSync(tmp, this.botJournalFile);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async addBotJournal(entry) {
    if (!entry || !entry.botId) return false;
    const botId = String(entry.botId);
    const idx = this.botJournalCache.findIndex(e => String(e.botId) === botId);
    const record = { ...entry, botId };
    if (idx >= 0) this.botJournalCache[idx] = { ...this.botJournalCache[idx], ...record };
    else this.botJournalCache.push(record);

    if (this.driver === 'mongo') {
      try {
        await this.mongoDb.collection('pending_bot_journal').updateOne(
          { botId },
          { $set: { ...record, updatedAt: new Date() } },
          { upsert: true }
        );
        return true;
      } catch (e) {
        console.error(`[DB] Failed to persist bot journal for ${botId} to Mongo:`, e.message);
      }
    }

    try {
      this._saveBotJournal();
      return true;
    } catch (e) {
      console.error(`[DB] Failed to persist bot journal for ${botId}:`, e.message);
      return false;
    }
  }

  async removeBotJournal(botId) {
    if (!botId) return false;
    const id = String(botId);
    this.botJournalCache = this.botJournalCache.filter(e => String(e.botId) !== id);

    if (this.driver === 'mongo') {
      try {
        await this.mongoDb.collection('pending_bot_journal').deleteOne({ botId: id });
        return true;
      } catch (e) {
        console.error(`[DB] Failed to remove bot journal ${id} from Mongo:`, e.message);
      }
    }

    try {
      this._saveBotJournal();
      return true;
    } catch (e) {
      console.error(`[DB] Failed to persist bot journal after removing ${id}:`, e.message);
      return false;
    }
  }

  async getBotJournal() {
    if (this.driver === 'mongo') {
      try {
        const docs = await this.mongoDb.collection('pending_bot_journal').find({}).toArray();
        const merged = new Map();
        for (const d of docs) {
          const { _id, ...entry } = d;
          merged.set(String(entry.botId), entry);
        }
        // Include any local/fallback entries not yet visible in Mongo.
        for (const entry of this.botJournalCache) {
          if (!merged.has(String(entry.botId))) merged.set(String(entry.botId), entry);
        }
        this.botJournalCache = Array.from(merged.values());
        return this.botJournalCache.slice();
      } catch (e) {
        console.error('[DB] Error reading bot journal from Mongo:', e.message);
      }
    }
    return this.botJournalCache.slice();
  }

  /**
   * Get 15M candles for a symbol
   */
  async getCandles(symbol, limit = 100) {
    if (this.driver === 'mongo') {
      try {
        const doc = await this.mongoDb.collection('candles_15m').findOne({ symbol });
        if (doc && doc.candles) {
          return doc.candles.slice(-limit);
        }
      } catch (e) {
        console.error(`[DB] Error reading candles for ${symbol}:`, e.message);
      }
    }

    const cached = this.candlesCache.get(symbol);
    return cached ? cached.slice(-limit) : [];
  }

  /**
   * Check if symbol has at least minCount candles
   */
  async hasCandles(symbol, minCount = 45) {
    const list = await this.getCandles(symbol, minCount);
    return list.length >= minCount;
  }

  /**
   * Bulk check missing symbols
   */
  async getMissingSymbols(symbols, minCount = 45) {
    const missing = [];
    for (const sym of symbols) {
      const has = await this.hasCandles(sym, minCount);
      if (!has) missing.push(sym);
    }
    return missing;
  }

  /**
   * Save full candle set (e.g. from initial REST fetch)
   */
  async saveCandles(symbol, candles) {
    if (!candles || candles.length === 0) return;

    return this._enqueueSymbol(symbol, async () => {
      // Standardize candle schema
      const formatted = candles.map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      })).sort((a, b) => a.time - b.time);

      // Keep latest 100
      const trimmed = formatted.slice(-100);

      // In-memory cache
      this.candlesCache.set(symbol, trimmed);

      if (this.driver === 'mongo') {
        try {
          await this.mongoDb.collection('candles_15m').updateOne(
            { symbol },
            { $set: { symbol, candles: trimmed, updatedAt: new Date() } },
            { upsert: true }
          );
          return;
        } catch (e) {
          console.error(`[DB] Error saving candles for ${symbol}:`, e.message);
        }
      }

      this._saveLocalStorage();
    });
  }

  /**
   * Append a single confirmed/finished candle (e.g. from WebSocket confirm: true)
   */
  async appendFinishedCandle(symbol, candle) {
    return this._enqueueSymbol(symbol, async () => {
      const c = {
        time: Number(candle.time),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume || 0)
      };

      let existing = await this.getCandles(symbol, 100);
      if (!existing) existing = [];

      // Replace if same time, otherwise append
      const idx = existing.findIndex(e => e.time === c.time);
      if (idx >= 0) {
        existing[idx] = c;
      } else {
        existing.push(c);
        existing.sort((a, b) => a.time - b.time);
      }

      const trimmed = existing.slice(-100);
      this.candlesCache.set(symbol, trimmed);

      if (this.driver === 'mongo') {
        try {
          await this.mongoDb.collection('candles_15m').updateOne(
            { symbol },
            { $set: { symbol, candles: trimmed, updatedAt: new Date() } },
            { upsert: true }
          );
          return;
        } catch (e) {
          console.error(`[DB] Error appending candle for ${symbol}:`, e.message);
        }
      }

      this._saveLocalStorage();
    });
  }

  /**
   * Delete symbol data when price breaches baseline floor or is retired
   */
  async removeSymbol(symbol) {
    return this._enqueueSymbol(symbol, async () => {
      this.candlesCache.delete(symbol);

      if (this.driver === 'mongo') {
        try {
          await this.mongoDb.collection('candles_15m').deleteOne({ symbol });
        } catch (e) {
          console.error(`[DB] Error deleting symbol ${symbol}:`, e.message);
        }
      } else {
        this._saveLocalStorage();
      }
    });
  }

  /**
   * Save triggered signal event
   */
  async saveSignal(signal) {
    signal.id = signal.id || `${signal.symbol}-${Date.now()}`;
    const nowIso = new Date().toISOString();
    signal.createdAt = signal.createdAt || nowIso;
    signal.createdAtDate = new Date(); // BSON Date for Mongo 48h TTL index

    this.signalsCache.unshift(signal);
    if (this.signalsCache.length > 50) this.signalsCache.pop(); // Cap at max 50

    if (this.driver === 'mongo') {
      try {
        await this.mongoDb.collection('decay_signals').insertOne(signal);
      } catch (e) {
        console.error('[DB] Error saving signal:', e.message);
      }
    } else {
      this._saveLocalStorage();
    }
  }

  /**
   * Get latest signals
   */
  async getSignals(limit = 50) {
    if (this.driver === 'mongo') {
      try {
        return await this.mongoDb.collection('decay_signals')
          .find()
          .sort({ timestamp: -1 })
          .limit(limit)
          .toArray();
      } catch (e) {
        console.error('[DB] Error getting signals:', e.message);
      }
    }
    return this.signalsCache.slice(0, limit);
  }

  /**
   * Get all currently active running grid bots
   */
  async getActiveBots() {
    if (this.driver === 'mongo') {
      try {
        const docs = await this.mongoDb.collection('active_bots').find({ status: 'RUNNING' }).toArray();
        // The cache is updated before the Mongo write. If that write failed,
        // the bot is still live and must remain visible to the PnL watcher.
        const merged = new Map();
        for (const d of docs) {
          const { _id, ...bot } = d;
          merged.set(String(bot.botId), bot);
        }
        for (const bot of this.activeBotsCache.values()) {
          if (bot.status === 'RUNNING' && !merged.has(String(bot.botId))) {
            merged.set(String(bot.botId), bot);
          }
        }
        return Array.from(merged.values());
      } catch (e) {
        console.error('[DB] Error getting active bots from Mongo:', e.message);
      }
    }
    return Array.from(this.activeBotsCache.values()).filter(b => b.status === 'RUNNING');
  }

  /**
   * Check if a symbol already has an active running bot
   */
  async getActiveBotBySymbol(symbol) {
    if (this.driver === 'mongo') {
      try {
        const doc = await this.mongoDb.collection('active_bots').findOne({ symbol, status: 'RUNNING' });
        if (doc) { const { _id, ...bot } = doc; return bot; }
      } catch (e) {
        console.error(`[DB] Error querying active bot for ${symbol}:`, e.message);
      }
    }
    for (const b of this.activeBotsCache.values()) {
      if (b.symbol === symbol && b.status === 'RUNNING') return b;
    }
    return null;
  }

  /**
   * Save newly created active grid bot
   */
  async saveActiveBot(bot) {
    bot.botId = String(bot.botId);
    bot.status = bot.status || 'RUNNING';
    bot.createdAt = bot.createdAt || Date.now();
    bot.lastCheckedAt = Date.now();

    this.activeBotsCache.set(bot.botId, bot);

    if (this.driver === 'mongo') {
      try {
        await this.mongoDb.collection('active_bots').updateOne(
          { botId: bot.botId },
          { $set: bot },
          { upsert: true }
        );
        return;
      } catch (e) {
        console.error(`[DB] Error saving active bot ${bot.botId} to Mongo:`, e.message);
        // Do not silently treat a failed active-bot write as success. The
        // caller must close the Bybit bot or journal it for recovery.
        throw e;
      }
    }

    this._saveLocalStorage(true);
  }

  /**
   * Remove or update ended grid bot from active collection and archive to history
   */
  async removeActiveBot(botId, closedBotData = null) {
    botId = String(botId);
    const bot = this.activeBotsCache.get(botId) || closedBotData;

    this.activeBotsCache.delete(botId);

    if (bot) {
      const nowIso = new Date().toISOString();
      const archived = {
        ...bot,
        ...closedBotData,
        archivedAt: nowIso,
        archivedAtDate: new Date() // BSON Date for Mongo 7-day TTL index
      };
      this.botHistoryCache.unshift(archived);
      if (this.botHistoryCache.length > 50) this.botHistoryCache.pop(); // Cap at max 50

      if (this.driver === 'mongo') {
        try {
          await this.mongoDb.collection('active_bots').deleteOne({ botId });
          await this.mongoDb.collection('bot_history').insertOne(archived);
          return;
        } catch (e) {
          console.error(`[DB] Error removing bot ${botId} from Mongo:`, e.message);
        }
      }
    }

    this._saveLocalStorage();
  }

  /**
   * Get bot history
   */
  async getBotHistory(limit = 50) {
    if (this.driver === 'mongo') {
      try {
        return await this.mongoDb.collection('bot_history')
          .find()
          .sort({ archivedAt: -1 })
          .limit(limit)
          .toArray();
      } catch (e) {
        console.error('[DB] Error getting bot history:', e.message);
      }
    }
    return this.botHistoryCache.slice(0, limit);
  }

  /**
   * Comprehensive Database & Memory Pruning Routine
   * - Prunes bot_history older than 7 days (caps at max 50 records)
   * - Prunes decay_signals older than 48 hours (caps at max 50 records)
   * - Prunes candles_15m for inactive symbols older than 24 hours
   */
  async pruneDatabase(activeSafeZoneSymbols = []) {
    const t0 = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    let prunedSignals = 0;
    let prunedBots = 0;
    let prunedSymbols = 0;

    // 1. Prune In-Memory & Local Bot History (>7 days or >50 records)
    const originalBotHistoryLen = this.botHistoryCache.length;
    this.botHistoryCache = this.botHistoryCache.filter(b => {
      const time = b.archivedAt ? new Date(b.archivedAt).getTime() : (b.endedAt || b.createdAt || 0);
      return (now - time) < SEVEN_DAYS_MS;
    }).slice(0, 50);
    prunedBots = originalBotHistoryLen - this.botHistoryCache.length;

    // 2. Prune In-Memory & Local Signals (>48h or >50 records)
    const originalSignalsLen = this.signalsCache.length;
    this.signalsCache = this.signalsCache.filter(s => {
      const time = s.createdAt ? new Date(s.createdAt).getTime() : new Date(s.timestamp).getTime();
      return (now - time) < FORTY_EIGHT_HOURS_MS;
    }).slice(0, 50);
    prunedSignals = originalSignalsLen - this.signalsCache.length;

    // 3. Prune Inactive Candles from Memory
    if (Array.isArray(activeSafeZoneSymbols) && activeSafeZoneSymbols.length > 0) {
      const safeSet = new Set(activeSafeZoneSymbols);
      // Keep any symbol with an active running bot
      for (const bot of this.activeBotsCache.values()) {
        safeSet.add(bot.symbol);
      }
      for (const sym of this.candlesCache.keys()) {
        if (!safeSet.has(sym)) {
          this.candlesCache.delete(sym);
          prunedSymbols++;
        }
      }
    }

    // 4. Prune MongoDB collections if active
    if (this.driver === 'mongo' && this.mongoDb) {
      try {
        const sevenDaysAgo = new Date(now - SEVEN_DAYS_MS);
        const fortyEightHoursAgo = new Date(now - FORTY_EIGHT_HOURS_MS);
        const twentyFourHoursAgo = new Date(now - TWENTY_FOUR_HOURS_MS);

        // Delete old bot history in Mongo
        const bRes = await this.mongoDb.collection('bot_history').deleteMany({
          $or: [
            { archivedAtDate: { $lt: sevenDaysAgo } },
            { archivedAt: { $lt: sevenDaysAgo.toISOString() } }
          ]
        });
        if (bRes.deletedCount) prunedBots += bRes.deletedCount;

        // Delete old signals in Mongo
        const sRes = await this.mongoDb.collection('decay_signals').deleteMany({
          $or: [
            { createdAtDate: { $lt: fortyEightHoursAgo } },
            { createdAt: { $lt: fortyEightHoursAgo.toISOString() } },
            { timestamp: { $lt: fortyEightHoursAgo.toISOString() } }
          ]
        });
        if (sRes.deletedCount) prunedSignals += sRes.deletedCount;

        // Delete stale inactive candles in Mongo
        if (Array.isArray(activeSafeZoneSymbols) && activeSafeZoneSymbols.length > 0) {
          const safeSetArr = Array.from(new Set(activeSafeZoneSymbols));
          const cRes = await this.mongoDb.collection('candles_15m').deleteMany({
            symbol: { $nin: safeSetArr },
            updatedAt: { $lt: twentyFourHoursAgo }
          });
          if (cRes.deletedCount) prunedSymbols += cRes.deletedCount;
        }
      } catch (mErr) {
        console.error('[DB Pruning] Error during MongoDB pruning:', mErr.message);
      }
    } else {
      this._saveLocalStorage();
    }

    console.log(`[DB Pruning] 🧹 Retention Prune: Kept max 50 bots (7d), 50 signals (48h). Pruned ${prunedBots} old bots, ${prunedSignals} old signals, ${prunedSymbols} inactive symbols in ${Date.now() - t0}ms.`);
    return { prunedBots, prunedSignals, prunedSymbols };
  }

  /**
   * Get System State (metadata like lastDailyRestartDate, lastAuditReport)
   */
  async getSystemState() {
    if (this.driver === 'mongo') {
      try {
        const doc = await this.mongoDb.collection('system_state').findOne({ id: 'app_state' });
        if (doc) return doc;
      } catch (e) {
        console.error('[DB] Error reading system state from Mongo:', e.message);
      }
    }

    try {
      if (fs.existsSync(this.systemStateFile)) {
        return JSON.parse(fs.readFileSync(this.systemStateFile, 'utf8'));
      }
    } catch (e) {
      console.error('[DB] Error reading local system state:', e.message);
    }
    return {};
  }

  /**
   * Save System State
   */
  async saveSystemState(stateUpdate) {
    const current = await this.getSystemState();
    const merged = { ...current, ...stateUpdate, id: 'app_state', updatedAt: new Date().toISOString() };

    if (this.driver === 'mongo') {
      try {
        await this.mongoDb.collection('system_state').updateOne(
          { id: 'app_state' },
          { $set: merged },
          { upsert: true }
        );
        return merged;
      } catch (e) {
        console.error('[DB] Error saving system state to Mongo:', e.message);
      }
    }

    try {
      fs.writeFileSync(this.systemStateFile, JSON.stringify(merged, null, 2), 'utf8');
    } catch (e) {
      console.error('[DB] Error saving local system state:', e.message);
    }
    return merged;
  }

  /**
   * Comprehensive Database Audit & Candlestick Repair
   * Runs automatically after every daily restart or on boot.
   * 1. Inspects all symbols in DB for corrupted candles (NaN, non-numbers, <= 0).
   * 2. Checks candle sequencing & detects gaps in 15M series (delta !== 900,000ms).
   * 3. Backfills missing candles via Bybit REST API.
   * 4. Deduplicates and ensures strictly sorted series.
   */
  async auditAndRepairDatabase() {
    console.log(`\n[DB Audit] 🔍 Running Comprehensive Database Integrity & Candlestick Gap Check...`);
    const t0 = Date.now();

    const symbols = Array.from(this.candlesCache.keys());
    let corruptedCandlesRemoved = 0;
    let gapsDetected = 0;
    let gapsBackfilled = 0;
    let symbolsChecked = 0;
    const repairedSymbols = [];

    for (const symbol of symbols) {
      symbolsChecked++;
      let candles = await this.getCandles(symbol, 100);
      if (!candles || candles.length === 0) continue;

      let hasCorrupted = false;
      const valid = [];
      const seenTimes = new Set();

      for (const c of candles) {
        const time = Number(c.time);
        const open = Number(c.open);
        const high = Number(c.high);
        const low = Number(c.low);
        const close = Number(c.close);

        if (isNaN(time) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || open <= 0 || close <= 0) {
          corruptedCandlesRemoved++;
          hasCorrupted = true;
          continue;
        }

        // Deduplicate timestamp
        if (seenTimes.has(time)) {
          continue;
        }
        seenTimes.add(time);

        valid.push({
          time,
          open,
          high,
          low,
          close,
          volume: Number(c.volume || 0)
        });
      }

      valid.sort((a, b) => a.time - b.time);

      // Check for 15M time gaps
      let hasGap = false;
      if (valid.length < 50) {
        hasGap = true;
      } else {
        for (let i = 1; i < valid.length; i++) {
          const delta = valid[i].time - valid[i - 1].time;
          // In 15M, delta should be exactly 900,000 ms (15 * 60 * 1000)
          if (delta > 900000) {
            hasGap = true;
            gapsDetected++;
            break;
          }
        }
      }

      // If gap detected or candles missing, backfill from Bybit REST API
      if (hasGap) {
        console.log(`[DB Audit] ⚠️ 15M Gap detected for ${symbol} (count: ${valid.length}). Fetching 100 fresh candles via REST...`);
        try {
          const res = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=100`);
          const data = await res.json();
          if (data.retCode === 0 && data.result?.list && data.result.list.length >= 20) {
            const freshCandles = data.result.list.slice().reverse().map(k => ({
              time: parseInt(k[0], 10),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5])
            }));

            await this.saveCandles(symbol, freshCandles);
            gapsBackfilled++;
            repairedSymbols.push(symbol);
            continue;
          }
        } catch (err) {
          console.error(`[DB Audit] Failed to backfill candles for ${symbol}:`, err.message);
        }
      }

      // If corrupted candles were cleaned up but no gap was found, resave valid
      if (hasCorrupted) {
        await this.saveCandles(symbol, valid);
      }
    }

    const durationMs = Date.now() - t0;
    const report = {
      timestamp: new Date().toISOString(),
      durationMs,
      symbolsChecked,
      corruptedCandlesRemoved,
      gapsDetected,
      gapsBackfilled,
      repairedSymbols,
      status: 'healthy'
    };

    console.log(`[DB Audit] ✅ Audit Complete in ${durationMs}ms: Checked ${symbolsChecked} symbols | Cleaned ${corruptedCandlesRemoved} corrupted | Repaired ${gapsBackfilled} gaps.`);
    await this.saveSystemState({ lastAuditReport: report });
    return report;
  }

  /**
   * Get database statistics
   */
  getStats() {
    return {
      driver: this.driver,
      mongoConfigured: this.mongoConfigured,
      persistenceHealthy: this.persistenceHealthy,
      totalSymbols: this.candlesCache.size,
      totalSignals: this.signalsCache.length
    };
  }
}

module.exports = DbManager;
