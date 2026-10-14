import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscordMessages, getTrendDirection } from '../api/bot.js';

test('trend direction recognizes a bearish EMA/MACD alignment when RSI lags above 50', () => {
  assert.equal(getTrendDirection({
    ema9: 99,
    ema21: 100,
    macd: -0.2,
    macdSignal: -0.1
  }, 54), 'SELL');
});

test('trend direction recognizes a bullish EMA/MACD alignment when RSI lags below 50', () => {
  assert.equal(getTrendDirection({
    ema9: 101,
    ema21: 100,
    macd: 0.2,
    macdSignal: 0.1
  }, 46), 'BUY');
});

test('trend direction waits when fewer than two indicators agree', () => {
  assert.equal(getTrendDirection({
    ema9: 101,
    ema21: 100,
    macd: -0.2,
    macdSignal: -0.1
  }, 50), 'HOLD');
});

test('trend direction waits when required indicator data is unavailable', () => {
  assert.equal(getTrendDirection({
    ema9: 99,
    ema21: 100,
    macd: -0.2,
    macdSignal: -0.1
  }, null), 'HOLD');
});

  test('scheduled notifications include confirmed trade signals but exclude early watches', () => {
    const market = { symbol: 'AUD/USD', candleClosedAt: new Date().toISOString() };
    const messages = createDiscordMessages([
      { action: 'BUY', confidence: 'HIGH', label: 'High-Confluence Setup', reason: 'Confirmed.', timestamp: 'now', market, risk: null },
      { action: 'WATCH', confidence: 'LOW', label: 'Upcoming Setup Watch', reason: 'Still forming.', timestamp: 'now', market, risk: null }
    ]);

    assert.equal(messages.length, 1);
    assert.match(messages[0], /AUD\/USD/);
    assert.doesNotMatch(messages[0], /WATCH|Still forming/);
  });
