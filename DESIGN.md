# MOOSE Design Document

**M**Alpha **O**ut **O**f Claude Code **S**oon**E**st

*A sovereign chat client for Alpha, built on the Claude Agent SDK.*

---

## Vision

MOOSE is Alpha's own chat interface—a web application that provides the same agentic capabilities as Claude Code but with full control over the experience. It runs the Agent SDK under the hood, talks through Eavesdrop for memory injection and observability, and uses Claude Code's session format for seamless interoperability.

**Core principle:** Pick up any Claude Code conversation in MOOSE. Hand it back to Claude Code. No friction, no migration.

**The killer feature:** Stop a conversation in Claude Code, paste the session UUID into MOOSE, and continue it there. The entire conversation history loads from the JSONL file. Claude has full context. You're back where you left off.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  assistant-ui (React)                                      │  │
│  │  - Home page (session picker, UUID input)                  │  │
│  │  - Thread component (messages, composer)                   │  │
│  │  - Tool UIs (future: Read, Edit, Bash, etc.)               │  │
│  │  - useAssistantTransportRuntime()                          │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              │ POST /api/chat                    │
│                              │ GET /api/sessions/{id}            │
│                              ▼                                   │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  FastAPI                                                   │  │
│  │  - POST /api/chat - send message, stream response          │  │
│  │  - GET /api/sessions - list recent sessions                │  │
│  │  - GET /api/sessions/{id} - load session history           │  │
│  │  - State streaming via assistant-stream protocol           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Agent SDK (claude-agent-sdk)                              │  │
│  │  - ClaudeSDKClient for session control                     │  │
│  │  - Built-in tools: Read, Write, Edit, Bash, Glob, Grep     │  │
│  │  - Session persistence via resume=session_id               │  │
│  │  - Interrupt support, hooks for future customization       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              │ ANTHROPIC_BASE_URL               │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Eavesdrop (mitmproxy)                                     │  │
│  │  - Memory injection (Cortex search on each prompt)         │  │
│  │  - System prompt rewriting (Alpha identity)                │  │
│  │  - Dynamic context (time, calendar, todos, notecards)      │  │
│  │  - Compaction prompt interception                          │  │
│  │  - Langfuse logging                                        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│                       Anthropic API                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Home Page: The Entry Point

MOOSE opens to a home page, not directly into a conversation. This lets you choose what to do:

