import marketDataHandler from './market-data.js';
import { getSharedRedis } from '../lib/redis.js';
import { recordTradeHistory } from '../lib/trade-history.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized request' });
  }

  const symbols = ['XAU/USD', 'BTC/USD', 'EUR/USD', 'AUD/USD'];

  try {
    const marketResponse = createInternalResponse();
    await marketDataHandler({
      method: 'GET',
      query: {
        symbols: symbols.join(','),
        cryptoSymbols: 'BTC/USD',
        timeframe: '15'
      }
    }, marketResponse);
    if (marketResponse.statusCode !== 200 || !Array.isArray(marketResponse.body?.results)) {
      throw new Error(marketResponse.body?.error || `Market-data scan failed (HTTP ${marketResponse.statusCode}).`);
    }

    const results = marketResponse.body.results;
    const timestamp = new Date().toISOString();
    const alerts = results.map(result => createAlert(result, timestamp));
    let history;
    try {
      const redis = getSharedRedis();
      if (!redis) {
        history = { available: false };
      } else {
        history = await recordTradeHistory(alerts, results, redis);
      }
    } catch (error) {
      console.error('Unable to update historical trade results:', error);
      history = { available: false };
    }

    if (process.env.DISCORD_WEBHOOK_URL) {
      for (const content of createDiscordMessages(alerts)) {
        const webhookResponse = await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        if (!webhookResponse.ok) {
          throw new Error(`Discord webhook returned HTTP ${webhookResponse.status}.`);
        }
      }
    }

    return res.status(200).json({ success: true, timestamp, alerts, results, history });
  } catch (error) {
    console.error('Scheduled trading scan failed:', error);
    return res.status(500).json({ error: error.message });
  }
}

function createInternalResponse() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
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

function createAlert(result, timestamp) {
  if (result.error || !Number.isFinite(result.price)) {
    return {
      action: 'HOLD',
      confidence: 'LOW',
      label: 'Cautionary Signal',
      reason: result.error || 'No valid market price was returned.',
      timestamp,
      market: { symbol: result.symbol, sources: result.marketSources || [] },
      risk: null
    };
  }

  const diagnostics = result.marketDiagnostics;
  const market = {
    symbol: result.symbol,
    timeframe: '15m',
    price: result.candleClose,
    currency: result.currency,
    provider: result.provider,
    sources: result.marketSources,
    sourceVerification: result.sourceVerification,
    candleClosedAt: new Date(result.candleClosedAt).toISOString(),
    regime: diagnostics?.regime || 'Unknown',
    diagnostics,
    backtest: result.backtestByTimeframe?.['15'] || null,
    calibrationDate: result.calibrationDate,
    indicators: {
      rsi15: result.rsi15,
      rsi30: result.rsi30,
      rsi45: result.rsi45,
      ...result.strategyIndicators
    }
  };
  const filterReason = getFilterReason(result, diagnostics);
  const active = getTrendFollowingSignal(result);
  if (filterReason) {
    return { action: 'HOLD', confidence: 'LOW', label: 'Cautionary Signal', reason: filterReason, timestamp, market, risk: null };
  }
  if (!['BUY', 'SELL'].includes(active.action)) {
    const upcoming = getUpcomingTrendSignal(result);
    if (upcoming) {
      return {
        action: 'WATCH',
        direction: upcoming.direction,
        confidence: 'MEDIUM',
        label: 'Upcoming Setup Watch',
        reason: upcoming.reason,
        timestamp,
        market,
        risk: null
      };
    }
    return {
      action: 'HOLD',
      confidence: 'LOW',
      label: 'Cautionary Signal',
      reason: `${active.reason} Regime: ${diagnostics.regime}.`,
      timestamp,
      market,
      risk: null
    };
  }

  const alignedTimeframes = [15, 30, 45]
    .map(timeframe => getTrendDirection(
      result.strategyIndicatorsByTimeframe?.[String(timeframe)],
      result.rsiByTimeframe?.[String(timeframe)]
    ))
    .filter(direction => direction === active.action).length;
  const compositeScore = alignedTimeframes / 3;
  if (alignedTimeframes < 2 || compositeScore < 0.65) {
    return {
      action: 'HOLD',
      confidence: 'LOW',
      label: 'Cautionary Signal',
      reason: `${active.reason} Trend score ${compositeScore.toFixed(2)} is below the 0.65 threshold; only ${alignedTimeframes}/3 timeframes align.`,
      timestamp,
      market,
      risk: null
    };
  }

  const confidence = alignedTimeframes > 0 &&
    alignedTimeframes === 3 &&
    result.sourceVerification?.status === 'verified' &&
    diagnostics.volumeAvailable
    ? 'HIGH'
    : 'MEDIUM';
  const risk = createRiskPlan(result, active.action);
  if (!risk) {
    return {
      action: 'HOLD',
      confidence: 'LOW',
      label: 'Cautionary Signal',
      reason: `${active.reason} ATR-based stop and target are unavailable, so the setup is incomplete.`,
      timestamp,
      market,
      risk: null
    };
  }
  return {
    action: active.action,
    confidence,
    label: confidence === 'HIGH' ? 'High-Confluence Setup' : 'Cautionary Signal',
    reason: `${active.reason} Regime: ${diagnostics.regime}. Trend score ${compositeScore.toFixed(2)} (threshold 0.65); ${alignedTimeframes}/3 timeframes align.`,
    timestamp,
    market,
    risk
  };
}

