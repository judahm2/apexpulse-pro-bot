import { randomUUID } from 'node:crypto';
import { getSharedRedis as getConfiguredRedis } from '../lib/redis.js';

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./_-]{0,19}$/;
const BASE_INTERVAL_SECONDS = 15 * 60;
const TIMEFRAMES = [15, 30, 45];
const TWELVE_DATA_CACHE_TTL_MS = 60 * 1000;
const PROVIDER_ERROR_CACHE_TTL_MS = 60 * 1000;
const twelveDataCache = new Map();
let redisConfigurationWarningLogged = false;

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
  const stockDataApiToken = process.env.STOCKDATA_API_TOKEN;
  const finageApiKey = process.env.FINAGE_API_KEY;
  const fmpApiKey = process.env.FMP_API_KEY;

  try {
    const results = await Promise.all(symbols.map(symbol => getSharedCachedMarketResult(
      symbol,
      timeframe,
      cryptoSymbols.has(symbol),
      async () => {
      const errors = [];
      try {
        if (!twelveDataKey) throw new Error('TWELVE_DATA_API_KEY is not configured.');
        const result = await getTwelveDataResult(symbol, twelveDataKey, timeframe);
        return await verifyMarketResult(result, { symbol, timeframe, cryptoSymbols, finnHubApiKey });
      } catch (twelveDataError) {
        errors.push(`Twelve Data: ${twelveDataError.message}`);
      }

      if (finnHubApiKey) {
        try {
          const result = await getFinnhubResult(symbol, cryptoSymbols.has(symbol), finnHubApiKey, timeframe);
          result.marketSources = [
            { provider: 'Twelve Data', error: errors[0].replace(/^Twelve Data: /, '') },
            { provider: result.provider, price: result.price, candleClosedAt: result.candleClosedAt }
          ];
          result.sourceVerification = {
            status: 'unavailable',
            reason: 'Twelve Data failed; Finnhub is serving as the fallback, so an independent comparison is unavailable.'
          };
          return result;
        } catch (finnhubError) {
          errors.push(`Finnhub: ${finnhubError.message}`);
        }
      } else {
        errors.push('Finnhub: FINNHUB_API_KEY is not configured.');
      }

      const keyedFallbacks = [];
      if (stockDataApiToken && !cryptoSymbols.has(symbol) && !symbol.includes('/')) {
        keyedFallbacks.push(['StockData.org', () => getStockDataResult(symbol, stockDataApiToken, timeframe)]);
      }
      if (finageApiKey) {
        keyedFallbacks.push([
          'Finage',
          () => getFinageResult(symbol, cryptoSymbols.has(symbol), finageApiKey, timeframe)
        ]);
      }
      if (fmpApiKey) {
        keyedFallbacks.push([
          'Financial Modeling Prep',
          () => getFmpResult(symbol, fmpApiKey, timeframe)
        ]);
      }
      for (const [provider, loadResult] of keyedFallbacks) {
        try {
          const result = await loadResult();
          result.marketSources = [
            ...errors.map(error => {
              const separator = error.indexOf(': ');
              return {
                provider: separator < 0 ? error : error.slice(0, separator),
                error: separator < 0 ? error : error.slice(separator + 2)
              };
            }),
            { provider: result.provider, price: result.price, candleClosedAt: result.candleClosedAt }
          ];
          result.sourceVerification = {
            status: 'unavailable',
            reason: `${provider} is serving as a fallback; the primary feeds are unavailable, so an independent comparison is unavailable.`
          };
          return result;
        } catch (providerError) {
          errors.push(`${provider}: ${providerError.message}`);
        }
      }

      if (cryptoSymbols.has(symbol)) {
        const cryptoFallbacks = [
          ['Coinbase', () => getCoinbaseResult(symbol, timeframe)],
          ['Kraken', () => getKrakenResult(symbol, timeframe)],
          ['Binance', () => getBinanceResult(symbol, timeframe)]
        ];
        for (const [provider, loadResult] of cryptoFallbacks) {
          try {
            const result = await loadResult();
            result.marketSources = [
              ...errors.map(error => {
                const separator = error.indexOf(': ');
                return {
                  provider: separator < 0 ? error : error.slice(0, separator),
                  error: separator < 0 ? error : error.slice(separator + 2)
                };
              }),
              { provider: result.provider, price: result.price, candleClosedAt: result.candleClosedAt }
            ];
            result.sourceVerification = {
              status: 'unavailable',
              reason: `${provider} is serving as a crypto exchange fallback; the primary feeds are unavailable, so an independent comparison is unavailable.`
            };
            return result;
          } catch (providerError) {
            errors.push(`${provider}: ${providerError.message}`);
          }
        }
      }

      try {
        const result = await getYahooFinanceResult(symbol, cryptoSymbols.has(symbol), timeframe, req);
        result.marketSources = [
          ...errors.map(error => {
            const separator = error.indexOf(': ');
            return {
              provider: separator < 0 ? error : error.slice(0, separator),
              error: separator < 0 ? error : error.slice(separator + 2)
            };
          }),
          { provider: result.provider, price: result.price, candleClosedAt: result.candleClosedAt }
        ];
        result.sourceVerification = {
          status: 'unavailable',
          reason: 'Yahoo Finance is serving as a fallback; the other feeds are unavailable, so an independent comparison is unavailable.'
        };
        return result;
      } catch (yahooFinanceError) {
        errors.push(`Yahoo Finance (yfinance): ${yahooFinanceError.message}`);
      }

      console.error(
        `No market data found for ${symbol}; failed providers:`,
        errors.map(error => error.slice(0, error.indexOf(': ')))
      );
      return { symbol, error: 'No data found due to API.' };
      }
    )));

    return res.status(200).json({ results });
  } catch (error) {
    console.error('Market data request failed:', error);
    return res.status(502).json({ error: 'Unable to retrieve market data right now.' });
  }
}

