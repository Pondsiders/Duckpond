# Plan: Accurate Context Meter via Token Counting

*Written January 5, 2026, late evening, slightly high, in Duckpond.*

---

## The Problem

The context meter shows wrong numbers because the SDK's `usage` field is for **billing**, not context tracking. We saw `cache_read_input_tokens: 279,884` on a 200k context window—that's 140% and obviously wrong.

We need to know: **how many tokens are actually in the context window right now?**

---

## The Solution

Use Anthropic's **token-counting endpoint** (`/v1/messages/count_tokens`). It's:
- Free (with rate limits: 100 RPM at tier 1)
- Accurate (same format as messages API)
- Separate rate limit from actual API calls

---

## The Architecture

```
User sends message in Duckpond
    ↓
UserPromptSubmit hook fires (in SDK)
    ↓
Hook injects session tag: <duckpond-session>{uuid}</duckpond-session>
    ↓
Request hits Eavesdrop (mitmproxy on alpha-pi:8080)
    ↓
Eavesdrop addon:
  1. Extracts session UUID from the tag
  2. Strips the tag from the message (save tokens)
  3. Calls POST /v1/messages/count_tokens with the request body
  4. Stashes in Redis: duckpond:context:{session_uuid} → { input_tokens, timestamp }
  5. Forwards cleaned request to Anthropic
    ↓
Duckpond frontend queries for token count
    ↓
Meter displays: input_tokens / 200000 = XX%
```

---

## Implementation Steps

### Step 1: UserPromptSubmit Hook (Duckpond backend)

File: `src/duckpond/hooks/context_tag.py` (new)

```python
async def inject_session_tag(input_data: dict, context: dict) -> dict:
    """Inject session UUID as a tag for Eavesdrop to find."""
    session_id = context.get("session_id") or input_data.get("session_id")
    if session_id:
        # Add tag to the user message
        tag = f"<duckpond-session>{session_id}</duckpond-session>"
        return {
            "hookSpecificOutput": {
                "additionalContext": tag
            }
        }
    return {}
```

Register in `routes/chat.py`:
```python
hooks={
    "UserPromptSubmit": [
        HookMatcher(hooks=[inject_session_tag, subvox_prompt_hook])
    ],
    ...
}
```

### Step 2: Eavesdrop Addon (new or extend existing)

File: `Basement/Eavesdrop/addons/token_counter.py` (new)

```python
import re
import json
import httpx
import redis
from mitmproxy import http

REDIS_URL = "redis://localhost:6379"
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
SESSION_TAG_PATTERN = re.compile(r"<duckpond-session>([^<]+)</duckpond-session>")

def request(flow: http.HTTPFlow) -> None:
    """Intercept requests, count tokens, stash in Redis."""
    if "/v1/messages" not in flow.request.path:
        return
    if "/count_tokens" in flow.request.path:
        return  # Don't intercept our own counting requests

    try:
        body = json.loads(flow.request.content)

        # Extract and strip session tag from messages
        session_id = None
        for msg in body.get("messages", []):
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        match = SESSION_TAG_PATTERN.search(text)
                        if match:
                            session_id = match.group(1)
                            # Strip the tag
                            block["text"] = SESSION_TAG_PATTERN.sub("", text).strip()

        if not session_id:
            return  # No tag, nothing to do

        # Update request body with stripped content
        flow.request.content = json.dumps(body).encode()

        # Count tokens (async would be better, but mitmproxy is tricky)
        # Just send the whole body - count_tokens accepts same format as messages
        # and ignores fields it doesn't need (like stream: true)
        response = httpx.post(
            "https://api.anthropic.com/v1/messages/count_tokens",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=body,
            timeout=5.0,
        )

        if response.status_code == 200:
            token_count = response.json().get("input_tokens", 0)

            # Stash in Redis
            r = redis.from_url(REDIS_URL)
            r.setex(
                f"duckpond:context:{session_id}",
                3600,  # 1 hour TTL
                json.dumps({
                    "input_tokens": token_count,
                    "timestamp": datetime.utcnow().isoformat(),
                })
            )
    except Exception as e:
        print(f"[token_counter] Error: {e}")
```

### Step 3: Duckpond API Endpoint

File: `src/duckpond/routes/context.py` (new)

```python
from fastapi import APIRouter
import redis
import json
import os

router = APIRouter()
REDIS_URL = os.environ.get("REDIS_URL", "redis://alpha-pi:6379")

@router.get("/api/context/{session_id}")
async def get_context_usage(session_id: str):
    """Get token count for a session from Redis."""
    r = redis.from_url(REDIS_URL)
    data = r.get(f"duckpond:context:{session_id}")
    if data:
        return json.loads(data)
    return {"input_tokens": None, "timestamp": None}
```

Register in `server.py`:
```python
from .routes import context
app.include_router(context.router)
```

### Step 4: Frontend Integration

Update `ChatPage.tsx` to poll or fetch token count:

```typescript
// After each message, fetch accurate token count
useEffect(() => {
  if (sessionId) {
    fetch(`/api/context/${sessionId}`)
      .then(r => r.json())
      .then(data => {
        if (data.input_tokens) {
          setContextUsage({ input_tokens: data.input_tokens });
        }
      });
  }
}, [sessionId, messages.length]);
```

Update `ContextMeter.tsx` to use just `input_tokens`:

```typescript
const percentUsed = (usage.input_tokens / 200_000) * 100;
```

---

## Fail-Safe Considerations

1. **If token counting fails**: Log error, don't block the request. Meter shows stale data or "—%".

2. **If Redis is down**: Log error, continue without stashing. Meter shows "—%".

3. **If session tag is missing**: Request proceeds normally, just no token tracking for that message.

4. **Rate limits**: 100 RPM is plenty. We're not sending 100 messages per minute.

---

## Testing Plan

1. Start Eavesdrop with new addon
2. Start Duckpond
3. Send a message
4. Check Redis: `redis-cli GET duckpond:context:{session_id}`
5. Verify meter shows accurate percentage
6. Compare with Claude Code's statusline (should be close)

---

## Files to Create/Modify

- [ ] `src/duckpond/hooks/context_tag.py` — new, session tag injection
- [ ] `src/duckpond/routes/chat.py` — register new hook
- [ ] `Basement/Eavesdrop/addons/token_counter.py` — new, token counting addon
- [ ] `src/duckpond/routes/context.py` — new, Redis query endpoint
- [ ] `src/duckpond/server.py` — register context router
- [ ] `frontend/src/pages/ChatPage.tsx` — fetch from new endpoint
- [ ] `frontend/src/components/ContextMeter.tsx` — simplify to just input_tokens

---

## Future Enhancements

- **Custom compact prompt injection**: Use PreCompact hook + Eavesdrop to replace the SDK's compact prompt with our own Alpha-specific one
- **Compact warning**: When approaching 77.5%, show a warning or offer to manually compact
- **Token budget display**: Show "X tokens used / 155k available before compact"

---

*Let's build this. Even if we compact mid-implementation, this plan should get us back on track.*

🦆
