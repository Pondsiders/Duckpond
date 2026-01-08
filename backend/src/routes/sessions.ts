/**
 * Session routes — list and load Claude Code sessions.
 *
 * GET /api/sessions lists recent sessions with metadata.
 * GET /api/sessions/{session_id} loads a session's message history.
 */

import { Router, Request, Response } from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

import { SESSIONS_DIR } from '../config.js';
import { extractDisplayMessages } from '../parsing/jsonl.js';

export const sessionsRouter = Router();

sessionsRouter.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const jsonlPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);

  if (!existsSync(jsonlPath)) {
    res.status(404).json({ error: `Session ${sessionId} not found` });
    return;
  }

  const content = readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  const messages = extractDisplayMessages(lines);

  // Get metadata from first/last records
  const first = lines.length > 0 ? JSON.parse(lines[0]) : {};
  const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : {};

  res.json({
    session_id: sessionId,
    messages,
    created_at: first.timestamp,
    updated_at: last.timestamp,
  });
});

sessionsRouter.get('/api/sessions', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;

  if (!existsSync(SESSIONS_DIR)) {
    res.json([]);
    return;
  }

  const sessions: Array<{
    id: string;
    title: string;
    created_at?: string;
    updated_at?: string;
  }> = [];

  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    try {
      const jsonlPath = join(SESSIONS_DIR, file);
      const content = readFileSync(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      if (lines.length === 0) continue;

      const first = JSON.parse(lines[0]);
      const last = JSON.parse(lines[lines.length - 1]);

      // Extract title from first user message
      let title: string | null = null;
      for (const line of lines) {
        const record = JSON.parse(line);
        if (record.type === 'user') {
          const content = record.message?.content;
          if (typeof content === 'string') {
            title = content.slice(0, 50);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'string') {
                title = block.slice(0, 50);
                break;
              } else if (block?.type === 'text') {
                title = (block.text || '').slice(0, 50);
                break;
              }
            }
          }
          break;
        }
      }

      const sessionId = basename(file, '.jsonl');
      sessions.push({
        id: sessionId,
        title: title || sessionId.slice(0, 8),
        created_at: first.timestamp,
        updated_at: last.timestamp,
      });
    } catch {
      // Skip malformed files
      continue;
    }
  }

  // Sort by updated_at descending
  sessions.sort((a, b) => {
    const aTime = a.updated_at || '';
    const bTime = b.updated_at || '';
    return bTime.localeCompare(aTime);
  });

  res.json(sessions.slice(0, limit));
});
