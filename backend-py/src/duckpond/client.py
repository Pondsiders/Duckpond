"""Global AlphaClient wrapper.

The raison d'être of Duckpond is to house and care for one AlphaClient
for the lifespan of the program. This module provides that client.

Session handling:
- At startup: no client, no session
- First request comes in with sessionId (or None for new)
- Create client with that session (streaming mode)
- Track current_session_id
- If next request has different sessionId, switch sessions
- If same sessionId, reuse existing client

AlphaClient handles everything:
- Soul injection (system prompt)
- Orientation (capsules, letter, today, here, context, calendar, todos)
- Memory recall and suggest
- Compact prompt rewriting
- Observability spans
- Cortex MCP tools
- Turn archiving

Streaming input mode:
- Client uses send() + events() instead of query() + stream()
- One persistent SSE pipe per session (GET /api/stream)
- POST /api/chat is fire-and-forget
- Messages queue on asyncio.Queue, responses flow through response queue
"""

from typing import Any, AsyncIterator

import logfire

from alpha_sdk import AlphaClient


class DuckpondClient:
    """Wrapper around AlphaClient for Duckpond's needs.

    Lazy initialization: no client at startup.
    Creates client on first request, recreates on session change.
    Uses streaming input mode for persistent SSE connections.
    """

    def __init__(self) -> None:
        self._client: AlphaClient | None = None
        self._current_session_id: str | None = None

    @property
    def connected(self) -> bool:
        return self._client is not None

    @property
    def current_session_id(self) -> str | None:
        return self._current_session_id

    @property
    def token_count(self) -> int:
        """Get current token count for context-o-meter."""
        if self._client:
            return self._client.token_count
        return 0

    @property
    def context_window(self) -> int:
        """Get context window size."""
        if self._client:
            return self._client.context_window
        return 200_000

    async def ensure_session(self, session_id: str | None) -> None:
        """Ensure we have a streaming client connected to the right session.

        Args:
            session_id: The session to connect to, or None for new session

        If no client exists, create one in streaming mode.
        If client exists but for different session, close and recreate.
        If client exists for same session, do nothing.
        """
        if self._client is None:
            # No client yet - create one
            await self._create_client(session_id)
        elif session_id != self._current_session_id:
            # Different session - close and recreate
            logfire.info(f"Session change: {self._current_session_id} -> {session_id}")
            await self._close_client()
            await self._create_client(session_id)
        # else: same session, reuse existing client

    async def _create_client(self, session_id: str | None) -> None:
        """Create a new AlphaClient in streaming mode."""
        self._client = AlphaClient(
            cwd="/Pondside",
            client_name="duckpond",
            permission_mode="bypassPermissions",
        )
        await self._client.connect(session_id, streaming=True)
        self._current_session_id = session_id

        desc = f"resuming {session_id[:8]}..." if session_id else "new session"
        logfire.info(f"Streaming client connected ({desc})")

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
            logfire.info("Streaming client disconnected")

    async def send(self, content: str | list[Any], session_id: str | None = None) -> None:
        """Queue a message. Returns immediately.

        Args:
            content: Text string or content blocks (multimodal).
            session_id: Session ID (used for ensure_session, not per-message).
        """
        await self.ensure_session(session_id)
        if not self._client:
            raise RuntimeError("Client not connected")
        await self._client.send(content)

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield SSE events from the response queue.

        Each event is a dict: {"type": "text-delta", "data": {...}, "id": N}
        Terminates when the session ends.
        """
        if not self._client:
            raise RuntimeError("Client not connected")
        async for event in self._client.events():
            # Update our session ID from session-id events
            if event.get("type") == "session-id":
                new_sid = event.get("data", {}).get("sessionId")
                if new_sid and self._current_session_id is None:
                    logfire.info(f"New session ID: {new_sid[:8]}...")
                    self._current_session_id = new_sid
            yield event

    async def interrupt(self) -> None:
        """Interrupt the current operation."""
        if self._client:
            await self._client.interrupt()

    async def shutdown(self) -> None:
        """Clean shutdown - close client if exists."""
        await self._close_client()


# Global singleton
client = DuckpondClient()