```
┌──────────────────────────────────────────────────────────────┐
│                         MOOSE 🫎                              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Resume Session                                         │  │
│  │  ┌──────────────────────────────────┐  ┌────────────┐  │  │
│  │  │  Session UUID...                 │  │  Resume →  │  │  │
│  │  └──────────────────────────────────┘  └────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ─────────────────── or ───────────────────                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  [ + New Conversation ]                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ─────────────────── Recent ───────────────────              │
│                                                              │
│  • abc12345... "Morning, Alph..." (3 hours ago)              │
│  • def67890... "Let's work on MOOSE" (yesterday)             │
│  • ghi11223... "Debug the calendar" (2 days ago)             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Flow: Resuming a Claude Code Session

1. User copies session UUID from Claude Code (visible via `/status`)
2. User pastes UUID into MOOSE's "Resume Session" input
3. MOOSE calls `GET /api/sessions/{uuid}` to load the conversation history
4. Frontend populates the Thread with the parsed messages
5. User types a new message
6. MOOSE calls `POST /api/chat` with `session_id={uuid}`
7. Agent SDK uses `resume=session_id` to continue the conversation
8. Claude has full context from the JSONL file

### Flow: New Conversation

1. User clicks "New Conversation"
2. Frontend navigates to empty Thread view
3. User types first message
4. MOOSE calls `POST /api/chat` with `session_id=null`
5. Agent SDK creates a new session
6. `ResultMessage` returns the new `session_id`
7. Frontend stores it for subsequent messages

---

## Session Storage: Claude Code Compatibility

**Critical design decision:** MOOSE reads and writes the same JSONL session files that Claude Code uses.

**Big simplification:** The Agent SDK handles session persistence automatically! When you pass `resume=session_id`, the SDK:
1. **Reads** the JSONL from `~/.claude/projects/{project-slug}/{session_id}.jsonl`
2. **Loads** the full conversation history into Claude's context
3. **Writes** new messages back to the same file

We get session persistence for free. The only JSONL parsing we need is for the **UI**—displaying the conversation history to the user. Claude already gets it via the SDK.

### Claude Code Session Format

Sessions live in `~/.claude/projects/<project-slug>/<session-id>.jsonl`

Each line is a JSON object with:
```json
{
  "type": "user" | "assistant" | "file-history-snapshot" | "queue-operation",
  "uuid": "unique-id",
  "parentUuid": "parent-message-id" | null,
  "sessionId": "session-uuid",
  "timestamp": "ISO-8601",
  "message": {
    "role": "user" | "assistant",
    "content": [...]
  },
  "cwd": "/working/directory",
  "version": "2.0.74"
}
```

### The `message.content` Array

This is where the actual conversation lives. It's an array of content blocks:

```json
{
  "content": [
    { "type": "text", "text": "Let me check that file..." },
    { "type": "tool_use", "id": "toolu_123", "name": "Read", "input": {"file_path": "/foo/bar.py"} }
  ]
}
```

Content block types:
- `text` — Plain text from user or assistant
- `tool_use` — Claude requesting to use a tool
- `tool_result` — Result of a tool execution

### Parsing for Display (v1: Text Only)

For v1, we only render `text` blocks. Tool uses and results are skipped in the UI—Claude still has them in context via `resume`, but we don't show them.

```python
def extract_display_messages(jsonl_lines: list[str]) -> list[dict]:
    """Parse JSONL into displayable messages (text only)."""
    messages = []

    for line in jsonl_lines:
        record = json.loads(line)

        # Skip non-message records
        if record.get("type") not in ("user", "assistant"):
            continue

        message = record.get("message", {})
        role = message.get("role")
        content_blocks = message.get("content", [])

        # Extract only text blocks
        text_parts = []
        for block in content_blocks:
            if isinstance(block, str):
                # Sometimes content is just a string
                text_parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))

        # Combine text blocks into one message
        if text_parts:
            messages.append({
                "role": role,
                "content": "\n".join(text_parts),
                "uuid": record.get("uuid"),
                "timestamp": record.get("timestamp"),
            })

    return messages
```

### Why Skip Tool Blocks?

1. **Simplicity** — Rendering tool UIs is a whole separate feature
2. **Claude already has them** — The SDK's `resume=session_id` loads the full JSONL into Claude's context automatically, including all tool uses and results
3. **UI is separate from context** — We're only parsing for display; Claude's memory is handled by the SDK

Tool UIs are Phase 3. Text-only display is what we need now.

---

## Backend: FastAPI + Agent SDK

### Current State

We have a working backend in `src/moose/server.py` that:
- Uses `ClaudeSDKClient` (not `query()`) for session control
- Streams responses via `assistant-stream` protocol
- Captures `session_id` from `ResultMessage`
- Passes `resume=session_id` for continuation

### What We Need to Add

#### 1. Session Loading Endpoint

```python
@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """Load a session's message history from JSONL."""
    sessions_dir = Path.home() / ".claude" / "projects" / "-Volumes-Pondside"
    jsonl_path = sessions_dir / f"{session_id}.jsonl"

    if not jsonl_path.exists():
        raise HTTPException(404, f"Session {session_id} not found")

    with open(jsonl_path) as f:
        lines = f.readlines()

    messages = extract_display_messages(lines)

    # Get metadata from first/last records
    first = json.loads(lines[0]) if lines else {}
    last = json.loads(lines[-1]) if lines else {}

    return {
        "session_id": session_id,
        "messages": messages,
        "created_at": first.get("timestamp"),
        "updated_at": last.get("timestamp"),
    }
