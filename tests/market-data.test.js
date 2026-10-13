import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/market-data.js';

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createCandles() {
  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  return Array.from({ length: 150 }, (_, index) => {
    const time = currentInterval - ((150 - index) * 900000);
    const close = 100 + index * 0.01;
    return {
      time: Math.floor(time / 1000),
      datetime: new Date(time).toISOString().replace('T', ' ').slice(0, 19),
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 500
    };
  });
}

function twelveDataResponse(candles) {
  return {
    meta: { currency: 'USD' },
    values: candles.slice().reverse().map(candle => ({
      datetime: candle.datetime,
      open: String(candle.open),
      high: String(candle.high),
      low: String(candle.low),
      close: String(candle.close),
      volume: String(candle.volume)
    }))
  };
}

function finnhubResponse(candles, { offset = 0 } = {}) {
  return {
    s: 'ok',
    t: candles.map(candle => candle.time),
    o: candles.map(candle => candle.open + offset),
    h: candles.map(candle => candle.high + offset),
    l: candles.map(candle => candle.low + offset),
    c: candles.map(candle => candle.close + offset),
    v: candles.map(candle => candle.volume)
  };
}

test('market-data endpoint rejects invalid symbols and unsupported methods', async () => {
  const invalidResponse = createResponse();
  await handler({ method: 'GET', query: { symbols: 'bad symbol', timeframe: '15' } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);

  const methodResponse = createResponse();
  await handler({ method: 'POST', query: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(methodResponse.headers.Allow, 'GET');
});

test('Twelve Data is cross-checked with Finnhub on traditional and crypto assets', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  const candles = createCandles();
  const requests = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify(twelveDataResponse(candles)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify(finnhubResponse(candles)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected market-data provider: ${requestUrl.hostname}`);
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'EUR/USD,BTC/USD', cryptoSymbols: 'BTC/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.results.length, 2);
    for (const result of response.body.results) {
      assert.equal(result.provider, 'Twelve Data');
      assert.equal(result.sourceVerification.status, 'verified');
      assert.deepEqual(result.marketSources.map(source => source.provider), ['Twelve Data', 'Finnhub']);
      assert.equal(result.rsi15, 100);
      assert.ok(result.candleClosedAt < Date.now());
    }
    assert.deepEqual(requests.map(url => url.hostname), [
      'api.twelvedata.com',
      'api.twelvedata.com',
      'finnhub.io',
      'finnhub.io'
    ]);
    const cryptoRequest = requests.find(url => url.hostname === 'finnhub.io' && url.searchParams.get('symbol') === 'BINANCE:BTCUSDT');
    assert.ok(cryptoRequest);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});

test('Upstash shared cache reuses market results until the next closed 15m candle', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalFinageApiKey = process.env.FINAGE_API_KEY;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  delete process.env.FINNHUB_API_KEY;
  process.env.FINAGE_API_KEY = 'test-finage-key';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token';
  const candles = createCandles();
  const redisValues = new Map();
  const redisCommands = [];
  const providerRequests = [];

  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = new URL(input);
    if (requestUrl.hostname === 'redis.test') {
      const commands = JSON.parse(init.body);
      const results = commands.map(command => {
        redisCommands.push(command);
        const [operation, ...args] = command;
        if (operation === 'get') return { result: redisValues.get(args[0]) ?? null };
        if (operation === 'set') {
          const [key, value, ...options] = args;
          if (options.includes('nx') && redisValues.has(key)) return { result: null };
          redisValues.set(key, value);
          return { result: 'OK' };
        }
        if (operation === 'eval') {
          const [script, keyCount, key, token] = args;
          assert.equal(Number(keyCount), 1);
          if (script.includes('redis.call("del"') && redisValues.get(key) === token) {
            redisValues.delete(key);
            return { result: 1 };
          }
          return { result: 0 };
        }
        throw new Error(`Unexpected Redis command: ${operation}`);
      });
      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    providerRequests.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({ message: 'Provider unavailable.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'api.finage.co.uk') {
      return new Response(JSON.stringify({
        results: candles.map(candle => ({
          t: candle.time * 1000,
          o: candle.open,
          h: candle.high,
          l: candle.low,
          c: candle.close,
          v: candle.volume
        }))
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected market-data provider: ${requestUrl.hostname}`);
  };

  try {
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    await Promise.all([
      handler({
        method: 'GET',
        query: { symbols: 'CAD/JPY', timeframe: '15' }
      }, firstResponse),
      handler({
        method: 'GET',
        query: { symbols: 'CAD/JPY', timeframe: '15' }
      }, secondResponse)
    ]);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.deepEqual(secondResponse.body.results, firstResponse.body.results);
    assert.equal(providerRequests.filter(url => url.hostname === 'api.finage.co.uk').length, 1);
    assert.ok(redisCommands.some(command =>
      command[0] === 'set' &&
      command[1] === 'market-data:v1:CAD/JPY:15:other' &&
      command.includes('ex')
    ));
    assert.ok(redisCommands.some(command =>
      command[0] === 'set' &&
      command[1] === 'market-data:v1:CAD/JPY:15:other:refresh-lock' &&
      command.includes('nx')
    ));
    assert.ok(redisCommands.some(command =>
      command[0] === 'get' &&
      command[1] === 'market-data:v1:CAD/JPY:15:other'
    ));
    assert.equal(JSON.stringify(secondResponse.body).includes('test-redis-token'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalFinageApiKey === undefined) delete process.env.FINAGE_API_KEY;
    else process.env.FINAGE_API_KEY = originalFinageApiKey;
    if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  }
});

test('Finnhub serves as fallback for all assets when Twelve Data fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  const candles = createCandles();
  const requests = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({ message: 'Plan restricted.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify(finnhubResponse(candles)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected market-data provider: ${requestUrl.hostname}`);
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'XAG/USD,AUD/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    for (const result of response.body.results) {
      assert.equal(result.provider, 'Finnhub');
      assert.equal(result.sourceVerification.status, 'unavailable');
      assert.match(result.sourceVerification.reason, /Twelve Data failed/i);
      assert.deepEqual(result.marketSources.map(source => source.provider), ['Twelve Data', 'Finnhub']);
      assert.equal(result.candleClosedAt < Date.now(), true);
    }
    assert.deepEqual(requests.map(url => url.hostname), [
      'api.twelvedata.com',
      'api.twelvedata.com',
      'finnhub.io',
      'finnhub.io'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});

test('Yahoo Finance via yfinance serves as fallback for traditional markets when keyed feeds fail', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalVercelUrl = process.env.VERCEL_URL;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  delete process.env.VERCEL_URL;
  const candles = createCandles();
  const requests = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com' || requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({ message: 'Provider unavailable.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.pathname === '/api/yfinance') {
      assert.equal(requestUrl.searchParams.get('symbols'), 'NZD/USD');
      assert.equal(requestUrl.searchParams.get('cryptoSymbols'), null);
      return new Response(JSON.stringify({
        results: [{
          symbol: 'NZD/USD',
          currency: 'USD',
          ticker: 'EURUSD=X',
          candles: candles.map(({ time, open, high, low, close, volume }) => ({
            time,
            open,
            high,
            low,
            close,
            volume
          }))
        }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected market-data provider: ${requestUrl.hostname}`);
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      headers: { host: 'localhost:3000' },
      query: { symbols: 'NZD/USD', timeframe: '15' }
    }, response);

    const result = response.body.results[0];
    assert.equal(response.statusCode, 200);
    assert.equal(result.provider, 'Yahoo Finance (yfinance)');
    assert.equal(result.sourceVerification.status, 'unavailable');
    assert.equal(result.price, candles.at(-1).close);
    assert.deepEqual(result.marketSources.map(source => source.provider), [
      'Twelve Data',
      'Finnhub',
      'Yahoo Finance (yfinance)'
    ]);
    assert.deepEqual(requests.map(url => url.hostname), [
      'api.twelvedata.com',
      'finnhub.io',
      'localhost'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
  }
});

test('all API failures return the concise no-data message without provider details', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalFinageApiKey = process.env.FINAGE_API_KEY;
  const originalFmpApiKey = process.env.FMP_API_KEY;
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalConsoleError = console.error;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  process.env.FINAGE_API_KEY = 'test-finage-key';
  process.env.FMP_API_KEY = 'test-fmp-key';
  delete process.env.VERCEL_URL;
  const requests = [];
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    return new Response(JSON.stringify({ message: 'Access denied.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      headers: { host: 'localhost:3000' },
      query: { symbols: 'GBP/USD', timeframe: '15' }
    }, response);

    const result = response.body.results[0];
    assert.equal(result.error, 'No data found due to API.');
    assert.doesNotMatch(JSON.stringify(result), /Access denied|test-(?:twelve|finage|fmp)-key/);
    assert.deepEqual(requests.map(url => url.hostname), [
      'api.twelvedata.com',
      'finnhub.io',
      'api.finage.co.uk',
      'financialmodelingprep.com',
      'localhost'
    ]);
    assert.equal(loggedErrors.length, 1);
    assert.match(loggedErrors[0][0], /No market data found for GBP\/USD/);
    assert.deepEqual(loggedErrors[0][1], [
      'Twelve Data',
      'Finnhub',
      'Finage',
      'Financial Modeling Prep',
      'Yahoo Finance (yfinance)'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalFinageApiKey === undefined) delete process.env.FINAGE_API_KEY;
    else process.env.FINAGE_API_KEY = originalFinageApiKey;
    if (originalFmpApiKey === undefined) delete process.env.FMP_API_KEY;
    else process.env.FMP_API_KEY = originalFmpApiKey;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
  }
});

test('StockData, Finage, and FMP provide keyed candle fallbacks', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalStockDataToken = process.env.STOCKDATA_API_TOKEN;
  const originalFinageApiKey = process.env.FINAGE_API_KEY;
  const originalFmpApiKey = process.env.FMP_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  process.env.STOCKDATA_API_TOKEN = 'test-stockdata-token';
  process.env.FINAGE_API_KEY = 'test-finage-key';
  process.env.FMP_API_KEY = 'test-fmp-key';
  const candles = createCandles();
  const requests = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com' || requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({ message: 'Provider unavailable.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'api.stockdata.org') {
      assert.equal(requestUrl.pathname, '/v1/data/intraday');
      assert.equal(requestUrl.searchParams.get('symbols'), 'AAPL');
      assert.equal(requestUrl.searchParams.get('interval'), 'minute');
      assert.equal(requestUrl.searchParams.get('api_token'), 'test-stockdata-token');
      return new Response(JSON.stringify({
        data: candles.map(candle => ({
          date: new Date(candle.time * 1000).toISOString(),
          ticker: 'AAPL',
          data: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume
          }
        }))
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestUrl.hostname === 'api.finage.co.uk') {
      assert.match(requestUrl.pathname, /\/agg\/forex\/(?:CADJPY|XAUUSD)\/15\/minute\//);
      assert.equal(requestUrl.searchParams.get('apikey'), 'test-finage-key');
      if (requestUrl.pathname.includes('/CADJPY/')) {
        return new Response(JSON.stringify({
          results: candles.map(candle => ({
            t: candle.time * 1000,
            o: candle.open,
            h: candle.high,
            l: candle.low,
            c: candle.close,
            v: candle.volume
          }))
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'Plan does not include this market.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'financialmodelingprep.com') {
      assert.equal(requestUrl.pathname, '/stable/historical-chart/15min');
      assert.equal(requestUrl.searchParams.get('symbol'), 'XAUUSD');
      assert.equal(requestUrl.searchParams.get('apikey'), 'test-fmp-key');
      return new Response(JSON.stringify(candles.map(candle => ({
        date: new Date(candle.time * 1000).toISOString().replace('T', ' ').slice(0, 19),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      }))), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected market-data provider: ${requestUrl.hostname}`);
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'AAPL,CAD/JPY,XAU/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.results.map(result => result.provider), [
      'StockData.org',
      'Finage',
      'Financial Modeling Prep'
    ]);
    assert.deepEqual(response.body.results.map(result => result.price), [
      candles.at(-1).close,
      candles.at(-1).close,
      candles.at(-1).close
    ]);
    assert.deepEqual(response.body.results.map(result => result.sourceVerification.status), [
      'unavailable',
      'unavailable',
      'unavailable'
    ]);
    assert.ok(requests.some(url => url.hostname === 'api.stockdata.org'));
    assert.ok(requests.some(url => url.hostname === 'api.finage.co.uk' &&
      url.pathname.includes('/CADJPY/')));
    assert.ok(requests.some(url => url.hostname === 'api.finage.co.uk' &&
      url.pathname.includes('/XAUUSD/')));
    assert.ok(requests.some(url => url.hostname === 'financialmodelingprep.com'));
    assert.doesNotMatch(JSON.stringify(response.body), /test-(?:twelve|finnhub|stockdata|finage|fmp)-key/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalStockDataToken === undefined) delete process.env.STOCKDATA_API_TOKEN;
    else process.env.STOCKDATA_API_TOKEN = originalStockDataToken;
    if (originalFinageApiKey === undefined) delete process.env.FINAGE_API_KEY;
    else process.env.FINAGE_API_KEY = originalFinageApiKey;
    if (originalFmpApiKey === undefined) delete process.env.FMP_API_KEY;
    else process.env.FMP_API_KEY = originalFmpApiKey;
  }
});

test('free crypto exchange feeds fall back from Coinbase to Kraken to Binance', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalVercelUrl = process.env.VERCEL_URL;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  delete process.env.VERCEL_URL;
  const candles = createCandles();
  const requests = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com' || requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({ message: 'Provider unavailable.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'api.exchange.coinbase.com') {
      if (requestUrl.pathname.endsWith('/ADA-USD/candles')) {
        return new Response(JSON.stringify(candles.slice().reverse().map(candle => [
          candle.time, candle.low, candle.high, candle.open, candle.close, candle.volume
        ])), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'Product not found.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'api.kraken.com') {
      if (requestUrl.searchParams.get('pair') === 'XDGUSD') {
        return new Response(JSON.stringify({
          error: [],
          result: {
            XDGUSD: candles.map(candle => [
              candle.time, candle.open, candle.high, candle.low, candle.close,
              candle.close, candle.volume, 20
            ]),
            last: 123
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: ['Unknown asset pair'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'api.binance.com') {
      const exchangeSymbol = requestUrl.searchParams.get('symbol');
      assert.ok(['LINKUSDT', 'SOLUSD'].includes(exchangeSymbol));
      if (exchangeSymbol === 'SOLUSD') {
        return new Response(JSON.stringify({ msg: 'Unknown symbol.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(candles.map(candle => [
        candle.time * 1000, String(candle.open), String(candle.high),
        String(candle.low), String(candle.close), String(candle.volume)
      ])), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestUrl.pathname === '/api/yfinance') {
      assert.equal(requestUrl.searchParams.get('symbols'), 'SOL/USD');
      assert.equal(requestUrl.searchParams.get('cryptoSymbols'), 'SOL/USD');
      return new Response(JSON.stringify({
        results: [{
          symbol: 'SOL/USD',
          currency: 'USD',
          candles: candles.map(({ time, open, high, low, close, volume }) => ({
            time, open, high, low, close, volume
          }))
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected market-data provider: ${requestUrl.hostname}`);
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      headers: { host: 'localhost:3000' },
      query: {
        symbols: 'ADA/USD,DOGE/USD,LINK/USDT,SOL/USD',
        cryptoSymbols: 'ADA/USD,DOGE/USD,LINK/USDT,SOL/USD',
        timeframe: '15'
      }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.results.map(result => result.provider), [
      'Coinbase',
      'Kraken',
      'Binance',
      'Yahoo Finance (yfinance)'
    ]);
    assert.deepEqual(response.body.results.map(result => result.sourceVerification.status), [
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable'
    ]);
    assert.deepEqual(response.body.results.map(result => result.marketSources.at(-1).provider), [
      'Coinbase',
      'Kraken',
      'Binance',
      'Yahoo Finance (yfinance)'
    ]);
    assert.ok(requests.some(url => url.hostname === 'api.exchange.coinbase.com' &&
      url.pathname.endsWith('/ADA-USD/candles')));
    assert.ok(requests.some(url => url.hostname === 'api.kraken.com' &&
      url.searchParams.get('pair') === 'XDGUSD'));
    assert.ok(requests.some(url => url.hostname === 'api.binance.com' &&
      url.searchParams.get('symbol') === 'LINKUSDT'));
    assert.ok(requests.some(url => url.hostname === 'api.binance.com' &&
      url.searchParams.get('symbol') === 'SOLUSD'));
    assert.equal(requests.some(url => url.hostname === 'api.binance.com' &&
      url.searchParams.get('symbol') === 'SOLUSDT'), false);
    assert.equal(response.body.results[2].currency, 'USDT');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
  }
});
