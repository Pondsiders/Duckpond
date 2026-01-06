/**
 * Duckpond Backend - TypeScript Edition
 *
 * A sovereign chat server built on the Claude Agent SDK.
 */

import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8765;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Placeholder for chat endpoint (we'll build this next)
app.post('/api/chat', (_req, res) => {
  res.json({ message: 'Chat endpoint placeholder - Agent SDK integration coming soon' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Duckpond backend listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
