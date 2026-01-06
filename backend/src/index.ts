/**
 * Duckpond Backend - TypeScript Edition
 *
 * A sovereign chat server built on the Claude Agent SDK.
 * Now with native SessionStart hooks!
 */

import * as logfire from '@pydantic/logfire-node';
import express from 'express';
import cors from 'cors';

import { configureEnvironment } from './config.js';
import { chatRouter } from './routes/chat.js';
import { sessionsRouter } from './routes/sessions.js';
import { contextRouter } from './routes/context.js';

// Configure Logfire first
logfire.configure({
  serviceName: 'duckpond-backend',
  serviceVersion: '0.1.0',
});

logfire.info('Logfire initialized for duckpond-backend');

// Configure environment (Eavesdrop proxy, etc.)
configureEnvironment();

const app = express();
const PORT = process.env.PORT || 8765;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow large image uploads

// Routes
app.use(chatRouter);
app.use(sessionsRouter);
app.use(contextRouter);

// Health check
app.get('/health', (_req, res) => {
  logfire.debug('Health check requested');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  logfire.info('Server started', { port: PORT });
  console.log(`Duckpond backend (TypeScript) listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Chat endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`Sessions: GET http://localhost:${PORT}/api/sessions`);
});
