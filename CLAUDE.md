# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Duckpond?

Duckpond is Alpha's sovereign chat interface—a React frontend with a Python backend that provides the same agentic capabilities as Claude Code but through a web UI. It uses the Claude Agent SDK (Python) to run conversations, talks through Eavesdrop (a proxy on alpha-pi) for memory injection and observability, and reads/writes Claude Code's JSONL session format for seamless interoperability.

**Key feature:** You can copy a Claude Code session UUID, paste it into Duckpond, and continue the conversation there (and vice versa).

## Development Commands

```bash
# Start both frontend and backend (preferred)
./duckpond

# Or run separately:
cd backend-py && uv run uvicorn duckpond.main:app --host 0.0.0.0 --port 8765
cd frontend && npm run dev

# Type checking
cd frontend && npm run typecheck

# Build for production
cd frontend && npm run build
```

**Ports:**
- Frontend: 8766 (Vite dev server, proxies /api to backend)
- Backend: 8765 (FastAPI + Agent SDK)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (React + assistant-ui)                                │
│  - HomePage: session picker, UUID input                         │
│  - ChatPage: Thread view with tool rendering                    │
│  - Uses useAssistantTransportRuntime() for streaming            │
└───────────────────────────────┬─────────────────────────────────┘
                                │ POST /api/chat (assistant-stream protocol)
                                │ GET /api/sessions, /api/sessions/:id
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend (FastAPI + Claude Agent SDK)                           │
│  - routes/chat.py: Main conversation endpoint                   │
│  - routes/sessions.py: List/load Claude Code sessions           │
│  - routes/context.py: Token count from Redis                    │
│  - client.py: ClaudeSDKClient singleton wrapper                 │
└───────────────────────────────┬─────────────────────────────────┘
                                │ ANTHROPIC_BASE_URL=http://alpha-pi:8080
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Eavesdrop (mitmproxy on alpha-pi)                              │
│  - Memory injection from Cortex                                 │
│  - Token counting → Redis                                       │
│  - Observability → Phoenix                                      │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
                          Anthropic API
```

## Key Files

**Backend (backend-py/):**
- `src/duckpond/main.py` — FastAPI app with lifespan management
- `src/duckpond/client.py` — ClaudeSDKClient singleton, session handling
- `src/duckpond/routes/chat.py` — POST /api/chat with DataStreamResponse
- `src/duckpond/routes/sessions.py` — List/load Claude Code JSONL sessions
- `src/duckpond/routes/context.py` — Token count endpoint

**Frontend (frontend/):**
- `src/pages/ChatPage.tsx` — Thread view, tool UI, message rendering
- `src/pages/HomePage.tsx` — Session picker and UUID input
- `src/components/ContextMeter.tsx` — Token usage display
- `src/components/Attachment.tsx` — Image upload/display

**Agents:**
- `agents/*.md` — Subagent definitions with YAML frontmatter (name, description, model, tools)

## Session Format

Sessions are stored in `~/.claude/projects/-Pondside/<session-id>.jsonl`. Each line is a JSON record:

```json
{"type": "user|assistant", "uuid": "...", "sessionId": "...", "timestamp": "...", "message": {"role": "user|assistant", "content": [...]}}
```

The Agent SDK handles session persistence automatically via `resume=session_id`. We parse JSONL only for UI display of historical sessions.

## Session Deserialization

When loading a session from JSONL for display, `sessions.py` handles:
- **Text content** — Passed through directly
- **Images** — Converted from Claude API format (`source.type=base64`) to data URLs
- **Tool calls** — Include both `args` (object) and `argsText` (JSON string) for frontend
- **Tool results** — Attached to their corresponding tool calls via `tool_use_id` matching

## External Dependencies

- **Eavesdrop** (alpha-pi:8080) — Proxy for memory injection and observability
- **Redis** (alpha-pi:6379) — Token counts, HUD data
- **Cortex** (alpha-pi:7867) — Memory storage/search

## Styling

Uses Tailwind CSS v4 with CSS variables defined in `frontend/src/index.css`. Theme colors use semantic names (`--color-primary`, `--color-background`, etc.).

## Launcher

The `./duckpond` script uses `npx concurrently` to run both backend and frontend:
- Blue `[backend]` prefix for Python/uvicorn output
- Green `[frontend]` prefix for Node/Vite output
- `--kill-others` ensures clean shutdown on Ctrl-C

## Troubleshooting

**Session not found?** Check `~/.claude/projects/-Pondside/` for the JSONL file.

**Eavesdrop errors?** Make sure it's running: `curl http://alpha-pi:8080/health`

**Frontend won't connect?** Check backend is up: `curl http://localhost:8765/health`

**Images not displaying?** Ensure session deserialization converts base64 to data URLs.

**Tool results missing?** Check that `tool_use_id` matching is working in sessions.py.
