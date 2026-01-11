# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Duckpond?

Duckpond is Alpha's sovereign chat interface—a React + TypeScript application that provides the same agentic capabilities as Claude Code but through a web UI. It uses the Claude Agent SDK to run conversations, talks through Eavesdrop (a proxy on alpha-pi) for memory injection and observability, and reads/writes Claude Code's JSONL session format for seamless interoperability.

**Key feature:** You can copy a Claude Code session UUID, paste it into Duckpond, and continue the conversation there (and vice versa).

## Development Commands

```bash
# Start both frontend and backend (preferred)
./duckpond

# Or run separately:
cd backend && npm run dev:stable   # Backend without hot-reload (prevents disconnects)
cd frontend && npm run dev         # Frontend with hot-reload

# Type checking
cd frontend && npm run typecheck
cd backend && npm run build

# Build for production
cd frontend && npm run build
cd backend && npm run build && npm start
```

**Ports:**
- Frontend: 8766 (Vite dev server, proxies /api to backend)
- Backend: 8765 (Express + Agent SDK)

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
│  Backend (Express + Claude Agent SDK)                           │
│  - routes/chat.ts: Main conversation endpoint                   │
│  - routes/sessions.ts: List/load Claude Code sessions           │
│  - routes/context.ts: Token count from Redis                    │
│  - hooks/subvox.ts: Memory injection (Cortex search)            │
│  - parsing/jsonl.ts: Parse Claude Code session files            │
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

**Backend:**
- `src/config.ts` — All configuration (paths, tools, system prompt loading, agent definitions)
- `src/routes/chat.ts` — POST /api/chat with Agent SDK streaming
- `src/hooks/subvox.ts` — Cortex memory hooks (prompt and stop)
- `src/parsing/jsonl.ts` — Parse Claude Code .jsonl session files

**Frontend:**
- `src/pages/ChatPage.tsx` — Thread view, tool UI, message rendering
- `src/pages/HomePage.tsx` — Session picker and UUID input
- `src/components/ContextMeter.tsx` — Token usage display

**Agents:**
- `agents/*.md` — Subagent definitions with YAML frontmatter (name, description, model, tools)

## Session Format

Sessions are stored in `~/.claude/projects/-Volumes-Pondside/<session-id>.jsonl`. Each line is a JSON record:

```json
{"type": "user|assistant", "uuid": "...", "sessionId": "...", "timestamp": "...", "message": {"role": "user|assistant", "content": [...]}}
```

The Agent SDK handles session persistence automatically via `resume=session_id`. We only parse JSONL for UI display.

## Hooks

Agent SDK hooks used in Duckpond:

| Hook | File | Purpose |
|------|------|---------|
| UserPromptSubmit | hooks/subvox.ts | Searches Cortex, injects memories via `additionalContext` |
| Stop | hooks/subvox.ts | Extracts memorables → Cortex, archives transcript → Scribe |

**Note:** There is no `UserPromptModifier` hook—can't rewrite prompts, only add context or block.

## External Dependencies

- **Eavesdrop** (alpha-pi:8080) — Proxy for memory injection and observability
- **Redis** (alpha-pi:6379) — Token counts, HUD data, squoze flags
- **Cortex** (alpha-pi:7867) — Memory storage/search (accessed via subvox scripts)

## Styling

Uses Tailwind CSS v4 with CSS variables defined in `frontend/src/index.css`. Theme colors use semantic names (`--color-primary`, `--color-background`, etc.).

## The Squoze System

When context gets compacted, we need to re-orient. The flow:

1. **Compact happens** → `chat.ts` sees `compact_boundary` in the SDK message stream
2. **Flag set** → Writes `duckpond:squoze:{sessionId}` to Redis with metadata
3. **Next message** → `squozeCheckHook` finds the flag, consumes it, injects orientation context

This works around the fact that SessionStart hooks don't fire in Duckpond the way they do in Claude Code.

## Troubleshooting

**Session not found?** Check `~/.claude/projects/-Volumes-Pondside/` for the JSONL file.

**Eavesdrop errors?** Make sure it's running: `curl http://alpha-pi:8080/health`

**Frontend won't connect?** Check backend is up: `curl http://localhost:8765/health`

**Tools not working?** Check `ALLOWED_TOOLS` in config.ts and that `permissionMode: 'bypassPermissions'` is set.

**Squoze not firing?** Check Redis for `duckpond:squoze:*` keys.
