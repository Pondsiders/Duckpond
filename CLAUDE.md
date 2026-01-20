# Gazebo

*What's fancier than a Duckpond? Also sounds like a long-legged African cropping quadruped with horns and a stripe.*

**Status:** Under construction. Main-branch Duckpond remains the working fallback.

---

## What Is This?

Gazebo is the rebuild of Duckpond. Same purpose—Alpha's sovereign chat interface—but with a fundamentally different architecture designed for performance and extensibility.

**The Problem with Duckpond v1:**
The current Duckpond uses `assistant-stream`'s state replication protocol, which round-trips the entire conversation state on every request. With 700+ message conversations, this means parsing multi-megabyte JSON payloads every turn. It works, but it's sluggish.

**Gazebo's Solution:**
Frontend owns state locally (Zustand). Backend is stateful (ClaudeSDKClient singleton). Communication is minimal: frontend sends `{ sessionId, content, attachments }`, backend streams SSE events. No round-tripping.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (React + assistant-ui primitives + Zustand)           │
│  - Zustand store: messages, sessionId, isRunning, inputTokens   │
│  - useExternalStoreRuntime() connects store to assistant-ui     │
│  - SSE reader updates store as events arrive                    │
│  - Everything is events: history AND live responses             │
└───────────────────────────────┬─────────────────────────────────┘
                                │ GET /api/sessions/:id → SSE stream (history + live)
                                │ POST /api/chat { sessionId, content, attachments }
                                │ POST /api/chat/interrupt
                                │ POST /api/chat/inject (future: mid-turn steering)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend (FastAPI + ClaudeSDKClient singleton)                  │
│  - client.py: Maintains SDK client across requests              │
│  - routes/chat.py: Streams SSE events (no assistant-stream!)    │
│  - routes/sessions.py: Unified SSE stream for history + live    │
│  - Tracks in-progress state for reconnection resilience         │
└───────────────────────────────┬─────────────────────────────────┘
                                │ ANTHROPIC_BASE_URL → The Loom
                                ▼
                          Anthropic API
```

---

## The Chat Loop

1. **User types, hits send**
   - Frontend immediately adds user message to Zustand (optimistic update)
   - Sets `isRunning = true`
   - User message appears instantly
   - "Alpha is thinking..." indicator shows

2. **Frontend POSTs to `/api/chat`**
   ```json
   { "sessionId": "abc-123", "content": "hello", "attachments": [] }
   ```

3. **Backend streams SSE events**
   ```
   data: {"type": "text", "data": "Hello"}
   data: {"type": "text", "data": " there!"}
   data: {"type": "tool-call", "data": {"toolCallId": "...", "toolName": "Read", ...}}
   data: {"type": "tool-result", "data": {"toolCallId": "...", "result": "..."}}
   data: {"type": "session-id", "data": "abc-123"}
   data: [DONE]
   ```

4. **Frontend processes events in real-time**
   - `text` → Append to assistant message content
   - `tool-call` → Add tool call to message, show tool UI with pulsing indicator
   - `tool-result` → Update tool call with result
   - `session-id` → Store for next request
   - `[DONE]` → Set `isRunning = false`

5. **UX Philosophy: "Show → Grow"**
   - Not "wait → show"
   - The assistant message starts empty and grows as events arrive
   - Tool UIs appear immediately and update when results come
   - The thinking indicator only shows while `isRunning && no assistant content yet`

---

## Hard Constraints

### SDK Client Lifecycle
**CANNOT recreate ClaudeSDKClient per turn.** Each instantiation involves warmup API calls that consume significant tokens. Recreating per-turn would blow our budget. The client MUST be reused across turns within a session.

The bug we're fixing: after the first successful turn, `receive_response()` hangs on subsequent calls. We need to understand and fix this, not work around it.

### No State Round-Tripping
The whole point of Gazebo is to NOT ship 700 messages on every request. The frontend owns state locally. The backend streams updates. State does not round-trip.

### SSE Over WebSockets
We use Server-Sent Events, not WebSockets. Our flow is asymmetric: client sends one request, server streams many events back. SSE is simpler, works through proxies, has automatic reconnection, and is sufficient. For client→server commands (interrupt, inject), we use separate HTTP POST endpoints.

---

## Key Decisions

### State Management: Zustand
Chosen over Redux, Jotai, Valtio for:
- Simplicity (small app, clear state shape)
- Non-React updates (SSE handlers can call store methods directly)
- No provider boilerplate
- Good TypeScript support

```typescript
interface GazeboStore {
  sessionId: string | null;
  messages: Message[];
  isRunning: boolean;
  inputTokens: number | null;

  // Pagination readiness (vestigial for now)
  totalMessageCount: number;
  hasMoreHistory: boolean;

