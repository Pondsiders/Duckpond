"""Sessions route - list and load Claude Code sessions.

GET /api/sessions lists recent sessions with metadata.
GET /api/sessions/{session_id} loads a session's message history.

Sessions are stored as JSONL files by Claude Code.
"""

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

# Claude Code stores sessions here
SESSIONS_DIR = Path(os.path.expanduser("~/.claude/projects/-Pondside"))


def extract_display_messages(lines: list[str]) -> list[dict[str, Any]]:
    """Extract messages suitable for display from JSONL records.

    Filters to user and assistant messages, formats content appropriately.
    Tool results are attached to their corresponding tool calls.
    """
    messages: list[dict[str, Any]] = []
    # Track tool calls by ID so we can attach results later
    tool_calls_by_id: dict[str, dict[str, Any]] = {}

    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        record_type = record.get("type")

        if record_type == "user":
            content = record.get("message", {}).get("content", "")
            # Normalize content to list of parts
            if isinstance(content, str):
                parts = [{"type": "text", "text": content}]
                messages.append({"role": "user", "content": parts})
            elif isinstance(content, list):
                parts = []
                has_tool_results = False
                for block in content:
                    if isinstance(block, str):
                        parts.append({"type": "text", "text": block})
                    elif isinstance(block, dict):
                        block_type = block.get("type")
                        if block_type == "text":
                            parts.append({"type": "text", "text": block.get("text", "")})
                        elif block_type == "image":
                            # Convert Claude API format to data URL for frontend
                            source = block.get("source", {})
                            if source.get("type") == "base64":
                                media_type = source.get("media_type", "image/png")
                                data = source.get("data", "")
                                data_url = f"data:{media_type};base64,{data}"
                                parts.append({"type": "image", "image": data_url})
                            else:
                                parts.append({"type": "image", "image": "[image]"})
                        elif block_type == "tool_result":
                            # Attach result to the matching tool call
                            has_tool_results = True
                            tool_use_id = block.get("tool_use_id")
                            result_content = block.get("content", "")
                            # Extract text from result content
                            if isinstance(result_content, str):
                                result_text = result_content
                            elif isinstance(result_content, list):
                                # Join text blocks
                                texts = []
                                for r in result_content:
                                    if isinstance(r, dict) and r.get("type") == "text":
                                        texts.append(r.get("text", ""))
                                    elif isinstance(r, str):
                                        texts.append(r)
                                result_text = "\n".join(texts)
                            else:
                                result_text = str(result_content)
                            # Find and update the tool call
                            if tool_use_id and tool_use_id in tool_calls_by_id:
                                tool_calls_by_id[tool_use_id]["result"] = result_text

                # Only add user message if it has non-tool-result content
                if parts:
                    messages.append({"role": "user", "content": parts})
                elif has_tool_results:
                    # Skip empty user messages that only contained tool results
                    pass
            else:
                parts = [{"type": "text", "text": str(content)}]
                messages.append({"role": "user", "content": parts})

        elif record_type == "assistant":
            content_blocks = record.get("message", {}).get("content", [])
            parts: list[dict[str, Any]] = []

            for block in content_blocks:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        parts.append({"type": "text", "text": block.get("text", "")})
                    elif block.get("type") == "tool_use":
                        tool_input = block.get("input", {})
                        tool_call = {
                            "type": "tool-call",
                            "toolCallId": block.get("id"),
                            "toolName": block.get("name"),
                            "args": tool_input,
                            "argsText": json.dumps(tool_input, indent=2),
                        }
                        parts.append(tool_call)
                        # Track for later result attachment
                        tool_id = block.get("id")
                        if tool_id:
                            tool_calls_by_id[tool_id] = tool_call

            if parts:
                messages.append({"role": "assistant", "content": parts})

    return messages


@router.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    """Load a session's message history."""
    jsonl_path = SESSIONS_DIR / f"{session_id}.jsonl"

    if not jsonl_path.exists():
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    content = jsonl_path.read_text()
    lines = [line for line in content.split("\n") if line.strip()]

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
async def list_sessions(limit: int = Query(default=20, ge=1, le=100)) -> list[dict[str, Any]]:
    """List recent sessions with metadata."""
    if not SESSIONS_DIR.exists():
        return []

    sessions: list[dict[str, Any]] = []

    for jsonl_file in SESSIONS_DIR.glob("*.jsonl"):
        try:
            content = jsonl_file.read_text()
            lines = [line for line in content.split("\n") if line.strip()]

            if not lines:
                continue

            first = json.loads(lines[0])
            last = json.loads(lines[-1])

            # Extract title from first user message
            title: str | None = None
            for line in lines:
                record = json.loads(line)
                if record.get("type") == "user":
                    msg_content = record.get("message", {}).get("content")
                    if isinstance(msg_content, str):
                        title = msg_content[:50]
                    elif isinstance(msg_content, list):
                        for block in msg_content:
                            if isinstance(block, str):
                                title = block[:50]
                                break
                            elif isinstance(block, dict) and block.get("type") == "text":
                                title = (block.get("text") or "")[:50]
                                break
                    break

            session_id = jsonl_file.stem
            sessions.append({
                "id": session_id,
                "title": title or session_id[:8],
                "created_at": first.get("timestamp"),
                "updated_at": last.get("timestamp"),
            })

        except (json.JSONDecodeError, KeyError):
            # Skip malformed files
            continue

    # Sort by updated_at descending
    sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)

    return sessions[:limit]
