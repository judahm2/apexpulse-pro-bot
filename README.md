# Apexatix Pro Bot

## Silver market data

The market-data API uses OANDA as a fallback for `XAG/USD` candles when Twelve Data and Finnhub cannot provide the symbol. The fallback requests completed 15-minute midpoint candles for OANDA's `XAG_USD` instrument. OANDA price availability depends on the account.

Configure these environment variables for local development and deployment:

- `OANDA_API_TOKEN`: OANDA v20 personal access token. Keep it server-side; do not expose it in browser code.
- `OANDA_ACCOUNT_ID`: account ID that can access the `XAG_USD` instrument.
- `OANDA_API_ENVIRONMENT`: `practice` (default) or `live`, matching the account that issued the token.

For local development, set the variables in the environment used by `vercel dev`. For deployment, add them as serverless-function environment variables in the hosting platform. Confirm that `XAG_USD` is listed among the account's available instruments. If the provider still denies access, the API returns the provider errors and the dashboard keeps trade signals unavailable rather than substituting silver futures for spot candles.

## Market scanning and alerts

The dashboard refreshes closed-candle market data while it is open and auto-scan is enabled. A BUY/SELL alert includes a rule-based confidence tier, the strategy rationale, an ISO timestamp, provider and candle-close time, RSI/EMA/MACD/ATR snapshot, and the existing ATR-derived invalidation and 2:1 target levels. HOLD decisions are recorded with their reason and market snapshot in the dashboard log; the asset cards show the current HOLD/WAIT reason and confidence.

Confidence is a confluence label, not a probability or a guarantee. Browser notifications are optional and require enabling the trade-alert control in the dashboard. Alerts are advisory: the bot does not execute orders or calculate position size. The user must confirm executable broker prices, instrument contract specifications, and account-specific risk limits before acting. Monitoring stops when the dashboard is closed or auto-scan is disabled.
