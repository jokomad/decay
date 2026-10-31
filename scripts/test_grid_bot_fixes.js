'use strict';

/**
 * Regression tests for the QUSDT-class grid-bot failures.
 * No Bybit calls are made; all exchange/DB interactions are stubbed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DbManager = require('../lib/dbManager');
const GridBotManager = require('../lib/gridBotManager');

const NOW = () => Date.now();
const ISO = () => new Date().toISOString();

function manager(db, signedRequest) {
  const m = new GridBotManager({
    db,
    timeSync: { now: NOW, getIsoTime: ISO }
  });
  m._signedRequest = signedRequest;
  return m;
}

async function testSaveFailureThrowsAndRemainsVisibleToWatcher() {
  const db = new DbManager({});
  db.driver = 'mongo';
  db.activeBotsCache = new Map();
  db._saveLocalStorage = () => {};
  db.mongoDb = {
    collection: () => ({
      updateOne: async () => { throw new Error('simulated Mongo write failure'); }
    })
  };

  await assert.rejects(
    db.saveActiveBot({ botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING' }),
    /simulated Mongo write failure/
  );
  assert.strictEqual(db.activeBotsCache.size, 1, 'cache should retain the bot');

  // Simulate a successful Mongo read that does not contain the failed write.
  db.mongoDb = {
    collection: () => ({
      find: () => ({ toArray: async () => [] }),
      findOne: async () => null
    })
  };
  const active = await db.getActiveBots();
  assert.strictEqual(active.length, 1, 'watcher must still see the cached bot');
  assert.strictEqual(active[0].botId, 'B1');
  const bySymbol = await db.getActiveBotBySymbol('TESTUSDT');
  assert.strictEqual(bySymbol.botId, 'B1');
}

async function testRejectedCloseKeepsBotTracked() {
  const removed = [];
  const db = {
    removeActiveBot: async (id, data) => removed.push({ id, data }),
    removeBotJournal: async () => true
  };
  const m = manager(db, async () => ({ retCode: 10001, retMsg: 'close rejected by exchange' }));
  const result = await m.closeGridBot('B1', 'TESTUSDT', 1.0, 'TAKE_PROFIT');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.retCode, 10001);
  assert.strictEqual(removed.length, 0, 'rejected close must not remove active bot');
}

async function testConfirmedCloseRemovesBot() {
  const removed = [];
  const db = {
    removeActiveBot: async (id, data) => removed.push({ id, data }),
    removeBotJournal: async () => true
  };
  const m = manager(db, async () => ({ retCode: 0, result: {} }));
  const result = await m.closeGridBot('B1', 'TESTUSDT', 1.0, 'TAKE_PROFIT');
  assert.strictEqual(result.success, true);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].id, 'B1');
}

async function testCanceledStatusIsTerminal() {
  const removed = [];
  const db = {
    getBotJournal: async () => [],
    getActiveBots: async () => [{ botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING', pnl: 0 }],
    removeActiveBot: async (id, data) => removed.push({ id, data }),
    saveActiveBot: async () => {},
    removeBotJournal: async () => true
  };
  const m = manager(db, async () => ({
    retCode: 0,
    result: { detail: { status: 'FUTURE_GRID_STATUS_CANCELED', realised_pnl: '0.5', unrealised_pnl: '0' } }
  }));
  const summary = await m.checkRunningBots();
  assert.strictEqual(summary.closed, 1);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].data.status, 'FUTURE_GRID_STATUS_CANCELED');
}

async function testCreateSaveFailureClosesOrphan() {
  let closeCalled = false;
  const db = {
    getActiveBotBySymbol: async () => null,
    addBotJournal: async () => true,
    saveActiveBot: async () => { throw new Error('simulated DB save failure'); },
    removeBotJournal: async () => true,
    removeActiveBot: async () => {},
    getActiveBots: async () => []
  };
  const m = manager(db, async () => ({ retCode: 0, result: { bot_id: 'B9' } }));
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';
  m.getInstrumentInfo = async () => ({ priceFilter: { tickSize: '0.01' } });
  m._closeOrphanBot = async () => { closeCalled = true; return { success: true }; };

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false, 'save failure must not report success');
  assert.strictEqual(result.botId, 'B9');
  assert.strictEqual(closeCalled, true, 'created bot must be closed or journaled');
}

async function testCreateSaveFailureRealOrphanClose() {
  const calls = [];
  const removed = [];
  const journal = [];
  const db = {
    getActiveBotBySymbol: async () => null,
    addBotJournal: async (e) => { const i = journal.findIndex(x => String(x.botId) === String(e.botId)); if (i >= 0) journal[i] = { ...journal[i], ...e }; else journal.push({ ...e }); return true; },
    saveActiveBot: async () => { throw new Error('simulated DB save failure'); },
    removeBotJournal: async (id) => { const i = journal.findIndex(e => String(e.botId) === String(id)); if (i >= 0) journal.splice(i, 1); return true; },
    removeActiveBot: async (id, data) => { removed.push({ id, data }); },
    getActiveBots: async () => []
  };
  const m = manager(db, async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/v5/fgridbot/create') return { retCode: 0, result: { bot_id: 'B10' } };
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 0, result: { detail: { status: 'FUTURE_GRID_STATUS_RUNNING', pnl: '0.1' } } };
    if (endpoint === '/v5/fgridbot/close') return { retCode: 0, result: {} };
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';
  m.getInstrumentInfo = async () => ({ priceFilter: { tickSize: '0.01' } });

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(calls, ['/v5/fgridbot/create', '/v5/fgridbot/detail', '/v5/fgridbot/close']);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].id, 'B10');
  assert.strictEqual(journal.length, 0, 'journal must be cleared after confirmed orphan close');
}

async function testOrphanCloseRejectedKeepsJournal() {
  const journal = [];
  const db = {
    getActiveBotBySymbol: async () => null,
    addBotJournal: async (e) => { const i = journal.findIndex(x => String(x.botId) === String(e.botId)); if (i >= 0) journal[i] = { ...journal[i], ...e }; else journal.push({ ...e }); return true; },
    saveActiveBot: async () => { throw new Error('simulated DB save failure'); },
    removeBotJournal: async (id) => { const i = journal.findIndex(e => String(e.botId) === String(id)); if (i >= 0) journal.splice(i, 1); return true; },
    removeActiveBot: async () => {},
    getActiveBots: async () => []
  };
  const m = manager(db, async (endpoint) => {
    if (endpoint === '/v5/fgridbot/create') return { retCode: 0, result: { bot_id: 'B11' } };
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 0, result: { detail: { status: 'FUTURE_GRID_STATUS_RUNNING', pnl: '0.1' } } };
    if (endpoint === '/v5/fgridbot/close') return { retCode: 10001, retMsg: 'close rejected' };
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';
  m.getInstrumentInfo = async () => ({ priceFilter: { tickSize: '0.01' } });

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.strictEqual(journal.length, 1, 'rejected orphan close must keep the journal');
  assert.strictEqual(journal[0].botId, 'B11');
}

async function testOrphanDetailNullStillCloses() {
  const calls = [];
  const removed = [];
  const journal = [];
  const db = {
    getActiveBotBySymbol: async () => null,
    addBotJournal: async (e) => { const i = journal.findIndex(x => String(x.botId) === String(e.botId)); if (i >= 0) journal[i] = { ...journal[i], ...e }; else journal.push({ ...e }); return true; },
    saveActiveBot: async () => { throw new Error('simulated DB save failure'); },
    removeBotJournal: async (id) => { const i = journal.findIndex(e => String(e.botId) === String(id)); if (i >= 0) journal.splice(i, 1); return true; },
    removeActiveBot: async (id, data) => { removed.push({ id, data }); },
    getActiveBots: async () => []
  };
  const m = manager(db, async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/v5/fgridbot/create') return { retCode: 0, result: { bot_id: 'B12' } };
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 0, result: {} };
    if (endpoint === '/v5/fgridbot/close') return { retCode: 0, result: {} };
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';
  m.getInstrumentInfo = async () => ({ priceFilter: { tickSize: '0.01' } });

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(calls, ['/v5/fgridbot/create', '/v5/fgridbot/detail', '/v5/fgridbot/close']);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(journal.length, 0, 'null detail must still close and clear the journal');
}

async function testOrphanDetailErrorStillCloses() {
  const calls = [];
  const removed = [];
  const journal = [];
  const db = {
    getActiveBotBySymbol: async () => null,
    addBotJournal: async (e) => { const i = journal.findIndex(x => String(x.botId) === String(e.botId)); if (i >= 0) journal[i] = { ...journal[i], ...e }; else journal.push({ ...e }); return true; },
    saveActiveBot: async () => { throw new Error('simulated DB save failure'); },
    removeBotJournal: async (id) => { const i = journal.findIndex(e => String(e.botId) === String(id)); if (i >= 0) journal.splice(i, 1); return true; },
    removeActiveBot: async (id, data) => { removed.push({ id, data }); },
    getActiveBots: async () => []
  };
  const m = manager(db, async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/v5/fgridbot/create') return { retCode: 0, result: { bot_id: 'B13' } };
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 10001, retMsg: 'detail temporarily unavailable' };
    if (endpoint === '/v5/fgridbot/close') return { retCode: 0, result: {} };
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';
  m.getInstrumentInfo = async () => ({ priceFilter: { tickSize: '0.01' } });

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(calls, ['/v5/fgridbot/create', '/v5/fgridbot/detail', '/v5/fgridbot/close']);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(journal.length, 0, 'detail error must still close and clear the journal');
}

async function testExistingRunningBotSkipsLaunch() {
  const calls = [];
  let created = false;
  const db = {
    getActiveBotBySymbol: async () => ({ botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING' }),
    removeActiveBot: async () => {},
    removeBotJournal: async () => true,
    saveActiveBot: async () => {}
  };
  const m = manager(db, async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 0, result: { detail: { status: 'FUTURE_GRID_STATUS_RUNNING' } } };
    if (endpoint === '/v5/fgridbot/create') { created = true; return { retCode: 0, result: { bot_id: 'B2' } }; }
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(created, false, 'running bot must block duplicate launch');
  assert.deepStrictEqual(calls, ['/v5/fgridbot/detail']);
}

async function testExistingTerminalBotAllowsNewLaunch() {
  const removed = [];
  let created = false;
  const db = {
    getActiveBotBySymbol: async () => ({ botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING' }),
    removeActiveBot: async (id, data) => removed.push({ id, data }),
    removeBotJournal: async () => true,
    addBotJournal: async () => true,
    saveActiveBot: async () => {}
  };
  const m = manager(db, async (endpoint) => {
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 0, result: { detail: { status: 'FUTURE_GRID_STATUS_COMPLETED', realised_pnl: '1.0', unrealised_pnl: '0' } } };
    if (endpoint === '/v5/fgridbot/create') { created = true; return { retCode: 0, result: { bot_id: 'B2' } }; }
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';
  m.getInstrumentInfo = async () => ({ priceFilter: { tickSize: '0.01' } });

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.botId, 'B2');
  assert.strictEqual(created, true, 'terminal bot must not block a new launch');
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].id, 'B1');
}

async function testExistingUnknownBotSkipsLaunch() {
  let created = false;
  const db = {
    getActiveBotBySymbol: async () => ({ botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING' }),
    removeActiveBot: async () => {},
    removeBotJournal: async () => true,
    saveActiveBot: async () => {}
  };
  const m = manager(db, async (endpoint) => {
    if (endpoint === '/v5/fgridbot/detail') return { retCode: 10001, retMsg: 'detail unavailable' };
    if (endpoint === '/v5/fgridbot/create') { created = true; return { retCode: 0, result: { bot_id: 'B2' } }; }
    return { retCode: 0, result: {} };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(created, false, 'unknown state must not open a duplicate');
}

async function testWatcherDoesNotCloseAtPnlTarget() {
  const removed = [];
  const saved = [];
  const db = {
    getBotJournal: async () => [],
    getActiveBots: async () => [{ botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING', pnl: 0 }],
    removeActiveBot: async (id, data) => removed.push({ id, data }),
    removeBotJournal: async () => true,
    saveActiveBot: async (bot) => saved.push({ ...bot })
  };
  const m = manager(db, async () => ({
    retCode: 0,
    result: { detail: { status: 'FUTURE_GRID_STATUS_RUNNING', realised_pnl: '5', unrealised_pnl: '0' } }
  }));

  const summary = await m.checkRunningBots();
  assert.strictEqual(summary.closed, 0, 'watcher must not close on PnL');
  assert.strictEqual(removed.length, 0, 'watcher must leave the bot active');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].pnl, 5);
}

async function testPersistentStoreDownBlocksLaunch() {
  const calls = [];
  const db = {
    persistenceHealthy: false,
    getActiveBotBySymbol: async () => null
  };
  const m = manager(db, async (endpoint) => {
    calls.push(endpoint);
    return { retCode: 0, result: { bot_id: 'B2' } };
  });
  m.apiKey = 'test-key';
  m.apiSecret = 'test-secret';

  const result = await m.startShortGridBot({ symbol: 'TESTUSDT', currentPrice: 1 });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.skipped, true);
  assert.ok(/Persistent Mongo/.test(result.reason));
  assert.strictEqual(calls.length, 0, 'must not call Bybit when persistent storage is down');
}

async function testNullDetailKeepsActive() {
  const removed = [];
  const bot = { botId: 'B1', symbol: 'TESTUSDT', status: 'RUNNING', missingChecks: 0 };
  const db = {
    getBotJournal: async () => [],
    getActiveBots: async () => [bot],
    removeActiveBot: async (id, data) => removed.push({ id, data }),
    removeBotJournal: async () => true,
    saveActiveBot: async () => {}
  };
  const m = manager(db, async () => ({ retCode: 0, result: {} }));

  await m.checkRunningBots();
  await m.checkRunningBots();
  const summary = await m.checkRunningBots();

  assert.strictEqual(removed.length, 0, 'null detail must not remove an active bot');
  assert.strictEqual(bot.missingChecks, 3);
  assert.strictEqual(summary.stale, 1);
}

async function testMongoJournalRoundTrip() {
  const db = new DbManager({});
  db.driver = 'mongo';
  db.botJournalCache = [];
  const docs = new Map();
  db.mongoDb = {
    collection: () => ({
      updateOne: async (filter, update) => { docs.set(filter.botId, { ...update.$set }); },
      deleteOne: async (filter) => { docs.delete(filter.botId); },
      find: () => ({ toArray: async () => Array.from(docs.values()) })
    })
  };

  assert.strictEqual(await db.addBotJournal({ botId: 'JM1', symbol: 'TESTUSDT', attempts: 0 }), true);
  assert.strictEqual(docs.has('JM1'), true, 'journal must be written to Mongo');
  const list = await db.getBotJournal();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].botId, 'JM1');
  assert.strictEqual(await db.removeBotJournal('JM1'), true);
  assert.strictEqual(docs.has('JM1'), false, 'journal must be deleted from Mongo');
  assert.strictEqual((await db.getBotJournal()).length, 0);
}

async function testJournalRoundTrip() {
  const db = new DbManager({});
  const tmp = path.join(os.tmpdir(), `bybit_bot_journal_${Date.now()}.json`);
  db.botJournalFile = tmp;
  db.botJournalCache = [];
  try {
    assert.strictEqual(await db.addBotJournal({ botId: 'J1', symbol: 'TESTUSDT', attempts: 0 }), true);
    assert.strictEqual((await db.getBotJournal()).length, 1);
    assert.strictEqual(fs.existsSync(tmp), true);
    assert.strictEqual(await db.removeBotJournal('J1'), true);
    assert.strictEqual((await db.getBotJournal()).length, 0);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { fs.unlinkSync(`${tmp}.tmp`); } catch (_) {}
  }
}

(async () => {
  await testSaveFailureThrowsAndRemainsVisibleToWatcher();
  await testRejectedCloseKeepsBotTracked();
  await testConfirmedCloseRemovesBot();
  await testCanceledStatusIsTerminal();
  await testCreateSaveFailureClosesOrphan();
  await testCreateSaveFailureRealOrphanClose();
  await testOrphanCloseRejectedKeepsJournal();
  await testOrphanDetailNullStillCloses();
  await testOrphanDetailErrorStillCloses();
  await testExistingRunningBotSkipsLaunch();
  await testExistingTerminalBotAllowsNewLaunch();
  await testExistingUnknownBotSkipsLaunch();
  await testWatcherDoesNotCloseAtPnlTarget();
  await testPersistentStoreDownBlocksLaunch();
  await testNullDetailKeepsActive();
  await testMongoJournalRoundTrip();
  await testJournalRoundTrip();
  console.log('PASS: grid bot persistence / close / status / orphan tests');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
