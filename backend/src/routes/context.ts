/**
 * Context route — provides context info for the frontend meter.
 *
 * GET /api/context returns current time and context information.
 * GET /api/context/{sessionId} returns token counts from Redis (populated by Eavesdrop).
 */

import { Router, Request, Response } from 'express';
import { hostname } from 'os';
import { pso8601Date, pso8601Time, pso8601DateTime } from '../utils/time.js';
import { getRedis, REDIS_KEYS } from '../redis.js';

export const contextRouter = Router();

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

  try {
    const r = getRedis();
    const redisKey = REDIS_KEYS.context(sessionId);
    const data = await r.get(redisKey);

    if (data) {
      const parsed = JSON.parse(data);
      res.json(parsed);
      return;
    }
  } catch (err) {
    // Redis down or other error - return empty response
    console.warn('[Duckpond] Redis error fetching context:', err);
  }

  res.json({ input_tokens: null, timestamp: null });
});
