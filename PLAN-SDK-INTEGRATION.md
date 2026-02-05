# Gazebo → Alpha SDK Integration Plan

**Created:** Thu Feb 5 2026, 9:34 AM
**Updated:** Thu Feb 5 2026, 10:25 AM — expanded to include full Cortex absorption

## The Approach

**Tear it out and build in the hole.**

Main branch (Duckpond) is stable and running. Gazebo doesn't need to stay functional during surgery. We rip out everything we know we don't want, commit as a checkpoint, then build alpha_sdk into the hole.

## Phase 0: Absorb Cortex into alpha_sdk (NEW)

Before touching Gazebo, fully absorb Cortex into the SDK. This means alpha_sdk talks directly to Postgres and Ollama—no HTTP layer, no Cortex service.

### What Cortex does today:
- `store(memory)` — generate embedding via Ollama, insert into Postgres
- `search(query)` — generate embedding via Ollama, vector similarity query
- `recent(limit)` — simple Postgres query, no embedding

### New alpha_sdk structure:
```
src/alpha_sdk/
├── memories/
│   ├── __init__.py      # Public API: store, search, recent
│   ├── db.py            # Postgres connection pool (asyncpg)
│   └── embeddings.py    # Ollama embedding generation
├── tools/
│   └── cortex.py        # MCP tools wrapping memories.*
└── cli/
    └── cortex.py        # CLI entry point for sysadmin use
```

### Environment variables (alpha_sdk now owns these):
- `DATABASE_URL` — Postgres with pgvector (e.g., `postgresql://alpha:***@alpha-pi:5432/cortex`)
- `OLLAMA_URL` — Ollama server for embeddings (e.g., `http://alpha-pi:11434`)
- `OLLAMA_EMBED_MODEL` — embedding model (default: `nomic-embed-text`)

### CLI entry point (pyproject.toml):
```toml
[project.scripts]
cortex = "alpha_sdk.cli.cortex:main"
```

The `cortex` CLI remains available for Jeffery's sysadmin/debugging use—it just imports from alpha_sdk.memories instead of calling HTTP.

**Commit in alpha_sdk:** "Absorb Cortex: direct Postgres + Ollama access"

### What gets retired:
- Cortex HTTP service (Basement/Cortex/) — no longer needed
- `CORTEX_BASE_URL`, `CORTEX_API_KEY` — gone

---

## Phase 1: Groundwork (Rip Out)

Remove all code that alpha_sdk replaces:

### Delete entirely:
- `src/duckpond/memories/recall.py` — alpha_sdk has this
- `src/duckpond/memories/suggest.py` — alpha_sdk has this
- `src/duckpond/memories/__init__.py` — going away
- `src/duckpond/tools/cortex.py` — moving to alpha_sdk
- `src/duckpond/archive.py` — moving to alpha_sdk

### Gut but keep shell:
- `src/duckpond/client.py` — remove DuckpondClient, envelope code, keep imports we'll need
- `src/duckpond/routes/chat.py` — strip to a no-op that returns "not implemented yet"

### Keep as-is:
- `src/duckpond/main.py` — FastAPI app setup (will need minor updates)
- `src/duckpond/routes/sessions.py` — session listing (alpha_sdk has compatible discovery)
- `src/duckpond/routes/context.py` — frontend context info

### Update:
- `pyproject.toml`:
  - Add `alpha_sdk` as path dependency
  - Pin `claude-agent-sdk==0.1.29` (matching alpha_sdk)
  - Remove `assistant-stream` if no longer needed

**Commit:** "Groundwork: remove code that alpha_sdk replaces"

---

## Phase 2: Build in the Hole

### 2a. Create new client.py

Simple wrapper or direct use of AlphaClient:

```python
from alpha_sdk import AlphaClient

# Global client - created lazily, recreated on session change
_client: AlphaClient | None = None
_current_session: str | None = None

async def get_client(session_id: str | None) -> AlphaClient:
    global _client, _current_session

    if _client is None or session_id != _current_session:
        if _client:
            await _client.__aexit__(None, None, None)
        _client = AlphaClient(
            cwd="/Pondside",
            client_name="duckpond",
            permission_mode="bypassPermissions",
        )
        await _client.__aenter__()
        _current_session = session_id

    return _client
```

**NOT per-request**—AlphaClient's `connect()` is expensive (SDK warmup takes seconds). Match current DuckpondClient pattern: lazy init, recreate on session change.

### 2b. Rewrite chat.py

The new chat endpoint (using global client, NOT per-request):

