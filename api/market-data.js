const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./_-]{0,19}$/;
const BASE_INTERVAL_SECONDS = 15 * 60;
const TIMEFRAMES = [15, 30, 45];
const TWELVE_DATA_CACHE_TTL_MS = 60 * 1000;
const PROVIDER_ERROR_CACHE_TTL_MS = 60 * 1000;
const twelveDataCache = new Map();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbolsParam = req.query?.symbols;
  const symbols = typeof symbolsParam === 'string'
    ? [...new Set(symbolsParam.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean))]
    : [];
  const cryptoSymbolsParam = req.query?.cryptoSymbols;
  const cryptoSymbols = new Set(typeof cryptoSymbolsParam === 'string'
    ? cryptoSymbolsParam.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean)
    : []);
  const timeframe = Number(req.query?.timeframe || 15);
  if (
    symbols.length === 0 ||
    symbols.length > 5 ||
    !TIMEFRAMES.includes(timeframe) ||
    symbols.some(symbol => !SYMBOL_PATTERN.test(symbol)) ||
    [...cryptoSymbols].some(symbol => !symbols.includes(symbol))
  ) {
    return res.status(400).json({ error: 'Provide 1-5 valid symbols and a timeframe of 15, 30, or 45 minutes.' });
  }

  const twelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const finnHubApiKey = process.env.FINNHUB_API_KEY;

  try {
    const results = await Promise.all(symbols.map(async symbol => {
      try {
        if (!twelveDataKey) throw new Error('TWELVE_DATA_API_KEY is not configured.');
        return await getTwelveDataResult(symbol, twelveDataKey, timeframe);
      } catch (primaryError) {
        let keylessCryptoError = null;
        if (cryptoSymbols.has(symbol)) {
          try {
            return await getKeylessCryptoResult(symbol, timeframe);
          } catch (error) {
            keylessCryptoError = error;
          }
        }

        if (finnHubApiKey) {
          try {
            return await getFinnhubResult(symbol, cryptoSymbols.has(symbol), finnHubApiKey, timeframe);
          } catch (fallbackError) {
            const errors = [`Twelve Data: ${primaryError.message}`];
            if (keylessCryptoError) errors.push(`Binance/Coinbase: ${keylessCryptoError.message}`);
            errors.push(`Finnhub: ${fallbackError.message}`);
            return { symbol, error: errors.join(' ') };
          }
        }

        const errors = [`Twelve Data: ${primaryError.message}`];
        if (keylessCryptoError) errors.push(`Binance/Coinbase: ${keylessCryptoError.message}`);
        else if (!finnHubApiKey) errors.push('Configure FINNHUB_API_KEY to enable a backup provider.');
        return { symbol, error: errors.join(' ') };
      }
    }));

    return res.status(200).json({ results });
  } catch (error) {
    console.error('Market data request failed:', error);
    return res.status(502).json({ error: 'Unable to retrieve market data right now.' });
  }
}

async function getKeylessCryptoResult(symbol, timeframe) {
  let binanceError;
  try {
    return await getBinanceResult(symbol, timeframe);
  } catch (error) {
    binanceError = error;
  }

  try {
    return await getCoinbaseResult(symbol, timeframe);
  } catch (error) {
    throw new Error(`Binance: ${binanceError.message} Coinbase: ${error.message}`);
  }
}

async function getBinanceResult(symbol, timeframe) {
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.search = new URLSearchParams({
    symbol: getBinanceSymbol(symbol),
    interval: '15m',
    limit: '150'
  }).toString();

  const response = await fetch(url);
  const candles = await readProviderJson(response, 'Binance');
  if (!Array.isArray(candles)) throw new Error('Provider returned an invalid candle response.');

  return createMarketResult(symbol, candles.map(candle => ({
    time: Number(candle[0]) / 1000,
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    closed: Number(candle[6]) < Date.now()
  })), 'Binance', timeframe);
}