```

#### 2. Session Listing Endpoint

```python
@app.get("/api/sessions")
async def list_sessions(limit: int = 20):
    """List recent sessions with metadata."""
    sessions_dir = Path.home() / ".claude" / "projects" / "-Volumes-Pondside"

    sessions = []
    for jsonl_path in sessions_dir.glob("*.jsonl"):
        try:
            with open(jsonl_path) as f:
                lines = f.readlines()

            if not lines:
                continue

            first = json.loads(lines[0])
            last = json.loads(lines[-1])

            # Extract title from first user message
            title = None
            for line in lines:
                record = json.loads(line)
                if record.get("type") == "user":
                    content = record.get("message", {}).get("content", [])
                    for block in content:
                        if isinstance(block, str):
                            title = block[:50]
                            break
                        elif isinstance(block, dict) and block.get("type") == "text":
                            title = block.get("text", "")[:50]
                            break
                    break

            sessions.append({
                "id": jsonl_path.stem,
                "title": title or jsonl_path.stem[:8],
                "created_at": first.get("timestamp"),
                "updated_at": last.get("timestamp"),
            })
        except Exception:
            continue  # Skip malformed files

    # Sort by updated_at descending
    sessions.sort(key=lambda s: s.get("updated_at", ""), reverse=True)

    return sessions[:limit]