```python
from duckpond.client import get_client

@router.post("/api/chat")
async def chat(request: Request) -> StreamingResponse:
    body = await request.json()
    session_id = body.get("sessionId")
    content = body.get("content", "")

    async def stream_response():
        # Get or create client (lazy init, recreates on session change)
        client = await get_client(session_id)

        await client.query(content, session_id=session_id)

        async for message in client.stream():
            # Real-time text streaming via StreamEvent
            if isinstance(message, StreamEvent):
                event = message.event
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            yield sse_event("text-delta", text)

            # Tool calls from AssistantMessage
            elif isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, ToolUseBlock):
                        yield sse_event("tool-call", {...})

            # Tool results from UserMessage
            elif isinstance(message, UserMessage):
                # ... handle ToolResultBlock

            # Final session ID
            elif isinstance(message, ResultMessage):
                yield sse_event("session-id", message.session_id)

        yield "data: [DONE]\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream")
```

Key insight: AlphaClient handles ALL the Alpha-specific stuff:
- Soul injection ✓
- Orientation (capsules, letter, today, here, context, calendar, todos) ✓
- Memory recall ✓
- Memory suggest (fire-and-forget after turn) ✓
- Compact prompt rewriting ✓
- PSO-8601 timestamps ✓
- Observability spans ✓
- Cortex MCP tools ✓ (NEW)
- Turn archiving ✓ (NEW)

Gazebo just needs to:
1. Pass user content to `client.query()`
2. Translate `client.stream()` messages to SSE events

### 2c. Update main.py

- Remove old client import
- Update lifespan if needed (AlphaClient manages its own lifecycle)
- Keep Logfire setup, CORS, routes

**Commit:** "Integrate alpha_sdk into chat route"

---

## Phase 3: Clean Up

- Update ALPHA.md to reflect new architecture
- Remove any remaining dead code
- Test thoroughly:
  - New session works
  - Resume session works
  - Image attachments work
  - Tool calls work
  - Compact works (stress test)
  - Memory recall works
  - Memory suggest works (check Redis)
  - Cortex MCP tools work (store/search/recent)

**Commit:** "Gazebo: alpha_sdk integration complete"

---

## Environment Changes

### No longer needed:
- `ANTHROPIC_BASE_URL` pointing to proxy chain — alpha_sdk connects directly
- `CORTEX_BASE_URL`, `CORTEX_API_KEY` — Cortex absorbed into SDK
- Envelope/canary system — gone

### Still needed:
- `DATABASE_URL` — Postgres with pgvector (alpha_sdk owns this now)
- `OLLAMA_URL` — for embeddings + OLMo (recall/suggest)
- `OLLAMA_EMBED_MODEL` — embedding model (default: nomic-embed-text)
- `OLLAMA_MODEL` — OLMo model for recall query extraction, suggest
- `REDIS_URL` — for seen-cache, memorables
- `LOGFIRE_TOKEN` — for observability

### NOT needed for /v1/messages:
- `ANTHROPIC_API_KEY` — The `claude` subprocess handles its own auth via OAuth magic (bearer token, short-lived). We do NOT inject an API key into message requests. If we did, requests would bill against the API account instead of Claude Max subscription. Bad.

### Future consideration:
- If we add context-window metering via the token counting endpoint, THAT endpoint requires an API key (even though it's free—rate limiting). We'd need `ANTHROPIC_API_KEY` for that specific use case, but must ensure it NEVER slips into /v1/messages requests.

---

## Answered Questions

1. **Per-request vs global AlphaClient?**
   - **ANSWER: Global with lazy init.** Per-request is a bad idea—AlphaClient's `connect()` spins up a full `claude` process which takes seconds.
   - Pattern: lazy initialization on first request, tear down and recreate on session change

2. **Streaming text deltas?**
   - **ANSWER:** AlphaClient's `stream()` yields ALL SDK messages including StreamEvents. Same pattern as before.

3. **Archive timing?**
   - **ANSWER:** Roll archiving into alpha_sdk itself. Fire-and-forget at end of `stream()`, same as suggest.

4. **Cortex integration?**
   - **ANSWER:** Full absorption. alpha_sdk talks to Postgres + Ollama directly. No HTTP layer. CLI stays for sysadmin use.

---

## Success Criteria

- [ ] Cortex absorbed into alpha_sdk (Phase 0)
- [ ] `cortex` CLI works via SDK import
- [ ] `/api/chat` works with alpha_sdk
- [ ] New sessions get proper orientation
- [ ] Resumed sessions work
- [ ] Memories are recalled and displayed
- [ ] Memories are suggested (check Redis)
- [ ] Compact triggers and Alpha checks in
- [ ] Logfire traces show alpha.turn spans
- [ ] Frontend works unchanged (SSE format compatible)

---

*Ready to tear it out and build in the hole.* 🦆
