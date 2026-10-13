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
    assert.equal(response.body.results[0].marketDiagnostics.regime, 'Quiet');
    assert.equal(response.body.results[0].marketDiagnostics.lowVolatility, true);
    assert.equal(response.body.results[0].marketDiagnostics.volumeAvailable, true);
    assert.ok(response.body.results[0].backtestByTimeframe['15'].trendFollowing);
    assert.ok(response.body.results[0].backtestByTimeframe['15'].rsi);
    assert.equal(response.body.results[0].calibrationDate, new Date(response.body.results[0].candleClosedAt).toISOString());
    assert.equal(response.body.results[0].marketSources[0].provider, 'Binance');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});

test('independent feed disagreement is reported when it exceeds the configured tolerance', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalOandaToken = process.env.OANDA_API_TOKEN;
  const originalOandaAccountId = process.env.OANDA_ACCOUNT_ID;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;
  delete process.env.OANDA_API_TOKEN;
  delete process.env.OANDA_ACCOUNT_ID;

  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const timestamps = Array.from({ length: 150 }, (_, index) =>
    Math.floor((currentInterval - ((150 - index) * 900000)) / 1000));
  const requestedUrls = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({
        meta: { currency: 'USD' },
        values: timestamps.slice().reverse().map(time => ({
          datetime: new Date(time * 1000).toISOString().replace('T', ' ').slice(0, 19),
          open: '100',
          high: '101',
          low: '99',
          close: '100',
          volume: '500'
        }))
      }), {
        status: 200,
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
              open: Array(150).fill(102),
              high: Array(150).fill(103),
              low: Array(150).fill(101),
              close: Array(150).fill(102),
              volume: Array(150).fill(500)
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
      query: { symbols: 'TEST/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    const result = response.body.results[0];
    assert.equal(result.sourceVerification.status, 'discrepancy');
    assert.ok(result.sourceVerification.discrepancyPercent > result.sourceVerification.thresholdPercent);
    assert.deepEqual(requestedUrls.map(url => url.hostname), [
      'api.twelvedata.com',
      'query1.finance.yahoo.com'
    ]);
    assert.deepEqual(result.marketSources.map(source => source.provider), ['Twelve Data', 'Yahoo Finance']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalOandaToken === undefined) delete process.env.OANDA_API_TOKEN;
    else process.env.OANDA_API_TOKEN = originalOandaToken;
    if (originalOandaAccountId === undefined) delete process.env.OANDA_ACCOUNT_ID;
    else process.env.OANDA_ACCOUNT_ID = originalOandaAccountId;
  }
});

