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


def build_structured_input(
    prompt: str | list[Any],
    session_id: str | None,
    memories: list[dict] | None = None,
) -> str:
    """Build the structured input JSON that wraps the user prompt.

    This is the new architecture (Jan 30, 2026): instead of metadata in one place
    and prompt in another, we send ONE JSON blob containing everything. The Loom
    unwraps it, extracts what it needs, and builds the real Anthropic API call.

    Args:
        prompt: The user's message (string or multimodal content list)
        session_id: Current session ID
        memories: Optional list of memories from Intro

    Returns:
        JSON string containing the structured input envelope
    """
    # Get traceparent from current span for distributed tracing
    headers: dict[str, str] = {}
    TraceContextTextMapPropagator().inject(headers)
    traceparent = headers.get("traceparent", "")

    # PSO-8601 timestamp
    sent_at = pendulum.now("America/Los_Angeles").format("ddd MMM D YYYY, h:mm A")

    envelope = {
        "canary": ALPHA_CANARY,
        "session_id": session_id or "new",
        "pattern": "alpha",
        "client": "duckpond",
        "traceparent": traceparent,
        "sent_at": sent_at,
        "prompt": prompt,
    }

    # Include memories if we have them
    if memories:
        envelope["memories"] = memories

    return json.dumps(envelope)


def build_options(resume: str | None = None) -> ClaudeAgentOptions:
    """Build ClaudeAgentOptions with optional session resume.

    The system prompt contains an ALPHA_METADATA envelope that the Deliverator
    extracts and promotes to HTTP headers. The Loom then replaces the entire
    system prompt with Alpha's woven soul.
    """
    return ClaudeAgentOptions(
        env={
            # Inherit environment (for ANTHROPIC_API_KEY, REDIS_URL, etc.)
            **os.environ,
            # Client identification header
            "ANTHROPIC_CUSTOM_HEADERS": "x-loom-client: duckpond",
        },
        system_prompt=build_envelope_system_prompt(resume),  # Loom replaces this
        allowed_tools=[
            "Read", "Write", "Edit", "Glob", "Grep", "Bash",
            "WebFetch", "WebSearch", "Task", "Skill",
            "TodoWrite", "NotebookEdit",
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
