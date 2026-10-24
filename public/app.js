/**
 * public/app.js
 * 
 * Bybit Decay Screener Frontend Client
 * - Phase 1: 1D Daily Candles & Climax Decay Detection
 * - Phase 2: 15M Candles & Keltner Bands (20 EMA, 2.0 ATR) for Safe Zone Pairs
 * - Default Sort: Closest to 15M Upper Keltner Band
 * - Interactive Popup Modal with 15M Keltner Chart & Suggested Grid Bot Blueprint
 */

let currentPairs = [];
let sortMode = 'keltner'; // Default: closest to Upper Keltner Band
let safeZoneOnly = true;  // Default: Safe Zone coins only
let currentModalItem = null;
let modalActiveTimeframe = '15m'; // Default modal view: 15m
let pollTimer = null;
let serverOffsetMs = 0;
let isRefreshing = false;

// Real-Time Precision Clock (ticking every 1000ms synchronized with Bybit)
setInterval(() => {
  const bybitNow = Date.now() + serverOffsetMs;
  const d = new Date(bybitNow);
  const timeStr = d.toISOString().substring(11, 19) + ' UTC';
  const elTime = document.getElementById('lw-bybit-time');
  if (elTime) elTime.textContent = timeStr;

  // Calculate next signal evaluation trigger (:01:03, :16:03, :31:03, :46:03)
  const checkMinutes = [1, 16, 31, 46];
  let target = null;
  for (let offsetHour = 0; offsetHour <= 2; offsetHour++) {
    for (const m of checkMinutes) {
      const candidate = new Date(d);
      candidate.setUTCHours(d.getUTCHours() + offsetHour, m, 3, 0);
      if (candidate.getTime() > bybitNow) {
        target = candidate.getTime();
        break;
      }
    }
    if (target) break;
  }
  if (!target) target = bybitNow + 15 * 60 * 1000;

  const diffSec = Math.max(0, Math.round((target - bybitNow) / 1000));
  const elNext = document.getElementById('lw-next-cycle');
  if (elNext) {
    const targetFormatted = new Date(target).toISOString().substring(11, 19) + ' UTC';
    elNext.textContent = `${targetFormatted} (${diffSec}s)`;
  }
}, 1000);

function formatPrice(p) {
  if (p === undefined || p === null || isNaN(p)) return '--';
  const num = Number(p);
  if (num === 0) return '0.00';
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return num.toFixed(4);
  if (abs >= 0.0001) return num.toFixed(6);
  return num.toFixed(8);
}

// ── Polling & Data Fetching ───────────────────────────────────────────────
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const state = await res.json();

    if (state.timeSync) {
      serverOffsetMs = state.timeSync.serverOffsetMs || 0;
    }

    // Update WebSocket Ribbon Badge
    const elWs = document.getElementById('lw-ws-status');
    if (elWs && state.webSocket) {
      if (state.webSocket.connected) {
        elWs.textContent = `${state.webSocket.activeSubscriptions} ACTIVE PAIRS`;
        elWs.className = 'live-val green';
      } else {
        elWs.textContent = 'RECONNECTING...';
        elWs.className = 'live-val amber';
      }
    }

    // Update DB Ribbon Badge
    const elDb = document.getElementById('lw-db-status');
    if (elDb && state.db) {
      if (state.db.driver === 'mongo') {
        elDb.textContent = `MONGODB (${state.db.totalSymbols} COINS)`;
        elDb.className = 'live-val green';
      } else {
        elDb.textContent = `LOCAL STORE (${state.db.totalSymbols} COINS)`;
        elDb.className = 'live-val primary';
      }
    }

    // Update Daily Restart Badge
    const elRestart = document.getElementById('lw-restart-status');
    if (elRestart && state.maintenance) {
      if (state.maintenance.isCompletedToday) {
        elRestart.textContent = 'DONE TODAY';
        elRestart.className = 'live-val green';
        elRestart.title = `Completed at ${state.maintenance.lastDailyRestartTime}. Next restart tomorrow at 04:05 UTC.`;
      } else {
        elRestart.textContent = `${String(state.maintenance.scheduledHourUtc).padStart(2, '0')}:${String(state.maintenance.scheduledMinuteUtc).padStart(2, '0')} UTC`;
        elRestart.className = 'live-val amber';
        elRestart.title = `Scheduled today between :01 and :14 at ${state.maintenance.scheduledHourUtc}:05 UTC.`;
      }
    }

    const scannerState = state.scanner || state;
    renderStats(scannerState.stats);

    const progressBox = document.getElementById('scan-progress-box');
    const progressFill = document.getElementById('progress-bar-fill');
    const progressText = document.getElementById('progress-status-text');
    const progressPct = document.getElementById('progress-pct-text');
    const rescanBtn = document.getElementById('btn-rescan');

    if (scannerState.status === 'scanning') {
      progressBox.style.display = 'block';
      const pct = scannerState.progress?.pct || 0;
      progressFill.style.width = `${pct}%`;
      const phaseName = scannerState.progress?.phaseName || 'Scanning market...';
      progressText.textContent = `[${scannerState.progress?.scanned}/${scannerState.progress?.total}] ${phaseName}`;
      progressPct.textContent = `${pct}%`;
      rescanBtn.disabled = true;
      rescanBtn.innerHTML = '<span>⏳</span> Scanning...';
    } else {
      progressBox.style.display = 'none';
      rescanBtn.disabled = false;
      rescanBtn.innerHTML = '<span>🔄</span> Force 15M Cycle';
    }

    return state;
  } catch (err) {
    console.error('Status fetch error:', err);
    return null;
  }
}

