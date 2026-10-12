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
