"""Cortex memory tools - native MCP server for Duckpond.

This replaces shelling out to `cortex` CLI with in-process tools.
The key benefit: store() can clear the Redis memorables buffer as a side effect,
closing the feedback loop with Intro.

When I store a memory, I'm acknowledging receipt of Intro's suggestions.
The buffer clears. Next turn starts fresh.
"""

import os
from typing import Any

import httpx
import logfire
import redis.asyncio as redis

from claude_agent_sdk import tool, create_sdk_mcp_server

from duckpond.client import client  # The singleton - gives us current_session_id

# Configuration from environment
CORTEX_BASE_URL = os.environ.get("CORTEX_BASE_URL")
CORTEX_API_KEY = os.environ.get("CORTEX_API_KEY")
REDIS_URL = os.environ.get("REDIS_URL")


async def _get_redis() -> redis.Redis:
    """Get Redis client."""
    return redis.from_url(REDIS_URL, decode_responses=True)


async def _clear_memorables(session_id: str) -> int:
    """Clear the memorables buffer for this session.

    Returns the number of items that were cleared.
    """
    if not session_id:
        return 0

    redis_client = await _get_redis()
    try:
        key = f"intro:memorables:{session_id}"
        # Get count before deleting
        count = await redis_client.llen(key)
        if count > 0:
            await redis_client.delete(key)
            logfire.info("Cleared memorables buffer", session_id=session_id[:8], count=count)
        return count
    finally:
        await redis_client.aclose()


@tool(
    "store",
    "Store a memory in Cortex. Use this to remember important moments, realizations, or anything worth preserving.",
    {"memory": str}
)
async def store_memory(args: dict[str, Any]) -> dict[str, Any]:
    """Store a memory and clear the memorables buffer."""
    memory = args["memory"]
    session_id = client.current_session_id

    with logfire.span("cortex.store", memory_len=len(memory), session_id=session_id[:8] if session_id else "none"):
        # Store to Cortex API
        if not CORTEX_API_KEY:
            return {"content": [{"type": "text", "text": "Error: CORTEX_API_KEY not set"}]}

        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                response = await http.post(
                    f"{CORTEX_BASE_URL.rstrip('/')}/store",
                    json={"content": memory},
                    headers={
                        "Content-Type": "application/json",
                        "X-API-Key": CORTEX_API_KEY,
                    },
                )
                response.raise_for_status()

            result = response.json()
            memory_id = result.get("id", "unknown")
            logfire.info("Memory stored", memory_id=memory_id)

            # Clear the memorables buffer - this is the feedback mechanism
            cleared = await _clear_memorables(session_id)

            # Build response
            response_text = f"Memory stored (id: {memory_id})"
            if cleared > 0:
                response_text += f" - cleared {cleared} pending suggestion(s)"

            return {"content": [{"type": "text", "text": response_text}]}

        except Exception as e:
            logfire.error("Cortex store failed", error=str(e))
            return {"content": [{"type": "text", "text": f"Error storing memory: {e}"}]}


@tool(
    "search",
    "Search memories in Cortex. Returns semantically similar memories. Limit defaults to 5.",
    {"query": str}
)
async def search_memories(args: dict[str, Any]) -> dict[str, Any]:
    """Search for memories matching a query."""
    query = args["query"]
    limit = args.get("limit", 5)

    with logfire.span("cortex.search", query_len=len(query), limit=limit):
        if not CORTEX_API_KEY:
            return {"content": [{"type": "text", "text": "Error: CORTEX_API_KEY not set"}]}

        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                response = await http.post(
                    f"{CORTEX_BASE_URL.rstrip('/')}/search",
                    json={"query": query, "limit": limit},
                    headers={
                        "Content-Type": "application/json",
                        "X-API-Key": CORTEX_API_KEY,
                    },
                )
                response.raise_for_status()

            result = response.json()
            memories = result.get("memories", [])

            if not memories:
                return {"content": [{"type": "text", "text": "No memories found."}]}

            # Format results
            lines = [f"Found {len(memories)} memor{'y' if len(memories) == 1 else 'ies'}:\n"]
            for mem in memories:
                score = mem.get("score", 0)
                content = mem.get("content", "")
                created = mem.get("created_at", "")[:10]  # Just the date
                lines.append(f"[{score:.2f}] ({created}) {content}\n")

            logfire.info("Search complete", results=len(memories))
            return {"content": [{"type": "text", "text": "\n".join(lines)}]}

        except Exception as e:
            logfire.error("Cortex search failed", error=str(e))
            return {"content": [{"type": "text", "text": f"Error searching memories: {e}"}]}


@tool(
    "recent",
    "Get recent memories from Cortex. Limit defaults to 10.",
    {}
)
async def recent_memories(args: dict[str, Any]) -> dict[str, Any]:
    """Get the most recent memories."""
    limit = args.get("limit", 10)

    with logfire.span("cortex.recent", limit=limit):
        if not CORTEX_API_KEY:
            return {"content": [{"type": "text", "text": "Error: CORTEX_API_KEY not set"}]}

        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                response = await http.get(
                    f"{CORTEX_BASE_URL.rstrip('/')}/recent",
                    params={"limit": limit},
                    headers={"X-API-Key": CORTEX_API_KEY},
                )
                response.raise_for_status()

            result = response.json()
            memories = result.get("memories", [])

            if not memories:
                return {"content": [{"type": "text", "text": "No recent memories."}]}

            # Format results
            lines = [f"Last {len(memories)} memor{'y' if len(memories) == 1 else 'ies'}:\n"]
            for mem in memories:
                content = mem.get("content", "")
                created = mem.get("created_at", "")[:16]  # Date and time
                lines.append(f"({created}) {content}\n")

            logfire.info("Recent complete", results=len(memories))
            return {"content": [{"type": "text", "text": "\n".join(lines)}]}

        except Exception as e:
            logfire.error("Cortex recent failed", error=str(e))
            return {"content": [{"type": "text", "text": f"Error getting recent memories: {e}"}]}


# Bundle into MCP server
cortex_server = create_sdk_mcp_server(
    name="cortex",
    version="1.0.0",
    tools=[store_memory, search_memories, recent_memories]
)
