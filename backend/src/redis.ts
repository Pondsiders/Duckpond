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
  // HUD keys - populated by Pulse hourly, assembled by Duckpond
  hud: {
    updated: 'hud:updated',
    summary1: 'hud:summary1',
    summary2: 'hud:summary2',
    summary3: 'hud:summary3',
    weather: 'hud:weather',
    calendar: 'hud:calendar',
    todos: 'hud:todos',
  },
} as const;

// TTL values
export const REDIS_TTL = {
  squoze: 3600, // 1 hour - flag should be consumed on next message
} as const;

import type { DynamicContext } from './config.js';

/**
 * Fetch all dynamic context components from Redis.
 *
 * Returns structured data for buildSystemPrompt() to assemble.
 */
export async function fetchDynamicContext(): Promise<DynamicContext | null> {
  const r = getRedis();

  try {
    const [updated, summary1, summary2, summary3, weather, calendar, todos] = await Promise.all([
      r.get(REDIS_KEYS.hud.updated),
      r.get(REDIS_KEYS.hud.summary1),
      r.get(REDIS_KEYS.hud.summary2),
      r.get(REDIS_KEYS.hud.summary3),
      r.get(REDIS_KEYS.hud.weather),
      r.get(REDIS_KEYS.hud.calendar),
      r.get(REDIS_KEYS.hud.todos),
    ]);

    if (!updated) {
      // No data available
      return null;
    }

    return {
      updated: updated || undefined,
      summary1: summary1 || undefined,
      summary2: summary2 || undefined,
      summary3: summary3 || undefined,
      weather: weather || undefined,
      calendar: calendar || undefined,
      todos: todos || undefined,
    };
  } catch (err) {
    console.error('[Duckpond] Failed to fetch dynamic context:', err);
    return null;
  }
}
