import assert from 'node:assert/strict';
import test from 'node:test';
import tradeHistoryHandler from '../api/trade-history.js';
import { advanceTradeEvents, recordTradeHistory, readTradeHistory, summarizeTradeEvents } from '../lib/trade-history.js';

const candleDuration = 15 * 60 * 1000;

function createAlert(action, signalTime = Date.parse('2026-10-14T18:00:00.000Z')) {
  return {
    action,
    confidence: 'MEDIUM',
    reason: 'Multi-timeframe direction confirmed.',
    market: {
      symbol: 'AUD/USD',
      timeframe: '15m',
      currency: 'USD',
      regime: 'Trending',
      candleClosedAt: new Date(signalTime).toISOString(),
      sourceVerification: { status: 'verified' },
      indicators: { rsi15: 42, rsi30: 44, rsi45: 40 }
    },
    risk: {
      entry: 100,
      stopLoss: action === 'BUY' ? 99 : 101,
      takeProfit: action === 'BUY' ? 103 : 97
    }
  };
}

function createCandle(time, { high, low, close }) {
  return { time, open: close, high, low, close };
}

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
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

test('trade history endpoint reports when Redis is not configured', async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const response = createResponse();

  try {
    await tradeHistoryHandler({ method: 'GET' }, response);
  } finally {
    if (url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = url;
    if (token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = token;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.available, false);
  assert.equal(Object.hasOwn(response.body, 'reason'), false);
  assert.match(response.headers['Cache-Control'], /s-maxage=60/);
});

test('trade history conservatively counts same-candle stop and target touches as a stop', () => {
  const alert = createAlert('BUY');
  const signalTime = Date.parse(alert.market.candleClosedAt);
  const result = {
    symbol: 'AUD/USD',
    candleClose: 100,
    recentClosedCandles: [
      createCandle(signalTime, { high: 100.5, low: 99.5, close: 100 }),
      createCandle(signalTime + candleDuration, { high: 103.2, low: 98.8, close: 101 })
    ]
  };

  const { events, changed } = advanceTradeEvents([], [alert], [result], signalTime + candleDuration * 2);

  assert.equal(changed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'CLOSED');
  assert.equal(events[0].outcome, 'STOP');
  assert.equal(events[0].outcomeR, -1);
  assert.ok(Math.abs(events[0].maxFavorableR - 3.2) < 1e-10);
  assert.ok(Math.abs(events[0].maxAdverseR - 1.2) < 1e-10);

  const summary = summarizeTradeEvents(events);
  assert.equal(summary.overall.closedTrades, 1);
  assert.equal(summary.overall.stopHits, 1);
  assert.equal(summary.overall.winRatePercent, 0);
  assert.equal(summary.bySymbol[0].key, 'AUD/USD');
});

test('trade history records a worse opening gap through the stop', () => {
  const alert = createAlert('BUY');
  const signalTime = Date.parse(alert.market.candleClosedAt);
  const result = {
    symbol: 'AUD/USD',
    candleClose: 100,
    recentClosedCandles: [
      createCandle(signalTime, { high: 100.5, low: 99.5, close: 100 }),
      { time: signalTime + candleDuration, open: 98.5, high: 102.2, low: 98.4, close: 101 }
    ]
  };

  const { events } = advanceTradeEvents([], [alert], [result], signalTime + candleDuration * 2);

  assert.equal(events[0].outcome, 'STOP');
  assert.equal(events[0].exitPrice, 98.5);
  assert.equal(events[0].outcomeR, -1.5);
});

test('trade history expires after 12 candles and records the simulated close return', () => {
  const alert = createAlert('SELL');
  const signalTime = Date.parse(alert.market.candleClosedAt);
  const candles = Array.from({ length: 12 }, (_, index) =>
    createCandle(signalTime + ((index + 1) * candleDuration), {
      high: 100.5,
      low: 99.5,
      close: 99.5
    })
  );
  const result = { symbol: 'AUD/USD', candleClose: 99.5, recentClosedCandles: candles };

  const { events } = advanceTradeEvents([], [alert], [result], signalTime + candleDuration * 12);

  assert.equal(events[0].status, 'CLOSED');
  assert.equal(events[0].outcome, 'TIME_EXIT');
  assert.equal(events[0].barsElapsed, 12);
  assert.equal(events[0].outcomeR, 0.5);
  assert.equal(events[0].maxFavorableR, 0.5);
  assert.equal(events[0].maxAdverseR, 0.5);
  assert.equal(summarizeTradeEvents(events).overall.timeExits, 1);
});

test('trade history deduplicates a repeated signal when no new candle has closed', () => {
  const alert = createAlert('BUY');
  const signalTime = Date.parse(alert.market.candleClosedAt);
  const result = {
    symbol: 'AUD/USD',
    candleClose: 100,
    recentClosedCandles: [
      createCandle(signalTime, { high: 100.5, low: 99.5, close: 100 })
    ]
  };
  const first = advanceTradeEvents([], [alert], [result], signalTime);
  const second = advanceTradeEvents(first.events, [alert], [result], signalTime);

  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 1);
  assert.equal(second.changed, false);
});

test('trade history keeps same-direction signals separate by strategy', () => {
  const trendAlert = { ...createAlert('BUY'), strategy: 'trendFollowing', strategyName: 'Trend Following' };
  const rsiAlert = { ...createAlert('BUY'), strategy: 'rsi', strategyName: 'Dual-TF RSI Confluence' };
  const signalTime = Date.parse(trendAlert.market.candleClosedAt);
  const result = {
    symbol: 'AUD/USD',
    candleClose: 100,
    recentClosedCandles: [
      createCandle(signalTime, { high: 100.5, low: 99.5, close: 100 })
    ]
  };

  const { events } = advanceTradeEvents([], [trendAlert, rsiAlert], [result], signalTime);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.strategy).sort(), ['Dual-TF RSI Confluence', 'Trend Following']);
});

test('trade history is persisted once and the rolling summary can be read back', async () => {
  const values = new Map();
  const redis = {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async eval(_script, [key], [token]) {
      if (values.get(key) === token) values.delete(key);
      return 1;
    }
  };
  const alert = createAlert('BUY');
  const signalTime = Date.parse(alert.market.candleClosedAt);
  const result = {
    symbol: 'AUD/USD',
    candleClose: 100,
    recentClosedCandles: [
      createCandle(signalTime, { high: 100.5, low: 99.5, close: 100 })
    ]
  };

  const recorded = await recordTradeHistory([alert], [result], redis, signalTime);
  const repeated = await recordTradeHistory([alert], [result], redis, signalTime);
  const stored = await readTradeHistory(redis, signalTime);

  assert.equal(recorded.available, true);
  assert.equal(recorded.updated, true);
  assert.equal(repeated.updated, false);
  assert.equal(stored.sampledEvents, 1);
  assert.equal(stored.overall.pending, 1);
  assert.equal(values.has('trade-history:v1:events:lock'), false);
});
