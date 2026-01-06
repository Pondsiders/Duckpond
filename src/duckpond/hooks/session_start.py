"""Session start hook — sets a flag in Redis for context injection.

When a session starts, this hook sets a global flag in Redis.
The chat route checks this flag to decide whether to inject
hostname and date (session start) or just time (continuation).
"""

import os
import redis
import logfire

REDIS_URL = os.environ.get("REDIS_URL", "redis://alpha-pi:6379")
SESSION_START_KEY = "duckpond:session_start"
SESSION_START_TTL = 60  # 1 minute TTL, should be consumed immediately


def get_redis():
    """Get Redis connection."""
    return redis.from_url(REDIS_URL)


async def session_start_hook(input_data: dict, _tool_use_id: str | None, _context) -> dict:
    """SessionStart hook — sets flag in Redis for context injection."""
    try:
        # Log what we receive to understand when this fires
        logfire.info("SessionStart hook fired", input_data=input_data)
        r = get_redis()
        r.set(SESSION_START_KEY, "1", ex=SESSION_START_TTL)
        logfire.info("Session start flag set in Redis")
    except Exception as e:
        logfire.error("Failed to set session start flag", error=str(e))

    return {}


def check_session_start() -> bool:
    """Check if this is a session start (flag exists) and clear the flag.

    Returns True if this is a session start, False otherwise.
    Called from the chat route before injecting context.
    """
    try:
        r = get_redis()
        # GETDEL atomically gets and deletes - returns value if existed, None if not
        result = r.getdel(SESSION_START_KEY)
        is_start = result is not None
        if is_start:
            logfire.info("Session start flag consumed")
        return is_start
    except Exception as e:
        logfire.error("Failed to check session start flag", error=str(e))
        return False
