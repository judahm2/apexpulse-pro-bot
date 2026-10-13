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

test('Yahoo Finance via yfinance serves as fallback when Twelve Data and Finnhub fail', async () => {
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
      assert.equal(requestUrl.searchParams.get('symbols'), 'DOGE/USD');
      assert.equal(requestUrl.searchParams.get('cryptoSymbols'), 'DOGE/USD');
      return new Response(JSON.stringify({
        results: [{
          symbol: 'DOGE/USD',
          currency: 'USD',
          ticker: 'DOGE-USD',
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
      query: { symbols: 'DOGE/USD', cryptoSymbols: 'DOGE/USD', timeframe: '15' }
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

test('market-data errors report Twelve Data, Finnhub, and yfinance failures', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalVercelUrl = process.env.VERCEL_URL;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  delete process.env.VERCEL_URL;
  const requests = [];
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
    assert.match(result.error, /Twelve Data:/);
    assert.match(result.error, /Finnhub:/);
    assert.match(result.error, /Yahoo Finance \(yfinance\):/);
    assert.doesNotMatch(result.error, /Binance|Coinbase|OANDA|Gold API/);
    assert.deepEqual(requests.map(url => url.hostname), ['api.twelvedata.com', 'finnhub.io', 'localhost']);
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
