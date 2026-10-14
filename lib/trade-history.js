import { randomUUID } from 'node:crypto';

const HISTORY_KEY = 'trade-history:v1:events';
const HISTORY_LOCK_KEY = `${HISTORY_KEY}:lock`;
const HISTORY_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_HISTORY_EVENTS = 250;
const MAX_HOLDING_CANDLES = 12;

export async function recordTradeHistory(alerts, results, redis, now = Date.now()) {
  const lockToken = randomUUID();
  const lockAcquired = await redis.set(HISTORY_LOCK_KEY, lockToken, { nx: true, ex: 20 });
  if (lockAcquired !== 'OK') {
    return { available: true, updated: false };
  }

  try {
    const stored = await redis.get(HISTORY_KEY);
    const events = parseStoredEvents(stored);
    const advanced = advanceTradeEvents(events, alerts, results, now);
    if (!advanced.changed) {
      return { available: true, updated: false, ...summarizeTradeEvents(events, now) };
    }

    const retained = retainRecentEvents(advanced.events, now);
    await redis.set(HISTORY_KEY, retained, { ex: HISTORY_TTL_SECONDS });
    return {
      available: true,
      updated: true,
      ...summarizeTradeEvents(retained, now)
    };
  } finally {
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      [HISTORY_LOCK_KEY],
      [lockToken]
    );
  }
}

export async function readTradeHistory(redis, now = Date.now()) {
  const stored = await redis.get(HISTORY_KEY);
  return {
    available: true,
    ...summarizeTradeEvents(parseStoredEvents(stored), now)
  };
}

export function advanceTradeEvents(currentEvents, alerts, results, now = Date.now()) {
  const events = currentEvents.map(event => ({ ...event }));
  let changed = false;
  const resultBySymbol = new Map(results.map(result => [result.symbol, result]));

  for (const alert of alerts) {
    if (!['BUY', 'SELL'].includes(alert.action) || !alert.risk) continue;
    if (typeof alert.market?.symbol !== 'string' || !alert.market.symbol) continue;
    const candleClosedAt = Date.parse(alert.market?.candleClosedAt);
    const entry = Number(alert.risk.entry);
    const stopLoss = Number(alert.risk.stopLoss);
    const takeProfit = Number(alert.risk.takeProfit);
    if (
      !Number.isFinite(candleClosedAt) ||
      !Number.isFinite(entry) ||
      !Number.isFinite(stopLoss) ||
      !Number.isFinite(takeProfit) ||
      Math.abs(entry - stopLoss) <= 0 ||
      (alert.action === 'BUY' && (stopLoss >= entry || takeProfit <= entry)) ||
      (alert.action === 'SELL' && (stopLoss <= entry || takeProfit >= entry))
    ) continue;

    const id = `${alert.market.symbol}:${candleClosedAt}:${alert.action}:trend-following-v1`;
    if (events.some(event => event.id === id)) continue;
    const result = resultBySymbol.get(alert.market.symbol);
    events.push({
      id,
      symbol: alert.market.symbol,
      action: alert.action,
      strategy: 'Trend Following',
      confidence: alert.confidence || 'UNKNOWN',
      regime: alert.market.regime || 'Unknown',
      sourceVerification: alert.market.sourceVerification?.status || 'unavailable',
      reason: alert.reason || '',
      signalCandleAt: candleClosedAt,
      entry,
      stopLoss,
      takeProfit,
      riskUnit: Math.abs(entry - stopLoss),
      lastEvaluatedCandleAt: candleClosedAt,
      barsElapsed: 0,
      maxFavorableR: 0,
      maxAdverseR: 0,
      status: 'PENDING',
      outcome: null,
      outcomeR: null,
      exitPrice: null,
      resolvedAt: null,
      createdAt: now,
      timeframe: alert.market.timeframe || '15m',
      currency: alert.market.currency || '',
      indicators: alert.market.indicators || {},
      signalPrice: Number.isFinite(result?.candleClose) ? result.candleClose : entry
    });
    changed = true;
  }

  for (const event of events) {
    if (event.status !== 'PENDING') continue;
    const result = resultBySymbol.get(event.symbol);
    const candles = result?.recentClosedCandles;
    if (!Array.isArray(candles)) continue;
    const nextCandles = candles
      .filter(candle => Number.isFinite(candle.time) && candle.time > event.lastEvaluatedCandleAt)
      .sort((first, second) => first.time - second.time);

    for (const candle of nextCandles) {
      if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
      event.lastEvaluatedCandleAt = candle.time;
      event.barsElapsed += 1;
      const buy = event.action === 'BUY';
      event.maxFavorableR = Math.max(
        event.maxFavorableR,
        buy ? (candle.high - event.entry) / event.riskUnit : (event.entry - candle.low) / event.riskUnit
      );
      event.maxAdverseR = Math.max(
        event.maxAdverseR,
        buy ? (event.entry - candle.low) / event.riskUnit : (candle.high - event.entry) / event.riskUnit
      );

      const stopTouched = buy ? candle.low <= event.stopLoss : candle.high >= event.stopLoss;
      const targetTouched = buy ? candle.high >= event.takeProfit : candle.low <= event.takeProfit;
      if (stopTouched || targetTouched) {
        const outcome = stopTouched ? 'STOP' : 'TARGET';
        const stopGapFill = buy ? candle.open < event.stopLoss : candle.open > event.stopLoss;
        const exitPrice = stopTouched
          ? stopGapFill ? candle.open : event.stopLoss
          : event.takeProfit;
        finishTradeEvent(event, outcome, exitPrice, candle.time);
        changed = true;
        break;
      }
      if (event.barsElapsed >= MAX_HOLDING_CANDLES) {
        const outcomeR = (buy ? candle.close - event.entry : event.entry - candle.close) / event.riskUnit;
        finishTradeEvent(event, 'TIME_EXIT', candle.close, candle.time, outcomeR);
        changed = true;
        break;
      }
      changed = true;
    }
  }

  return { events, changed };
}