function getFilterReason(result, diagnostics) {
  if (!diagnostics) return 'Volatility and liquidity diagnostics are unavailable.';
  const candleAge = Date.now() - result.candleClosedAt;
  if (!Number.isFinite(candleAge) || candleAge < 0 || candleAge > (17 * 60 * 1000)) {
    return `Stale market data: the latest completed candle is ${Number.isFinite(candleAge) ? Math.round(candleAge / 60000) : 'an invalid number of'} minutes old.`;
  }
  if (result.sourceVerification?.status === 'discrepancy') return `Conflicting data feeds: ${result.sourceVerification.reason}`;
  if (diagnostics.lowVolatility) return `Quiet market: ATR is ${diagnostics.atrPercent.toFixed(3)}%, below the 0.02% minimum.`;
  if (diagnostics.erraticSpike) return `Erratic candle range is ${diagnostics.spikeRatio.toFixed(2)}× the recent median.`;
  if (diagnostics.lowVolume) return `Unusually low volume: ${diagnostics.volumeRatio.toFixed(2)}× the recent average.`;
  return null;
}

function getRawSignal(result, strategy, timeframe) {
  const key = String(timeframe);
  const rsi = result.rsiByTimeframe?.[key];
  const indicators = result.strategyIndicatorsByTimeframe?.[key];
  if (strategy === 'rsi') {
    const secondaryTimeframe = timeframe === 30 ? '45' : '30';
    const secondaryRsi = result.rsiByTimeframe?.[secondaryTimeframe];
    if (!Number.isFinite(rsi) || !Number.isFinite(secondaryRsi)) {
      return { action: 'UNAVAILABLE', reason: 'RSI history is insufficient for multi-timeframe confirmation.' };
    }
    if (rsi <= 30 && secondaryRsi <= 38) {
      return { action: 'BUY', reason: `${timeframe}m RSI ${rsi.toFixed(1)} is oversold and ${secondaryTimeframe}m RSI ${secondaryRsi.toFixed(1)} confirms.` };
    }
    if (rsi >= 70 && secondaryRsi >= 62) {
      return { action: 'SELL', reason: `${timeframe}m RSI ${rsi.toFixed(1)} is overbought and ${secondaryTimeframe}m RSI ${secondaryRsi.toFixed(1)} confirms.` };
    }
    return { action: 'HOLD', reason: `No ${timeframe}m RSI extreme with secondary-timeframe confirmation.` };
  }

  if (!indicators) return { action: 'UNAVAILABLE', reason: 'Strategy indicators are unavailable.' };
  if (strategy === 'emaMacd') {
    if (indicators.previousEma9 <= indicators.previousEma21 &&
        indicators.ema9 > indicators.ema21 && indicators.macd > indicators.macdSignal) {
      return { action: 'BUY', reason: `EMA9 crossed above EMA21 and MACD ${indicators.macd.toFixed(4)} is above its signal ${indicators.macdSignal.toFixed(4)}.` };
    }
    if (indicators.previousEma9 >= indicators.previousEma21 &&
        indicators.ema9 < indicators.ema21 && indicators.macd < indicators.macdSignal) {
      return { action: 'SELL', reason: `EMA9 crossed below EMA21 and MACD ${indicators.macd.toFixed(4)} is below its signal ${indicators.macdSignal.toFixed(4)}.` };
    }
    return { action: 'HOLD', reason: `No confirmed ${timeframe}m EMA crossover.` };
  }

  const close = result.candleCloseByTimeframe?.[key];
  if (close <= indicators.lowerBand && rsi <= 30) {
    return { action: 'BUY', reason: `${timeframe}m close ${close} is below the lower Bollinger Band with RSI ${rsi.toFixed(1)}.` };
  }
  if (close >= indicators.upperBand && rsi >= 70) {
    return { action: 'SELL', reason: `${timeframe}m close ${close} is above the upper Bollinger Band with RSI ${rsi.toFixed(1)}.` };
  }
  return { action: 'HOLD', reason: `No ${timeframe}m Bollinger Band and RSI confluence.` };
}

