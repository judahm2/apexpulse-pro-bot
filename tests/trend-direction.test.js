import assert from 'node:assert/strict';
import test from 'node:test';
import { getTrendDirection } from '../api/bot.js';

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