async function getCoinbaseResult(symbol, timeframe) {
  const product = symbol.includes('/') ? symbol.replace('/', '-') : symbol;
  const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`);
  const to = Math.floor(Date.now() / 1000);
  url.search = new URLSearchParams({
    granularity: '900',
    start: String(to - (150 * BASE_INTERVAL_SECONDS)),
    end: String(to)
  }).toString();

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const candles = await readProviderJson(response, 'Coinbase');
  if (!Array.isArray(candles)) throw new Error('Provider returned an invalid candle response.');

  return createMarketResult(symbol, candles.map(candle => ({
    time: Number(candle[0]),
    low: Number(candle[1]),
    high: Number(candle[2]),
    open: Number(candle[3]),
    close: Number(candle[4])
  })).reverse(), 'Coinbase', timeframe);
}

async function getTwelveDataResult(symbol, apiKey, timeframe) {
  const series = await getCachedTwelveDataSeries(symbol, async () => {
    const url = new URL('https://api.twelvedata.com/time_series');
    url.search = new URLSearchParams({
      symbol,
      interval: '15min',
      outputsize: '150',
      timezone: 'UTC',
      apikey: apiKey
    }).toString();

    const response = await fetch(url);
    const data = await readProviderJson(response, 'Twelve Data');
    if (data.status === 'error' || !Array.isArray(data.values)) {
      throw new Error(data.message || 'Market data is unavailable for this symbol.');
    }

    return {
      currency: data.meta?.currency,
      candles: data.values.map(value => ({
        time: parseProviderDate(value.datetime),
        open: Number(value.open),
        high: Number(value.high),
        low: Number(value.low),
        close: Number(value.close)
      })).reverse()
    };
  });

  return createMarketResult(symbol, series.candles, 'Twelve Data', timeframe, series.currency);
}

async function getCachedTwelveDataSeries(symbol, loadSeries) {
  const cached = twelveDataCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) twelveDataCache.delete(symbol);

  const entry = {
    expiresAt: Date.now() + TWELVE_DATA_CACHE_TTL_MS,
    promise: null
  };
  entry.promise = loadSeries().catch(error => {
    entry.expiresAt = Date.now() + PROVIDER_ERROR_CACHE_TTL_MS;
    throw error;
  });
  twelveDataCache.set(symbol, entry);

  if (twelveDataCache.size > 100) {
    const oldestSymbol = twelveDataCache.keys().next().value;
    if (oldestSymbol !== undefined && oldestSymbol !== symbol) twelveDataCache.delete(oldestSymbol);
  }

  return entry.promise;
}

async function getFinnhubResult(symbol, isCrypto, apiKey, timeframe) {
  const providerSymbol = getFinnhubSymbol(symbol, isCrypto);
  const to = Math.floor(Date.now() / 1000);
  const from = to - (150 * BASE_INTERVAL_SECONDS);
  const endpoint = isCrypto ? 'crypto/candle' : symbol.includes('/') ? 'forex/candle' : 'stock/candle';
  const url = new URL(`https://finnhub.io/api/v1/${endpoint}`);
  url.search = new URLSearchParams({
    symbol: providerSymbol,
    resolution: '15',
    from: String(from),
    to: String(to),
    token: apiKey
  }).toString();

  const response = await fetch(url);
  const data = await readProviderJson(response, 'Finnhub');
  if (data.s !== 'ok' || !Array.isArray(data.c)) {
    throw new Error(data.error || `No candle data for ${providerSymbol}.`);
  }

  const candles = data.c.map((close, index) => ({
    time: Number(data.t[index]),
    open: Number(data.o[index]),
    high: Number(data.h[index]),
    low: Number(data.l[index]),
    close: Number(close)
  }));
  return createMarketResult(symbol, candles, 'Finnhub', timeframe);
}

async function readProviderJson(response, provider) {
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const message = /forbidden/i.test(body)
      ? 'access was denied'
      : 'the response was not valid JSON';
    throw new Error(`${provider} ${message} (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = data && typeof data === 'object'
      ? data.message || data.error || data.msg
      : null;
    throw new Error(`${provider} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
  }

  return data;
}

function createMarketResult(symbol, inputCandles, provider, timeframe, currency) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const candles = inputCandles
    .filter(candle =>
      Number.isFinite(candle.time) &&
      [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
      candle.time + BASE_INTERVAL_SECONDS <= nowSeconds &&
      candle.closed !== false)
    .sort((first, second) => first.time - second.time)
    .filter((candle, index, sorted) => index === 0 || candle.time !== sorted[index - 1].time);

  if (candles.length < 2) throw new Error('Provider returned insufficient closed-candle history.');

  const candles15 = candles;
  const candles30 = aggregateCandles(candles, 2);
  const candles45 = aggregateCandles(candles, 3);
  const selectedCandles = timeframe === 15 ? candles15 : timeframe === 30 ? candles30 : candles45;
  if (selectedCandles.length < 2) throw new Error(`Insufficient complete ${timeframe}-minute candles.`);

  const last = selectedCandles[selectedCandles.length - 1];
  const previous = selectedCandles[selectedCandles.length - 2];
  const candlesByTimeframe = { 15: candles15, 30: candles30, 45: candles45 };
  const rsiByTimeframe = {
    15: calculateRSI(candles15.map(candle => candle.close)),
    30: calculateRSI(candles30.map(candle => candle.close)),
    45: calculateRSI(candles45.map(candle => candle.close))
  };
  const candleCloseByTimeframe = Object.fromEntries(
    Object.entries(candlesByTimeframe).map(([minutes, bars]) => [minutes, bars.at(-1)?.close ?? null])
  );
  const candleClosedAtByTimeframe = Object.fromEntries(
    Object.entries(candlesByTimeframe).map(([minutes, bars]) => {
      const latest = bars.at(-1);
      return [minutes, latest ? (latest.time + (Number(minutes) * 60)) * 1000 : null];
    })
  );
  const strategyIndicatorsByTimeframe = Object.fromEntries(
    Object.entries(candlesByTimeframe).map(([minutes, bars]) => [
      minutes,
      calculateStrategyIndicators(bars.map(candle => candle.close))
    ])
  );
  const atrByTimeframe = Object.fromEntries(
    Object.entries(candlesByTimeframe).map(([minutes, bars]) => [minutes, calculateATR(bars)])
  );
  return {
    symbol,
    price: last.close,
    candleClose: candleCloseByTimeframe[timeframe],
    candleCloseByTimeframe,
    candleClosedAtByTimeframe,
    currency: currency || (provider === 'Binance' && symbol.endsWith('/USD')
      ? 'USDT'
      : symbol.includes('/') ? symbol.split('/').pop() : 'USD'),
    changePercent: previous.close === 0 ? null : ((last.close - previous.close) / previous.close) * 100,
    rsi15: rsiByTimeframe[15],
    rsi30: rsiByTimeframe[30],
    rsi45: rsiByTimeframe[45],
    rsiByTimeframe,
    strategyRsi: rsiByTimeframe[timeframe],
    strategyIndicators: strategyIndicatorsByTimeframe[timeframe],
    strategyIndicatorsByTimeframe,
    atr: atrByTimeframe[timeframe],
    atrByTimeframe,
    candleClosedAt: candleClosedAtByTimeframe[timeframe],
    provider
  };
}