export function getTrendDirection(indicators, rsi) {
  if (!indicators ||
      ![indicators.ema9, indicators.ema21, indicators.macd, indicators.macdSignal].every(Number.isFinite) ||
      !Number.isFinite(rsi)) return 'HOLD';
  const bullishVotes = Number(indicators.ema9 > indicators.ema21) +
    Number(indicators.macd > indicators.macdSignal) +
    Number(rsi > 50);
  const bearishVotes = Number(indicators.ema9 < indicators.ema21) +
    Number(indicators.macd < indicators.macdSignal) +
    Number(rsi < 50);
  if (bullishVotes >= 2) return 'BUY';
  if (bearishVotes >= 2) return 'SELL';
  return 'HOLD';
}

function getTrendFollowingSignal(result) {
  const regimeDirection = getTrendDirection(
    result.strategyIndicatorsByTimeframe?.['45'],
    result.rsiByTimeframe?.['45']
  );
  if (regimeDirection === 'HOLD') {
    return { action: 'HOLD', reason: 'At least two of the 45m EMA9/EMA21, MACD, and RSI checks must agree on direction; wait for clearer trend alignment.' };
  }
  const entryDirection = getTrendDirection(
    result.strategyIndicatorsByTimeframe?.['15'],
    result.rsiByTimeframe?.['15']
  );
  if (entryDirection !== regimeDirection) {
    return {
      action: 'HOLD',
      reason: `${regimeDirection === 'BUY' ? 'Bullish' : 'Bearish'} 45m trend established; 15m EMA/MACD/RSI have not confirmed the matching entry.`
    };
  }
  return {
    action: regimeDirection,
    reason: `${regimeDirection === 'BUY' ? 'Bullish' : 'Bearish'} 45m regime and 15m entry align: at least two of EMA9/EMA21, MACD, and RSI confirm the direction.`
  };
}

export function getUpcomingTrendSignal(result) {
  const direction = getTrendDirection(
    result.strategyIndicatorsByTimeframe?.['45'],
    result.rsiByTimeframe?.['45']
  );
  if (!['BUY', 'SELL'].includes(direction)) return null;

  const indicators = result.strategyIndicatorsByTimeframe?.['15'];
  const atr = result.atrByTimeframe?.['15'];
  if (!indicators ||
      ![indicators.ema9, indicators.ema21, indicators.previousEma9, indicators.previousEma21,
        indicators.macd, indicators.macdSignal, indicators.previousMacd, indicators.previousMacdSignal].every(Number.isFinite) ||
      !Number.isFinite(atr) ||
      atr <= 0) return null;

  const emaGap = indicators.ema9 - indicators.ema21;
  const previousEmaGap = indicators.previousEma9 - indicators.previousEma21;
  const macdGap = indicators.macd - indicators.macdSignal;
  const previousMacdGap = indicators.previousMacd - indicators.previousMacdSignal;
  const emaConverging = Math.abs(emaGap) <= atr * 0.5 &&
    (direction === 'BUY' ? emaGap < 0 && emaGap > previousEmaGap : emaGap > 0 && emaGap < previousEmaGap);
  const macdConverging = Math.abs(macdGap) <= atr * 0.25 &&
    (direction === 'BUY' ? macdGap < 0 && macdGap > previousMacdGap : macdGap > 0 && macdGap < previousMacdGap);
  if (!emaConverging && !macdConverging) return null;

  return {
    direction,
    reason: `${direction === 'BUY' ? 'Bullish' : 'Bearish'} 45m trend is confirmed and 15m ${emaConverging ? 'EMA9/EMA21' : 'MACD/signal'} lines are converging toward a possible entry. This is an early WATCH, not a trade signal; wait for full confirmation.`
  };
}

