import marketDataHandler from './market-data.js';
import { getSharedRedis } from '../lib/redis.js';
import { recordTradeHistory } from '../lib/trade-history.js';

const STRATEGIES = {
  trendFollowing: 'Trend Following',
  trendRsi: 'Trend + Dual-TF RSI Confluence',
  conservativeDayTrade: 'Conservative Day-Trade Pullback',
  rsi: 'Dual-TF RSI Confluence',
  emaMacd: 'EMA Crossover + MACD',
  bollingerRsi: 'Bollinger Bands + RSI'
};

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
    const alerts = results.flatMap(result =>
      Object.keys(STRATEGIES).map(strategy => createAlert(result, timestamp, strategy))
    );
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

export function createAlert(result, timestamp, strategy = 'trendFollowing') {
  const strategyName = STRATEGIES[strategy];
  if (!strategyName) throw new Error(`Unsupported strategy: ${strategy}`);

  if (result.error || !Number.isFinite(result.price)) {
    return {
      action: 'HOLD',
      strategy,
      strategyName,
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
  const active = getStrategySignal(result, strategy);
  if (filterReason) {
    return { action: 'HOLD', strategy, strategyName, confidence: 'LOW', label: 'Cautionary Signal', reason: filterReason, timestamp, market, risk: null };
  }
  if (!['BUY', 'SELL'].includes(active.action)) {
    return {
      action: 'HOLD',
      strategy,
      strategyName,
      confidence: 'LOW',
      label: 'Cautionary Signal',
      reason: `${active.reason} Regime: ${diagnostics.regime}.`,
      timestamp,
      market,
      risk: null
    };
  }

  let confidence;
  let confluenceReason;
  if (strategy === 'trendFollowing') {
    const alignedTimeframes = ['15', '30', '45']
      .filter(timeframe => getTrendDirection(
        result.strategyIndicatorsByTimeframe?.[timeframe],
        result.rsiByTimeframe?.[timeframe]
      ) === active.action).length;
    if (alignedTimeframes < 2) {
      return holdAlert(strategy, strategyName, active, timestamp, market,
        `Only ${alignedTimeframes}/3 timeframes align; at least two are required.`);
    }
    confidence = alignedTimeframes === 3 &&
      result.sourceVerification?.status === 'verified' &&
      diagnostics.volumeAvailable
      ? 'HIGH'
      : 'MEDIUM';
    confluenceReason = `${alignedTimeframes}/3 trend timeframes align.`;
  } else if (strategy === 'trendRsi' || strategy === 'conservativeDayTrade') {
    const regimeDirection = getTrendDirection(
      result.strategyIndicatorsByTimeframe?.['45'],
      result.rsiByTimeframe?.['45']
    );
    const confirmationDirection = getTrendDirection(
      result.strategyIndicatorsByTimeframe?.['30'],
      result.rsiByTimeframe?.['30']
    );
    if (regimeDirection !== active.action || confirmationDirection !== active.action) {
      return holdAlert(strategy, strategyName, active, timestamp, market,
        '30m and 45m trend directions must both align with the entry.');
    }
    if (strategy === 'conservativeDayTrade' &&
        (result.sourceVerification?.status !== 'verified' || !diagnostics.volumeAvailable)) {
      return holdAlert(strategy, strategyName, active, timestamp, market,
        'Verified market feeds and available volume are required.');
    }
    confidence = result.sourceVerification?.status === 'verified' &&
      diagnostics.volumeAvailable
      ? 'HIGH'
      : 'MEDIUM';
    confluenceReason = '30m/45m trend alignment and strategy-specific entry conditions confirmed.';
  } else {
    const trendTimeframes = ['15', '30', '45'].map(timeframe => getTrendDirection(
      result.strategyIndicatorsByTimeframe?.[timeframe],
      result.rsiByTimeframe?.[timeframe]
    ));
    const alignedTrendTimeframes = trendTimeframes.filter(direction => direction === active.action).length;
    if (alignedTrendTimeframes < 2 || trendTimeframes[2] !== active.action) {
      return holdAlert(strategy, strategyName, active, timestamp, market,
        `Only ${alignedTrendTimeframes}/3 trend timeframes align; the 45m regime and at least two timeframes must agree.`);
    }
    if (result.sourceVerification?.status === 'discrepancy') {
      return holdAlert(strategy, strategyName, active, timestamp, market, 'Market feeds disagree.');
    }

    const weights = diagnostics.regime === 'Trending'
      ? { rsi: 0.3, emaMacd: 0.5, bollingerRsi: 0.2 }
      : { rsi: 0.35, emaMacd: 0.15, bollingerRsi: 0.5 };
    const strategyVotes = Object.fromEntries(
      ['rsi', 'emaMacd', 'bollingerRsi'].map(name => [
        name,
        getRawSignal(result, name, 15).action
      ])
    );
    const strategyScore = Object.entries(strategyVotes).reduce((score, [name, vote]) =>
      score + (vote === active.action ? weights[name] :
        ['HOLD', 'UNAVAILABLE'].includes(vote) ? 0 : -weights[name]), 0);
    const timeframeVotes = ['30', '45'].map(timeframe =>
      getRawSignal(result, strategy, Number(timeframe)).action
    );
    const alignedTimeframes = timeframeVotes.filter(vote => vote === active.action).length;
    const opposingTimeframes = timeframeVotes.filter(vote =>
      ['BUY', 'SELL'].includes(vote) && vote !== active.action).length;
    const compositeScore = strategyScore + (0.25 * (alignedTimeframes - opposingTimeframes));
    if (compositeScore < 0.45) {
      return holdAlert(strategy, strategyName, active, timestamp, market,
        'Indicator signals conflict or lack sufficient confluence.');
    }
    confidence = alignedTimeframes > 0 &&
      alignedTrendTimeframes === 3 &&
      Math.abs(strategyScore) >= 0.5 &&
      result.sourceVerification?.status === 'verified' &&
      diagnostics.volumeAvailable
      ? 'HIGH'
      : 'MEDIUM';
    confluenceReason = `Indicator confluence ${compositeScore.toFixed(2)}; ${alignedTrendTimeframes}/3 trend timeframes align.`;
  }

  const risk = createRiskPlan(result, active.action);
  if (!risk) {
    return {
      action: 'HOLD',
      strategy,
      strategyName,
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
    strategy,
    strategyName,
    confidence,
    label: confidence === 'HIGH' ? 'High-Confluence Setup' : 'Cautionary Signal',
    reason: `${active.reason} Regime: ${diagnostics.regime}. ${confluenceReason}`,
    timestamp,
    market,
    risk
  };
}

function holdAlert(strategy, strategyName, active, timestamp, market, reason) {
  return {
    action: 'HOLD',
    strategy,
    strategyName,
    confidence: 'LOW',
    label: 'Cautionary Signal',
    reason: `${active.reason} ${reason}`,
    timestamp,
    market,
    risk: null
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
  const previousRsi = result.previousRsiByTimeframe?.[key];
  const indicators = result.strategyIndicatorsByTimeframe?.[key];
  if (strategy === 'rsi') {
    const secondaryTimeframe = timeframe === 30 ? '45' : '30';
    const secondaryRsi = result.rsiByTimeframe?.[secondaryTimeframe];
    if (!Number.isFinite(rsi) || !Number.isFinite(previousRsi) || !Number.isFinite(secondaryRsi)) {
      return { action: 'UNAVAILABLE', reason: 'RSI history is insufficient for multi-timeframe confirmation.' };
    }
    if (rsi <= 30 && secondaryRsi <= 38 && rsi > previousRsi) {
      return { action: 'BUY', reason: `${timeframe}m RSI ${rsi.toFixed(1)} is oversold and turning up; ${secondaryTimeframe}m RSI ${secondaryRsi.toFixed(1)} confirms.` };
    }
    if (rsi >= 70 && secondaryRsi >= 62 && rsi < previousRsi) {
      return { action: 'SELL', reason: `${timeframe}m RSI ${rsi.toFixed(1)} is overbought and turning down; ${secondaryTimeframe}m RSI ${secondaryRsi.toFixed(1)} confirms.` };
    }
    return { action: 'HOLD', reason: `No ${timeframe}m RSI reversal with secondary-timeframe confirmation.` };
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
  const open = result.candleOpenByTimeframe?.[key];
  if (Number.isFinite(close) && Number.isFinite(open) && Number.isFinite(rsi) &&
      Number.isFinite(previousRsi) && Number.isFinite(indicators.lowerBand) &&
      close <= indicators.lowerBand && rsi <= 30 && rsi > previousRsi && close > open) {
    return { action: 'BUY', reason: `${timeframe}m close ${close} is below the lower Bollinger Band with RSI turning up and a bullish reversal candle.` };
  }
  if (Number.isFinite(close) && Number.isFinite(open) && Number.isFinite(rsi) &&
      Number.isFinite(previousRsi) && Number.isFinite(indicators.upperBand) &&
      close >= indicators.upperBand && rsi >= 70 && rsi < previousRsi && close < open) {
    return { action: 'SELL', reason: `${timeframe}m close ${close} is above the upper Bollinger Band with RSI turning down and a bearish reversal candle.` };
  }
  return { action: 'HOLD', reason: `No ${timeframe}m Bollinger Band and RSI reversal confluence.` };
}

function getStrategySignal(result, strategy) {
  if (strategy === 'trendFollowing') return getTrendFollowingSignal(result);

  const regimeDirection = getTrendDirection(
    result.strategyIndicatorsByTimeframe?.['45'],
    result.rsiByTimeframe?.['45']
  );
  if (strategy === 'trendRsi' || strategy === 'conservativeDayTrade') {
    const confirmationDirection = getTrendDirection(
      result.strategyIndicatorsByTimeframe?.['30'],
      result.rsiByTimeframe?.['30']
    );
    const entryDirection = getTrendEntryDirection(result.strategyIndicatorsByTimeframe?.['15']);
    if (!['BUY', 'SELL'].includes(regimeDirection) || confirmationDirection !== regimeDirection) {
      return { action: 'HOLD', reason: '30m/45m trend alignment is not confirmed.' };
    }
    if (entryDirection !== regimeDirection) {
      return { action: 'HOLD', reason: '15m EMA/MACD do not confirm the trend direction.' };
    }

    const rsi = result.rsiByTimeframe?.['15'];
    const previousRsi = result.previousRsiByTimeframe?.['15'];
    if (strategy === 'trendRsi') {
      const rsiSignal = getRawSignal(result, 'rsi', 15);
      if (rsiSignal.action !== regimeDirection) {
        return { action: 'HOLD', reason: '15m/30m RSI have not confirmed a pullback reversal in the trend direction.' };
      }
      return { action: regimeDirection, reason: `45m trend and 15m EMA/MACD align; ${rsiSignal.reason}` };
    }

    const pullbackConfirmed = Number.isFinite(rsi) && Number.isFinite(previousRsi) &&
      (regimeDirection === 'BUY'
        ? rsi >= 40 && rsi < 50 && rsi > previousRsi
        : rsi > 50 && rsi <= 60 && rsi < previousRsi);
    if (!pullbackConfirmed) {
      return { action: 'HOLD', reason: '15m RSI has not reset and turned back toward the trend.' };
    }
    return { action: regimeDirection, reason: `30m/45m trend and 15m EMA/MACD align; 15m RSI ${rsi.toFixed(1)} confirms the trend pullback.` };
  }

  const active = getRawSignal(result, strategy, 15);
  if (!['BUY', 'SELL'].includes(active.action)) return active;
  if (regimeDirection !== active.action) {
    return { action: 'HOLD', reason: `The ${active.action} setup does not align with the 45m trend.` };
  }
  return active;
}

function getTrendEntryDirection(indicators) {
  if (!indicators ||
      ![indicators.ema9, indicators.ema21, indicators.macd, indicators.macdSignal].every(Number.isFinite)) {
    return 'HOLD';
  }
  if (indicators.ema9 > indicators.ema21 && indicators.macd > indicators.macdSignal) return 'BUY';
  if (indicators.ema9 < indicators.ema21 && indicators.macd < indicators.macdSignal) return 'SELL';
  return 'HOLD';
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
  return `**${alert.strategyName || 'Trade Strategy'} • ${alert.label} • ${alert.action} • ${alert.confidence}**\n${alert.market?.symbol || 'Market'} • ${alert.reason}\n${marketLine}\n${indicatorLine}\nSources: ${sources} • feed check ${verification.status || 'unavailable'}${verification.reason ? `: ${verification.reason}` : ''}\n${riskLine}\n${alert.timestamp}`;
}

export function createDiscordMessages(alerts) {
  const messages = [];
  const now = Date.now();
  const reportableAlerts = alerts.filter(alert => {
    const candleClosedAt = Date.parse(alert.market?.candleClosedAt);
    const candleAge = now - candleClosedAt;
    return ['BUY', 'SELL'].includes(alert.action) &&
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