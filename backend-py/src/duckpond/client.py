"""Global AlphaClient wrapper.

The raison d'être of Duckpond is to house and care for one AlphaClient
for the lifespan of the program. This module provides that client.

Session handling:
- At startup: no client, no session
- First request comes in with sessionId (or None for new)
- Create client with that session
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
"""

from typing import Any, AsyncIterator

import logfire

from alpha_sdk import AlphaClient
from alpha_sdk.tools.cortex import create_cortex_server


class DuckpondClient:
    """Wrapper around AlphaClient for Duckpond's needs.

    Lazy initialization: no client at startup.
    Creates client on first request, recreates on session change.
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

    def set_token_count_callback(self, callback) -> None:
        """Set the token count callback on the underlying AlphaClient.

        Called per-turn with a closure over the current SSE queue.
        """
        if self._client:
            self._client.set_token_count_callback(callback)

    async def ensure_session(self, session_id: str | None) -> None:
        """Ensure we have a client connected to the right session.

        Args:
            session_id: The session to connect to, or None for new session

        If no client exists, create one.
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
        """Create a new AlphaClient, optionally resuming a session."""
        # Create Cortex MCP server with session ID provider and memorables clearer
        cortex_server = create_cortex_server(
            get_session_id=lambda: self._current_session_id,
            clear_memorables=lambda: self._client.clear_memorables() if self._client else 0,
        )

        self._client = AlphaClient(
            cwd="/Pondside",
            client_name="gazebo",
            permission_mode="bypassPermissions",
            mcp_servers={"cortex": cortex_server},
            allowed_tools=[
                "Read", "Write", "Edit", "Glob", "Grep", "Bash",
                "WebFetch", "WebSearch", "Task", "TaskOutput", "Skill",
                "TodoWrite", "NotebookEdit", "KillShell",
                "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
                # MCP tools
                "mcp__cortex__store",
                "mcp__cortex__search",
                "mcp__cortex__recent",
            ],
        )
        await self._client.connect(session_id)
        self._current_session_id = session_id

        desc = f"resuming {session_id[:8]}..." if session_id else "new session"
        logfire.info(f"Client connected ({desc})")

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
            logfire.info("Client disconnected")

    def update_session_id(self, session_id: str) -> None:
        """Update the current session ID after receiving it from Claude.

        Called when we start a new session (resume=None) and Claude
        gives us back the actual session ID in ResultMessage.
        """
        if self._current_session_id is None and session_id:
            logfire.info(f"New session ID: {session_id[:8]}...")
            self._current_session_id = session_id

    async def query(self, prompt: str | list[Any], session_id: str | None = None) -> None:
        """Send a message to Claude.

        Args:
            prompt: Either a string (text-only) or a list of content blocks (multimodal).
            session_id: The session ID for this message.
        """
        if not self._client:
            raise RuntimeError("Client not connected - call ensure_session first")

        await self._client.query(prompt, session_id=session_id)

    async def stream(self) -> AsyncIterator[Any]:
        """Stream response from Claude."""
        if not self._client:
            raise RuntimeError("Client not connected")
        async for event in self._client.stream():
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