function createRiskPlan(result, action) {
  const entry = result.candleClose;
  const atr = result.atr;
  if (!Number.isFinite(entry) || !Number.isFinite(atr) || atr <= 0) return null;
  const baseRisk = atr * 1.5;
  const structure = action === 'BUY'
    ? result.marketDiagnostics.support
    : result.marketDiagnostics.resistance;
  const structuralStop = Number.isFinite(structure)
    ? structure + (action === 'BUY' ? -0.1 : 0.1) * atr
    : null;
  const structuralStopIsNearby = Number.isFinite(structuralStop) &&
    Math.abs(entry - structuralStop) <= baseRisk * 1.25;
  const atrStop = entry + (action === 'BUY' ? -baseRisk : baseRisk);
  const stopLoss = structuralStopIsNearby
    ? action === 'BUY' ? Math.min(atrStop, structuralStop) : Math.max(atrStop, structuralStop)
    : atrStop;
  const riskDistance = Math.abs(entry - stopLoss);
  return {
    entry,
    stopLoss,
    takeProfit: entry + (action === 'BUY' ? 3 : -3) * riskDistance,
    riskRewardRatio: '3:1',
    rationale: structuralStopIsNearby
      ? `Stop refined beyond recent ${action === 'BUY' ? 'support' : 'resistance'} with a 0.1× ATR buffer; target remains 3R.`
      : 'Stop is 1.5× ATR; no nearby support/resistance justified a refinement. Target is 3R.',
    positionSize: null
  };
}

function formatDiscordAlert(alert) {
  const price = alert.market?.price;
  const diagnostics = alert.market?.diagnostics;
  const marketLine = alert.market
    ? `Price ${price ?? 'unavailable'} ${alert.market.currency || ''} • ${alert.market.provider || 'no feed'} • ${alert.market.regime || 'unknown'} regime • ATR ${Number.isFinite(diagnostics?.atrPercent) ? `${diagnostics.atrPercent.toFixed(3)}%` : 'unavailable'} • Volume ${diagnostics?.volumeAvailable ? `${diagnostics.volumeRatio.toFixed(2)}× average` : 'unavailable'}`
    : 'Market snapshot unavailable';
  const riskLine = alert.risk
    ? `Entry ${alert.risk.entry} • Stop ${alert.risk.stopLoss} • Target ${alert.risk.takeProfit} (3R). ${alert.risk.rationale} Position size not calculated.`
    : 'No trade levels; do not act.';
  const sources = alert.market?.sources?.map(source =>
    source.error ? `${source.provider} unavailable` : source.provider
  ).join(', ') || 'none';
  const verification = alert.market?.sourceVerification || {};
  const indicators = alert.market?.indicators || {};
  const indicatorLine = `RSI 15/30/45 ${indicators.rsi15 ?? '—'}/${indicators.rsi30 ?? '—'}/${indicators.rsi45 ?? '—'} • EMA9 ${indicators.ema9 ?? '—'} • EMA21 ${indicators.ema21 ?? '—'} • MACD ${indicators.macd ?? '—'}/${indicators.macdSignal ?? '—'} • ATR ${indicators.atr ?? '—'}`;
  const actionLabel = alert.action === 'WATCH' ? `${alert.direction} WATCH` : alert.action;
  return `**${alert.label} • ${actionLabel} • ${alert.confidence}**\n${alert.market?.symbol || 'Market'} • ${alert.reason}\n${marketLine}\n${indicatorLine}\nSources: ${sources} • feed check ${verification.status || 'unavailable'}${verification.reason ? `: ${verification.reason}` : ''}\n${riskLine}\n${alert.timestamp}`;
}

function createDiscordMessages(alerts) {
  const messages = [];
  const now = Date.now();
  const reportableAlerts = alerts.filter(alert => {
    const candleClosedAt = Date.parse(alert.market?.candleClosedAt);
    const candleAge = now - candleClosedAt;
    return ['BUY', 'SELL', 'WATCH'].includes(alert.action) &&
      Number.isFinite(candleClosedAt) &&
      candleAge >= 0 &&
      candleAge <= (5 * 60 * 1000);
  });
  if (!reportableAlerts.length) return messages;

  let message = '**Apexatix Pro Bot • 5-minute scan**';
  reportableAlerts.forEach(alert => {
    const formatted = formatDiscordAlert(alert);
    if (message.length + formatted.length + 2 > 1800) {
      messages.push(message);
      message = '**Apexatix Pro Bot • 15-minute scan (continued)**';
    }
    message += `\n\n${formatted}`;
  });
  if (message.length > 0) messages.push(message);
  return messages;
}