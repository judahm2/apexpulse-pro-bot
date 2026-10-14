import { Redis } from '@upstash/redis';

let sharedRedis;
let sharedRedisConfig;

export function getSharedRedis(url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN) {
  if (!url || !token) return null;
  const config = `${url}\n${token}`;
  if (!sharedRedis || sharedRedisConfig !== config) {
    sharedRedis = new Redis({ url, token });
    sharedRedisConfig = config;
  }
  return sharedRedis;
}