  // Actions
  addUserMessage: (content: string, attachments?: Attachment[]) => void;
  setMessages: (messages: Message[]) => void;  // Enables branch switching in assistant-ui
  updateMessage: (id: string, updates: Partial<Message>) => void;  // For streaming updates
  setRunning: (running: boolean) => void;
  setSessionId: (id: string) => void;
}
```

Use Zustand v5 with `immer` middleware for immutable updates:
```typescript
const useGazeboStore = create<GazeboStore>()(
  immer((set) => ({
    // state and actions
  }))
);
```

### Wiring to assistant-ui

The `useExternalStoreRuntime` hook bridges Zustand to assistant-ui:

```typescript
const runtime = useExternalStoreRuntime({
  messages,                    // From Zustand
  isRunning,                   // From Zustand — triggers typing indicator automatically
  setMessages,                 // Enables edit/branch UI
  convertMessage,              // Our Message → ThreadMessageLike
  onNew: async (message) => {  // Called when user sends
    // 1. Add user message to store (optimistic)
    // 2. POST to /api/chat
    // 3. Process SSE events, updating store as they arrive
  },
});
```

Key behaviors we get for free:
- **Typing indicator** — Shows automatically when `isRunning` is true
- **Tool result matching** — Runtime matches `toolCallId` between call and result
- **Branch switching** — Enabled by providing `setMessages`
- **Message conversion** — `convertMessage` transforms our format to assistant-ui's

### Pagination: Design for It, Don't Build It Yet
Ship simple: all messages, plain scrollable div, no virtualization. We tried React Virtuoso; it fought us (wrong scroll positions, zero-sized elements, refs that wouldn't attach).

But include metadata fields so pagination is possible later:
- `totalMessageCount` (may differ from `messages.length` if paginated)
- `hasMoreHistory` (always false for now)
- `oldestLoadedId` (for cursor-based loading)

When/if we need backwards infinite scroll, the data shape already supports it.

### SSE Format
Simple, custom, not assistant-stream:

```typescript
type SSEEvent =
  | { type: "meta"; data: { sessionId: string; isRunning: boolean; totalCount: number } }
  | { type: "message"; data: Message }           // Historical message (full object)
  | { type: "text"; data: string }               // Live: append to assistant
  | { type: "tool-call"; data: ToolCallData }    // Live: tool invocation
  | { type: "tool-result"; data: ToolResultData } // Live: tool result
  | { type: "session-id"; data: string }         // New session ID assigned
  | { type: "error"; data: string }
  // Plus: data: [DONE] to signal stream end
```

### Unified Session Loading

`GET /api/sessions/:id` returns an SSE stream, not JSON:

```
data: {"type": "meta", "data": {"sessionId": "abc", "isRunning": true, "totalCount": 47}}
data: {"type": "message", "data": {"role": "user", "content": [...]}}
data: {"type": "message", "data": {"role": "assistant", "content": [...]}}
... (all historical messages)
data: {"type": "text", "data": "Let me check that"}   ← if turn in progress
data: {"type": "tool-call", "data": {...}}            ← live events continue
data: [DONE]
```

**Why:** One code path for everything. The frontend doesn't distinguish between "loading old messages" and "receiving new ones"—it's all events. This enables:
- Graceful reconnection mid-turn (Chrome crashes, you come back, pick up where you left off)
- Pagination-ready (stream first N, `hasMore: true`, request more)
- Uniform mental model (frontend is just an event processor)

---

## Components to Keep

These are battle-tested from Duckpond v1:

| Component | Location | Notes |
|-----------|----------|-------|
| MarkdownText | `frontend/src/components/` | Solid markdown rendering |
| ContextMeter | `frontend/src/components/` | Token gauge |
| Attachment | `frontend/src/components/` | Image handling |
| ToolFallback | Currently in ChatPage | Collapsible tool UI |
| index.css | `frontend/src/` | Styling/theme |
| client.py | `backend-py/src/duckpond/` | SDK client wrapper |
| prompt.py | `backend-py/src/duckpond/` | System prompt assembly |
| context.py | `backend-py/src/duckpond/routes/` | Token counts from Redis |
| chat.py | `backend-py/src/duckpond/routes/` | Already streams SSE |

---

## What Needs Work

| What | Current State | Target State |
|------|---------------|--------------|
| ChatPage.tsx | Uses `useExternalStoreRuntime` with `useState` | Extract state to Zustand store |
| routes/sessions.py | Returns JSON | Stream SSE (unified loading) |
| ToolFallback | Inline in ChatPage | Extract to `components/` |

---

## Development

```bash
# Start both (uses different ports than main Duckpond)
./duckpond

# Ports (dev worktree uses 8767/8768 to avoid conflicts)
# Frontend: 8768
# Backend: 8767
```

Main Duckpond stays on 8765/8766. Both can run simultaneously.

---

## Future Shit

Ideas for after the basic chat loop works:

- **Mood picker drawer** — Thumbnails of all mood pics, click to insert, dims what's already in context
- **Themes Alpha can change** — Hot reload CSS variables from backend
- **Session switching without page reload** — Keep conversation in memory, swap views
- **Attachment management UX** — See what's in context, remove things
- **Accurate context meter** — Token counting via Anthropic endpoint
- **Mid-turn steering** — `/api/chat/inject` to push messages while I'm working (SDK supports this via AsyncIterable prompts)

---

## Links

- [Claude Agent SDK (Python)](https://platform.claude.com/docs/en/agent-sdk/python.md)
- [assistant-ui docs](https://www.assistant-ui.com/docs)
- [Zustand](https://github.com/pmndrs/zustand)
- Main Duckpond: `/Pondside/Barn/Duckpond` (the working fallback)
