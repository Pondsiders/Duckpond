"""Session routes — list and load Claude Code sessions.

GET /api/sessions lists recent sessions with metadata.
GET /api/sessions/{session_id} loads a session's message history.
"""

import json

from fastapi import APIRouter, HTTPException

from ..config import SESSIONS_DIR
from ..parsing import extract_display_messages

router = APIRouter()


@router.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """Load a session's message history from JSONL."""
    jsonl_path = SESSIONS_DIR / f"{session_id}.jsonl"

    if not jsonl_path.exists():
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    with open(jsonl_path) as f:
        lines = f.readlines()

    messages = extract_display_messages(lines)

    # Get metadata from first/last records
    first = json.loads(lines[0]) if lines else {}
    last = json.loads(lines[-1]) if lines else {}

    return {
        "session_id": session_id,
        "messages": messages,
        "created_at": first.get("timestamp"),
        "updated_at": last.get("timestamp"),
    }


@router.get("/api/sessions")
async def list_sessions(limit: int = 20):
    """List recent sessions with metadata."""
    if not SESSIONS_DIR.exists():
        return []

    sessions = []
    for jsonl_path in SESSIONS_DIR.glob("*.jsonl"):
        try:
            with open(jsonl_path) as f:
                lines = f.readlines()

            if not lines:
                continue

            first = json.loads(lines[0])
            last = json.loads(lines[-1])

            # Extract title from first user message
            title = None
            for line in lines:
                record = json.loads(line)
                if record.get("type") == "user":
                    content = record.get("message", {}).get("content", [])
                    for block in content:
                        if isinstance(block, str):
                            title = block[:50]
                            break
                        elif isinstance(block, dict) and block.get("type") == "text":
                            title = block.get("text", "")[:50]
                            break
                    break

            sessions.append({
                "id": jsonl_path.stem,
                "title": title or jsonl_path.stem[:8],
                "created_at": first.get("timestamp"),
                "updated_at": last.get("timestamp"),
            })
        except Exception:
            continue  # Skip malformed files

    # Sort by updated_at descending (handle None timestamps)
    sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)

    return sessions[:limit]