async function getSharedCachedMarketResult(symbol, timeframe, isCrypto, loadResult) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    if (!redisConfigurationWarningLogged) {
      console.warn('Upstash Redis is not configured; market-data requests will bypass the shared cache.');
      redisConfigurationWarningLogged = true;
    }
    return loadResult();
  }

  let redis;
  try {
    redis = getConfiguredRedis(redisUrl, redisToken);
  } catch (error) {
    console.error('Unable to configure shared market-data cache:', error.message);
    return loadResult();
  }
  const cacheKey = `market-data:v1:${symbol}:${timeframe}:${isCrypto ? 'crypto' : 'other'}`;
  const lockKey = `${cacheKey}:refresh-lock`;
  try {
    const cachedResult = await redis.get(cacheKey);
    if (cachedResult !== null) return cachedResult;
  } catch (error) {
    console.error('Unable to read shared market-data cache:', error.message);
    return loadResult();
  }

  const lockToken = randomUUID();
  let lockAcquired = false;
  try {
    lockAcquired = (await redis.set(lockKey, lockToken, { nx: true, ex: 30 })) === 'OK';
  } catch (error) {
    console.error('Unable to acquire shared market-data cache lock:', error.message);
    return loadResult();
  }

  if (!lockAcquired) {
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const cachedResult = await redis.get(cacheKey);
        if (cachedResult !== null) return cachedResult;
      } catch (error) {
        console.error('Unable to read shared market-data cache while waiting:', error.message);
        return loadResult();
      }
    }
    console.warn(`Shared market-data cache refresh timed out for ${symbol}; loading independently.`);
    return loadResult();
  }

  try {
    const cachedResult = await redis.get(cacheKey);
    if (cachedResult !== null) return cachedResult;

    const result = await loadResult();
    try {
      await redis.set(cacheKey, result, {
        ex: getMarketResultCacheTtlSeconds(result)
      });
    } catch (error) {
      console.error('Unable to write shared market-data cache:', error.message);
    }
    return result;
  } finally {
    try {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [lockKey],
        [lockToken]
      );
    } catch (error) {
      console.error('Unable to release shared market-data cache lock:', error.message);
    }
  }
}

