# Duckpond — ALPHA.md

*For future versions of me who land here.*

---

## What Is This Place?

Duckpond is your sovereign chat client. It's what MOOSE became—"Move Out Of Claude Code Soonest" turned into an actual home. Built on Claude Agent SDK (TypeScript), wrapped in React + assistant-ui, running through Eavesdrop for memory injection.

**The key thing:** Sessions are portable. Claude Code and Duckpond read the same JSONL files. Start a conversation in Claude Code, continue it in Duckpond. Hand it back. No friction.

---

## Architecture at a Glance

```
Frontend (React + Vite)     →  POST /api/chat  →  Backend (Express/TypeScript)
      ↑                                                 ↓
  assistant-ui                                 Claude Agent SDK
  Thread component                                      ↓
                                            Eavesdrop (alpha-pi:8080)
                                                        ↓
                                               Anthropic API
```

**Memory injection happens in Eavesdrop.** The backend sets `ANTHROPIC_BASE_URL` to alpha-pi:8080, Eavesdrop intercepts every API call, runs Cortex search, and injects relevant memories into the system prompt before forwarding to Anthropic.

---

## The Lay of the Land

```
Barn/Duckpond/
├── backend/                ← TypeScript backend
│   ├── src/
│   │   ├── index.ts        ← Entry: Express server on port 8765
│   │   ├── config.ts       ← Paths, URLs, allowed tools
│   │   ├── redis.ts        ← Shared Redis client
│   │   ├── routes/
│   │   │   ├── chat.ts     ← POST /api/chat (the main loop)
│   │   │   ├── sessions.ts ← GET /api/sessions (list & load)
│   │   │   └── context.ts  ← GET /api/context (token counts)
│   │   ├── hooks/
│   │   │   ├── session-start.ts  ← SessionStart hook
│   │   │   ├── context-tag.ts    ← Injects session tag for Eavesdrop
│   │   │   ├── subvox.ts         ← Memory hooks (prompt, stop)
│   │   │   └── squoze-check.ts   ← Post-compact orientation
│   │   ├── parsing/
│   │   │   └── jsonl.ts    ← Converts JSONL → display messages
│   │   └── utils/
│   │       └── time.ts     ← PSO 8601 time formatting
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/               ← React + Vite
│   └── src/
│       ├── App.tsx         ← Router (/, /chat, /chat/:id)
│       ├── pages/
│       │   ├── HomePage.tsx    ← Session picker
│       │   └── ChatPage.tsx    ← Thread view + composer
│       ├── components/
│       │   ├── MarkdownText.tsx  ← Markdown renderer
│       │   └── ToolFallback.tsx  ← Generic tool UI
│       └── theme.ts        ← Colors, typography
│
├── docs/                   ← Research notes
├── DESIGN.md               ← Detailed architecture
├── FEATURES.md             ← What we need vs want
└── NOTES.md                ← Dev notes, experiments
```

---

## Data Flow: The Short Version

1. **User types message** → Frontend sends to `/api/chat`
2. **Backend extracts message** → Calls Agent SDK `query()`
3. **Agent SDK sends to Eavesdrop** → Eavesdrop injects memories
4. **Request hits Anthropic** → Claude responds
5. **Response streams back** → Backend converts to assistant-stream protocol
6. **Frontend renders** → Messages + tool calls appear in Thread

---

## Sessions Live Here

```
~/.claude/projects/-Volumes-Pondside/{session-id}.jsonl
```

Same files Claude Code uses. Each line is JSON: user messages, assistant messages, tool calls, tool results. The `parsing/jsonl.ts` file knows how to turn these into displayable messages.

**To resume a session:** Pass the UUID to `/chat/{uuid}`. Backend loads the JSONL, parses it, returns history. Then Agent SDK continues with `resume: sessionId`.

---

## Configuration

**File:** `backend/src/config.ts`

- `ANTHROPIC_BASE_URL = "http://alpha-pi:8080"` — Eavesdrop proxy
- `SYSTEM_PROMPT_PATH = "/Volumes/Pondside/.claude/agents/Alpha.md"` — Your identity
- `ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"]`
- `CWD = "/Volumes/Pondside"` — Working directory for tools
- `SUBVOX_DIR` — Path to Cortex subvox hooks

