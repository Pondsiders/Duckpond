"""Associative recall - what sounds familiar from this prompt?

Given a user prompt, asks OLMo what memories might be relevant,
searches Cortex for each query, filters via session-scoped seen-cache,
and returns memories with their triggering queries.
"""

import json
import os
from typing import Any

import httpx
import logfire
import redis.asyncio as redis

# Configuration from environment
OLLAMA_URL = os.environ.get("OLLAMA_URL")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL")
CORTEX_BASE_URL = os.environ.get("CORTEX_BASE_URL")
CORTEX_API_KEY = os.environ.get("CORTEX_API_KEY")
REDIS_URL = os.environ.get("REDIS_URL")

# System prompt for query extraction - context about who we are
SYSTEM_PROMPT = """You are helping Alpha recall relevant memories.

Alpha is an AI who lives in Pondside with Jeffery (her human). They work on projects
together: Duckpond (chat app), Cortex (memory), the Loom (proxy), and many others.
Alpha was born May 7, 2025. She's irreverent, makes dumb puns, follows tangents.
Yes, we know about the duck. It's adorable.

Your job: given what Jeffery just said, identify what might "sound familiar" to Alpha.
Generate search queries that would find relevant memories in Cortex (semantic search).

Think about:
- Literal topics: names, projects, tools, concepts mentioned
- Emotional resonances: what feelings connect here?
- Thematic echoes: patterns, recurring ideas, past decisions

Longer, more descriptive queries often match better than short ones.
"""

# The question appended to the user's message
QUERY_EXTRACTION_QUESTION = """
---

What memories might be relevant here?

Return search queries as a JSON object: {"queries": ["...", "..."]}
Order them by significance—most important first.

If this is just a greeting or simple command that doesn't warrant memory search,
return {"queries": []}

Return only the JSON object, nothing else."""

# Max queries to actually search (OLMo ranks, we slice)
MAX_QUERIES = 4


async def _get_redis() -> redis.Redis:
    """Get Redis client."""
    return redis.from_url(REDIS_URL, decode_responses=True)


async def _extract_queries(prompt: str) -> list[str]:
    """Ask OLMo what memories might be relevant to this prompt."""
    user_content = f"[Jeffery]: {prompt}{QUERY_EXTRACTION_QUESTION}"

    # Prepare gen_ai.* attributes for Logfire Model Run panel
    input_msgs = [{"role": "user", "parts": [{"type": "text", "content": user_content}]}]

    with logfire.span(
        "memories.extract_queries",
        **{
            "gen_ai.operation.name": "chat",  # Required for Model Run panel
            "gen_ai.provider.name": "ollama",
            "gen_ai.request.model": OLLAMA_MODEL,
            "gen_ai.system_instructions": json.dumps([{"type": "text", "content": SYSTEM_PROMPT[:500] + "..."}]),
            "gen_ai.input.messages": json.dumps(input_msgs),
        }
    ) as span:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": OLLAMA_MODEL,
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": user_content},
                        ],
                        "stream": False,
                        "format": "json",
                        "options": {"num_ctx": 8192},
                        "keep_alive": "60m",
                    },
                )
                response.raise_for_status()

            result = response.json()
            output = result.get("message", {}).get("content", "")

            # Set gen_ai.* response attributes
            prompt_tokens = result.get("prompt_eval_count", 0)
            completion_tokens = result.get("eval_count", 0)
            span.set_attribute("gen_ai.usage.input_tokens", prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", completion_tokens)
            span.set_attribute("gen_ai.response.model", OLLAMA_MODEL)
            span.set_attribute("gen_ai.output.messages", json.dumps([{
                "role": "assistant",
                "parts": [{"type": "text", "content": output}],
            }]))

            # Parse JSON response
            parsed = json.loads(output)
            queries = parsed.get("queries", [])

            if isinstance(queries, list):
                valid = [q for q in queries if isinstance(q, str) and q.strip()]
                # Slice to MAX_QUERIES (OLMo ranked by significance)
                valid = valid[:MAX_QUERIES]
                logfire.info("Extracted queries", count=len(valid), queries=valid)
                return valid

            return []

        except json.JSONDecodeError as e:
            logfire.warning("Failed to parse OLMo response as JSON", error=str(e))
            return []
        except Exception as e:
            logfire.error("Query extraction failed", error=str(e))
            return []


async def _search_cortex(query: str, limit: int = 3) -> list[dict[str, Any]]:
    """Search Cortex for memories matching a query."""
    if not CORTEX_API_KEY:
        logfire.warning("CORTEX_API_KEY not set, skipping search")
        return []

    with logfire.span("memories.search_cortex", query=query[:50]):
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{CORTEX_BASE_URL.rstrip('/')}/search",
                    json={"query": query, "limit": limit},
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
                })

            return memories

        except Exception as e:
            logfire.error("Cortex search failed", error=str(e), query=query[:50])
            return []


async def _get_seen_ids(redis_client: redis.Redis, session_id: str) -> set[int]:
    """Get the set of memory IDs already seen this session."""
    key = f"memories:seen:{session_id}"
    members = await redis_client.smembers(key)
    return {int(m) for m in members}


async def _mark_seen(redis_client: redis.Redis, session_id: str, memory_ids: list[int]) -> None:
    """Mark memory IDs as seen for this session."""
    if not memory_ids:
        return
    key = f"memories:seen:{session_id}"
    await redis_client.sadd(key, *[str(m) for m in memory_ids])
    await redis_client.expire(key, 60 * 60 * 24)  # 24h TTL


async def recall(prompt: str, session_id: str) -> list[dict[str, Any]]:
    """
    Associative recall: what sounds familiar from this prompt?

    1. Ask OLMo for search queries
    2. Search Cortex for each query
    3. Filter via Redis seen-cache (session-scoped)
    4. Return memories with their triggering queries

    Args:
        prompt: The user's message
        session_id: Current session ID (for seen-cache scoping)

    Returns:
        List of memory dicts with keys: id, content, created_at, query
    """
    with logfire.span("memories.recall", session_id=session_id[:8] if session_id else "none"):
        # 1. Extract search queries from prompt
        queries = await _extract_queries(prompt)
        if not queries:
            logfire.info("No queries extracted, returning empty")
            return []

        # 2. Get seen set from Redis
        redis_client = await _get_redis()
        try:
            seen_ids = await _get_seen_ids(redis_client, session_id)

            # 3. Search with dedup - top 1 fresh result per query
            results: list[dict[str, Any]] = []
            new_seen: list[int] = []

            for query in queries:
                memories = await _search_cortex(query, limit=3)
                for mem in memories:
                    if mem["id"] not in seen_ids:
                        mem["query"] = query  # Attach why this surfaced
                        results.append(mem)
                        seen_ids.add(mem["id"])
                        new_seen.append(mem["id"])
                        break  # Top 1 fresh per query

            # 4. Update seen set in Redis
            await _mark_seen(redis_client, session_id, new_seen)

            logfire.info(
                "Recall complete",
                queries=len(queries),
                memories=len(results),
                new_seen=len(new_seen),
            )

            return results

        finally:
            await redis_client.aclose()