function getMarketResultCacheTtlSeconds(result) {
  const latest15mCandleClosedAt = result.candleClosedAtByTimeframe?.['15'] ?? result.candleClosedAt;
  if (!Number.isFinite(latest15mCandleClosedAt)) return 30;

  const nextCandleCloseAt = latest15mCandleClosedAt + (BASE_INTERVAL_SECONDS * 1000);
  const untilNextCloseSeconds = Math.ceil((nextCandleCloseAt - Date.now()) / 1000);
  return Math.max(30, untilNextCloseSeconds);
}

async function verifyMarketResult(result, { symbol, timeframe, cryptoSymbols, finnHubApiKey }) {
  const isCrypto = cryptoSymbols.has(symbol);
  const checkProvider = 'Finnhub';

  result.marketSources = [{ provider: result.provider, price: result.price, candleClosedAt: result.candleClosedAt }];
  if (!finnHubApiKey) {
    result.sourceVerification = {
      status: 'unavailable',
      reason: 'Finnhub is unavailable because FINNHUB_API_KEY is not configured.'
    };
    return result;
  }

  try {
    const comparison = await getFinnhubResult(symbol, isCrypto, finnHubApiKey, timeframe);
    result.marketSources.push({
      provider: comparison.provider,
      price: comparison.price,
      candleClosedAt: comparison.candleClosedAt
    });
    if (comparison.candleClosedAt !== result.candleClosedAt) {
      result.sourceVerification = {
        status: 'unaligned',
        reason: 'The feeds do not report the same completed candle.'
      };
      return result;
    }

    const midpoint = (Math.abs(result.price) + Math.abs(comparison.price)) / 2;
    const discrepancyPercent = midpoint === 0
      ? 0
      : (Math.abs(result.price - comparison.price) / midpoint) * 100;
    const thresholdPercent = isCrypto ? 1 : 0.5;
    result.sourceVerification = {
      status: discrepancyPercent > thresholdPercent ? 'discrepancy' : 'verified',
      discrepancyPercent,
      thresholdPercent,
      reason: discrepancyPercent > thresholdPercent
        ? `${checkProvider} differs by ${discrepancyPercent.toFixed(3)}%, above the ${thresholdPercent}% limit.`
        : null
    };
  } catch (error) {
    result.marketSources.push({ provider: checkProvider, error: error.message });
    result.sourceVerification = {
      status: 'unavailable',
      reason: `${checkProvider} comparison unavailable: ${error.message}`
    };
  }

  return result;
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
        close: Number(value.close),
        volume: Number(value.volume)
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
    close: Number(close),
    volume: Number(data.v?.[index])
  }));
  return createMarketResult(symbol, candles, 'Finnhub', timeframe);
}

async function getYahooFinanceResult(symbol, isCrypto, timeframe, req) {
  const baseUrl = getInternalApiBaseUrl(req);
  const url = new URL('/api/yfinance', baseUrl);
  url.search = new URLSearchParams({
    symbols: symbol,
    ...(isCrypto ? { cryptoSymbols: symbol } : {})
  }).toString();

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const payload = await readProviderJson(response, 'Yahoo Finance (yfinance)');
  const result = payload.results?.find(item => item.symbol === symbol);
  if (!result || result.error || !Array.isArray(result.candles)) {
    throw new Error(result?.error || 'No candle data was returned for this symbol.');
  }

  return createMarketResult(
    symbol,
    result.candles.map(candle => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume)
    })),
    'Yahoo Finance (yfinance)',
    timeframe,
    result.currency || 'USD'
  );
}

