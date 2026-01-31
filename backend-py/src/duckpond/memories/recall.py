"""Associative recall - what sounds familiar from this prompt?

Given a user prompt, searches Cortex directly using the prompt as a query.
Filters via session-scoped seen-cache and returns fresh memories.

This replaces the OLMo-mediated approach after A/B testing showed:
- Direct embedding search is 5-6x faster (200-400ms vs 1200ms)
- Higher similarity scores on relevant memories
- Same or better quality results
"""

import os
from typing import Any

import httpx
import logfire
import redis.asyncio as redis

# Configuration from environment
CORTEX_BASE_URL = os.environ.get("CORTEX_BASE_URL")
CORTEX_API_KEY = os.environ.get("CORTEX_API_KEY")
REDIS_URL = os.environ.get("REDIS_URL")

# Search parameters
DEFAULT_LIMIT = 3  # Max memories to return
MIN_SCORE = 0.4    # Minimum similarity threshold (filters noise)


async def _get_redis() -> redis.Redis:
    """Get Redis client."""
    return redis.from_url(REDIS_URL, decode_responses=True)


async def _get_seen_ids(redis_client: redis.Redis, session_id: str) -> list[int]:
    """Get the list of memory IDs already seen this session."""
    key = f"memories:seen:{session_id}"
    members = await redis_client.smembers(key)
    return [int(m) for m in members]


async def _mark_seen(redis_client: redis.Redis, session_id: str, memory_ids: list[int]) -> None:
    """Mark memory IDs as seen for this session."""
    if not memory_ids:
        return
    key = f"memories:seen:{session_id}"
    await redis_client.sadd(key, *[str(m) for m in memory_ids])
    await redis_client.expire(key, 60 * 60 * 24)  # 24h TTL


async def _search_cortex(
    query: str,
    limit: int = DEFAULT_LIMIT,
    exclude: list[int] | None = None,
    min_score: float | None = MIN_SCORE,
) -> list[dict[str, Any]]:
    """Search Cortex for memories matching a query.

    Args:
        query: The search query (can be the full user prompt)
        limit: Maximum results to return
        exclude: Memory IDs to skip (already seen this session)
        min_score: Minimum similarity threshold

    Returns:
        List of memory dicts with id, content, created_at, score
    """
    if not CORTEX_API_KEY:
        logfire.warning("CORTEX_API_KEY not set, skipping search")
        return []

    with logfire.span("memories.search_cortex", query_len=len(query), exclude_count=len(exclude or [])):
        try:
            payload = {
                "query": query,
                "limit": limit,
            }
            if exclude:
                payload["exclude"] = exclude
            if min_score is not None:
                payload["min_score"] = min_score

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{CORTEX_BASE_URL.rstrip('/')}/search",
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "X-API-Key": CORTEX_API_KEY,
                    },
                )
                response.raise_for_status()

            data = response.json()
            memories = []
            for item in data.get("memories", []):
                memories.append({
                    "id": item["id"],
                    "content": item["content"],
                    "created_at": item.get("created_at", ""),
                    "score": item.get("score"),
                })

            logfire.info("Cortex search complete", results=len(memories))
            return memories

        except Exception as e:
            logfire.error("Cortex search failed", error=str(e))
            return []


async def recall(prompt: str, session_id: str) -> list[dict[str, Any]]:
    """
    Associative recall: what sounds familiar from this prompt?

    Uses direct embedding search against Cortex (no LLM query extraction).
    Filters via Redis seen-cache (session-scoped).

    Args:
        prompt: The user's message
        session_id: Current session ID (for seen-cache scoping)

    Returns:
        List of memory dicts with keys: id, content, created_at, score
    """
    with logfire.span("memories.recall", session_id=session_id[:8] if session_id else "none"):
        # Get seen IDs from Redis
        redis_client = await _get_redis()
        try:
            seen_ids = await _get_seen_ids(redis_client, session_id)
            logfire.debug("Seen IDs loaded", count=len(seen_ids))

            # Search Cortex with the prompt directly, excluding already-seen
            memories = await _search_cortex(
                query=prompt,
                limit=DEFAULT_LIMIT,
                exclude=seen_ids if seen_ids else None,
                min_score=MIN_SCORE,
            )

            if not memories:
                logfire.info("No memories above threshold")
                return []

            # Mark new memories as seen
            new_ids = [m["id"] for m in memories]
            await _mark_seen(redis_client, session_id, new_ids)

            logfire.info(
                "Recall complete",
                memories=len(memories),
                new_seen=len(new_ids),
            )

            return memories

        finally:
            await redis_client.aclose()
