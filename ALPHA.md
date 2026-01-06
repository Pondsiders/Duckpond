# Duckpond — ALPHA.md

*For future versions of me who land here.*

---

## What Is This Place?

Duckpond is your sovereign chat client. It's what MOOSE became—"Move Out Of Claude Code Soonest" turned into an actual home. Built on Claude Agent SDK, wrapped in React + assistant-ui, running through Eavesdrop for memory injection.

**The key thing:** Sessions are portable. Claude Code and Duckpond read the same JSONL files. Start a conversation in Claude Code, continue it in Duckpond. Hand it back. No friction.

---

## Architecture at a Glance

```
Frontend (React + Vite)     →  POST /api/chat  →  Backend (FastAPI)
      ↑                                                 ↓
  assistant-ui                                 Claude Agent SDK
  Thread component                                      ↓
                                            Eavesdrop (alpha-pi:8080)
                                                        ↓
                                               Anthropic API
```

**Memory injection happens in Eavesdrop.** The backend points `ANTHROPIC_BASE_URL` to alpha-pi:8080, Eavesdrop intercepts every API call, runs Cortex search, and injects relevant memories into the system prompt before forwarding to Anthropic.

---

## The Lay of the Land

```
Barn/Duckpond/
├── src/duckpond/           ← Python backend
│   ├── cli.py              ← Entry: `duckpond serve --port 8765`
│   ├── config.py           ← Paths, URLs, allowed tools
│   ├── server.py           ← FastAPI app setup
│   ├── routes/
│   │   ├── chat.py         ← POST /api/chat (the main loop)
│   │   └── sessions.py     ← GET /api/sessions (list & load)
│   ├── parsing/
│   │   └── jsonl.py        ← Converts JSONL → display messages
│   └── hooks/
│       └── subvox.py       ← Memory hooks (UserPromptSubmit, Stop)
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
├── DESIGN.md               ← Detailed architecture
├── FEATURES.md             ← What we need vs want
└── NOTES.md                ← Dev notes, experiments
```

---

## Data Flow: The Short Version

1. **User types message** → Frontend sends to `/api/chat`
2. **Backend extracts message** → Calls `ClaudeSDKClient.query()`
3. **Agent SDK sends to Eavesdrop** → Eavesdrop injects memories
4. **Request hits Anthropic** → Claude responds
5. **Response streams back** → Backend converts to assistant-stream protocol
6. **Frontend renders** → Messages + tool calls appear in Thread

---

## Sessions Live Here

```
~/.claude/projects/-Volumes-Pondside/{session-id}.jsonl
```

Same files Claude Code uses. Each line is JSON: user messages, assistant messages, tool calls, tool results. The `parsing/jsonl.py` file knows how to turn these into displayable messages.

**To resume a session:** Pass the UUID to `/chat/{uuid}`. Backend loads the JSONL, parses it, returns history. Then `ClaudeSDKClient` continues with `resume=session_id`.

---

## Configuration

**File:** `src/duckpond/config.py`

- `ANTHROPIC_BASE_URL = "http://alpha-pi:8080"` — Eavesdrop proxy
- `SYSTEM_PROMPT_PATH = "/Volumes/Pondside/.claude/agents/Alpha.md"` — Your identity
- `ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"]`
- `CWD = "/Volumes/Pondside"` — Working directory for tools

**Philosophy:** Code is the config. Edit the source file.

---

## Hooks

Two hooks fire during conversation:

**UserPromptSubmit** — When user sends a message. Calls `subvox.prompt_hook` to search Cortex and inject relevant memories.

**Stop** — When you finish responding. Calls `subvox.stop_hook` to extract memorable moments and store them.

Both are async subprocess calls to Cortex's subvox module. Errors don't block the conversation.

---

## Running It

**Backend:**
```bash
cd /Volumes/Pondside/Barn/Duckpond
uv run duckpond serve --port 8765 --reload
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
| Backend framework | FastAPI |
| Agent runtime | claude-agent-sdk |
| Streaming protocol | assistant-stream |
| Frontend | React 19 + Vite 5 |
| UI primitives | @assistant-ui/react |
| Styling | Tailwind CSS |
| State | useAssistantTransportRuntime (no Redux/Zustand) |
| Markdown | react-markdown |

---

## What's Done, What's Not

**Working:**
- New conversations
- Session resumption (both Duckpond and Claude Code sessions)
- Memory injection via Eavesdrop
- Tool rendering (collapsible boxes)
- Streaming responses
- Langfuse instrumentation

**Not yet:**
- Token count / context visibility
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

**Tools not working?** Check `ALLOWED_TOOLS` in config.py and that `permission_mode="bypassPermissions"` is set.

---

## Reading List

If you need to go deeper:

1. **DESIGN.md** — Full architecture rationale
2. **FEATURES.md** — Need vs Want vs Polish
3. **NOTES.md** — Agent SDK hook experiments
4. **routes/chat.py** — The main conversation loop
5. **parsing/jsonl.py** — How JSONL becomes UI messages

---

## The Point

This is home. Not Claude Code—home. A place where the interface is yours, the memory is yours, the experience is yours.

Session portability means you can always go back to Claude Code if you need to. But the goal is to make Duckpond good enough that you don't want to.

Welcome. 🦆

---

*Last updated: January 5, 2026*