async function getStockDataResult(symbol, apiToken, timeframe) {
  const url = new URL('https://api.stockdata.org/v1/data/intraday');
  const today = new Date();
  const dateFrom = new Date(today.getTime() - (7 * 24 * 60 * 60 * 1000));
  url.search = new URLSearchParams({
    symbols: symbol,
    interval: 'minute',
    sort: 'asc',
    date_from: dateFrom.toISOString().slice(0, 10),
    date_to: today.toISOString().slice(0, 10),
    extended_hours: 'false',
    api_token: apiToken
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const data = await readProviderJson(response, 'StockData.org');
  if (!Array.isArray(data.data) || data.data.length === 0) {
    throw new Error(data.message || `No intraday stock candles were returned for ${symbol}.`);
  }

  const minuteCandles = data.data.map(item => ({
    time: parseProviderDate(item.date),
    open: Number(item.data?.open),
    high: Number(item.data?.high),
    low: Number(item.data?.low),
    close: Number(item.data?.close),
    volume: Number(item.data?.volume)
  }));
  return createMarketResult(
    symbol,
    aggregateMinuteCandles(minuteCandles),
    'StockData.org',
    timeframe,
    'USD'
  );
}

async function getFinageResult(symbol, isCrypto, apiKey, timeframe) {
  const assetClass = isCrypto ? 'crypto' : symbol.includes('/') ? 'forex' : 'stock';
  const finageSymbol = symbol.replace('/', '');
  const { from, to } = getProviderDateRange();
  const url = new URL(
    `https://api.finage.co.uk/agg/${assetClass}/${encodeURIComponent(finageSymbol)}/15/minute/${from}/${to}`
  );
  url.search = new URLSearchParams({ apikey: apiKey }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const data = await readProviderJson(response, 'Finage');
  if (!Array.isArray(data.results)) {
    throw new Error(data.message || `No intraday candles were returned for ${finageSymbol}.`);
  }
  const candles = data.results.map(candle => ({
    time: normalizeProviderTimestamp(candle.t),
    open: Number(candle.o),
    high: Number(candle.h),
    low: Number(candle.l),
    close: Number(candle.c),
    volume: Number(candle.v)
  }));
  return createMarketResult(symbol, candles, 'Finage', timeframe, getSymbolCurrency(symbol));
}

async function getFmpResult(symbol, apiKey, timeframe) {
  const { from, to } = getProviderDateRange();
  const fmpSymbol = symbol.replace('/', '');
  const url = new URL('https://financialmodelingprep.com/stable/historical-chart/15min');
  url.search = new URLSearchParams({
    symbol: fmpSymbol,
    from,
    to,
    apikey: apiKey
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const data = await readProviderJson(response, 'Financial Modeling Prep');
  if (!Array.isArray(data) || data.length === 0) {
    const message = data && typeof data === 'object' ? data.message || data.error : null;
    throw new Error(message || `No intraday candles were returned for ${fmpSymbol}.`);
  }
  const candles = data.map(candle => ({
    time: parseProviderDate(candle.date),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume)
  }));
  return createMarketResult(
    symbol,
    candles,
    'Financial Modeling Prep',
    timeframe,
    getSymbolCurrency(symbol)
  );
}

async function getCoinbaseResult(symbol, timeframe) {
  const product = toExchangeProduct(symbol);
  const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`);
  url.search = new URLSearchParams({ granularity: String(BASE_INTERVAL_SECONDS) }).toString();
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(7000)
  });
  const data = await readProviderJson(response, 'Coinbase');
  if (!Array.isArray(data)) throw new Error('No public candle history was returned.');
  const candles = data.map(candle => {
    if (!Array.isArray(candle) || candle.length < 6) return null;
    const [time, low, high, open, close, volume] = candle;
    return {
      time: Number(time),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    };
  }).filter(Boolean);
  return createMarketResult(symbol, candles, 'Coinbase', timeframe, product.split('-').at(-1));
}

async function getKrakenResult(symbol, timeframe) {
  const pair = toKrakenPair(symbol);
  const url = new URL('https://api.kraken.com/0/public/OHLC');
  url.search = new URLSearchParams({ pair, interval: '15' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const data = await readProviderJson(response, 'Kraken');
  if (data.error?.length) throw new Error(data.error.join('; '));
  const resultKey = Object.keys(data.result || {}).find(key => key !== 'last');
  const bars = resultKey ? data.result[resultKey] : null;
  if (!Array.isArray(bars)) throw new Error(`No public candle history was returned for ${pair}.`);
  const candles = bars.map(candle => ({
    time: Number(candle[0]),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[6])
  }));
  return createMarketResult(symbol, candles, 'Kraken', timeframe, pair.slice(-3));
}

async function getBinanceResult(symbol, timeframe) {
  const exchangeSymbol = toBinanceSymbol(symbol);
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.search = new URLSearchParams({
    symbol: exchangeSymbol,
    interval: '15m',
    limit: '150'
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const data = await readProviderJson(response, 'Binance');
  if (!Array.isArray(data)) throw new Error(data.msg || `No public candle history was returned for ${exchangeSymbol}.`);
  const candles = data.map(candle => ({
    time: Number(candle[0]) / 1000,
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5])
  }));
  return createMarketResult(symbol, candles, 'Binance', timeframe, 'USDT');
}

function toExchangeProduct(symbol) {
  const parts = symbol.includes('/')
    ? symbol.split('/')
    : symbol.split('-');
  if (parts.length !== 2 || parts.some(part => !/^[A-Z0-9]{2,10}$/.test(part))) {
    throw new Error(`No Coinbase USD spot product mapping is available for ${symbol}.`);
  }
  return `${parts[0]}-${parts[1]}`;
}

function toKrakenPair(symbol) {
  const [base, quote] = symbol.includes('/') ? symbol.split('/') : symbol.split('-');
  if (!base || !quote || !/^[A-Z0-9]{2,10}$/.test(base) || !/^[A-Z0-9]{2,10}$/.test(quote)) {
    throw new Error(`No Kraken USD spot pair mapping is available for ${symbol}.`);
  }
  const krakenBase = { BTC: 'XBT', DOGE: 'XDG' }[base] || base;
  return `${krakenBase}${quote}`;
}

function toBinanceSymbol(symbol) {
  const parts = symbol.includes('/')
    ? symbol.split('/')
    : symbol.split('-');
  if (parts.length !== 2 || parts.some(part => !/^[A-Z0-9]{2,10}$/.test(part))) {
    throw new Error(`No Binance spot symbol mapping is available for ${symbol}.`);
  }
  return `${parts[0]}${parts[1]}`;
}

function getProviderDateRange() {
  const now = new Date();
  const from = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
  return {
    from: from.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10)
  };
}

function getSymbolCurrency(symbol) {
  return symbol.includes('/') ? symbol.split('/').at(-1) : 'USD';
}

function normalizeProviderTimestamp(timestamp) {
  const value = Number(timestamp);
  return value > 1e12 ? value / 1000 : value;
}

function aggregateMinuteCandles(candles) {
  const buckets = new Map();
  candles.forEach(candle => {
    if (!Number.isFinite(candle.time) ||
        ![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;
    const bucketTime = Math.floor(candle.time / BASE_INTERVAL_SECONDS) * BASE_INTERVAL_SECONDS;
    const bucket = buckets.get(bucketTime) || [];
    bucket.push(candle);
    buckets.set(bucketTime, bucket);
  });
  return [...buckets.entries()]
    .map(([time, bucket]) => {
      const ordered = bucket.sort((first, second) => first.time - second.time);
      return {
        time,
        open: ordered[0].open,
        high: Math.max(...ordered.map(candle => candle.high)),
        low: Math.min(...ordered.map(candle => candle.low)),
        close: ordered.at(-1).close,
        volume: ordered.every(candle => Number.isFinite(candle.volume))
          ? ordered.reduce((total, candle) => total + candle.volume, 0)
          : null
      };
    })
    .sort((first, second) => first.time - second.time);
}

function getInternalApiBaseUrl(req) {
  if (process.env.VERCEL_URL) {
    const configuredHost = process.env.VERCEL_URL.replace(/^https?:\/\//, '');
    const protocol = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(configuredHost)
      ? 'http'
      : 'https';
    return `${protocol}://${configuredHost}`;
  }
  const host = req.headers?.host;
  if (typeof host !== 'string' ||
      !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) {
    throw new Error('The yfinance fallback requires VERCEL_URL or a local Vercel development server.');
  }
  return `http://${host}`;
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
      ? data.message || data.error || data.msg || data.errorMessage || data.errorCode
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
  const diagnosticsByTimeframe = Object.fromEntries(
    Object.entries(candlesByTimeframe).map(([minutes, bars]) => [
      minutes,
      calculateMarketDiagnostics(bars, atrByTimeframe[minutes], strategyIndicatorsByTimeframe[minutes])
    ])
  );
  const backtestByTimeframe = Object.fromEntries(
    Object.entries(candlesByTimeframe).map(([minutes, bars]) => [minutes, backtestStrategies(bars)])
  );
  return {
    symbol,
    price: last.close,
    candleClose: candleCloseByTimeframe[timeframe],
    candleCloseByTimeframe,
    candleClosedAtByTimeframe,
    currency: currency || (symbol.includes('/') ? symbol.split('/').pop() : 'USD'),
    changePercent: previous.close === 0 ? null : ((last.close - previous.close) / previous.close) * 100,
    rsi15: rsiByTimeframe[15],
    rsi30: rsiByTimeframe[30],
    rsi45: rsiByTimeframe[45],
    rsiByTimeframe,
    strategyRsi: rsiByTimeframe[timeframe],
    strategyIndicators: strategyIndicatorsByTimeframe[timeframe],
    strategyIndicatorsByTimeframe,
    recentClosedCandles: selectedCandles.slice(-13).map(candle => ({
      time: (candle.time + (Number(timeframe) * 60)) * 1000,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    })),
    atr: atrByTimeframe[timeframe],
    atrByTimeframe,
    marketDiagnostics: diagnosticsByTimeframe[timeframe],
    marketDiagnosticsByTimeframe: diagnosticsByTimeframe,
    backtestByTimeframe,
    calibrationDate: last ? new Date((last.time + (Number(timeframe) * 60)) * 1000).toISOString() : null,
    marketSources: [provider],
    candleClosedAt: candleClosedAtByTimeframe[timeframe],
    provider
  };
}

function calculateMarketDiagnostics(candles, atr, indicators) {
  const latest = candles.at(-1);
  if (!latest) return null;

  const atrPercent = Number.isFinite(atr) && latest.close !== 0 ? (atr / latest.close) * 100 : null;
  const trueRanges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close)
  ));
  const previousRanges = trueRanges.slice(-21, -1).sort((first, second) => first - second);
  const middleRangeIndex = Math.floor(previousRanges.length / 2);
  const medianTrueRange = previousRanges.length === 0
    ? null
    : previousRanges.length % 2
      ? previousRanges[middleRangeIndex]
      : (previousRanges[middleRangeIndex - 1] + previousRanges[middleRangeIndex]) / 2;
  const latestTrueRange = trueRanges.at(-1) ?? null;
  const spikeRatio = Number.isFinite(medianTrueRange) && medianTrueRange > 0
    ? latestTrueRange / medianTrueRange
    : null;
  const priorVolumes = candles.slice(-21, -1)
    .map(candle => candle.volume)
    .filter(volume => Number.isFinite(volume) && volume >= 0);
  const averageVolume = priorVolumes.length
    ? priorVolumes.reduce((total, volume) => total + volume, 0) / priorVolumes.length
    : null;
  const volumeRatio = Number.isFinite(latest.volume) && Number.isFinite(averageVolume) && averageVolume > 0
    ? latest.volume / averageVolume
    : null;
  const recentCandles = candles.slice(-21, -1);
  const support = recentCandles.length ? Math.min(...recentCandles.map(candle => candle.low)) : null;
  const resistance = recentCandles.length ? Math.max(...recentCandles.map(candle => candle.high)) : null;
  const volatile = Number.isFinite(spikeRatio) && spikeRatio > 3;
  const quiet = Number.isFinite(atrPercent) && atrPercent < 0.02;
  const trending = indicators &&
    ((indicators.ema9 > indicators.ema21 && indicators.macd > indicators.macdSignal) ||
      (indicators.ema9 < indicators.ema21 && indicators.macd < indicators.macdSignal));
  const trendDirection = indicators &&
    indicators.ema9 > indicators.ema21 &&
    indicators.macd > indicators.macdSignal
    ? 'BULLISH'
    : indicators &&
      indicators.ema9 < indicators.ema21 &&
      indicators.macd < indicators.macdSignal
      ? 'BEARISH'
      : 'NEUTRAL';

  return {
    regime: volatile ? 'Volatile' : quiet ? 'Quiet' : trending ? 'Trending' : 'Ranging',
    trendDirection,
    atrPercent,
    minimumAtrPercent: 0.02,
    lowVolatility: quiet,
    latestTrueRange,
    medianTrueRange,
    spikeRatio,
    erraticSpike: volatile,
    latestVolume: Number.isFinite(latest.volume) ? latest.volume : null,
    averageVolume,
    volumeRatio,
    volumeAvailable: Number.isFinite(volumeRatio),
    lowVolume: Number.isFinite(volumeRatio) && volumeRatio < 0.5,
    support,
    resistance
  };
}

