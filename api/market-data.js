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
  const oandaApiToken = process.env.OANDA_API_TOKEN;
  const oandaAccountId = process.env.OANDA_ACCOUNT_ID;

  try {
    const results = await Promise.all(symbols.map(async symbol => {
      try {
        if (!twelveDataKey) throw new Error('TWELVE_DATA_API_KEY is not configured.');
        return await verifyMarketResult(
          await getTwelveDataResult(symbol, twelveDataKey, timeframe),
          { symbol, timeframe, cryptoSymbols, finnHubApiKey, oandaApiToken, oandaAccountId }
        );
      } catch (primaryError) {
        let keylessCryptoError = null;
        if (cryptoSymbols.has(symbol)) {
          try {
            return await verifyMarketResult(
              await getKeylessCryptoResult(symbol, timeframe),
              {
                symbol,
                timeframe,
                cryptoSymbols,
                finnHubApiKey,
                oandaApiToken,
                oandaAccountId,
                failedProviders: new Set(['Twelve Data'])
              }
            );
          } catch (error) {
            keylessCryptoError = error;
          }
        }

        const errors = [`Twelve Data: ${primaryError.message}`];
        if (keylessCryptoError) errors.push(`Binance/Coinbase: ${keylessCryptoError.message}`);

        if (finnHubApiKey) {
          try {
            return await verifyMarketResult(
              await getFinnhubResult(symbol, cryptoSymbols.has(symbol), finnHubApiKey, timeframe),
              {
                symbol,
                timeframe,
                cryptoSymbols,
                finnHubApiKey,
                oandaApiToken,
                oandaAccountId,
                failedProviders: new Set([
                  'Twelve Data',
                  ...(keylessCryptoError ? ['Binance', 'Coinbase'] : [])
                ])
              }
            );
          } catch (fallbackError) {
            errors.push(`Finnhub: ${fallbackError.message}`);
          }
        }

        if (symbol === 'XAG/USD') {
          if (!oandaApiToken || !oandaAccountId) {
            errors.push('OANDA: configure OANDA_API_TOKEN and OANDA_ACCOUNT_ID for the XAG/USD candle fallback.');
          } else {
            try {
              return await verifyMarketResult(
                await getOandaResult(symbol, oandaApiToken, oandaAccountId, timeframe),
                {
                  symbol,
                  timeframe,
                  cryptoSymbols,
                  finnHubApiKey,
                  oandaApiToken,
                  oandaAccountId,
                  failedProviders: new Set(['Twelve Data', 'Finnhub'])
                }
              );
            } catch (fallbackError) {
              errors.push(`OANDA: ${fallbackError.message}`);
            }
          }
        }

        try {
          return await verifyMarketResult(
            await getYahooFinanceResult(symbol, cryptoSymbols.has(symbol), timeframe),
            {
              symbol,
              timeframe,
              cryptoSymbols,
              finnHubApiKey,
              oandaApiToken,
              oandaAccountId,
              failedProviders: new Set([
                'Twelve Data',
                ...(finnHubApiKey ? ['Finnhub'] : []),
                ...(symbol === 'XAG/USD' && oandaApiToken && oandaAccountId ? ['OANDA'] : []),
                ...(cryptoSymbols.has(symbol) ? ['Binance', 'Coinbase'] : [])
              ])
            }
          );
        } catch (fallbackError) {
          errors.push(`Yahoo Finance: ${fallbackError.message}`);
        }

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
    const result = await getCoinbaseResult(symbol, timeframe);
    result.failedProviders = ['Binance'];
    return result;
  } catch (error) {
    throw new Error(`Binance: ${binanceError.message} Coinbase: ${error.message}`);
  }
}

async function verifyMarketResult(result, {
  symbol,
  timeframe,
  cryptoSymbols,
  finnHubApiKey,
  oandaApiToken,
  oandaAccountId,
  failedProviders: previouslyFailedProviders = []
}) {
  const isCrypto = cryptoSymbols.has(symbol);
  const failedProviders = new Set([
    ...(result.failedProviders || []),
    ...previouslyFailedProviders
  ]);
  delete result.failedProviders;
  let checkProvider;
  let loadCheck;

  if (isCrypto) {
    if (result.provider === 'Binance') {
      checkProvider = 'Coinbase';
      if (!failedProviders.has(checkProvider)) loadCheck = () => getCoinbaseResult(symbol, timeframe);
    } else {
      checkProvider = 'Binance';
      if (!failedProviders.has(checkProvider)) loadCheck = () => getBinanceResult(symbol, timeframe);
    }
  } else if (finnHubApiKey && result.provider !== 'Finnhub' && !failedProviders.has('Finnhub')) {
    checkProvider = 'Finnhub';
    loadCheck = () => getFinnhubResult(symbol, false, finnHubApiKey, timeframe);
  } else if (
    symbol === 'XAG/USD' &&
    oandaApiToken &&
    oandaAccountId &&
    result.provider !== 'OANDA' &&
    !failedProviders.has('OANDA')
  ) {
    checkProvider = 'OANDA';
    loadCheck = () => getOandaResult(symbol, oandaApiToken, oandaAccountId, timeframe);
  } else if (result.provider !== 'Yahoo Finance' && !failedProviders.has('Yahoo Finance')) {
    checkProvider = 'Yahoo Finance';
    loadCheck = () => getYahooFinanceResult(symbol, false, timeframe);
  }

  result.marketSources = [{ provider: result.provider, price: result.price, candleClosedAt: result.candleClosedAt }];
  if (!loadCheck) {
    result.sourceVerification = {
      status: 'unavailable',
      reason: 'No independent free comparison feed is available for this symbol.'
    };
    return result;
  }

  try {
    const comparison = await loadCheck();
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
    volume: Number(candle[5]),
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
    close: Number(candle[4]),
    volume: Number(candle[5])
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

async function getOandaResult(symbol, apiToken, accountId, timeframe) {
  const environment = process.env.OANDA_API_ENVIRONMENT || 'practice';
  const host = environment === 'practice'
    ? 'api-fxpractice.oanda.com'
    : environment === 'live' ? 'api-fxtrade.oanda.com' : null;
  if (!host) throw new Error('OANDA_API_ENVIRONMENT must be "practice" or "live".');

  const instrument = symbol.replace('/', '_');
  const url = new URL(`https://${host}/v3/accounts/${encodeURIComponent(accountId)}/instruments/${encodeURIComponent(instrument)}/candles`);
  url.search = new URLSearchParams({
    granularity: 'M15',
    count: '150',
    price: 'M'
  }).toString();

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`
    }
  });
  const data = await readProviderJson(response, 'OANDA');
  if (!Array.isArray(data.candles)) throw new Error('Provider returned an invalid candle response.');

  const candles = data.candles.map(candle => ({
    time: parseProviderDate(candle.time),
    open: Number(candle.mid?.o),
    high: Number(candle.mid?.h),
    low: Number(candle.mid?.l),
    close: Number(candle.mid?.c),
    closed: candle.complete
  }));
  return createMarketResult(symbol, candles, 'OANDA', timeframe, 'USD');
}

async function getYahooFinanceResult(symbol, isCrypto, timeframe) {
  const ticker = getYahooFinanceSymbol(symbol, isCrypto);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.search = new URLSearchParams({
    range: '5d',
    interval: '15m',
    includePrePost: 'false'
  }).toString();

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0'
    }
  });
  const data = await readProviderJson(response, 'Yahoo Finance');
  const result = data.chart?.result?.[0];
  if (!result || data.chart?.error) {
    throw new Error(data.chart?.error?.description || `No candle data for ${ticker}.`);
  }

  const quote = result.indicators?.quote?.[0];
  if (!quote || !Array.isArray(result.timestamp)) {
    throw new Error('Provider returned an invalid candle response.');
  }

  const candles = result.timestamp.map((time, index) => ({
    time: Number(time),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index])
  }));
  return createMarketResult(symbol, candles, 'Yahoo Finance', timeframe, result.meta?.currency);
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

function getYahooFinanceSymbol(symbol, isCrypto) {
  if (isCrypto && symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `${base}-${quote}`;
  }
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `${base}${quote}=X`;
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