test('silver falls back to its Yahoo spot ticker when configured providers deny access', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalOandaToken = process.env.OANDA_API_TOKEN;
  const originalOandaAccountId = process.env.OANDA_ACCOUNT_ID;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  process.env.FINNHUB_API_KEY = 'test-key';
  delete process.env.OANDA_API_TOKEN;
  delete process.env.OANDA_ACCOUNT_ID;
  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const timestamps = Array.from({ length: 150 }, (_, index) =>
    Math.floor((currentInterval - ((150 - index) * 900000)) / 1000));
  const close = timestamps.map((_, index) => 30 + (index * 0.01));
  const requestedUrls = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({
        message: 'This symbol is available starting with the Grow or Venture plan.'
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({
        error: "You don't have access to this resource."
      }), {
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
              high: close.map(price => price + 0.1),
              low: close.map(price => price - 0.1),
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
      query: { symbols: 'XAG/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].provider, 'Yahoo Finance');
    assert.equal(response.body.results[0].currency, 'USD');
    assert.deepEqual(requestedUrls.map(url => url.hostname), [
      'api.twelvedata.com',
      'finnhub.io',
      'query1.finance.yahoo.com'
    ]);
    assert.equal(decodeURIComponent(requestedUrls[2].pathname.split('/').pop()), 'XAGUSD=X');
    assert.equal(response.body.results[0].price, close.at(-1));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalOandaToken === undefined) delete process.env.OANDA_API_TOKEN;
    else process.env.OANDA_API_TOKEN = originalOandaToken;
    if (originalOandaAccountId === undefined) delete process.env.OANDA_ACCOUNT_ID;
    else process.env.OANDA_ACCOUNT_ID = originalOandaAccountId;
  }
});

test('silver returns a Gold API spot-only quote when candle feeds are unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalOandaToken = process.env.OANDA_API_TOKEN;
  const originalOandaAccountId = process.env.OANDA_ACCOUNT_ID;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  process.env.FINNHUB_API_KEY = 'test-key';
  delete process.env.OANDA_API_TOKEN;
  delete process.env.OANDA_ACCOUNT_ID;
  const updatedAt = new Date().toISOString();
  const requestedUrls = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.hostname === 'api.gold-api.com') {
      return new Response(JSON.stringify({
        symbol: 'XAG',
        currency: 'USD',
        price: 60.52,
        updatedAt
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    const status = requestUrl.hostname === 'api.twelvedata.com' ? 404
      : requestUrl.hostname === 'finnhub.io' ? 403
        : 404;
    return new Response(JSON.stringify({ message: 'Feed unavailable.' }), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'XAG/USD', timeframe: '15' }
    }, response);

    const result = response.body.results[0];
    assert.equal(response.statusCode, 200);
    assert.equal(result.provider, 'Gold API');
    assert.equal(result.spotOnly, true);
    assert.equal(result.price, 60.52);
    assert.equal(result.currency, 'USD');
    assert.equal(result.quoteUpdatedAt, updatedAt);
    assert.equal(result.candleClosedAt, undefined);
    assert.equal(result.marketDiagnostics, undefined);
    assert.equal(result.sourceVerification.status, 'unavailable');
    assert.match(result.sourceVerification.reason, /no historical candles/i);
    assert.ok(result.marketSources.some(source => source.provider === 'Yahoo Finance' && source.error));
    assert.deepEqual(requestedUrls.map(url => url.hostname), [
      'api.twelvedata.com',
      'finnhub.io',
      'query1.finance.yahoo.com',
      'api.gold-api.com'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalOandaToken === undefined) delete process.env.OANDA_API_TOKEN;
    else process.env.OANDA_API_TOKEN = originalOandaToken;
    if (originalOandaAccountId === undefined) delete process.env.OANDA_ACCOUNT_ID;
    else process.env.OANDA_ACCOUNT_ID = originalOandaAccountId;
  }
});

test('silver uses completed OANDA spot candles when configured providers deny access', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalOandaToken = process.env.OANDA_API_TOKEN;
  const originalOandaAccountId = process.env.OANDA_ACCOUNT_ID;
  const originalOandaEnvironment = process.env.OANDA_API_ENVIRONMENT;
  process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  process.env.OANDA_API_TOKEN = 'test-oanda-token';
  process.env.OANDA_ACCOUNT_ID = 'test-account-id';
  process.env.OANDA_API_ENVIRONMENT = 'practice';

  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const closes = Array.from({ length: 150 }, (_, index) => 30 + (index * 0.01));
  const candles = closes.map((close, index) => {
    const time = new Date(currentInterval - ((150 - index) * 900000)).toISOString();
    return {
      time,
      complete: true,
      mid: {
        o: String(close),
        h: String(close + 0.1),
        l: String(close - 0.1),
        c: String(close)
      }
    };
  });
  candles.push({
    time: new Date(currentInterval).toISOString(),
    complete: false,
    mid: { o: '99', h: '100', l: '98', c: '99' }
  });
  const timestamps = candles.slice(0, 150).map(candle => Math.floor(Date.parse(candle.time) / 1000));
  const requestedUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    requestedUrls.push({ url: requestUrl, options });
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({ message: 'Plan restricted.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({ error: 'Access denied.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'api-fxpractice.oanda.com') {
      return new Response(JSON.stringify({ candles }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'query1.finance.yahoo.com') {
      return new Response(JSON.stringify({
        chart: {
          result: [{
            meta: { currency: 'USD' },
            timestamp: timestamps,
            indicators: {
              quote: [{
                open: closes.slice(0, 150),
                high: closes.slice(0, 150).map(price => price + 0.1),
                low: closes.slice(0, 150).map(price => price - 0.1),
                close: closes.slice(0, 150),
                volume: Array(150).fill(100)
              }]
            }
          }],
          error: null
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected provider request: ${requestUrl.hostname}`);
  };

  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { symbols: 'XAG/USD', timeframe: '15' }
    }, response);

    const oandaRequest = requestedUrls.find(request => request.url.hostname === 'api-fxpractice.oanda.com');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.results[0].provider, 'OANDA');
    assert.equal(response.body.results[0].price, closes.at(-1));
    assert.equal(response.body.results[0].currency, 'USD');
    assert.ok(Number.isFinite(response.body.results[0].rsi15));
    assert.equal(response.body.results[0].sourceVerification.status, 'verified');
    assert.equal(response.body.results[0].marketSources.length, 2);
    assert.deepEqual(requestedUrls.slice(-2).map(request => request.url.hostname), [
      'finnhub.io',
      'query1.finance.yahoo.com'
    ]);
    assert.equal(oandaRequest.url.pathname, '/v3/accounts/test-account-id/instruments/XAG_USD/candles');
    assert.equal(oandaRequest.url.searchParams.get('granularity'), 'M15');
    assert.equal(oandaRequest.url.searchParams.get('count'), '150');
    assert.equal(oandaRequest.url.searchParams.get('price'), 'M');
    assert.equal(oandaRequest.options.headers.Authorization, 'Bearer test-oanda-token');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
    if (originalOandaToken === undefined) delete process.env.OANDA_API_TOKEN;
    else process.env.OANDA_API_TOKEN = originalOandaToken;
    if (originalOandaAccountId === undefined) delete process.env.OANDA_ACCOUNT_ID;
    else process.env.OANDA_ACCOUNT_ID = originalOandaAccountId;
    if (originalOandaEnvironment === undefined) delete process.env.OANDA_API_ENVIRONMENT;
    else process.env.OANDA_API_ENVIRONMENT = originalOandaEnvironment;
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

test('gold falls back to its Yahoo spot ticker instead of a futures proxy', async () => {
  const originalFetch = globalThis.fetch;
  const originalTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  process.env.FINNHUB_API_KEY = 'test-key';
  const currentInterval = Math.floor(Date.now() / 900000) * 900000;
  const timestamps = Array.from({ length: 150 }, (_, index) =>
    Math.floor((currentInterval - ((150 - index) * 900000)) / 1000));
  const close = timestamps.map((_, index) => 2000 + index);
  const requestedUrls = [];
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.hostname === 'api.twelvedata.com') {
      return new Response(JSON.stringify({ error: 'Access denied.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.hostname === 'finnhub.io') {
      return new Response(JSON.stringify({ error: 'Access denied.' }), {
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
              high: close.map(price => price + 1),
              low: close.map(price => price - 1),
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
      query: { symbols: 'XAU/USD', timeframe: '15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedUrls.map(url => url.hostname), [
      'api.twelvedata.com',
      'finnhub.io',
      'query1.finance.yahoo.com'
    ]);
    assert.equal(decodeURIComponent(requestedUrls[2].pathname.split('/').pop()), 'XAUUSD=X');
    assert.equal(response.body.results[0].provider, 'Yahoo Finance');
    assert.equal(response.body.results[0].price, close.at(-1));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTwelveDataKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveDataKey;
    if (originalFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalFinnhubKey;
  }
});