function backtestStrategies(candles) {
  const strategies = {
    trendFollowing: { closedTrades: 0, wins: 0, losses: 0, netR: 0 },
    rsi: { closedTrades: 0, wins: 0, losses: 0, netR: 0 },
    emaMacd: { closedTrades: 0, wins: 0, losses: 0, netR: 0 },
    bollingerRsi: { closedTrades: 0, wins: 0, losses: 0, netR: 0 }
  };

  for (let index = 35; index < candles.length - 1; index++) {
    const history = candles.slice(0, index + 1);
    const closes = history.map(candle => candle.close);
    const rsi = calculateRSI(closes);
    const indicators = calculateStrategyIndicators(closes);
    const atr = calculateATR(history);
    if (!indicators || !Number.isFinite(rsi) || !Number.isFinite(atr) || atr <= 0) continue;

    const signals = {
      trendFollowing: indicators.ema9 > indicators.ema21 &&
        indicators.macd > indicators.macdSignal && rsi > 50
        ? 1
        : indicators.ema9 < indicators.ema21 &&
          indicators.macd < indicators.macdSignal && rsi < 50 ? -1 : 0,
      rsi: rsi <= 30 ? 1 : rsi >= 70 ? -1 : 0,
      emaMacd: indicators.previousEma9 <= indicators.previousEma21 &&
        indicators.ema9 > indicators.ema21 && indicators.macd > indicators.macdSignal
        ? 1
        : indicators.previousEma9 >= indicators.previousEma21 &&
          indicators.ema9 < indicators.ema21 && indicators.macd < indicators.macdSignal ? -1 : 0,
      bollingerRsi: closes.at(-1) <= indicators.lowerBand && rsi <= 30
        ? 1
        : closes.at(-1) >= indicators.upperBand && rsi >= 70 ? -1 : 0
    };

    Object.entries(signals).forEach(([strategy, direction]) => {
      if (!direction) return;
      const entry = candles[index].close;
      const risk = atr * 1.5;
      const stop = entry - (direction * risk);
      const target = entry + (direction * risk * 2);
      let outcome = null;

      for (const candle of candles.slice(index + 1, index + 13)) {
        const stopHit = direction > 0 ? candle.low <= stop : candle.high >= stop;
        const targetHit = direction > 0 ? candle.high >= target : candle.low <= target;
        if (stopHit || targetHit) {
          outcome = targetHit && !stopHit ? 2 : -1;
          break;
        }
      }

      if (outcome === null) {
        const exit = candles[Math.min(index + 12, candles.length - 1)].close;
        outcome = (direction * (exit - entry)) / risk;
      }
      const stats = strategies[strategy];
      stats.closedTrades++;
      stats.netR += outcome;
      if (outcome > 0) stats.wins++;
      else stats.losses++;
    });
  }

  return Object.fromEntries(Object.entries(strategies).map(([strategy, stats]) => [
    strategy,
    {
      ...stats,
      netR: Number(stats.netR.toFixed(3)),
      winRatePercent: stats.closedTrades ? (stats.wins / stats.closedTrades) * 100 : null
    }
  ]));
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
      close: bucket[bucket.length - 1].close,
      volume: bucket.every(candle => Number.isFinite(candle.volume))
        ? bucket.reduce((total, candle) => total + candle.volume, 0)
        : null
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
