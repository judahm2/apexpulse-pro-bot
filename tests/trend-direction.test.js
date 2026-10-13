import assert from 'node:assert/strict';
import test from 'node:test';
import { getTrendDirection, getUpcomingTrendSignal } from '../api/bot.js';

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

test('upcoming setup watch identifies converging 15m entry indicators in a bearish regime', () => {
  const watch = getUpcomingTrendSignal({
    strategyIndicatorsByTimeframe: {
      45: { ema9: 99, ema21: 100, macd: -0.2, macdSignal: -0.1 },
      15: {
        ema9: 100.1,
        ema21: 100,
        previousEma9: 100.2,
        previousEma21: 100,
        macd: 0.1,
        macdSignal: 0,
        previousMacd: 0.2,
        previousMacdSignal: 0
      }
    },
    rsiByTimeframe: { 45: 40 },
    atrByTimeframe: { 15: 1 }
  });

  assert.equal(watch.direction, 'SELL');
  assert.match(watch.reason, /early WATCH/i);
});

test('upcoming setup watch identifies converging 15m entry indicators in a bullish regime', () => {
  const watch = getUpcomingTrendSignal({
    strategyIndicatorsByTimeframe: {
      45: { ema9: 101, ema21: 100, macd: 0.2, macdSignal: 0.1 },
      15: {
        ema9: 99.9,
        ema21: 100,
        previousEma9: 99.8,
        previousEma21: 100,
        macd: -0.1,
        macdSignal: 0,
        previousMacd: -0.2,
        previousMacdSignal: 0
      }
    },
    rsiByTimeframe: { 45: 60 },
    atrByTimeframe: { 15: 1 }
  });

  assert.equal(watch.direction, 'BUY');
});