export function summarizeTradeEvents(events, now = Date.now()) {
  const closed = events.filter(event => event.status === 'CLOSED' && Number.isFinite(event.outcomeR));
  const pending = events.filter(event => event.status === 'PENDING');
  const overall = summarizeGroup(closed);
  overall.pending = pending.length;
  overall.targetHits = closed.filter(event => event.outcome === 'TARGET').length;
  overall.stopHits = closed.filter(event => event.outcome === 'STOP').length;
  overall.timeExits = closed.filter(event => event.outcome === 'TIME_EXIT').length;

  const bySymbol = summarizeGroups(closed, event => event.symbol);
  const byRegime = summarizeGroups(closed, event => event.regime);
  const byConfidence = summarizeGroups(closed, event => event.confidence);
  const byAction = summarizeGroups(closed, event => event.action);
  const recentOutcomes = closed
    .slice()
    .sort((first, second) => second.resolvedAt - first.resolvedAt)
    .slice(0, 10)
    .map(event => ({
      id: event.id,
      symbol: event.symbol,
      action: event.action,
      outcome: event.outcome,
      outcomeR: event.outcomeR,
      exitPrice: event.exitPrice,
      barsElapsed: event.barsElapsed,
      maxFavorableR: event.maxFavorableR,
      maxAdverseR: event.maxAdverseR,
      entry: event.entry,
      resolvedAt: new Date(event.resolvedAt).toISOString(),
      timeframe: event.timeframe
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    retentionDays: HISTORY_TTL_SECONDS / (24 * 60 * 60),
    capacity: MAX_HISTORY_EVENTS,
    sampledEvents: events.length,
    overall,
    bySymbol,
    byRegime,
    byConfidence,
    byAction,
    recentOutcomes
  };
}

function finishTradeEvent(event, outcome, exitPrice, resolvedAt, calculatedOutcomeR) {
  const buy = event.action === 'BUY';
  event.status = 'CLOSED';
  event.outcome = outcome;
  event.exitPrice = exitPrice;
  event.resolvedAt = resolvedAt;
  event.outcomeR = Number.isFinite(calculatedOutcomeR)
    ? calculatedOutcomeR
    : (buy ? exitPrice - event.entry : event.entry - exitPrice) / event.riskUnit;
}

function summarizeGroups(events, getKey) {
  const groups = new Map();
  for (const event of events) {
    const key = getKey(event) || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...summarizeGroup(group) }))
    .sort((first, second) => second.closedTrades - first.closedTrades || first.key.localeCompare(second.key));
}

function summarizeGroup(events) {
  const wins = events.filter(event => event.outcomeR > 0).length;
  const losses = events.filter(event => event.outcomeR < 0).length;
  const netR = events.reduce((total, event) => total + event.outcomeR, 0);
  return {
    closedTrades: events.length,
    wins,
    losses,
    winRatePercent: events.length ? (wins / events.length) * 100 : null,
    averageR: events.length ? netR / events.length : null,
    netR
  };
}

function retainRecentEvents(events, now) {
  const cutoff = now - (HISTORY_TTL_SECONDS * 1000);
  return events
    .filter(event => event.status === 'PENDING' || event.signalCandleAt >= cutoff)
    .sort((first, second) => first.signalCandleAt - second.signalCandleAt)
    .slice(-MAX_HISTORY_EVENTS);
}

function parseStoredEvents(stored) {
  if (stored === null || stored === undefined) return [];
  const events = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (!Array.isArray(events) || events.some(event =>
    !event || typeof event.id !== 'string' || !['PENDING', 'CLOSED'].includes(event.status)
  )) {
    throw new Error('Stored trade history has an invalid format.');
  }
  return events;
}
