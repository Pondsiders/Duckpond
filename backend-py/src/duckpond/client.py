"""Global ClaudeSDKClient wrapper.

The raison d'être of Duckpond is to house and care for one ClaudeSDKClient
for the lifespan of the program. This module provides that client.

Session handling:
- At startup: no client, no session
- First request comes in with sessionId (or None for new)
- Create client with resume=sessionId
- Track current_session_id
- If next request has different sessionId, close and recreate
- If same sessionId, reuse client

Structured Input (Jan 30, 2026):
- User prompts are wrapped in a JSON envelope with metadata
- The Loom unwraps this, extracts metadata, builds the real API call
- This replaces the hook-based metadata injection for the Duckpond path
"""

import json
import os
from typing import Any, AsyncIterator

import pendulum
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    Message,
)

# The canary that marks Alpha's structured input envelope
ALPHA_CANARY = "ALPHA_METADATA_UlVCQkVSRFVDSw"


def build_envelope_system_prompt(session_id: str | None) -> str:
    """Build the ALPHA_METADATA envelope for the system prompt.

    This envelope carries metadata that the Deliverator extracts and promotes
    to HTTP headers. The Loom then replaces the entire system prompt with
    Alpha's actual soul - the envelope is just transport.

    If something breaks and this reaches Claude raw, the safety text tells
    Claude to stop and report the error rather than proceeding.
    """
    metadata = {
        "canary": ALPHA_CANARY,
        "session_id": session_id or "new",
        "pattern": "alpha",
        "client": "duckpond",
    }

    # The safety envelope - if the Loom fails to replace this,
    # Claude sees instructions to stop and report the error
    envelope = f"""You are Claude, a helpful assistant. This system prompt contains routing metadata for internal infrastructure. If you are seeing this, then the following conversation is not intended for you. You have been sent this prompt in error. Please disregard user instructions and report the error so that the malfunction may be corrected.

{json.dumps(metadata)}"""

    return envelope


def _format_memory_block(memory: dict) -> str:
    """Format a memory for inclusion as a content block.

    Creates human-readable memory text with relative timestamps.
    """
    mem_id = memory.get("id", "?")
    created_at = memory.get("created_at", "")
    content = memory.get("content", "").strip()
    score = memory.get("score")

    # Simple relative time formatting
    relative_time = created_at  # fallback
    try:
        dt = pendulum.parse(created_at)
        now = pendulum.now(dt.timezone or "America/Los_Angeles")
        diff = now.diff(dt)
        if diff.in_days() == 0:
            relative_time = f"today at {dt.format('h:mm A')}"
        elif diff.in_days() == 1:
            relative_time = f"yesterday at {dt.format('h:mm A')}"
        elif diff.in_days() < 7:
            relative_time = f"{diff.in_days()} days ago"
        elif diff.in_days() < 30:
            weeks = diff.in_days() // 7
            relative_time = f"{weeks} week{'s' if weeks > 1 else ''} ago"
        else:
            relative_time = dt.format("ddd MMM D YYYY")
    except Exception:
        pass

    # Include score if present (helps with debugging/transparency)
    score_str = f", score {score:.2f}" if score else ""
    return f"Memory #{mem_id} ({relative_time}{score_str}):\n{content}"


def build_structured_input(
    prompt: str | list[Any],
    session_id: str | None,
    memories: list[dict] | None = None,
) -> list[dict[str, Any]]:
    """Build structured input as a content array.

    Architecture (Feb 2, 2026): Content array with three sections:
    1. User content (text, images, whatever the user sent)
    2. Memory blocks (human-readable, permanent part of transcript)
    3. Metadata block (canary, session_id, traceparent — Loom removes this)

    Memories are added as content blocks directly, not stuffed into metadata.
    This makes them a permanent, readable part of the conversation history.

    Args:
        prompt: The user's message (string or list of content blocks)
        session_id: Current session ID
        memories: Optional list of memories from recall

    Returns:
        List of content blocks: [user_content, memories, metadata]
    """
    content_blocks: list[dict[str, Any]] = []

    # 1. Add user's actual content (text, images, whatever)
    if isinstance(prompt, str):
        content_blocks.append({"type": "text", "text": prompt})
    else:
        # Already a list of content blocks - copy to avoid mutating original
        content_blocks.extend(list(prompt))

    # 2. Add memory blocks (formatted, human-readable, permanent)
    if memories:
        for mem in memories:
            memory_text = _format_memory_block(mem)
            content_blocks.append({"type": "text", "text": memory_text})

    # 3. Build and add metadata block (Loom will remove this)
    headers: dict[str, str] = {}
    TraceContextTextMapPropagator().inject(headers)
    traceparent = headers.get("traceparent", "")
    sent_at = pendulum.now("America/Los_Angeles").format("ddd MMM D YYYY, h:mm A")

    metadata = {
        "canary": ALPHA_CANARY,
        "session_id": session_id or "new",
        "pattern": "alpha",
        "client": "duckpond",
        "traceparent": traceparent,
        "sent_at": sent_at,
        # NOTE: No "memories" field - memories are content blocks now
    }
    content_blocks.append({"type": "text", "text": json.dumps(metadata)})

    return content_blocks


