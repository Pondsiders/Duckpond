"""Context route — token usage tracking for the context meter.

GET /api/context/{session_id} returns accurate token counts from Redis,
populated by Eavesdrop's token counter addon.
"""

import json
import os

import redis
from fastapi import APIRouter

router = APIRouter()

REDIS_URL = os.environ.get("REDIS_URL", "redis://alpha-pi:6379")


@router.get("/api/context/{session_id}")
async def get_context_usage(session_id: str):
    """Get token count for a session from Redis.

    Eavesdrop calls Anthropic's token-counting endpoint on each request
    and stashes the result in Redis keyed by session ID.
    """
    try:
        r = redis.from_url(REDIS_URL)
        data = r.get(f"duckpond:context:{session_id}")
        if data:
            return json.loads(data)
    except Exception:
        # Redis down or other error - return empty response
        pass

    return {"input_tokens": None, "timestamp": None}