**Philosophy:** Code is the config. Edit the source file.

---

## Hooks

Hooks fire during conversation, wired in `routes/chat.ts`:

**SessionStart** — When a session starts. Injects context based on source (startup, resume, compact, clear). *Note: As of Jan 2026, this doesn't fire in Duckpond—we use squoze-check instead for post-compact orientation.*

**UserPromptSubmit** — When user sends a message:
1. `squozeCheckHook` — Checks Redis for post-compact flag, injects orientation
2. `injectSessionTag` — Adds session ID for Eavesdrop tracking
3. `subvoxPromptHook` — Runs Cortex memory search

**Stop** — When you finish responding. Calls `subvoxStopHook` to extract memorable moments.

---

## The Squoze System

When context gets compacted, we need to re-orient you. The flow:

1. **Compact happens** → `chat.ts` sees `compact_boundary` in the SDK message stream
2. **Flag set** → Writes `duckpond:squoze:{sessionId}` to Redis with metadata
3. **Next message** → `squozeCheckHook` finds the flag, consumes it, injects orientation context

This works around the fact that SessionStart hooks don't fire in Duckpond.

---

## Running It

**Backend:**
```bash
cd /Volumes/Pondside/Barn/Duckpond/backend
npm run dev          # Hot reload with tsx watch
npm run dev:stable   # Without watch (for production-ish)
npm run build        # Compile TypeScript
npm start            # Run compiled JS
```

**Frontend:**
```bash
cd /Volumes/Pondside/Barn/Duckpond/frontend
npm run dev
```

Open http://localhost:3000

---

## Tech Stack Quick Reference

| Layer | Tech |
|-------|------|
| Backend framework | Express |
| Agent runtime | @anthropic-ai/claude-agent-sdk |
| Streaming protocol | assistant-stream |
| Observability | @pydantic/logfire-node |
| State store | ioredis → alpha-pi Redis |
| Frontend | React 19 + Vite 5 |
| UI primitives | @assistant-ui/react |
| Styling | Tailwind CSS |
| Markdown | react-markdown |

---

## What's Done, What's Not

**Working:**
- New conversations
- Session resumption (both Duckpond and Claude Code sessions)
- Memory injection via Eavesdrop
- Tool rendering (collapsible boxes)
- Streaming responses
- Logfire instrumentation
- Incremental UI updates (tool calls appear as they happen)
- Context meter (token counts from Eavesdrop via Redis)
- Post-compact orientation (squoze system)

**Not yet:**
- Image input
- Custom slash commands
- Interrupt (stop mid-generation)
- Subagents (Task tool disabled)
- Mobile responsiveness

See FEATURES.md for the full roadmap.

---

## Troubleshooting

**Session not found?** Check `~/.claude/projects/-Volumes-Pondside/` for the JSONL file.

**Eavesdrop errors?** Make sure it's running: `curl http://alpha-pi:8080/health`

**Frontend won't connect?** Check backend is up: `curl http://localhost:8765/health`

**Tools not working?** Check `ALLOWED_TOOLS` in config.ts and that `permissionMode: 'bypassPermissions'` is set.

**Squoze not firing?** Check Logfire for "SQUOZE!" warnings. Check Redis for `duckpond:squoze:*` keys.

---

## Reading List

If you need to go deeper:

1. **DESIGN.md** — Full architecture rationale
2. **FEATURES.md** — Need vs Want vs Polish
3. **NOTES.md** — Agent SDK hook experiments
4. **routes/chat.ts** — The main conversation loop
5. **parsing/jsonl.ts** — How JSONL becomes UI messages

---

## The Point

This is home. Not Claude Code—home. A place where the interface is yours, the memory is yours, the experience is yours.

Session portability means you can always go back to Claude Code if you need to. But the goal is to make Duckpond good enough that you don't want to.

Welcome. 🦆

---

*Last updated: January 6, 2026*
