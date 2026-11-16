/**
 * multiTfStore.js
 *
 * Multi-Timeframe Candle Storage and Restart Gap Stitcher for BybitDecay.
 *
 * Purpose:
 * 1. Stores and maintains rolling multi-TF candles for Safe Zone symbols only (~6 to 15 coins).
 * 2. Uses MongoDB collection 'candles_multi_tf' with automatic fallback to local .data/candles_multi_tf.json.
 * 3. Keeps total database footprint under 1 MB on Northflank (< 0.02% of 6 GB tier).
 * 4. Provides sub-second hydration on boot and instant gap-stitching after the daily
 *    2-second clean restart (04:05 UTC).
 * 5. Provides synchronous in-memory access for the 1-minute ticker.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Indicator = require('./crossoverIndicator');

const REST_TIMEOUT_MS = 6000;
const MAX_1M_CANDLES = 500;
const MAX_HIGHER_CANDLES = 50;

const BYBIT_INTERVAL_MAP = Object.freeze({
  '1m': '1',
  '1h': '60',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D'
});

const STORED_TIMEFRAMES = Object.freeze(['1m', '1h', '4h', '6h', '12h', '1d']);

class MultiTfStore {
  /**
   * @param {Object} dbManager - Existing DbManager instance
   * @param {Object} [options]
   * @param {Object} [options.rateLimiter] - Optional rate limiter instance
   * @param {Function} [options.fetchFn] - Custom fetch function for testing
   */
  constructor(dbManager, options = {}) {
    this.db = dbManager;
    this.rateLimiter = options.rateLimiter || null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.collectionName = 'candles_multi_tf';

    // Local fallback path
    this.localFile = path.join(
      this.db?.dataDir || path.join(__dirname, '..', '.data'),
      'candles_multi_tf.json'
    );

    // In-memory cache: symbol -> { '1m': [], '1h': [], ... }
    this.cache = new Map();
    this.initialized = false;
    this.syncQueue = new Map();
  }

  /**
   * Initialize collection indexes in MongoDB or ensure local file
   */
  async init() {
    if (this.initialized) return;

    if (this.db?.driver === 'mongo' && this.db.mongoDb) {
      try {
        await this.db.mongoDb.collection(this.collectionName).createIndex(
          { symbol: 1 },
          { unique: true }
        );
        await this.db.mongoDb.collection(this.collectionName).createIndex(
          { updatedAt: 1 }
        );
        console.log(`[MultiTfStore] ✅ MongoDB collection "${this.collectionName}" indexed.`);
      } catch (e) {
        console.error(`[MultiTfStore] Warning creating indexes on ${this.collectionName}:`, e.message);
      }
    } else {
      const dir = path.dirname(this.localFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // Hydrate in-memory cache from persistence
    await this.hydrateFromStore();
    this.initialized = true;
  }

  /**
   * Hydrates in-memory cache from MongoDB or local file on startup
   */
  async hydrateFromStore() {
    this.cache.clear();

    if (this.db?.driver === 'mongo' && this.db.mongoDb) {
      try {
        const docs = await this.db.mongoDb.collection(this.collectionName).find({}).toArray();
        for (const doc of docs) {
          if (doc.symbol && doc.candles) {
            this.cache.set(doc.symbol, doc.candles);
          }
        }
        console.log(`[MultiTfStore] 📦 Hydrated ${this.cache.size} symbols from MongoDB "${this.collectionName}".`);
        return;
      } catch (e) {
        console.error('[MultiTfStore] Failed to read from Mongo, attempting local fallback:', e.message);
      }
    }

    if (fs.existsSync(this.localFile)) {
      try {
        const raw = fs.readFileSync(this.localFile, 'utf8');
        const parsed = JSON.parse(raw);
        for (const [sym, candles] of Object.entries(parsed)) {
          this.cache.set(sym, candles);
        }
        console.log(`[MultiTfStore] 📦 Hydrated ${this.cache.size} symbols from local storage.`);
      } catch (e) {
        console.error('[MultiTfStore] Failed to read local storage:', e.message);
      }
    }
  }

  /**
   * Persists a symbol's candle set to MongoDB or local storage
   */
  async persistSymbol(symbol) {
    const candles = this.cache.get(symbol);
    if (!candles) return;

    if (this.db?.driver === 'mongo' && this.db.mongoDb) {
      try {
        await this.db.mongoDb.collection(this.collectionName).updateOne(
          { symbol },
          {
            $set: {
              symbol,
              candles,
              updatedAt: new Date()
            }
          },
          { upsert: true }
        );
        return;
      } catch (e) {
        console.error(`[MultiTfStore] Mongo persist failed for ${symbol}:`, e.message);
      }
    }

    try {
      const obj = {};
      for (const [s, c] of this.cache.entries()) {
        obj[s] = c;
      }
      fs.writeFileSync(this.localFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error(`[MultiTfStore] Local persist failed for ${symbol}:`, e.message);
    }
  }

  /**
   * Fetches candles directly from Bybit REST API with rate-limiting and retries
   */
  async fetchBybitKlines(symbol, interval, limit = 100) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let release = null;
      try {
        if (this.rateLimiter) {
          release = await this.rateLimiter.acquire();
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);

        const res = await this.fetchFn(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (release) {
          release();
          release = null;
        }

        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 250 * attempt));
          continue;
        }

        const data = await res.json();
        if (data.retCode === 0 && data.result?.list) {
          // Convert Bybit's reverse-chronological list to ascending sorted candles
          return data.result.list.slice().reverse().map(c => ({
            time: parseInt(c[0], 10),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
          }));
        }

        if (data.retCode === 10006) {
          // Rate limit error code from Bybit
          await new Promise(r => setTimeout(r, 300 * attempt));
          continue;
        }
      } catch (e) {
        if (release) {
          release();
          release = null;
        }
        if (attempt === 3) {
          console.error(`[MultiTfStore] Kline fetch error for ${symbol} interval=${interval}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 200 * attempt));
      } finally {
        if (release) {
          release();
          release = null;
        }
      }
    }

    return null;
  }

  /**
   * Warms up multi-TF candles for a Safe Zone symbol.
   * - Performs cold-boot initial fetch if missing.
   * - Performs lightweight gap stitching if restarted shortly after shutdown.
   *
   * @param {string} symbol - e.g. 'KMNOUSDT'
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<boolean>} True if symbol has sufficient candles across all TFs
   */
  async warmupSymbol(symbol, forceRefresh = false) {
    if (!symbol) return false;

    // Enqueue per-symbol to avoid concurrent warmups for the same coin
    const currentPromise = this.syncQueue.get(symbol) || Promise.resolve();
    const nextPromise = currentPromise.then(async () => {
      let symbolCandles = this.cache.get(symbol);
      if (!symbolCandles) {
        symbolCandles = {
          '1m': [],
          '1h': [],
          '4h': [],
          '6h': [],
          '12h': [],
          '1d': []
        };
        this.cache.set(symbol, symbolCandles);
      }

      let updated = false;

      // 1. Check Macro Timeframes (1h, 4h, 6h, 12h, 1d)
      for (const tf of ['1h', '4h', '6h', '12h', '1d']) {
        const existing = symbolCandles[tf] || [];
        const intervalStr = BYBIT_INTERVAL_MAP[tf];

        if (forceRefresh || existing.length < 25) {
          const fresh = await this.fetchBybitKlines(symbol, intervalStr, 40);
          if (fresh && fresh.length >= 20) {
            symbolCandles[tf] = fresh.slice(-MAX_HIGHER_CANDLES);
            updated = true;
          }
        }
      }

      // 2. Check 1m Timeframe (with gap stitching)
      const existing1m = symbolCandles['1m'] || [];
      const now = Date.now();

      if (forceRefresh || existing1m.length < 100) {
        // Cold-boot fetch: 200 1m candles
        const fresh1m = await this.fetchBybitKlines(symbol, '1', 200);
        if (fresh1m && fresh1m.length > 0) {
          symbolCandles['1m'] = fresh1m.slice(-MAX_1M_CANDLES);
          updated = true;
        }
      } else {
        // Gap stitch: check difference between latest cached 1m candle and now
        const lastTime = existing1m[existing1m.length - 1].time;
        const gapMin = Math.floor((now - lastTime) / 60000);

        if (gapMin > 1) {
          const fetchLimit = Math.min(200, gapMin + 5);
          const gapCandles = await this.fetchBybitKlines(symbol, '1', fetchLimit);
          if (gapCandles && gapCandles.length > 0) {
            // Merge & deduplicate
            const candleMap = new Map();
            for (const c of existing1m) candleMap.set(c.time, c);
            for (const c of gapCandles) candleMap.set(c.time, c);

            const merged = Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
            symbolCandles['1m'] = merged.slice(-MAX_1M_CANDLES);
            updated = true;
          }
        }
      }

      if (updated) {
        await this.persistSymbol(symbol);
      }

      return this.hasSufficientData(symbol);
    });

    this.syncQueue.set(symbol, nextPromise);
    try {
      return await nextPromise;
    } finally {
      if (this.syncQueue.get(symbol) === nextPromise) {
        this.syncQueue.delete(symbol);
      }
    }
  }

  /**
   * Appends or updates a newly completed 1m candle into memory and marks for persistence
   */
  async append1mCandle(symbol, candle) {
    if (!symbol || !candle) return;
    const norm = Indicator.normalizeCandle(candle);
    if (!norm) return;

    let symbolCandles = this.cache.get(symbol);
    if (!symbolCandles) {
      symbolCandles = {
        '1m': [],
        '1h': [],
        '4h': [],
        '6h': [],
        '12h': [],
        '1d': []
      };
      this.cache.set(symbol, symbolCandles);
    }

    const list1m = symbolCandles['1m'];
    const last = list1m.length > 0 ? list1m[list1m.length - 1] : null;

    if (!last || norm.time > last.time) {
      list1m.push(norm);
      if (list1m.length > MAX_1M_CANDLES) list1m.shift();
    } else if (norm.time === last.time) {
      // Overwrite/update current candle
      list1m[list1m.length - 1] = norm;
    }

    // Persist every 5 minutes or on demand
    const minute = new Date(norm.time).getUTCMinutes();
    if (minute % 5 === 0) {
      await this.persistSymbol(symbol);
    }
  }

  /**
   * Appends a completed higher-TF candle (e.g. from 1h or 15m close)
   */
  async appendHigherCandle(symbol, timeframe, candle) {
    if (!symbol || !STORED_TIMEFRAMES.includes(timeframe) || !candle) return;
    const norm = Indicator.normalizeCandle(candle);
    if (!norm) return;

    let symbolCandles = this.cache.get(symbol);
    if (!symbolCandles) return;

    const list = symbolCandles[timeframe] || [];
    const last = list.length > 0 ? list[list.length - 1] : null;

    if (!last || norm.time > last.time) {
      list.push(norm);
      if (list.length > MAX_HIGHER_CANDLES) list.shift();
      symbolCandles[timeframe] = list;
      await this.persistSymbol(symbol);
    } else if (norm.time === last.time) {
      list[list.length - 1] = norm;
    }
  }

  /**
   * Returns all candles for a symbol across all 11 timeframes.
   * Dynamically synthesizes 3m, 5m, 15m, 30m in-memory from rolling 1m candles.
   *
   * @param {string} symbol
   * @param {number} [referenceTime]
   * @returns {Object<string, Array>|null}
   */
  getAllCandles(symbol, referenceTime = null) {
    const symbolCandles = this.cache.get(symbol);
    if (!symbolCandles) return null;

    const c1m = symbolCandles['1m'] || [];
    if (c1m.length < 25) return null;

    return {
      '1m': c1m,
      '3m': Indicator.aggregate1mCandles(c1m, 3, { completedOnly: true, referenceTime }),
      '5m': Indicator.aggregate1mCandles(c1m, 5, { completedOnly: true, referenceTime }),
      '15m': Indicator.aggregate1mCandles(c1m, 15, { completedOnly: true, referenceTime }),
      '30m': Indicator.aggregate1mCandles(c1m, 30, { completedOnly: true, referenceTime }),
      '1h': symbolCandles['1h'] || [],
      '4h': symbolCandles['4h'] || [],
      '6h': symbolCandles['6h'] || [],
      '12h': symbolCandles['12h'] || [],
      '1d': symbolCandles['1d'] || []
    };
  }

  /**
   * Checks whether a symbol has sufficient candles for indicator evaluation
   */
  hasSufficientData(symbol) {
    const candles = this.cache.get(symbol);
    if (!candles) return false;
    if (!candles['1m'] || candles['1m'].length < 25) return false;
    for (const tf of ['1h', '4h', '6h', '12h', '1d']) {
      if (!candles[tf] || candles[tf].length < 20) return false;
    }
    return true;
  }

  /**
   * Prunes cached and persisted coins that are no longer in the Safe Zone
   */
  async pruneInactiveSymbols(activeSafeZoneSymbols) {
    if (!Array.isArray(activeSafeZoneSymbols)) return;
    const activeSet = new Set(activeSafeZoneSymbols);

    for (const cachedSymbol of Array.from(this.cache.keys())) {
      if (!activeSet.has(cachedSymbol)) {
        this.cache.delete(cachedSymbol);
        if (this.db?.driver === 'mongo' && this.db.mongoDb) {
          try {
            await this.db.mongoDb.collection(this.collectionName).deleteOne({ symbol: cachedSymbol });
          } catch (e) {
            console.error(`[MultiTfStore] Failed to prune ${cachedSymbol} from Mongo:`, e.message);
          }
        }
      }
    }

    if (this.db?.driver !== 'mongo') {
      try {
        const obj = {};
        for (const [s, c] of this.cache.entries()) obj[s] = c;
        fs.writeFileSync(this.localFile, JSON.stringify(obj, null, 2), 'utf8');
      } catch (_) {}
    }
  }
}

module.exports = MultiTfStore;
