"""Context route - provides context info for the frontend meter.

GET /api/context returns current time and machine info.
GET /api/context/{session_id} returns token counts from Redis (populated by Eavesdrop).
"""

import json
import os
import socket

import pendulum
import redis

from fastapi import APIRouter

router = APIRouter()

# Redis connection
REDIS_URL = os.getenv("REDIS_URL", "redis://alpha-pi:6379")


def get_redis() -> redis.Redis:
    """Get Redis connection."""
    return redis.from_url(REDIS_URL)


def pso8601_datetime() -> str:
    """Format current time in PSO-8601 format.

    PSO-8601: Local time, human-readable.
    Example: "Mon Jan 12 2026, 6:30 PM"
    """
    now = pendulum.now("America/Los_Angeles")
    return now.format("ddd MMM D YYYY, h:mm A")


@router.get("/api/context")
async def get_context() -> dict[str, str]:
    """Get basic context info (time, hostname)."""
    now = pendulum.now("America/Los_Angeles")
    return {
        "hostname": socket.gethostname(),
        "date": now.format("ddd MMM D YYYY"),
        "time": now.format("h:mm A"),
        "datetime": pso8601_datetime(),
    }


@router.get("/api/context/{session_id}")
async def get_session_context(session_id: str) -> dict[str, int | str | None]:
    """Get token count for a session from Redis.

    Eavesdrop populates this when processing requests tagged with the session ID.
    """
    try:
        r = get_redis()
        redis_key = f"duckpond:context:{session_id}"
        data = r.get(redis_key)

        if data:
            parsed = json.loads(data)
            return parsed

    except Exception as e:
        print(f"[Duckpond] Redis error fetching context: {e}")

    return {"input_tokens": None, "timestamp": None}