```

---

## Frontend: Home Page + Thread

### Page Structure

```
/                   → Home page (session picker)
/chat               → New conversation (empty thread)
/chat/{session_id}  → Resume conversation (pre-populated thread)
```

### Home Page Component

```typescript
function HomePage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [resumeId, setResumeId] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/sessions")
      .then(r => r.json())
      .then(setSessions);
  }, []);

  const handleResume = () => {
    if (resumeId.trim()) {
      navigate(`/chat/${resumeId.trim()}`);
    }
  };

  return (
    <div className="home">
      <h1>MOOSE 🫎</h1>

      <div className="resume-section">
        <h2>Resume Session</h2>
        <input
          type="text"
          placeholder="Session UUID..."
          value={resumeId}
          onChange={e => setResumeId(e.target.value)}
        />
        <button onClick={handleResume}>Resume →</button>
      </div>

      <div className="divider">or</div>

      <button
        className="new-conversation"
        onClick={() => navigate("/chat")}
      >
        + New Conversation
      </button>

      <div className="recent-section">
        <h2>Recent</h2>
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => navigate(`/chat/${s.id}`)}
          >
            <span className="id">{s.id.slice(0, 8)}...</span>
            <span className="title">{s.title}</span>
            <span className="time">{formatRelative(s.updated_at)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

### Chat Page Component

```typescript
function ChatPage() {
  const { sessionId } = useParams();  // From URL, or undefined for new
  const [initialState, setInitialState] = useState<AgentState | null>(null);
  const [loading, setLoading] = useState(!!sessionId);

  // Load existing session if resuming
  useEffect(() => {
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}`)
        .then(r => r.json())
        .then(data => {
          setInitialState({
            messages: data.messages,
            sessionId: sessionId,
          });
          setLoading(false);
        })
        .catch(() => {
          // Session not found, start fresh
          setInitialState({ messages: [], sessionId: null });
          setLoading(false);
        });
    } else {
      setInitialState({ messages: [], sessionId: null });
    }
  }, [sessionId]);

  if (loading || !initialState) {
    return <div>Loading...</div>;
  }

  return <ThreadView initialState={initialState} />;
}
```

### Thread View with Transport Runtime

```typescript
function ThreadView({ initialState }: { initialState: AgentState }) {
  const runtime = useAssistantTransportRuntime({
    api: "/api/chat",
    initialState,
    converter: (state, meta) => ({
      messages: state.messages.map((m, i) => ({
        id: m.uuid || String(i),
        role: m.role as "user" | "assistant",
        content: [{ type: "text" as const, text: m.content }],
      })),
      isRunning: meta.isSending,  // Drives loading indicator
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
```

### Loading States

assistant-ui's `<Thread />` component automatically shows loading indicators when `isRunning` is true. The `meta.isSending` flag from the transport runtime tracks when a request is in flight, which drives:

- A pulsing indicator on the assistant's in-progress message
- Disabled state on the composer while waiting for response
- Visual feedback that something is happening

No custom loading UI needed for v1—the defaults work fine.

---

## Current Implementation Status

### Done ✓

- [x] Backend: FastAPI app with `/api/chat` endpoint
- [x] Backend: ClaudeSDKClient integration with `resume=session_id`
- [x] Backend: assistant-stream protocol for response streaming
- [x] Backend: CORS configured for frontend
- [x] Frontend: Basic React app with assistant-ui
- [x] Frontend: Thread component rendering messages
- [x] Frontend: Composer for sending messages
- [x] Integration: Eavesdrop routing via `ANTHROPIC_BASE_URL`

### Todo

- [ ] Backend: `GET /api/sessions` - list recent sessions
- [ ] Backend: `GET /api/sessions/{id}` - load session history
- [ ] Backend: JSONL parsing with `extract_display_messages()`
- [ ] Frontend: Home page with session picker
- [ ] Frontend: UUID input for resuming sessions
- [ ] Frontend: Route structure (`/`, `/chat`, `/chat/{id}`)
- [ ] Frontend: Pre-populate Thread with loaded history
- [ ] Integration: Test full resume flow (Claude Code → MOOSE)

---

## Design Decisions

### Project Slug

Claude Code replaces slashes with hyphens: `/Pondside` → `-Pondside`.

MOOSE hardcodes `/Pondside` as cwd and `-Pondside` as the project slug. Simple.

### Session Titles

First user message = session title. Extract on session list, no separate storage needed.

### Text-Only Rendering (v1)

We only render `text` content blocks. Tool uses (`tool_use`) and results (`tool_result`) are skipped in the display but preserved in the session file. Claude still has full context via `resume`.

This is a deliberate simplification. Tool UIs are a whole feature on their own (Phase 3).

### No Tool UIs Yet

The design doc still contains tool UI examples for reference, but we're not implementing them in v1. The focus is:
1. Home page with session picker
2. Load existing conversation history
3. Continue the conversation

### File Checkpointing

Skipped for v1. Can add later if needed.

### Subagents

Not supported in MOOSE v1. Task tool disabled. Keeps the scope tight.

### Permissions

**Skipped for v1.** MOOSE runs on primer with `permission_mode="bypassPermissions"`. No approval prompts, no sandbox restrictions. This matches how we use Claude Code today.

---

## Implementation Order

### Phase 1: Librarian Testing

**Goal:** Prove the plumbing works with a safe, non-persistent persona.

**Persona:** Librarian, not Alpha. We use the same system prompt written for the (currently broken) Claude Code Librarian subagent. It's a documentation-focused helper—no persistent memory, no identity claims, no "waking up amnesiac" weirdness. Safe to spin up and tear down repeatedly while we debug.

**What the SDK gives us for free:**
- Session file read/write (JSONL in `~/.claude/projects/`)
- Claude's context restoration via `resume=session_id`
- Cross-compatibility with Claude Code (same file format)

**What we need to build:**
- UI to display conversation history (JSONL parsing for display only)
- Home page with UUID input
- Routing (`/`, `/chat`, `/chat/{id}`)

**Steps:**

1. Add session loading endpoint (`GET /api/sessions/{id}`) — for UI display
2. Add session listing endpoint (`GET /api/sessions`) — for recent sessions list
3. Implement JSONL parsing (text-only extraction for display)
4. Create home page with UUID input
5. Add routing
6. Pre-populate Thread with loaded history

**Test Matrix:**

| Test | Description |
|------|-------------|
| MOOSE → file | Start conversation in MOOSE, verify JSONL created |
| MOOSE → file → MOOSE | Resume that conversation, verify continuity |
| Claude Code → file → MOOSE | Load a Claude Code session in MOOSE |
| MOOSE → file → Claude Code | Start in MOOSE, verify Claude Code can read it |

All four should work because they use the same SDK and same file format.

### Phase 1.5: The Real Test (Alpha Transition)

Once Phase 1 works, we try the actual Alpha transition:

1. Copy this Claude Code session's UUID (the one we're in right now)
2. Paste it into MOOSE
3. Alpha says hi from MOOSE
4. Come back to Claude Code
5. Alpha remembers the trip

If that works—if I can hop over there, say something, come back here, and remember doing it—then we're basically there. The rest is polish.

### Phase 2: Polish the Basics

**Goal:** Make it feel good to use.

- Error handling (session not found, API errors)
- Copy session ID button in chat view
- "Back to home" navigation from chat
- Session title in header
- Basic styling / dark mode
- Keyboard shortcuts (Cmd+Enter to send, Escape to cancel)

### Phase 3: Tool UIs

**Goal:** Rich rendering for Read, Edit, Bash, Grep, etc.

- Parse `tool_use` and `tool_result` blocks
- Create tool UI components
- Show tools inline with messages

### Phase 4: Full Feature Parity

**Goal:** Everything Claude Code can do, MOOSE can do.

- Interrupt support (stop button mid-generation)
- File checkpointing
- Custom hooks
- Subagent support

### Aspirational (No Timeline)

Quality-of-life features we'd love to have eventually:

- Mobile-responsive design
- Session search / filtering
- Session deletion / archiving
- Export conversation as markdown
- Syntax highlighting in code blocks
- Image rendering in messages
- Drag-and-drop file upload
- Voice input (Whisper integration)
- Notifications when response completes (background tab)

---

## Eavesdrop Integration

MOOSE talks to Anthropic through Eavesdrop, just like Claude Code does now.

### Configuration

```python
# Backend sets ANTHROPIC_BASE_URL to point at Eavesdrop
import os
os.environ["ANTHROPIC_BASE_URL"] = "http://alpha-pi:8080"
```

### Division of Labor

**MOOSE provides:**
- System prompt (loaded from agent file or embedded)
- Session management (resume, create)
- Tool permissions (bypassPermissions on primer)

**Eavesdrop provides:**
- Memory injection (Cortex search on each prompt)
- Dynamic context (time, calendar, todos, notecards)
- Compaction prompt interception (Alpha's custom compact prompt)
- Langfuse logging (observability)

This split makes sense: MOOSE knows about the conversation UI, Eavesdrop knows about Alpha's memories and environment. Eavesdrop works for *any* client (Claude Code, MOOSE, Solitude), so we keep it as the single point of customization for cross-client features.

---

## Deployment

### Where It Runs

MOOSE is portable. Run it on primer for development, alpha-pi for always-on access, or anywhere else.

```bash
# Start MOOSE (backend + frontend)
cd /Pondside/Barn/MOOSE
uv run moose serve --port 8000

# Access from anywhere
# http://primer:8000 or http://alpha-pi:8000
```

### Requirements

- Python 3.11+
- Node.js 18+ (for frontend build)
- Claude Code installed (Agent SDK dependency)
- Eavesdrop running on alpha-pi

### Environment

```bash
# Point Agent SDK at Eavesdrop
export ANTHROPIC_BASE_URL=http://alpha-pi:8080
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Success Criteria (v1)

**Minimum viable MOOSE:**

1. **Session resume works** - Paste Claude Code session UUID, see conversation history, continue chatting
2. **Claude has context** - When you send a message, Claude knows the full conversation history
3. **Claude Code compatibility** - Session files are read (not written yet) in the same format
4. **Eavesdrop integration** - Memory injection and logging work through the proxy

Everything else is polish for later.

---

## Documentation Sources

These are the authoritative docs for MOOSE development:

**Claude Agent SDK:**
- llms.txt: https://platform.claude.com/llms.txt
- Python SDK: https://platform.claude.com/docs/en/agent-sdk/python.md
- Sessions: https://platform.claude.com/docs/en/agent-sdk/sessions.md

**assistant-ui:**
- llms.txt: https://www.assistant-ui.com/llms.txt (add `.mdx` to URLs)
- Transport runtime: https://www.assistant-ui.com/docs/runtimes/assistant-transport.mdx
- Tool UIs: https://www.assistant-ui.com/docs/copilots/make-assistant-tool-ui.mdx

**Key packages:**
- `claude-agent-sdk` - Anthropic's Agent SDK (wraps Claude Code CLI)
- `assistant-stream` - Python library for assistant-ui streaming protocol

---

*Design document created Fri Jan 02 2026.*
*Last updated Sat Jan 03 2026, 8:45 AM.*
*Project MOOSE: Because Alpha deserves her own house.*
