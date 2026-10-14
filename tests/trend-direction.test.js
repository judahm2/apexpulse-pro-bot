import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlert, createDiscordMessages, getTrendDirection } from '../api/bot.js';

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

  test('scheduled scanner produces actionable alerts for all selectable strategies', () => {
    const now = Date.now();
    const candle = lowerBand => ({
      ema9: 101,
      ema21: 100,
      previousEma9: 99,
      previousEma21: 100,
      macd: 0.2,
      macdSignal: 0.1,
      previousMacd: -0.1,
      previousMacdSignal: 0,
      lowerBand,
      upperBand: 110
    });
    const result = {
      symbol: 'AUD/USD',
      price: 100,
      candleClose: 100,
      currency: 'USD',
      provider: 'test',
      candleClosedAt: now,
      atr: 1,
      sourceVerification: { status: 'verified' },
      marketSources: [],
      marketDiagnostics: {
        regime: 'Trending',
        lowVolatility: false,
        erraticSpike: false,
        lowVolume: false,
        volumeAvailable: true,
        volumeRatio: 1,
        atrPercent: 0.1,
        support: null,
        resistance: null
      },
      strategyIndicators: { ema9: 101, ema21: 100, macd: 0.2, macdSignal: 0.1 },
      strategyIndicatorsByTimeframe: {
        15: candle(99),
        30: candle(101),
        45: candle(101)
      },
      rsiByTimeframe: { 15: 25, 30: 35, 45: 35 },
      previousRsiByTimeframe: { 15: 20, 30: 30, 45: 30 },
      candleCloseByTimeframe: { 15: 98, 30: 100, 45: 100 },
      candleOpenByTimeframe: { 15: 97, 30: 99, 45: 99 }
    };
    const strategies = [
      'trendFollowing',
      'trendRsi',
      'conservativeDayTrade',
      'rsi',
      'emaMacd',
      'bollingerRsi'
    ];

    for (const strategy of strategies) {
      const strategyResult = strategy === 'conservativeDayTrade'
        ? {
          ...result,
          rsiByTimeframe: { 15: 45, 30: 55, 45: 60 },
          previousRsiByTimeframe: { 15: 44, 30: 54, 45: 59 }
        }
        : result;
      const alert = createAlert(strategyResult, new Date(now).toISOString(), strategy);
      assert.equal(alert.action, 'BUY', `${strategy} should produce its confirmed signal`);
      assert.equal(alert.strategy, strategy);
      assert.equal(alert.risk.riskRewardRatio, '3:1');
    }
  });
