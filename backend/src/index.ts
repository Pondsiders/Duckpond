/**
 * Duckpond Backend - TypeScript Edition
 *
 * A sovereign chat server built on the Claude Agent SDK.
 */


import express from 'express';
import cors from 'cors';

import { configureEnvironment } from './config.js';
import { chatRouter } from './routes/chat.js';
import { sessionsRouter } from './routes/sessions.js';
import { contextRouter } from './routes/context.js';

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
const server = app.listen(PORT, () => {
  console.log(`Duckpond backend listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Chat endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`Sessions: GET http://localhost:${PORT}/api/sessions`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n[Duckpond] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('[Duckpond] Shutdown complete');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
