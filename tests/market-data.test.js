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

test('market-data endpoint rejects invalid symbols and unsupported methods', async () => {
  const invalidResponse = createResponse();
  await handler({ method: 'GET', query: { symbols: 'bad symbol', timeframe: '15' } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);

  const methodResponse = createResponse();
  await handler({ method: 'POST', query: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(methodResponse.headers.Allow, 'GET');
});

test('keyless crypto fallback returns closed candles and neutral RSI for flat prices', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  delete process.env.TWELVE_DATA_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const candles = Array.from({ length: 150 }, (_, index) => {
    const openTime = currentInterval - ((150 - index) * 900000);
    return [openTime, '100', '100', '100', '100', '100', openTime + 899999];
  });
  globalThis.fetch = async () => new Response(JSON.stringify(candles), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'BTC/USD', cryptoSymbols: 'BTC/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].provider, 'Binance');
    assert.equal(response.body.results[0].rsi15, 50);
    assert.ok(response.body.results[0].candleClosedAt < Date.now());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});

test('silver uses the configured spot-market provider instead of a futures proxy', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;
  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const values = Array.from({ length: 150 }, (_, index) => {
    const openTime = currentInterval - ((150 - index) * 900000);
    const close = 30 + (index * 0.01);
    return {
      datetime: new Date(openTime).toISOString().slice(0, 19).replace('T', ' '),
      open: String(close),
      high: String(close + 0.1),
      low: String(close - 0.1),
      close: String(close)
    };
  }).reverse();
  let requestedUrl;
  globalThis.fetch = async url => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      meta: { currency: 'USD' },
      values
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'XAG/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].provider, 'Twelve Data');
    assert.equal(response.body.results[0].currency, 'USD');
    assert.equal(requestedUrl.hostname, 'api.twelvedata.com');
    assert.equal(requestedUrl.searchParams.get('symbol'), 'XAG/USD');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});

test('Yahoo Finance supplies forex candles when the configured providers deny access', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  process.env.FINNHUB_API_KEY = 'test-key';
  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const timestamps = Array.from({ length: 150 }, (_, index) =>
    Math.floor((currentInterval - ((150 - index) * 900000)) / 1000));
  const close = timestamps.map((_, index) => 1.1 + (index * 0.0001));
  const requestedHosts = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requestedHosts.push(requestUrl.hostname);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({ message: 'Symbol requires a higher plan.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({ error: 'You do not have access to this resource.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      chart: {
        result: [{
          meta: { currency: 'USD' },
          timestamp: timestamps,
          indicators: {
            quote: [{
              open: close,
              high: close.map(price => price + 0.0001),
              low: close.map(price => price - 0.0001),
              close
            }]
          }
        }],
        error: null
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'EUR/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedHosts, [
      'api.twelvedata.com',
      'finnhub.io',
      'query1.finance.yahoo.com'
    ]);
    assert.equal(response.body.results[0].provider, 'Yahoo Finance');
    assert.ok(Number.isFinite(response.body.results[0].price));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});

test('spot metals never fall back to Yahoo futures', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  process.env.FINNHUB_API_KEY = 'test-key';
  const requestedHosts = [];
  globalThis.fetch = async url => {
    requestedHosts.push(new URL(url).hostname);
    return new Response(JSON.stringify({ error: 'Access denied.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'XAU/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedHosts, ['api.twelvedata.com', 'finnhub.io']);
    assert.match(response.body.results[0].error, /Twelve Data/);
    assert.match(response.body.results[0].error, /Finnhub/);
    assert.doesNotMatch(response.body.results[0].error, /Yahoo Finance/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});
