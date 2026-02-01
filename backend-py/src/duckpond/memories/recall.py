"""Associative recall - what sounds familiar from this prompt?

Given a user prompt, searches Cortex using two parallel strategies:
1. Direct embedding search (fast, catches overall semantic similarity)
2. OLMo query extraction (slower, catches distinctive terms in long prompts)

Results are merged and deduped. Filters via session-scoped seen-cache.

The dual approach solves the "Mrs. Hughesbot problem": when a distinctive
term is buried in a long meta-prompt, direct embedding averages it out.
OLMo can isolate it as a separate query.
"""

import asyncio
import json
import os
from typing import Any

import httpx
import logfire
import redis.asyncio as redis

# Configuration from environment
CORTEX_BASE_URL = os.environ.get("CORTEX_BASE_URL")
CORTEX_API_KEY = os.environ.get("CORTEX_API_KEY")
REDIS_URL = os.environ.get("REDIS_URL")
OLLAMA_URL = os.environ.get("OLLAMA_URL")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL")

# Search parameters
DEFAULT_LIMIT = 3  # Max memories to return from direct search
QUERY_LIMIT = 1    # Max memories per extracted query (top 1 only)
MIN_SCORE = 0.4    # Minimum similarity threshold (filters noise)

# Query extraction prompt (adapted from Intro)
# Key insight: ignore the main topic (embedding search catches that).
# Focus on the frilly edges—brief mentions, proper nouns, asides.
QUERY_EXTRACTION_PROMPT = """Jeffery just said:

"{message}"

---

Alpha is searching her memories. A separate system already handles the MAIN topic of this message. Your job is to catch the PERIPHERAL details that might get lost:

- Names mentioned in passing (people, pets, projects)
- Brief references to past events or inside jokes
- Asides that take only 10-20 words of a longer message
- Distinctive terms that aren't the central subject

IGNORE the main thrust of what Jeffery is talking about. Focus on the edges.

Give me 0-3 short search queries (2-5 words each) for these peripheral mentions: {{"queries": ["query one", "query two"]}}

If there are no peripheral details worth searching (just one focused topic), return {{"queries": []}}

Return only the JSON object, nothing else."""


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

    with logfire.span("memories.search_cortex", query_preview=query[:50], exclude_count=len(exclude or [])):
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

            logfire.debug("Cortex search complete", query_preview=query[:30], results=len(memories))
            return memories

        except Exception as e:
            logfire.error("Cortex search failed", error=str(e))
            return []


async def _extract_queries(message: str) -> list[str]:
    """Extract search queries from a user message using OLMo.

    Returns 1-4 short queries, or empty list if message doesn't warrant search.
    """
    if not OLLAMA_URL or not OLLAMA_MODEL:
        logfire.debug("OLLAMA not configured, skipping query extraction")
        return []

    prompt = QUERY_EXTRACTION_PROMPT.format(message=message[:2000])  # Truncate very long messages

    with logfire.span(
        "memories.extract_queries",
        **{
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "ollama",
            "gen_ai.request.model": OLLAMA_MODEL,
        }
    ) as span:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": OLLAMA_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "stream": False,
                        "format": "json",
                        "options": {"num_ctx": 4096},
                    },
                )
                response.raise_for_status()

            result = response.json()
            output = result.get("message", {}).get("content", "")

            # Log token usage for observability
            span.set_attribute("gen_ai.usage.input_tokens", result.get("prompt_eval_count", 0))
            span.set_attribute("gen_ai.usage.output_tokens", result.get("eval_count", 0))
            span.set_attribute("gen_ai.response.model", OLLAMA_MODEL)

            # Parse JSON response
            parsed = json.loads(output)
            queries = parsed.get("queries", [])

            if isinstance(queries, list):
                valid = [q for q in queries if isinstance(q, str) and q.strip()]
                logfire.info("Extracted queries", count=len(valid), queries=valid)
                return valid

            return []

        except json.JSONDecodeError as e:
            logfire.warning("Failed to parse OLMo response as JSON", error=str(e), raw=output[:200] if 'output' in dir() else "")
            return []
        except Exception as e:
            logfire.error("Query extraction failed", error=str(e))
            return []


async def _search_extracted_queries(
    queries: list[str],
    exclude: list[int],
) -> list[dict[str, Any]]:
    """Search Cortex for each extracted query, taking top 1 per query.

    Returns list of memories, one per query (deduped against exclude list).
    """
    if not queries:
        return []

    # Search all queries in parallel
    async def search_one(query: str) -> dict[str, Any] | None:
        results = await _search_cortex(
            query=query,
            limit=QUERY_LIMIT,
            exclude=exclude,
            min_score=MIN_SCORE,
        )
        return results[0] if results else None

    with logfire.span("memories.search_extracted", query_count=len(queries)):
        tasks = [search_one(q) for q in queries]
        results = await asyncio.gather(*tasks)

        # Filter None results and dedupe
        memories = []
        seen_in_batch = set(exclude)
        for mem in results:
            if mem and mem["id"] not in seen_in_batch:
                memories.append(mem)
                seen_in_batch.add(mem["id"])

        logfire.info("Extracted query search complete", found=len(memories))
        return memories


async def recall(prompt: str, session_id: str) -> list[dict[str, Any]]:
    """
    Associative recall: what sounds familiar from this prompt?

    Uses two parallel strategies:
    1. Direct embedding search (fast, semantic similarity)
    2. OLMo query extraction + search (slower, catches distinctive terms)

    Results are merged and deduped. Filters via Redis seen-cache.

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

            # Run direct search and query extraction in parallel
            direct_task = _search_cortex(
                query=prompt,
                limit=DEFAULT_LIMIT,
                exclude=seen_ids if seen_ids else None,
                min_score=MIN_SCORE,
            )
            extract_task = _extract_queries(prompt)

            direct_memories, extracted_queries = await asyncio.gather(direct_task, extract_task)

            # Build exclude list for extracted query searches (seen + direct results)
            exclude_for_extracted = set(seen_ids)
            for mem in direct_memories:
                exclude_for_extracted.add(mem["id"])

            # Search for extracted queries
            extracted_memories = await _search_extracted_queries(
                extracted_queries,
                list(exclude_for_extracted),
            )

            # Merge: direct results first, then extracted (they're already deduped)
            all_memories = direct_memories + extracted_memories

            if not all_memories:
                logfire.info("No memories above threshold")
                return []

            # Mark all new memories as seen
            new_ids = [m["id"] for m in all_memories]
            await _mark_seen(redis_client, session_id, new_ids)

            logfire.info(
                "Recall complete",
                direct=len(direct_memories),
                extracted=len(extracted_memories),
                total=len(all_memories),
            )

            return all_memories

        finally:
            await redis_client.aclose()
