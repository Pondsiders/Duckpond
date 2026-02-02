"""Archive conversation turns to Postgres (Scribe integration).

Records user and assistant messages to scribe.messages as turns complete.
This replaces the old hook-based Scribe that read from Claude Code transcripts.

Messages are inserted with timestamps, roles, and session IDs.
Embeddings are handled separately (can be backfilled later).
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import logfire
import psycopg

# Database connection from environment
DATABASE_URL = os.environ.get("DATABASE_URL")


@dataclass
class ArchiveResult:
    """Result of an archive operation."""

    success: bool
    error: str | None = None
    rows_inserted: int = 0


def _extract_text_content(content: str | list[Any]) -> str:
    """Extract text from content (which may be a string or list of content blocks)."""
    if isinstance(content, str):
        return content

    # List of content blocks - extract text parts
    texts = []
    for block in content:
        if isinstance(block, dict):
            if block.get("type") == "text":
                texts.append(block.get("text", ""))
    return "\n".join(texts)


async def archive_turn(
    user_content: str | list[Any],
    assistant_content: str,
    session_id: str | None,
    timestamp: datetime | None = None,
) -> ArchiveResult:
    """Archive a conversation turn to scribe.messages.

    Inserts one row for the user message and one for the assistant response.
    Uses ON CONFLICT to avoid duplicates (keyed on timestamp + role + content hash).

    Args:
        user_content: The user's message (string or list of content blocks)
        assistant_content: The assistant's full response text
        session_id: Current session ID (can be None for new sessions)
        timestamp: When the turn occurred (defaults to now)

    Returns:
        ArchiveResult with success status and any error message
    """
    if not DATABASE_URL:
        return ArchiveResult(success=False, error="DATABASE_URL not configured")

    if timestamp is None:
        timestamp = datetime.now(timezone.utc)

    # Extract text from potentially complex content
    user_text = _extract_text_content(user_content)

    if not user_text.strip() and not assistant_content.strip():
        return ArchiveResult(success=True, rows_inserted=0)  # Nothing to archive

    with logfire.span(
        "archive.turn",
        session_id=session_id[:8] if session_id else "none",
        user_len=len(user_text),
        assistant_len=len(assistant_content),
    ):
        try:
            # Build rows to insert
            rows: list[tuple[datetime, str, str, str | None]] = []

            if user_text.strip():
                rows.append((timestamp, "human", user_text, session_id))

            if assistant_content.strip():
                # Slight offset for assistant timestamp to maintain ordering
                assistant_ts = timestamp.replace(microsecond=timestamp.microsecond + 1)
                rows.append((assistant_ts, "assistant", assistant_content, session_id))

            if not rows:
                return ArchiveResult(success=True, rows_inserted=0)

            # Insert into Postgres
            # Using sync psycopg in a span - it's fast enough for 2 rows
            with psycopg.connect(DATABASE_URL) as conn:
                with conn.cursor() as cur:
                    cur.executemany(
                        """
                        INSERT INTO scribe.messages (timestamp, role, content, session_id)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (timestamp, role, md5(content)) DO NOTHING
                        """,
                        rows,
                    )
                conn.commit()

            sid_short = session_id[:8] if session_id else "none"
            logfire.info("Archived turn", rows=len(rows), session_id=sid_short)
            return ArchiveResult(success=True, rows_inserted=len(rows))

        except Exception as e:
            error_msg = f"Archive failed: {e}"
            logfire.error(error_msg, error=str(e))
            return ArchiveResult(success=False, error=error_msg)
