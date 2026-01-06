/**
 * Context route — provides context info for the frontend meter.
 *
 * GET /api/context returns current time and context information.
 * GET /api/context/{sessionId} returns token counts from Redis (populated by Eavesdrop).
 */

import * as logfire from '@pydantic/logfire-node';
import { Router, Request, Response } from 'express';
import { hostname } from 'os';
import Redis from 'ioredis';
import { pso8601Date, pso8601Time, pso8601DateTime } from '../utils/time.js';

export const contextRouter = Router();

// Redis connection for token counts from Eavesdrop
const REDIS_URL = process.env.REDIS_URL || 'redis://alpha-pi:6379';
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL);
  }
  return redis;
}

// Basic context info (time, hostname)
contextRouter.get('/api/context', (_req: Request, res: Response) => {
  res.json({
    hostname: hostname(),
    date: pso8601Date(),
    time: pso8601Time(),
    datetime: pso8601DateTime(),
  });
});

// Session-specific token count from Redis
contextRouter.get('/api/context/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  logfire.info('Context request for session', { sessionIdShort: sessionId.slice(0, 8) });

  try {
    const r = getRedis();
    const redisKey = `duckpond:context:${sessionId}`;
    const data = await r.get(redisKey);

    logfire.info('Redis lookup', {
      key: redisKey,
      found: !!data,
      dataPreview: data ? data.slice(0, 100) : null,
    });

    if (data) {
      const parsed = JSON.parse(data);
      logfire.info('Returning context data', {
        input_tokens: parsed.input_tokens,
        sessionIdShort: sessionId.slice(0, 8),
      });
      res.json(parsed);
      return;
    }
  } catch (err) {
    // Redis down or other error - return empty response
    logfire.error('Redis error fetching context', { error: String(err), sessionIdShort: sessionId.slice(0, 8) });
    console.warn('[Duckpond] Redis error fetching context:', err);
  }

  logfire.info('No context data found, returning nulls', { sessionIdShort: sessionId.slice(0, 8) });
  res.json({ input_tokens: null, timestamp: null });
});
