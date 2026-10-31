/**
 * sgsIndicator.js
 *
 * SGS-1 — Short Grid Safety indicator.
 *
 * A standalone entry filter for the short grid bot. It is evaluated on every
 * completed 15M candle inside a safe zone. The 1D features use the previous
 * COMPLETED daily candle only (never the current partial day).
 *
 * Formulas are ported 1:1 from the backtest indicator library:
 *   EMA: 2/(p+1), seeded with the first value
 *   RMA: Wilder smoothing, seeded with the first value
 *   ATR: RMA(true range, p)
 *   RSI: RMA(gains)/RMA(losses), 100 - 100/(1+rs)
 */

'use strict';

const DAY_MS = 24 * 3600 * 1000;

const THRESHOLDS = Object.freeze({
  dAtrPct:      { min: 6.55152,  max: 11.843   },
  distE200D:    { min: -20.0,    max: 23.6149  },
  downside:     { min: 20.3757 },
  dropFromPeak: { min: 25.0 },
  daysSincePeak:{ min: 14.0,     max: 107.0    },
  dRsi:         { min: 41.3239,  max: 53.3136  },
  dCloseVsLl20: { min: 7.84743 },
  dVolRatio:    { max: 1.25013 },
  rsi15:        { min: 35.0 },
});

function emaSeries(a, p) {
  const n = a.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const k = 2 / (p + 1);
  out[0] = a[0];
  for (let i = 1; i < n; i++) out[i] = a[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rmaSeries(a, p) {
  const n = a.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  out[0] = a[0];
  for (let i = 1; i < n; i++) out[i] = (out[i - 1] * (p - 1) + a[i]) / p;
  return out;
}

function trueRangeSeries(h, l, c) {
  const n = h.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  out[0] = h[0] - l[0];
  for (let i = 1; i < n; i++) {
    out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return out;
}

function atrSeries(h, l, c, p = 14) {
  return rmaSeries(trueRangeSeries(h, l, c), p);
}

function rsiSeries(c, p = 14) {
  const n = c.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const ag = new Float64Array(n);
  const al = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    ag[i] = d > 0 ? d : 0;
    al[i] = d < 0 ? -d : 0;
  }
  const ga = rmaSeries(ag, p);
  const la = rmaSeries(al, p);
  for (let i = 0; i < n; i++) {
    const rs = la[i] > 0 ? ga[i] / la[i] : 100;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

/**
 * Calculate SGS-1 daily features from the previous completed 1D candles.
 *
 * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} candles
 * @param {number} now  current timestamp (ms)
 * @param {number} peakIdx  index of the safe-zone peak in `candles`, or -1
 * @returns {null|object}
 */
function calculateDaily(candles, now, peakIdx) {
  if (!Array.isArray(candles) || !Number.isFinite(now)) return null;

  const completed = candles
    .filter(c => c && Number.isFinite(c.time) && (c.time + DAY_MS) <= now)
    .sort((a, b) => a.time - b.time);

  if (completed.length < 200) return null;

  const closes = completed.map(c => Number(c.close));
  const highs = completed.map(c => Number(c.high));
  const lows = completed.map(c => Number(c.low));
  const vols = completed.map(c => Number(c.volume));

  if (closes.some(v => !Number.isFinite(v)) ||
      highs.some(v => !Number.isFinite(v)) ||
      lows.some(v => !Number.isFinite(v)) ||
      vols.some(v => !Number.isFinite(v))) {
    return null;
  }

  const last = completed.length - 1;
  const e200 = emaSeries(closes, 200);
  const a14 = atrSeries(highs, lows, closes, 14);
  const r14 = rsiSeries(closes, 14);

  const ll20 = Math.min(...lows.slice(-20));
  const priorVols = vols.slice(-21, -1);
  const avgVol = priorVols.length
    ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length
    : 0;

  const dAtrPct = closes[last] > 0 ? (a14[last] / closes[last]) * 100 : null;
  const distE200D = e200[last] > 0 ? ((closes[last] - e200[last]) / e200[last]) * 100 : null;
  const dRsi = Number.isFinite(r14[last]) ? r14[last] : null;
  const dCloseVsLl20 = ll20 > 0 ? ((closes[last] - ll20) / ll20) * 100 : null;
  const dVolRatio = avgVol > 0 ? vols[last] / avgVol : null;

  const daysSincePeakBars =
    Number.isInteger(peakIdx) && peakIdx >= 0 && peakIdx < completed.length
      ? completed.length - 1 - peakIdx
      : null;

  return {
    dAtrPct,
    distE200D,
    dRsi,
    dCloseVsLl20,
    dVolRatio,
    daysSincePeakBars,
    completedBars: completed.length,
    lastDailyTime: completed[last].time,
  };
}

/**
 * Evaluate all SGS-1 conditions.
 *
 * downside/dropFromPeak are recomputed from the 15M trigger price (the last
 * finished candle close), matching the backtest. If the 1D-derived days count
 * is unavailable, the scanner's calendar-day estimate is used as a fallback.
 */
function evaluate({ daily, basePrice, peakPrice, triggerPrice, rsi15, fallbackDownside, fallbackDrop, fallbackDays }) {
  if (!daily) return { pass: false, reason: 'insufficient completed 1D history' };

  const downside = (Number.isFinite(basePrice) && basePrice > 0 && Number.isFinite(triggerPrice) && triggerPrice > 0)
    ? ((triggerPrice - basePrice) / triggerPrice) * 100
    : fallbackDownside;

  const dropFromPeak = (Number.isFinite(peakPrice) && peakPrice > 0 && Number.isFinite(triggerPrice) && triggerPrice > 0)
    ? ((peakPrice - triggerPrice) / peakPrice) * 100
    : fallbackDrop;

  const days = daily.daysSincePeakBars != null ? daily.daysSincePeakBars : fallbackDays;

  const checks = {
    dAtrPct: daily.dAtrPct != null && daily.dAtrPct > THRESHOLDS.dAtrPct.min && daily.dAtrPct <= THRESHOLDS.dAtrPct.max,
    distE200D: daily.distE200D != null && daily.distE200D > THRESHOLDS.distE200D.min && daily.distE200D <= THRESHOLDS.distE200D.max,
    downside: downside != null && downside > THRESHOLDS.downside.min,
    dropFromPeak: dropFromPeak != null && dropFromPeak > THRESHOLDS.dropFromPeak.min,
    daysSincePeak: days != null && days > THRESHOLDS.daysSincePeak.min && days <= THRESHOLDS.daysSincePeak.max,
    dRsi: daily.dRsi != null && daily.dRsi > THRESHOLDS.dRsi.min && daily.dRsi <= THRESHOLDS.dRsi.max,
    dCloseVsLl20: daily.dCloseVsLl20 != null && daily.dCloseVsLl20 > THRESHOLDS.dCloseVsLl20.min,
    dVolRatio: daily.dVolRatio != null && daily.dVolRatio <= THRESHOLDS.dVolRatio.max,
    rsi15: rsi15 != null && rsi15 > THRESHOLDS.rsi15.min,
  };

  const pass = Object.values(checks).every(Boolean);

  return {
    pass,
    reason: pass ? 'ok' : 'SGS-1 conditions not met',
    downside,
    dropFromPeak,
    days,
    rsi15,
    ...daily,
    checks,
  };
}

module.exports = {
  DAY_MS,
  THRESHOLDS,
  emaSeries,
  rmaSeries,
  trueRangeSeries,
  atrSeries,
  rsiSeries,
  calculateDaily,
  evaluate,
};
