export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized request' });
  }

  const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
  const symbols = ['XAU/USD', 'BTC/USD', 'XAG/USD', 'EUR/USD', 'AUD/USD'];
  const results = [];

  function checkMarketBreak(symbol) {
    if (symbol.includes('BTC')) return false;
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    if (utcDay === 6) return true;
    if (utcDay === 0 && utcHour < 21) return true;
    if (utcDay === 5 && utcHour >= 21) return true;
    return false;
  }

  try {
    for (const symbol of symbols) {
      if (checkMarketBreak(symbol)) {
        results.push({ symbol, status: 'MARKET_ON_BREAK', signal: 'PAUSED' });
        continue;
      }

      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=30&apikey=${TWELVE_DATA_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.status === 'error' || !data.values) {
        results.push({ symbol, error: data.message || 'Failed to fetch' });
        continue;
      }

      const closes = data.values.reverse().map(c => parseFloat(c.close));
      const rsi15 = calculateRSI(closes, 14);
      const rsi30 = calculateRSI(closes.slice(0, -2), 14);

      let signal = 'HOLD';
      if (rsi15 <= 30 && rsi30 <= 38) signal = 'BUY_SIGNAL (Confluent)';
      if (rsi15 >= 70 && rsi30 >= 62) signal = 'SELL_SIGNAL (Confluent)';

      results.push({
        symbol,
        price: closes[closes.length - 1],
        rsi15: rsi15 ? rsi15.toFixed(2) : 'N/A',
        rsi30: rsi30 ? rsi30.toFixed(2) : 'N/A',
        signal
      });
    }

    let alertBody = "📊 **ApexPulse Pro Day-Trading Scan**\n\n";
    results.forEach(item => {
      alertBody += `🔹 **${item.symbol}**\n   Price: ${item.price || 'N/A'}\n   15m RSI: ${item.rsi15}\n   30m RSI: ${item.rsi30}\n   Status: ${item.signal}\n\n`;
    });

    if (process.env.DISCORD_WEBHOOK_URL) {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: alertBody })
      });
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}