/**
 * bybitWebSocket.js
 * 
 * Bybit V5 Public Linear WebSocket Client.
 * Streams real-time 15M Candlestick updates for active Safe Zone symbols.
 * Handles heartbeats (ping-pong), auto-reconnect, dynamic subscriptions,
 * and detects finished/closed candles (confirm: true).
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

class BybitWebSocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || 'wss://stream.bybit.com/v5/public/linear';
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;

    // Subscriptions
    this.subscribedSymbols = new Set();
    this.pendingSubscriptions = new Set();

    // Heartbeat
    this.pingInterval = null;
    this.pongTimeout = null;
    this.lastPong = Date.now();

    // Reconnection
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
  }

  /**
   * Connect to Bybit Public WebSocket
   */
  connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    console.log(`[WebSocket] 🔌 Connecting to Bybit WebSocket at ${this.wsUrl}...`);

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      console.error('[WebSocket] Failed to instantiate WebSocket:', e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      console.log(`[WebSocket] ✅ Connected to Bybit Live Stream!`);

      this._startHeartbeat();

      // Resubscribe all active symbols
      if (this.subscribedSymbols.size > 0) {
        const symbols = Array.from(this.subscribedSymbols);
        this.subscribedSymbols.clear();
        this.subscribe(symbols);
      }

      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      this._handleMessage(data);
    });

    this.ws.on('error', (err) => {
      console.error('[WebSocket] ❌ Error:', err.message);
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      this.isConnected = false;
      this.isConnecting = false;
      this._stopHeartbeat();
      console.warn(`[WebSocket] ⚠️ Disconnected (code: ${code}, reason: ${reason || 'none'}).`);
      this.emit('disconnected');
      this._scheduleReconnect();
    });
  }

  /**
   * Start 20-second Ping-Pong loop with Zombie Watchdog
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastPong = Date.now();

    this.pingInterval = setInterval(() => {
      // Zombie Watchdog: If no message/pong received for >45s, connection is dead
      const silenceMs = Date.now() - this.lastPong;
      if (silenceMs > 45000) {
        console.warn(`[WebSocket] ⚠️ Zombie connection detected (no response for ${(silenceMs / 1000).toFixed(0)}s). Forcing termination...`);
        if (this.ws) {
          try {
            this.ws.terminate(); // Force destroy dead TCP socket
          } catch (e) {}
        }
        return;
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ op: 'ping' }));
        } catch (e) {
          console.error('[WebSocket] Ping send error:', e.message);
        }
      }
    }, 20000);
  }

  _stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(30000, 2000 * Math.pow(1.5, this.reconnectAttempts));
    this.reconnectAttempts++;
    console.log(`[WebSocket] 🔄 Scheduling reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Parse incoming WebSocket messages
   */
  _handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
      this.lastPong = Date.now(); // Any inbound message proves connection is alive
    } catch (e) {
      return;
    }

    // Handle pong
    if (msg.op === 'pong' || msg.ret_msg === 'pong') {
      return;
    }

    // Handle subscription confirmation
    if (msg.op === 'subscribe') {
      if (msg.success) {
        // Subscribed successfully
      } else {
        console.warn('[WebSocket] Subscription response:', msg.ret_msg);
      }
      return;
    }

    // Handle kline event: "topic": "kline.15.BTCUSDT"
    if (msg.topic && msg.topic.startsWith('kline.15.')) {
      const symbol = msg.topic.replace('kline.15.', '');
      if (Array.isArray(msg.data) && msg.data.length > 0) {
        const kline = msg.data[0];

        // We only care about FINISHED / CONFIRMED candles!
        if (kline.confirm === true) {
          const finishedCandle = {
            time: Number(kline.start),
            open: parseFloat(kline.open),
            high: parseFloat(kline.high),
            low: parseFloat(kline.low),
            close: parseFloat(kline.close),
            volume: parseFloat(kline.volume || 0),
            turnover: parseFloat(kline.turnover || 0),
            confirm: true
          };

          console.log(`[WebSocket] 🔔 Finished 15M candle received for ${symbol}: O=${finishedCandle.open} H=${finishedCandle.high} L=${finishedCandle.low} C=${finishedCandle.close}`);
          this.emit('finishedCandle', { symbol, candle: finishedCandle });
        }
      }
    }
  }

  /**
   * Subscribe to 15M klines for symbols
   */
  subscribe(symbols) {
    if (!symbols || symbols.length === 0) return;
    const toSub = symbols.filter(s => !this.subscribedSymbols.has(s));
    if (toSub.length === 0) return;

    toSub.forEach(s => this.subscribedSymbols.add(s));

    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Bybit allows up to 10 topics per subscribe command
    const topics = toSub.map(s => `kline.15.${s}`);
    const chunkSize = 10;
    for (let i = 0; i < topics.length; i += chunkSize) {
      const chunk = topics.slice(i, i + chunkSize);
      try {
        this.ws.send(JSON.stringify({
          op: 'subscribe',
          args: chunk
        }));
      } catch (e) {
        console.error('[WebSocket] Subscribe error:', e.message);
      }
    }

    console.log(`[WebSocket] 📡 Subscribed to 15M klines for ${toSub.length} symbols. Total active: ${this.subscribedSymbols.size}.`);
  }

  /**
   * Unsubscribe from symbols (e.g. when coin breaches baseline floor)
   */
  unsubscribe(symbols) {
    if (!symbols || symbols.length === 0) return;
    const toUnsub = symbols.filter(s => this.subscribedSymbols.has(s));
    if (toUnsub.length === 0) return;

    toUnsub.forEach(s => this.subscribedSymbols.delete(s));

    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const topics = toUnsub.map(s => `kline.15.${s}`);
    const chunkSize = 10;
    for (let i = 0; i < topics.length; i += chunkSize) {
      const chunk = topics.slice(i, i + chunkSize);
      try {
        this.ws.send(JSON.stringify({
          op: 'unsubscribe',
          args: chunk
        }));
      } catch (e) {
        console.error('[WebSocket] Unsubscribe error:', e.message);
      }
    }

    console.log(`[WebSocket] 🔕 Unsubscribed from ${toUnsub.length} retired symbols. Remaining: ${this.subscribedSymbols.size}.`);
  }

  /**
   * Synchronize active subscriptions to match target symbol list exactly
   */
  syncSubscriptions(targetSymbols) {
    const targetSet = new Set(targetSymbols);
    const toAdd = [];
    const toRemove = [];

    for (const sym of targetSymbols) {
      if (!this.subscribedSymbols.has(sym)) {
        toAdd.push(sym);
      }
    }

    for (const sym of this.subscribedSymbols) {
      if (!targetSet.has(sym)) {
        toRemove.push(sym);
      }
    }

    if (toRemove.length > 0) this.unsubscribe(toRemove);
    if (toAdd.length > 0) this.subscribe(toAdd);
  }

  /**
   * Get WebSocket Status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      activeSubscriptions: this.subscribedSymbols.size,
      lastPong: new Date(this.lastPong).toISOString()
    };
  }

  close() {
    this._stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
  }
}

module.exports = BybitWebSocket;