function aggregateCandles(candles, factor) {
  const intervalSeconds = BASE_INTERVAL_SECONDS * factor;
  const buckets = new Map();
  candles.forEach(candle => {
    const bucketTime = Math.floor(candle.time / intervalSeconds) * intervalSeconds;
    const bucket = buckets.get(bucketTime) || [];
    bucket.push(candle);
    buckets.set(bucketTime, bucket);
  });

  return [...buckets.entries()]
    .filter(([bucketTime, bucket]) => {
      if (bucket.length !== factor) return false;
      const timestamps = new Set(bucket.map(candle => candle.time));
      return Array.from({ length: factor }, (_, index) => bucketTime + (index * BASE_INTERVAL_SECONDS))
        .every(time => timestamps.has(time));
    })
    .map(([time, bucket]) => ({
      time,
      open: bucket[0].open,
      high: Math.max(...bucket.map(candle => candle.high)),
      low: Math.min(...bucket.map(candle => candle.low)),
      close: bucket[bucket.length - 1].close
    }))
    .sort((first, second) => first.time - second.time);
}

function calculateStrategyIndicators(closes) {
  if (closes.length < 35) return null;

  const ema9 = calculateEma(closes, 9);
  const ema21 = calculateEma(closes, 21);
  const fastEma = calculateEma(closes, 12);
  const slowEma = calculateEma(closes, 26);
  const macdLine = fastEma.map((value, index) => value - slowEma[index]);
  const macdSignal = calculateEma(macdLine, 9);
  const recentCloses = closes.slice(-20);
  const middleBand = recentCloses.reduce((total, close) => total + close, 0) / recentCloses.length;
  const standardDeviation = Math.sqrt(
    recentCloses.reduce((total, close) => total + (close - middleBand) ** 2, 0) / recentCloses.length
  );

  return {
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    previousEma9: ema9.at(-2),
    previousEma21: ema21.at(-2),
    macd: macdLine.at(-1),
    macdSignal: macdSignal.at(-1),
    previousMacd: macdLine.at(-2),
    previousMacdSignal: macdSignal.at(-2),
    lowerBand: middleBand - (2 * standardDeviation),
    upperBand: middleBand + (2 * standardDeviation)
  };
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close)
  ));
  const recentRanges = trueRanges.slice(-period);
  return recentRanges.reduce((total, range) => total + range, 0) / recentRanges.length;
}

function calculateEma(prices, period) {
  const multiplier = 2 / (period + 1);
  return prices.reduce((emaValues, price, index) => {
    emaValues.push(index === 0 ? price : (price - emaValues[index - 1]) * multiplier + emaValues[index - 1]);
    return emaValues;
  }, []);
}

function parseProviderDate(value) {
  if (typeof value !== 'string') return Number.NaN;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const timestamp = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return timestamp / 1000;
}

function getBinanceSymbol(symbol) {
  if (!symbol.includes('/')) return symbol;
  const [base, quote] = symbol.split('/');
  return `${base}${quote === 'USD' ? 'USDT' : quote}`;
}

function getFinnhubSymbol(symbol, isCrypto) {
  if (isCrypto && symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `BINANCE:${base}${quote === 'USD' ? 'USDT' : quote}`;
  }
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `OANDA:${base}_${quote}`;
  }
  return symbol;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) gains += difference;
    else losses -= difference;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) {
      averageGain = (averageGain * (period - 1) + difference) / period;
      averageLoss = (averageLoss * (period - 1)) / period;
    } else {
      averageGain = (averageGain * (period - 1)) / period;
      averageLoss = (averageLoss * (period - 1) - difference) / period;
    }
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}
