/**
 * Duckpond Backend - TypeScript Edition
 *
 * A sovereign chat server built on the Claude Agent SDK.
 * Instrumented with Laminar for observability.
 */

import { Laminar } from '@lmnr-ai/lmnr';
import express from 'express';
import cors from 'cors';

import { configureEnvironment } from './config.js';
import { chatRouter } from './routes/chat.js';
import { sessionsRouter } from './routes/sessions.js';
import { contextRouter } from './routes/context.js';

// Configure Laminar FIRST (before any SDK usage)
Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  baseUrl: 'http://primer:8000',
  httpPort: 8000,
  forceHttp: true,
  logLevel: 'info',
});

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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  Laminar.event({ name: 'server_started', attributes: { port: Number(PORT) } });
  console.log(`Duckpond backend listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Chat endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`Sessions: GET http://localhost:${PORT}/api/sessions`);
});
