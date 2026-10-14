import { getSharedRedis } from '../lib/redis.js';
import { readTradeHistory } from '../lib/trade-history.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const redis = getSharedRedis();
    if (!redis) {
      return res.status(200).json({
        available: false,
        reason: 'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable rolling trade history.'
      });
    }
    return res.status(200).json(await readTradeHistory(redis));
  } catch (error) {
    console.error('Unable to read historical trade results:', error);
    return res.status(503).json({ error: 'Historical trade results are temporarily unavailable.' });
  }
}