async function fetchSignals() {
  try {
    const res = await fetch('/api/signals?limit=50');
    const data = await res.json();
    const signals = data.signals || [];

    const badge = document.getElementById('signals-badge-count');
    if (badge) badge.textContent = signals.length;

    const container = document.getElementById('signals-list-container');
    if (!container) return;

    if (signals.length === 0) {
      container.innerHTML = '<div class="signal-empty">No active signals triggered yet. When a 15M finished candle breaches the Upper KC with Spread &ge;1.25%, the entry signal will display here.</div>';
      return;
    }

    container.innerHTML = signals.map(s => `
      <div class="signal-card ${s.signalType === 'FIRST_TOUCH' ? 'first-touch' : ''}">
        <div class="signal-header-row monospace">
          <div>
            <b style="font-size: 15px; color: #fff;">${s.symbol}</b>
            <span class="badge-tag ${s.signalType === 'FIRST_TOUCH' ? 'kc-touch' : 'kc-near'}" style="margin-left: 8px;">
              ${s.signalType === 'FIRST_TOUCH' ? '🔥 FRESH FIRST TOUCH' : '⚡ EXTENDED TOUCH'}
            </span>
            ${s.isHighVelocitySpread ? '<span class="badge-tag safe-zone">⚡ FAST TP</span>' : ''}
          </div>
          <div style="font-size: 11px; color: var(--text-muted);">
            🕒 ${new Date(s.timestamp).toISOString().substring(11, 19)} UTC
          </div>
        </div>

        <div class="signal-stats-grid monospace">
          <div>
            <span style="color: var(--text-dim);">Trigger Price:</span>
            <b>$${formatPrice(s.currentPrice)}</b>
          </div>
          <div>
            <span style="color: var(--text-dim);">Upper KC:</span>
            <b style="color: var(--red);">$${formatPrice(s.kcUpper)}</b>
          </div>
          <div>
            <span style="color: var(--text-dim);">KC Spread:</span>
            <b style="color: var(--green);">${s.kcSpreadPct ? s.kcSpreadPct.toFixed(2) + '%' : '--'}</b>
          </div>
          <div>
            <span style="color: var(--text-dim);">Room to Base:</span>
            <b style="color: var(--primary);">-${s.downsidePct ? s.downsidePct.toFixed(1) + '%' : '--'}</b>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 11px;" class="monospace">
          <span style="color: var(--text-muted);">
            Suggested Grid: 2.0x • 40 Grids • Range [-$${formatPrice(s.suggestedGrid?.lowerLimit)}, +$${formatPrice(s.suggestedGrid?.upperLimit)}] • TP: +$1.00
          </span>
          <a href="https://www.bybit.com/trade/usdt/${s.symbol}" target="_blank" class="btn-copy" style="text-decoration: none;">
            Open on Bybit ↗
          </a>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Signals fetch error:', err);
  }
}

async function fetchBots() {
  try {
    const res = await fetch('/api/bots');
    const data = await res.json();
    const bots = data.bots || [];
    const history = data.history || [];

    const badge = document.getElementById('bots-badge-count');
    if (badge) badge.textContent = bots.length;

    const modalBadge = document.getElementById('bots-modal-status-badge');
    if (modalBadge) {
      if (data.configured) {
        modalBadge.textContent = `API CONNECTED • ${bots.length} RUNNING`;
        modalBadge.className = 'badge-tag safe-zone';
      } else {
        modalBadge.textContent = 'READ-ONLY (ADD API KEY IN .ENV)';
        modalBadge.className = 'badge-tag kc-touch';
      }
    }

    const container = document.getElementById('bots-list-container');
    if (!container) return;

    if (bots.length === 0 && history.length === 0) {
      container.innerHTML = `
        <div class="signal-empty">
          <div style="font-size: 28px; margin-bottom: 8px;">🤖</div>
          <b>No Active Bybit Short Grid Bots</b>
          <p style="margin-top: 6px; font-size: 12px; color: var(--text-dim);">
            When a verified 15M entry signal triggers and API keys are configured, a Short Grid Bot (2x Cross, 40 Grids, 1% TP) will launch automatically and display here.
          </p>
        </div>
      `;
      return;
    }

    let html = '';

    if (bots.length > 0) {
      html += `<div style="font-size: 11px; font-weight: 700; color: var(--primary); text-transform: uppercase; margin-bottom: 8px;" class="monospace">Active Running Bots (${bots.length})</div>`;
      html += bots.map(b => {
        const pnl = Number(b.pnl || 0);
        const pnlColor = pnl >= 1.00 ? 'var(--green)' : (pnl > 0 ? '#86efac' : (pnl < 0 ? 'var(--red)' : '#fff'));
        const pnlSign = pnl > 0 ? '+' : '';

        return `
          <div class="signal-card ${pnl >= 1.00 ? 'first-touch' : ''}">
            <div class="signal-header-row monospace">
              <div>
                <b style="font-size: 16px; color: #fff;">${b.symbol}</b>
                <span class="badge-tag safe-zone" style="margin-left: 8px;">SHORT 2.0x</span>
                <span class="badge-tag" style="background: rgba(56, 189, 248, 0.15); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.3);">
                  40 GRIDS
                </span>
                <span class="badge-tag" style="background: rgba(16, 185, 129, 0.15); color: #86efac; border: 1px solid rgba(16, 185, 129, 0.3);">
                  TP: +$1.00 (1%)
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 11px; color: var(--text-muted);">
                  Bot ID: <code style="color: #7dd3fc;">${b.botId}</code>
                </span>
                <button class="bot-close-btn monospace" onclick="closeBotManual('${b.botId}', '${b.symbol}')">
                  Market Close
                </button>
              </div>
            </div>

            <div class="signal-stats-grid monospace">
              <div>
                <span style="color: var(--text-dim);">Entry Price:</span>
                <b>$${formatPrice(b.entryPrice)}</b>
              </div>
              <div>
                <span style="color: var(--text-dim);">Lower Limit (-30%):</span>
                <b style="color: var(--green);">$${formatPrice(b.minPrice)}</b>
              </div>
              <div>
                <span style="color: var(--text-dim);">Upper Limit (+70%):</span>
                <b style="color: var(--red);">$${formatPrice(b.maxPrice)}</b>
              </div>
              <div>
                <span style="color: var(--text-dim);">Live PnL (Target: $1.00):</span>
                <b style="color: ${pnlColor}; font-size: 13px;">${pnlSign}$${pnl.toFixed(4)} USDT</b>
              </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;" class="monospace">
              <span style="color: var(--text-muted);">
                Started: ${b.createdAtIso ? b.createdAtIso.substring(11, 19) + ' UTC' : '--'} • Investment: 100 USDT • 60s Watcher
              </span>
              <a href="https://www.bybit.com/trade/usdt/${b.symbol}" target="_blank" class="btn-copy" style="text-decoration: none;">
                View on Bybit ↗
              </a>
            </div>
          </div>
        `;
      }).join('');
    }

    if (history.length > 0) {
      html += `<div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-top: 16px; margin-bottom: 8px;" class="monospace">Closed / Completed History (${history.length})</div>`;
      html += history.map(h => {
        const pnl = Number(h.pnl || 0);
        const pnlSign = pnl > 0 ? '+' : '';
        const pnlColor = pnl > 0 ? 'var(--green)' : (pnl < 0 ? 'var(--red)' : '#fff');
        return `
          <div class="signal-card" style="opacity: 0.8; padding: 10px 14px;">
            <div class="signal-header-row monospace" style="font-size: 12px;">
              <div>
                <b>${h.symbol}</b>
                <span class="badge-tag" style="background: rgba(255,255,255,0.05); margin-left: 6px;">${h.status || 'CLOSED'}</span>
                <span style="color: var(--text-dim); margin-left: 8px;">Reason: ${h.reason || 'Completed'}</span>
              </div>
              <div>
                <span style="color: var(--text-dim);">Final PnL:</span>
                <b style="color: ${pnlColor}; margin-left: 4px;">${pnlSign}$${pnl.toFixed(4)} USDT</b>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    container.innerHTML = html;
  } catch (err) {
    console.error('Bots fetch error:', err);
  }
}

async function closeBotManual(botId, symbol) {
  if (!confirm(`Are you sure you want to Market Close the bot for ${symbol} (ID: ${botId})?`)) {
    return;
  }
  showToast(`Closing bot ${symbol}...`);
  try {
    const res = await fetch('/api/bots/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId, symbol, reason: 'Manual User Close' })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`Bot ${symbol} closed! PnL: $${result.pnl || 0}`);
      await fetchBots();
    } else {
      alert(`Failed to close bot: ${result.error || result.reason}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

async function fetchPairs() {
  const search = document.getElementById('search-input').value.trim();
  const minGain = document.getElementById('min-gain-select').value;
  
  const params = new URLSearchParams({
    sort: sortMode,
    safeZoneOnly: safeZoneOnly ? 'true' : 'false',
    minGain,
    search
  });

  try {
    const res = await fetch(`/api/pairs?${params.toString()}`);
    const data = await res.json();
    currentPairs = data.pairs || [];
    renderCards(currentPairs);
  } catch (err) {
    console.error('Pairs fetch error:', err);
  }
}

function renderStats(stats) {
  if (!stats) return;
  document.getElementById('stat-total-inst').textContent = stats.totalInstruments || '--';
  document.getElementById('stat-stocks-excl').textContent = stats.skippedStocks || '0';
  document.getElementById('stat-delist-excl').textContent = stats.skippedDelisting || '0';
  document.getElementById('stat-valid-coins').textContent = stats.validEstablished || '--';
  document.getElementById('stat-active-decays').textContent = stats.activeDecays || '--';
  document.getElementById('stat-safe-count').textContent = stats.safeZoneCount || '0';
  document.getElementById('stat-near-base').textContent = stats.nearBaseCount || '0';
}

// ── Render Cards ──────────────────────────────────────────────────────────
function renderCards(pairs) {
  const container = document.getElementById('pairs-container');

  if (pairs.length === 0) {
    container.innerHTML = safeZoneOnly
      ? '<div class="empty-box">No pairs currently inside the <b>Zero-Liquidation Safe Zone</b> (10%-45% drop, Day 2+, vol &lt;25%, downside &ge;1.50%). Turn off "Safe Zone Only" to view all active decays.</div>'
      : '<div class="empty-box">No pairs match the current filter criteria.</div>';
    return;
  }

  container.innerHTML = pairs.map(item => {
    const isClose = item.downsidePct <= 15;
    const isRecent = item.daysSincePeak <= 3;
    const decayClamped = Math.min(100, Math.max(0, item.decayPct));

    let barColorClass = 'fill-green';
    if (decayClamped < 40) barColorClass = 'fill-red';
    else if (decayClamped < 75) barColorClass = 'fill-amber';

    const pumpDays = item.daysSincePumpStart !== undefined ? item.daysSincePumpStart : (item.daysSincePeak + 4);

    return `
      <div class="pair-card" data-symbol="${item.symbol}">
        <div class="card-header">
          <div class="symbol-badge-row">
            <span class="symbol-name monospace">${item.symbol}</span>
            <span class="badge-tag drop monospace">-${item.dropFromPeakPct.toFixed(1)}% Peak</span>
            ${item.isSafeZone 
              ? `<span class="badge-tag safe-zone">🛡️ Safe Zone</span>` 
              : (item.downsidePct < 1.50 
                  ? `<span class="badge-tag outside-safe monospace" title="Downside to Base is only ${item.downsidePct.toFixed(1)}% (<1.50%). Insufficient room to complete 1.25% TP before floor!">⚠️ At Base (${item.downsidePct.toFixed(1)}%)</span>`
                  : `<span class="badge-tag outside-safe">⚠️ Outside Safe</span>`)}
            ${item.isFirstTouch
              ? `<span class="badge-tag kc-touch monospace" style="background: rgba(234, 179, 8, 0.2); border-color: #eab308; color: #fde047;">🔥 15M FIRST TOUCH (${item.kcSpreadPct.toFixed(1)}% Spread${item.isHighVelocitySpread ? ' ⚡ Fast' : ''})</span>`
              : (item.isKeltnerTouch 
                  ? `<span class="badge-tag kc-touch monospace">⚡ 15M EXTENDED TOUCH (${item.kcSpreadPct.toFixed(1)}% Spread)</span>` 
                  : (item.kcUpper 
                      ? (item.isChannelWideEnough 
                          ? `<span class="badge-tag kc-near monospace">🎯 15M KC: ${item.kcDistPct > 0 ? '+' : ''}${item.kcDistPct.toFixed(1)}% (Spread: ${item.kcSpreadPct.toFixed(1)}%)</span>`
                          : `<span class="badge-tag outside-safe monospace" title="Band is too narrow (<1.25%) for mean-reversion TP">⚠️ Tight KC: ${item.kcSpreadPct.toFixed(2)}%</span>`)
                      : ''))}
            <span class="badge-tag days ${isRecent ? 'hot' : ''}">${item.daysSincePeak === 0 ? 'Peak Today' : `${item.daysSincePeak}d ago`}</span>
            <span class="badge-tag days monospace">${item.ageDays}d old</span>
          </div>
          <div class="downside-box">
            <div class="downside-title">${isClose ? 'Distance to Base' : 'Downside to Base'}</div>
            <div class="downside-number monospace ${isClose ? 'close' : 'far'}">
              ${isClose ? `+${item.downsidePct.toFixed(1)}%` : `-${item.downsidePct.toFixed(1)}%`}
            </div>
          </div>
        </div>

        <div class="card-stats-row monospace">
          <div>
            <div class="stat-micro-label">Current Price</div>
            <div class="stat-micro-val">$${formatPrice(item.currentPrice)}</div>
          </div>
          <div>
            <div class="stat-micro-label">15M Upper KC (Spread)</div>
            <div class="stat-micro-val monospace" style="color: ${item.isKeltnerTouch ? 'var(--red)' : (item.isChannelWideEnough ? 'var(--primary)' : 'var(--text-dim)')};">
              ${item.kcUpper ? `$${formatPrice(item.kcUpper)} (${item.kcSpreadPct ? item.kcSpreadPct.toFixed(1) + '%' : '--'})` : '--'}
            </div>
          </div>
          <div>
            <div class="stat-micro-label">Climax Peak</div>
            <div class="stat-micro-val" style="color: var(--amber);">$${formatPrice(item.peakPrice)} (+${item.peakGainPct.toFixed(0)}%)</div>
          </div>
          <div>
            <div class="stat-micro-label">Origin Base</div>
            <div class="stat-micro-val" style="color: var(--primary);">$${formatPrice(item.basePrice)}</div>
          </div>
        </div>

        <!-- Inline 1D Candlestick Chart (Macro Decay View) -->
        <div class="chart-container">
          <div class="chart-header-tag monospace">🏛️ 1D Macro Climax Decay Chart (Bybit Daily Candles)</div>
          <canvas id="canvas-1d-${item.symbol}" class="inline-1d-canvas" width="860" height="180"></canvas>
        </div>

        <!-- 1D Climax Anatomy -->
        <div class="card-anatomy-row monospace">
          <div>
            <div class="mini-item-label">🚀 1. Pump Ignition</div>
            <div class="mini-item-val" style="color: var(--green);">$${formatPrice(item.pumpStartPrice || item.basePrice)}</div>
          </div>
          <div>
            <div class="mini-item-label">🔥 2. Climax Peak</div>
            <div class="mini-item-val" style="color: var(--amber);">$${formatPrice(item.peakPrice)}</div>
          </div>
          <div>
            <div class="mini-item-label">🏛️ 3. Baseline Floor</div>
            <div class="mini-item-val" style="color: var(--primary);">$${formatPrice(item.basePrice)}</div>
          </div>
          <div>
            <div class="mini-item-label">⏱️ 4. Room to Base</div>
            <div class="mini-item-val" style="color: ${isClose ? 'var(--green)' : 'var(--red)'};">-${item.downsidePct.toFixed(1)}%</div>
          </div>
        </div>

        <!-- Round-Trip Decay Progress Track -->
        <div class="decay-track-box">
          <div class="decay-labels monospace">
            <span>Decay Progress (Round-Trip)</span>
            <span><b>${decayClamped.toFixed(0)}%</b> Completed</span>
          </div>
          <div class="decay-track">
            <div class="decay-fill ${barColorClass}" style="width: ${decayClamped}%;"></div>
          </div>
        </div>

        <div class="card-footer-hint monospace">
          🎯 Click card to view 15M Candlesticks, Keltner Bands &amp; Zero-Liquidation Grid Blueprint ↗
        </div>
      </div>
    `;
  }).join('');

  // Draw 1D Canvas charts on main cards
  pairs.forEach(item => {
    const canvas = document.getElementById(`canvas-1d-${item.symbol}`);
    if (canvas && item.recentCandles && item.recentCandles.length > 0) {
      draw1DCanvas(item, canvas);
    }
  });

  // Attach card click handlers to open 15M Execution Modal
  container.querySelectorAll('.pair-card').forEach(card => {
    card.addEventListener('click', () => {
      const sym = card.dataset.symbol;
      const match = pairs.find(p => p.symbol === sym);
      if (match) openModal(match);
    });
  });
}

// ── Draw 1D Canvas Chart (Main Feed) ───────────────────────────────────────
function draw1DCanvas(item, canvas) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, width, height);

  const candles = item.recentCandles;
  const count = candles.length;
  if (count === 0) return;

  const padTop = 26;
  const padBottom = 20;
  const padLeft = 10;
  const padRight = 80;

  const chartW = width - padLeft - padRight;
  const totalH = height - padTop - padBottom;
  const priceH = totalH; // Full vertical space for price candles

  let minP = Math.min(...candles.map(c => c.l), item.basePrice);
  let maxP = Math.max(...candles.map(c => c.h), item.peakPrice);

  const priceSpan = (maxP - minP) || 1;
  const priceToY = (p) => padTop + (1 - (p - minP) / priceSpan) * priceH;

  const spacing = chartW / count;
  const barW = Math.max(3, spacing * 0.65);

  // Grid Lines
  ctx.strokeStyle = '#121824';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';

  for (let step = 0; step <= 3; step++) {
    const p = minP + (step / 3) * priceSpan;
    const y = priceToY(p);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();
    ctx.fillText(`$${formatPrice(p)}`, padLeft + chartW + 6, y + 3);
  }

  // Draw Candlesticks & Volume
  candles.forEach((c, i) => {
    const x = padLeft + i * spacing + spacing / 2;
    const oY = priceToY(c.o);
    const hY = priceToY(c.h);
    const lY = priceToY(c.l);
    const cY = priceToY(c.c);

    const isBull = c.c >= c.o;
    const color = isBull ? '#10b981' : '#f43f5e';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, hY);
    ctx.lineTo(x, lY);
    ctx.stroke();

    ctx.fillStyle = color;
    const topY = Math.min(oY, cY);
    const bH = Math.max(2, Math.abs(cY - oY));
    ctx.fillRect(x - barW / 2, topY, barW, bH);
  });

  // Dashed Reference Lines: Baseline, Peak, Current Price
  drawDashedLine(ctx, padLeft, chartW, priceToY(item.basePrice), '#38bdf8', `BASE: $${formatPrice(item.basePrice)}`);
  drawDashedLine(ctx, padLeft, chartW, priceToY(item.peakPrice), '#f59e0b', `PEAK: $${formatPrice(item.peakPrice)}`);
  drawDashedLine(ctx, padLeft, chartW, priceToY(item.currentPrice), '#ffffff', `NOW: $${formatPrice(item.currentPrice)}`);
}

// ── Draw 15M Candlestick Chart with Continuous Keltner Bands (Modal) ───────
function draw15MKeltnerCanvas(item, canvas) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, width, height);

  const candles = item.candles15m && item.candles15m.length > 0 ? item.candles15m : [];
  if (candles.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px monospace';
    ctx.fillText('No 15M candles available for this symbol.', width / 2 - 140, height / 2);
    return;
  }

  const count = candles.length;
  const kEma = 2.0 / 21.0;
  const emaArr = new Float64Array(count);
  const atrArr = new Float64Array(count);
  const upArr = new Float64Array(count);
  const midArr = new Float64Array(count);
  const lowArr = new Float64Array(count);

  let ema = candles[0].close;
  let atr = candles[0].high - candles[0].low;

  for (let i = 0; i < count; i++) {
    const c = candles[i];
    ema = c.close * kEma + ema * (1 - kEma);
    const prevC = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC));
    atr = tr * kEma + atr * (1 - kEma);

    emaArr[i] = ema;
    atrArr[i] = atr;
    upArr[i] = ema + 2.0 * atr;
    midArr[i] = ema;
    lowArr[i] = ema - 2.0 * atr;
  }

  const padTop = 32;
  const padBottom = 22;
  const padLeft = 10;
  const padRight = 85;

  const chartW = width - padLeft - padRight;
  const totalH = height - padTop - padBottom;
  const priceH = totalH; // Full height for price candles & Keltner channel ribbon

  let minP = Math.min(...candles.map(c => c.low), ...lowArr);
  let maxP = Math.max(...candles.map(c => c.high), ...upArr);

  const priceSpan = (maxP - minP) || 1;
  const priceToY = (p) => padTop + (1 - (p - minP) / priceSpan) * priceH;

  const spacing = chartW / count;
  const barW = Math.max(2.5, spacing * 0.65);

  // 1. Grid Lines
  ctx.strokeStyle = '#141a26';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';

  for (let step = 0; step <= 4; step++) {
    const p = minP + (step / 4) * priceSpan;
    const y = priceToY(p);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();
    ctx.fillText(`$${formatPrice(p)}`, padLeft + chartW + 6, y + 3);
  }

  // 2. Shaded Keltner Ribbon
  ctx.fillStyle = 'rgba(56, 189, 248, 0.05)';
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = padLeft + i * spacing + spacing / 2;
    const y = priceToY(upArr[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  for (let i = count - 1; i >= 0; i--) {
    const x = padLeft + i * spacing + spacing / 2;
    const y = priceToY(lowArr[i]);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // 3. Upper Keltner Band (Red)
  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = padLeft + i * spacing + spacing / 2;
    const y = priceToY(upArr[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 4. Middle 20 EMA (Cyan)
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = padLeft + i * spacing + spacing / 2;
    const y = priceToY(midArr[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 5. Lower Keltner Band (Purple)
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = padLeft + i * spacing + spacing / 2;
    const y = priceToY(lowArr[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 6. Draw 15M Candlesticks & Volume
  candles.forEach((c, i) => {
    const x = padLeft + i * spacing + spacing / 2;
    const oY = priceToY(c.open);
    const hY = priceToY(c.high);
    const lY = priceToY(c.low);
    const cY = priceToY(c.close);

    const isBull = c.close >= c.open;
    const color = isBull ? '#10b981' : '#f43f5e';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, hY);
    ctx.lineTo(x, lY);
    ctx.stroke();

    ctx.fillStyle = color;
    const topY = Math.min(oY, cY);
    const bH = Math.max(2, Math.abs(cY - oY));
    ctx.fillRect(x - barW / 2, topY, barW, bH);

    // Highlight Upper Keltner Touches strictly when:
    // 1. High wick touches or pierces Upper KC
    // 2. Channel spread is >= 1.25% (sufficient room for +$1.00 TP on mean reversion)
    const barSpread = midArr[i] > 0 ? ((upArr[i] - midArr[i]) / midArr[i]) * 100 : 0;
    if (c.high >= upArr[i] && barSpread >= 1.25) {
      const isFirstTouchBar = (i > 0 && candles[i - 1].high < upArr[i - 1]);
      ctx.fillStyle = isFirstTouchBar ? '#eab308' : '#f43f5e';
      ctx.beginPath();
      ctx.arc(x, hY - 4, isFirstTouchBar ? 3.5 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 7. Dashed Target Lines
  const lastPrice = candles[count - 1].close;
  drawDashedLine(ctx, padLeft, chartW, priceToY(lastPrice), '#ffffff', `NOW: $${formatPrice(lastPrice)}`);
  drawDashedLine(ctx, padLeft, chartW, priceToY(upArr[count - 1]), '#f43f5e', `15M KC UPPER: $${formatPrice(upArr[count - 1])}`);

  // Indicator Legend
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = '#f43f5e';
  ctx.fillText('─ Upper KC (2.0 ATR) ● Gold: First Touch ● Red: Extended', padLeft + 10, padTop - 12);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText('─ Middle (20 EMA)', padLeft + 360, padTop - 12);
  ctx.fillStyle = '#a855f7';
  ctx.fillText('─ Lower KC', padLeft + 480, padTop - 12);
}

function drawDashedLine(ctx, x, w, y, color, label) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = 'bold 9px monospace';
  ctx.fillText(label, x + 6, y - 4);
  ctx.restore();
}

// ── Modal Handling ────────────────────────────────────────────────────────
function renderModalChart() {
  if (!currentModalItem) return;
  const canvas = document.getElementById('modal-chart-canvas');
  const label = document.getElementById('modal-chart-label');
  if (!canvas) return;

  if (modalActiveTimeframe === '15m') {
    label.textContent = `15M Candlestick Chart with Continuous Keltner Channel (20 EMA, 2.0 ATR)`;
    draw15MKeltnerCanvas(currentModalItem, canvas);
  } else {
    label.textContent = `1D Daily Macro Decay Anatomy Chart`;
    draw1DCanvas(currentModalItem, canvas);
  }
}

function openModal(item) {
  currentModalItem = item;
  modalActiveTimeframe = '15m'; // Default to 15m on click
  const modal = document.getElementById('detail-modal');

  document.getElementById('modal-symbol').textContent = item.symbol;
  
  const safeBadge = document.getElementById('modal-safe-badge');
  if (item.isSafeZone) {
    safeBadge.textContent = '🛡️ ZERO-LIQ SAFE ZONE ACTIVE';
    safeBadge.className = 'badge-tag safe-zone';
  } else if (item.downsidePct < 1.50) {
    safeBadge.textContent = `⚠️ AT BASELINE FLOOR (${item.downsidePct.toFixed(1)}% < 1.50% TP ROOM)`;
    safeBadge.className = 'badge-tag outside-safe monospace';
  } else {
    safeBadge.textContent = '⚠️ OUTSIDE SAFE ZONE';
    safeBadge.className = 'badge-tag outside-safe';
  }

  document.getElementById('modal-drop-badge').textContent = `-${item.dropFromPeakPct.toFixed(1)}% FROM PEAK`;
  document.getElementById('modal-days-badge').textContent = `${item.daysSincePeak}d SINCE PEAK`;

  // Timeframe Tabs inside modal
  const tab15m = document.getElementById('modal-tab-15m');
  const tab1d = document.getElementById('modal-tab-1d');
  if (tab15m) tab15m.classList.add('active');
  if (tab1d) tab1d.classList.remove('active');

  // Populate 15M Keltner Trigger Box
  const kcStatusBadge = document.getElementById('modal-kc-status-badge');
  const kcUpperEl = document.getElementById('modal-kc-upper-val');
  const kcMidEl = document.getElementById('modal-kc-mid-val');
  const kcLowEl = document.getElementById('modal-kc-low-val');
  const kcDistEl = document.getElementById('modal-kc-dist-val');
  const kcSpreadEl = document.getElementById('modal-kc-spread-val');

  if (item.kcUpper) {
    kcUpperEl.textContent = `$${formatPrice(item.kcUpper)}`;
    kcMidEl.textContent = `$${formatPrice(item.kcMiddle)}`;
    kcLowEl.textContent = `$${formatPrice(item.kcLower)}`;
    kcDistEl.textContent = `${item.kcDistPct > 0 ? '+' : ''}${item.kcDistPct.toFixed(2)}%`;

    if (kcSpreadEl) {
      kcSpreadEl.textContent = `${item.kcSpreadPct ? item.kcSpreadPct.toFixed(2) + '%' : '--'}`;
      kcSpreadEl.style.color = item.isChannelWideEnough ? 'var(--green)' : 'var(--amber)';
    }

    if (item.isFirstTouch) {
      kcStatusBadge.textContent = `🔥 15M FRESH FIRST TOUCH - OPTIMAL BOT ENTRY (${item.kcSpreadPct.toFixed(1)}% Spread${item.isHighVelocitySpread ? ' ⚡ Fast TP' : ''})`;
      kcStatusBadge.className = 'badge-tag kc-touch monospace';
      kcStatusBadge.style.background = 'rgba(234, 179, 8, 0.25)';
      kcStatusBadge.style.borderColor = '#eab308';
      kcStatusBadge.style.color = '#fde047';
    } else if (item.isKeltnerTouch) {
      kcStatusBadge.textContent = `⚡ 15M EXTENDED TOUCH (${item.kcSpreadPct.toFixed(1)}% Spread)`;
      kcStatusBadge.className = 'badge-tag kc-touch monospace';
      kcStatusBadge.style.background = '';
      kcStatusBadge.style.borderColor = '';
      kcStatusBadge.style.color = '';
    } else if (item.isChannelWideEnough) {
      kcStatusBadge.textContent = `APPROACHING (${Math.abs(item.kcDistPct).toFixed(1)}% AWAY)`;
      kcStatusBadge.className = 'badge-tag kc-near monospace';
      kcStatusBadge.style.background = '';
      kcStatusBadge.style.borderColor = '';
      kcStatusBadge.style.color = '';
    } else {
      kcStatusBadge.textContent = `⚠️ TIGHT BAND (${item.kcSpreadPct ? item.kcSpreadPct.toFixed(2) + '%' : '--'} < 1.25% TP TARGET)`;
      kcStatusBadge.className = 'badge-tag outside-safe monospace';
      kcStatusBadge.style.background = '';
      kcStatusBadge.style.borderColor = '';
      kcStatusBadge.style.color = '';
    }
  } else {
    kcStatusBadge.textContent = 'NO 15M DATA';
    kcUpperEl.textContent = '--';
    kcMidEl.textContent = '--';
    kcLowEl.textContent = '--';
    kcDistEl.textContent = '--';
    if (kcSpreadEl) kcSpreadEl.textContent = '--';
  }

  // 1D Climax Anatomy
  document.getElementById('modal-pump-val').textContent = `$${formatPrice(item.pumpStartPrice || item.basePrice)}`;
  document.getElementById('modal-peak-val').textContent = `$${formatPrice(item.peakPrice)} (+${item.peakGainPct.toFixed(0)}%)`;
  document.getElementById('modal-base-val').textContent = `$${formatPrice(item.basePrice)}`;
  document.getElementById('modal-room-val').textContent = `-${item.downsidePct.toFixed(1)}%`;

  // Calculated 2.0x Short Grid Limits
  const upperLimit = item.currentPrice * 1.70; // +70%
  const lowerLimit = item.currentPrice * 0.70; // -30%

  document.getElementById('modal-upper-limit').textContent = `$${formatPrice(upperLimit)}`;
  document.getElementById('modal-lower-limit').textContent = `$${formatPrice(lowerLimit)}`;

  document.getElementById('modal-bybit-btn').href = `https://www.bybit.com/trade/usdt/${item.symbol}`;

  renderModalChart();

  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  const modal = document.getElementById('detail-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function copyText(val, btn) {
  navigator.clipboard.writeText(val).then(() => {
    const oldText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    showToast(`Copied: ${val}`);
    setTimeout(() => {
      btn.textContent = oldText;
      btn.classList.remove('copied');
    }, 1500);
  });
}

function openSignalsModal() {
  fetchSignals();
  const m = document.getElementById('signals-modal');
  if (m) {
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
  }
}

function closeSignalsModal() {
  const m = document.getElementById('signals-modal');
  if (m) {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  }
}

function openBotsModal() {
  fetchBots();
  const m = document.getElementById('bots-modal');
  if (m) {
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
  }
}

function closeBotsModal() {
  const m = document.getElementById('bots-modal');
  if (m) {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  }
}

// ── Event Handlers ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Bots Modal triggers
  const btnViewBots = document.getElementById('btn-view-bots');
  if (btnViewBots) btnViewBots.addEventListener('click', openBotsModal);

  const btnCloseBots = document.getElementById('bots-modal-close');
  if (btnCloseBots) btnCloseBots.addEventListener('click', closeBotsModal);

  const botsModal = document.getElementById('bots-modal');
  if (botsModal) {
    botsModal.addEventListener('click', (e) => {
      if (e.target.id === 'bots-modal') closeBotsModal();
    });
  }

  const btnForceCheck = document.getElementById('btn-force-check-bots');
  if (btnForceCheck) {
    btnForceCheck.addEventListener('click', async () => {
      btnForceCheck.disabled = true;
      btnForceCheck.textContent = 'Checking...';
      try {
        const res = await fetch('/api/bots/check', { method: 'POST' });
        const d = await res.json();
        showToast(`Check done: ${d.activeCount || 0} active, ${d.closedCount || 0} closed`);
        await fetchBots();
      } catch (err) {
        showToast(`Check error: ${err.message}`);
      } finally {
        btnForceCheck.disabled = false;
        btnForceCheck.textContent = '🔄 Check Bots Now';
      }
    });
  }

  // Signals Modal triggers
  const btnViewSignals = document.getElementById('btn-view-signals');
  if (btnViewSignals) btnViewSignals.addEventListener('click', openSignalsModal);

  const btnCloseSignals = document.getElementById('signals-modal-close');
  if (btnCloseSignals) btnCloseSignals.addEventListener('click', closeSignalsModal);

  const signalsModal = document.getElementById('signals-modal');
  if (signalsModal) {
    signalsModal.addEventListener('click', (e) => {
      if (e.target.id === 'signals-modal') closeSignalsModal();
    });
  }

  // Sort Buttons
  document.querySelectorAll('.btn-sort').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-sort').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sortMode = btn.dataset.sort;
      fetchPairs();
    });
  });

  // Safe Zone Toggle
  const safeBtn = document.getElementById('btn-toggle-safe-zone');
  safeBtn.addEventListener('click', () => {
    safeZoneOnly = !safeZoneOnly;
    safeBtn.classList.toggle('active', safeZoneOnly);
    fetchPairs();
  });

  // Search Input
  document.getElementById('search-input').addEventListener('input', () => {
    fetchPairs();
  });

  // Min Gain Dropdown
  document.getElementById('min-gain-select').addEventListener('change', () => {
    fetchPairs();
  });

  // Rescan Button
  document.getElementById('btn-rescan').addEventListener('click', async () => {
    try {
      await fetch('/api/scan', { method: 'POST' });
      pollStatus();
    } catch (err) {
      console.error('Trigger scan error:', err);
    }
  });

  // Modal Timeframe Tabs
  document.getElementById('modal-tab-15m').addEventListener('click', () => {
    modalActiveTimeframe = '15m';
    document.getElementById('modal-tab-15m').classList.add('active');
    document.getElementById('modal-tab-1d').classList.remove('active');
    renderModalChart();
  });

  document.getElementById('modal-tab-1d').addEventListener('click', () => {
    modalActiveTimeframe = '1d';
    document.getElementById('modal-tab-1d').classList.add('active');
    document.getElementById('modal-tab-15m').classList.remove('active');
    renderModalChart();
  });

  // Copy Buttons in Modal
  document.getElementById('btn-copy-upper').addEventListener('click', function() {
    if (currentModalItem) {
      const val = (currentModalItem.currentPrice * 1.70).toFixed(6);
      copyText(val, this);
    }
  });

  document.getElementById('btn-copy-lower').addEventListener('click', function() {
    if (currentModalItem) {
      const val = (currentModalItem.currentPrice * 0.70).toFixed(6);
      copyText(val, this);
    }
  });

  document.getElementById('btn-copy-tp').addEventListener('click', function() {
    copyText('1.00', this);
  });

  // Modal Close
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') closeModal();
  });

  // Initial load & Polling Loop
  pollStatus();
});

async function pollStatus() {
  const state = await fetchStatus();
  await fetchPairs();
  await fetchSignals();
  await fetchBots();

  const scannerState = state?.scanner || state;
  if (scannerState && scannerState.status === 'scanning') {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollStatus, 1500);
  } else {
    // Poll every 15 seconds when idle
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollStatus, 15000);
  }
}
