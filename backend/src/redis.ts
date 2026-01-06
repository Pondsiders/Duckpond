/**
 * Shared Redis client for Duckpond backend.
 *
 * Used by:
 * - context.ts: Token count lookups from Eavesdrop
 * - chat.ts: Squoze flag for post-compact orientation
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://alpha-pi:6379';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL);
  }
  return redis;
}

// Key prefixes for different uses
export const REDIS_KEYS = {
  context: (sessionId: string) => `duckpond:context:${sessionId}`,
  squoze: (sessionId: string) => `duckpond:squoze:${sessionId}`,
} as const;

// TTL values
export const REDIS_TTL = {
  squoze: 3600, // 1 hour - flag should be consumed on next message
} as const;