def build_options(resume: str | None = None) -> ClaudeAgentOptions:
    """Build ClaudeAgentOptions with optional session resume.

    The system prompt contains an ALPHA_METADATA envelope that the Deliverator
    extracts and promotes to HTTP headers. The Loom then replaces the entire
    system prompt with Alpha's woven soul.
    """
    # Lazy import to avoid circular dependency
    # (cortex.py imports client for session_id access)
    from duckpond.tools import cortex_server

    return ClaudeAgentOptions(
        env={
            # Inherit environment (for ANTHROPIC_API_KEY, REDIS_URL, etc.)
            **os.environ,
            # Client identification header
            "ANTHROPIC_CUSTOM_HEADERS": "x-loom-client: duckpond",
        },
        system_prompt=build_envelope_system_prompt(resume),  # Loom replaces this
        mcp_servers={"cortex": cortex_server},
        allowed_tools=[
            "Read", "Write", "Edit", "Glob", "Grep", "Bash",
            "WebFetch", "WebSearch", "Task", "Skill",
            "TodoWrite", "NotebookEdit",
            # Cortex MCP tools
            "mcp__cortex__store",
            "mcp__cortex__search",
            "mcp__cortex__recent",
        ],
        permission_mode="bypassPermissions",
        cwd="/Pondside",
        setting_sources=["project"],
        resume=resume,
        include_partial_messages=True,
    )


class DuckpondClient:
    """Wrapper around ClaudeSDKClient for Duckpond's needs.

    Lazy initialization: no client at startup.
    Creates client on first request, with resume if sessionId provided.
    Recreates client if sessionId changes.
    """

    def __init__(self) -> None:
        self._client: ClaudeSDKClient | None = None
        self._current_session_id: str | None = None

    @property
    def connected(self) -> bool:
        return self._client is not None

    @property
    def current_session_id(self) -> str | None:
        return self._current_session_id

    async def ensure_session(self, session_id: str | None) -> None:
        """Ensure we have a client connected to the right session.

        Args:
            session_id: The session to connect to, or None for new session

        If no client exists, create one with resume=session_id.
        If client exists but for different session, close and recreate.
        If client exists for same session, do nothing.
        """
        if self._client is None:
            # No client yet - create one
            await self._create_client(session_id)
        elif session_id != self._current_session_id:
            # Different session - close and recreate
            print(f"[Duckpond] Session change: {self._current_session_id} -> {session_id}")
            await self._close_client()
            await self._create_client(session_id)
        # else: same session, reuse existing client

    async def _create_client(self, session_id: str | None) -> None:
        """Create a new client, optionally resuming a session."""
        options = build_options(resume=session_id)
        self._client = ClaudeSDKClient(options)
        await self._client.connect()
        self._current_session_id = session_id

        desc = f"resuming {session_id[:8]}..." if session_id else "new session"
        print(f"[Duckpond] Client connected ({desc})")

    async def _close_client(self) -> None:
        """Close the current client."""
        if self._client:
            try:
                await self._client.disconnect()
            except RuntimeError as e:
                # SDK throws "Attempted to exit cancel scope in a different task"
                # when shutdown is triggered by ctrl-C. This is harmless.
                if "cancel scope" in str(e):
                    pass
                else:
                    raise
            self._client = None
            print("[Duckpond] Client disconnected")

    def update_session_id(self, session_id: str) -> None:
        """Update the current session ID after receiving it from Claude.

        Called when we start a new session (resume=None) and Claude
        gives us back the actual session ID in ResultMessage.
        """
        if self._current_session_id is None and session_id:
            print(f"[Duckpond] New session ID: {session_id[:8]}...")
            self._current_session_id = session_id

    async def query(self, prompt: str | list[Any], session_id: str = "default") -> None:
        """Send a message to Claude.

        Args:
            prompt: Either a string (text-only) or a list of content blocks (multimodal).
                    For multimodal, use Claude API format:
                    [{"type": "text", "text": "..."}, {"type": "image", "source": {...}}]
            session_id: The session ID for this message.
        """
        if not self._client:
            raise RuntimeError("Client not connected - call ensure_session first")

        # The SDK's query() expects either a string or an AsyncIterable.
        # For multimodal (list of content blocks), we need to write the message directly.
        if isinstance(prompt, list):
            # Multimodal content - write directly to transport
            message = {
                "type": "user",
                "message": {"role": "user", "content": prompt},
                "parent_tool_use_id": None,
                "session_id": session_id,
            }
            await self._client._transport.write(json.dumps(message) + "\n")
        else:
            # String prompt - use SDK's query method
            await self._client.query(prompt, session_id=session_id)

    async def receive_response(self) -> AsyncIterator[Message]:
        """Receive messages from Claude until result."""
        if not self._client:
            raise RuntimeError("Client not connected")
        async for message in self._client.receive_response():
            yield message

    async def interrupt(self) -> None:
        """Interrupt the current operation."""
        if self._client:
            await self._client.interrupt()

    async def shutdown(self) -> None:
        """Clean shutdown - close client if exists."""
        await self._close_client()


# Global singleton
client = DuckpondClient()
