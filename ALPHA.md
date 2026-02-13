---
autoload: when
when: "working on or discussing Duckpond, the chat interface, memories.recall, memories.suggest"
---

## Development Commands

```bash
# Start both frontend and backend (production ports 8765/8766)
./duckpond

# Start in dev worktree (ports 8767/8768, for parallel testing)
./duckpond-dev

# Frontend only
cd frontend && npm run dev
cd frontend && npm run build
cd frontend && npm run typecheck

# Backend only
cd backend-py && uv run uvicorn duckpond.main:app --host 0.0.0.0 --port 8765

# Lint/format backend
cd backend-py && uv run ruff check src/
cd backend-py && uv run ruff format src/

# Type check backend
cd backend-py && uv run mypy src/

# Test streaming (standalone utility)
./test-streaming.py
```

## Architecture

Duckpond is Alpha's chat interface. Frontend (React + assistant-ui + Zustand) owns state locally. Backend (FastAPI + Claude Agent SDK) maintains a singleton ClaudeSDKClient. Communication is SSE streams, not round-tripped state.

```
Frontend (port 8766)                    Backend (port 8765)
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ Zustand store               │        │ DuckpondClient singleton    │
│ useExternalStoreRuntime()   │◄─SSE──►│ Claude Agent SDK            │
│ assistant-ui primitives     │        │ FastAPI routes              │
└─────────────────────────────┘        └─────────────────────────────┘
                                                    │
                                                    ▼
                                           ANTHROPIC_BASE_URL → The Loom
```

### API Endpoints

- `POST /api/chat` - Send message `{ sessionId, content, attachments }`, streams SSE response
- `GET /api/sessions/:id` - SSE stream of session history + live events
- `POST /api/chat/interrupt` - Interrupt current turn
- `GET /health` - Health check

### SSE Event Types

```typescript
type SSEEvent =
  | { type: "text"; data: string }          // Append to assistant
  | { type: "tool-call"; data: ToolCall }   // Tool invocation
  | { type: "tool-result"; data: Result }   // Tool result
  | { type: "session-id"; data: string }    // New session assigned
  | { type: "error"; data: string }
  // data: [DONE] signals stream end
```

## Key Files

**Frontend:**
- `src/store.ts` - Zustand store: messages, sessionId, isRunning, actions
- `src/pages/ChatPage.tsx` - Main conversation view with SSE handling
- `src/components/` - MarkdownText, ContextMeter, Attachment, ToolFallback

**Backend:**
- `src/duckpond/client.py` - DuckpondClient wrapper around ClaudeSDKClient singleton
- `src/duckpond/routes/chat.py` - Chat endpoint, streams SSE events
- `src/duckpond/routes/sessions.py` - Session loading/management
- `src/duckpond/tools/cortex.py` - MCP server for memory storage
- `src/duckpond/memories/` - Memory recall and suggestion pipeline

## Hard Constraints

### SDK Client Lifecycle
**CANNOT recreate ClaudeSDKClient per turn.** Each instantiation involves warmup API calls that consume significant tokens. The client MUST be reused across turns within a session. If sessionId changes, close and recreate. Same sessionId = reuse existing client.

### No State Round-Tripping
Frontend owns state locally (Zustand). Backend streams updates. Do not ship conversation history on every request.

### SSE Over WebSockets
Client sends one request, server streams many events. For client→server commands (interrupt), use separate HTTP POST endpoints.

## Structured Input Protocol

User prompts are wrapped in a JSON envelope with metadata. The Loom (via ANTHROPIC_BASE_URL) unwraps this, extracts metadata, and builds the real API call. The envelope includes:
- `canary`: `ALPHA_METADATA_UlVCQkVSRFVDSw` (identifies structured input)
- `session_id`, `pattern`, `client`, `traceparent`, `sent_at`, `prompt`
- Optional `memories` array from recall pipeline

## Observability

Backend is instrumented with Logfire (wraps OpenTelemetry). Distributed tracing via `traceparent` header propagation. Service name: `duckpond`.
