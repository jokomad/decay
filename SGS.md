# SGS-1 — Short Grid Safety (live bot)

SGS-1 is a standalone entry signal for the short grid bot. It is evaluated on
every completed 15M candle inside a safe zone. It does not use the Keltner
touch; it is a second, independent signal.

## Live behavior

- The watcher evaluates SGS-1 for every safe-zone symbol at :01, :16, :31, :46
  (after the 15M candle closes).
- If SGS-1 passes and the symbol has no active grid, a short grid is opened with
  the same payload as the Keltner signal: 100 USDT, 2x, 40 geometric grids,
  range [-30%, +70%], TP +1.00 USDT.
- If both SGS-1 and Keltner fire on the **same symbol** in the same cycle, only
  SGS-1 is used. SGS-1 candidates are executed before Keltner candidates.
- If a grid is already running on a symbol, no second grid is opened. This is
  the existing `getActiveBotBySymbol` / `startShortGridBot` guard.
- Funding behavior is unchanged: every candidate attempts to open; Bybit
  rejects the request if the funding wallet cannot cover it, and the loop moves
  to the next candidate.
- The signal type stored in the signal and active-bot records is `SGS_1`.

## Rule

Open if ALL conditions are true:

| Feature | Condition |
|---|---|
| `dAtrPct` (prev completed 1D ATR14 / close × 100) | `> 6.55152` and `<= 11.843` |
| `distE200D` (prev completed 1D close vs 1D EMA200) | `> -20.0` and `<= 23.6149` |
| `downside` (trigger close vs safe-zone base) | `> 20.3757%` |
| `dropFromPeak` (safe-zone peak vs trigger close) | `> 25.0%` |
| `daysSincePeak` (daily bars) | `> 14` and `<= 107` |
| `dRsi` (prev completed 1D RSI14) | `> 41.3239` and `<= 53.3136` |
| `dCloseVsLl20` (prev completed 1D close vs 20D low) | `> 7.84743%` |
| `dVolRatio` (prev completed 1D volume / prior 20D average) | `<= 1.25013` |
| `rsi` (current 15M RSI14) | `> 35` |

All 1D features use the **previous completed** daily candle. The current partial
day is excluded.

## Code

- `lib/sgsIndicator.js` — formulas, daily feature calculation, condition checks.
- `lib/bybitScanner.js` — fetches 1000 daily candles for the SGS-1 features;
  keeps the existing 200-day safe-zone analysis window unchanged; attaches
  `sgsDaily` to each decay analysis result.
- `lib/liveWatcher.js` — evaluates SGS-1 for every safe item, dedupes by symbol
  with SGS-1 priority, executes SGS-1 first.
- `lib/gridBotManager.js` — stores `signalType: 'SGS_1'` and the SGS snapshot.
- `public/app.js` / `public/style.css` — SGS-1 card label and stats.

## Backtest result (Binance 15M/1D, 1,544,758 safe-zone entries)

- 107,633 trades
- 0 liquidations
- 107,539 TP (99.91%)
- 94 unresolved
- 6.97% of all safe-zone entries
- All 298 symbols with safe zones, 2020–2026

## Safe-zone peak: live and backtest match

The live scanner and the backtest use the same safe-zone logic:

- 200 daily candles;
- peak = the highest high in that window;
- base = the 30th percentile of the 40 closes before the peak;
- same drop / volume / downside / breach gates.

`backtest/engine.mjs` `safeZones()` and `lib/bybitScanner.js`
`_evaluateDecay()` are the same algorithm. The earlier "peak mismatch" was a
test artifact: my parity script gave the calculator 1,000 daily bars, so LQTY
picked its March 2023 high (3.8659); the live scanner and the backtest both use
200 bars and pick the October 2023 pump high (2.289). The live bot's
safe-zone logic was not changed; the fetch is sliced back to the same 200 bars.

SGS-1's 1,000-candle daily fetch is sliced back to 200 for the decay analysis;
the extra history is only used for the SGS 1D features (EMA200, ATR, RSI, 20-day
low, volume ratio).

## Remaining live-vs-backtest differences

The pump/base are the same, but the live safe zone is not evaluated at a daily
close:

- live uses the current ticker price for safe-zone membership and
  `dropFromPeak`; the backtest uses the daily close;
- live uses the last 3 daily candles including the current partial day for the
  volume ratio; the backtest uses three completed daily candles;
- live uses Bybit candles; the backtest uses Binance candles;
- live `daysSincePeak` uses the current time; the backtest uses daily bar
  timestamps (±1 day);
- SGS-1 daily features use the last 1,000 daily bars; the backtest uses the full
  history (EMA200 seed can differ slightly on very old tokens).

Those can move a symbol in or out of a safe zone intraday, so the 0-liquidation
backtest is not a live guarantee even though the peak/base logic is identical.

The 1000BONK 2025-01-06 parity row is a case where the 200-bar peak and the
1,000-bar peak coincide; the live features match the backtest to ~1e-7.

Before trading SGS-1 with real size, run it on the Bybit demo/testnet and compare
the first signals with the expected rule values.

## Tests

```bash
npm run test:sgs          # unit + priority/dedupe
npm run test:sgs:parity   # parity with the backtest row (needs D:/BinanceCandles)
node scripts/smoke_sgs_bybit.js 1000BONKUSDT  # live Bybit data smoke test
```
