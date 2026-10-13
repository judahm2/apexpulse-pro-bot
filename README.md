# Apexatix Pro Bot

## Silver market data

For XAG/USD, the market-data API uses OANDA as a candle fallback when Twelve Data and Finnhub cannot provide the symbol. The fallback requests completed 15-minute midpoint candles for OANDA's `XAG_USD` instrument. If no candle feed is available, the API tries the free Gold API spot quote as a price-only fallback; because it does not provide candle history, the dashboard and scheduled scanner show a LOW-confidence HOLD and do not calculate indicators or trade levels. Silver futures are not substituted for spot.

Configure these environment variables for local development and deployment:

- `OANDA_API_TOKEN`: OANDA v20 personal access token. Keep it server-side; do not expose it in browser code.
- `OANDA_ACCOUNT_ID`: account ID that can access the `XAG_USD` instrument.
- `OANDA_API_ENVIRONMENT`: `practice` (default) or `live`, matching the account that issued the token.

For local development, set the variables in the environment used by `vercel dev`. For deployment, add them as serverless-function environment variables in the hosting platform. Confirm that `XAG_USD` is listed among the account's available instruments. If the provider denies access, the dashboard may still display the Gold API's current XAG spot quote, but it keeps trade signals unavailable rather than substituting silver futures for spot candles.

## Market scanning and alerts

The dashboard refreshes closed-candle market data while it is open and auto-scan is enabled. The default strategy and scheduled scanner follow market direction: EMA9/EMA21, MACD, and RSI above/below 50 must agree on the 45-minute bullish/bearish regime; the entry timeframe must agree, and at least two of the 15m, 30m, and 45m trends must align. This produces BUY setups only in a confirmed bullish trend and SELL setups only in a confirmed bearish trend. Mixed, unconfirmed, or filtered conditions produce an explanatory HOLD. Separately, the GitHub Actions workflow calls `/api/bot` every 15 minutes; when `DISCORD_WEBHOOK_URL` is configured, that scheduled scan sends the same trend-following advisory BUY/SELL/HOLD reports to Discord. Set the repository secrets `VERCEL_URL` and `CRON_SECRET` for the scheduled workflow. A BUY/SELL alert includes a rule-based confidence tier, the strategy rationale, an ISO timestamp, provider and candle-close time, RSI/EMA/MACD/ATR snapshot, and ATR-based invalidation and 2:1 target levels. HOLD decisions include their reason and market snapshot.

When possible, the API checks the selected provider against an independent free feed (Binance/Coinbase for crypto; Finnhub, OANDA when configured, or Yahoo Finance for traditional symbols). A same-candle price disagreement above 0.5% for traditional markets or 1% for crypto suppresses entries. Source verification and provider details continue to inform signal validation but are omitted from dashboard cards and summaries.

Signals are held during quiet volatility (ATR below 0.02% of price), an erratic candle (range above 3 times the recent median), or available volume below half its recent average. Volume feeds are not universal; when volume is unavailable, that limitation is shown and confidence is capped rather than treating missing volume as adequate. Regimes are classified as Trending, Ranging, Volatile, or Quiet. The default trend-following strategy uses a 2-of-3 timeframe alignment threshold; the optional RSI, EMA/MACD, and Bollinger/RSI strategies retain their adaptive weighted composite score of at least 0.45. Confidence reflects cross-timeframe alignment and data quality.

Stops start at 1.5 ATR and may be widened just beyond nearby recent support/resistance; targets are recalculated at 2R. Recent closed candles are also used for simplified directional backtests, with trade count, win rate, and net R calculated internally. The trend-following historical sample uses the EMA/MACD/RSI direction rule; live entries additionally require the multi-timeframe alignment above. Backtests use a maximum 12-candle holding window, treat same-candle stop/target touches conservatively as stop-outs, and exclude fees, spread, and slippage. They are informational only: thresholds remain fixed and are not auto-tuned. Diagnostic inputs such as regime, ATR, volume availability, feed verification, support/resistance reasoning, and backtest metrics inform filtering and confidence but are not displayed in the dashboard cards.

Confidence is a confluence label, not a probability or a guarantee. Browser notifications are optional and require enabling the trade-alert control in the dashboard. Dashboard scans pause when the page is closed or auto-scan is disabled; the separately configured GitHub Actions scan continues on its 15-minute schedule. Alerts are advisory: the bot does not execute orders or calculate position size. The user must confirm executable broker prices, instrument contract specifications, and account-specific risk limits before acting.

Routine HOLD results are grouped into a single summary per manual scan rather than one log entry per asset. Auto-scan does not repeatedly log unchanged no-setup outcomes; individual HOLD reasons remain visible on the asset cards, while actionable signals and data-quality warnings remain in the transparency log.
