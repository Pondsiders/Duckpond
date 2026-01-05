"""JSONL parsing for Claude Code session files.

Claude Code stores conversations in ~/.claude/projects/<slug>/<session-id>.jsonl
Each line is a JSON record with type, message, uuid, timestamp, etc.
"""

import json


def extract_display_messages(lines: list[str]) -> list[dict]:
    """Parse JSONL into displayable messages with text and tool calls.

    Extracts text blocks and tool_use/tool_result pairs for UI rendering.
    Tool results are matched to their corresponding tool_use by ID.
    """
    messages = []
    # Track tool results by tool_use_id so we can match them up
    tool_results = {}

    # First pass: collect all tool results
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        message = record.get("message", {})
        content_blocks = message.get("content", [])

        if isinstance(content_blocks, list):
            for block in content_blocks:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_use_id = block.get("tool_use_id")
                    if tool_use_id:
                        tool_results[tool_use_id] = {
                            "content": block.get("content", ""),
                            "is_error": block.get("is_error", False),
                        }

    # Second pass: build messages with tool calls
    for line in lines:
        if not line.strip():
            continue

        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Skip non-message records
        if record.get("type") not in ("user", "assistant"):
            continue

        message = record.get("message", {})
        role = message.get("role")
        content_blocks = message.get("content", [])

        # Build content parts array
        content_parts = []

        # Handle case where content is a plain string (not an array)
        if isinstance(content_blocks, str):
            if content_blocks:
                content_parts.append({"type": "text", "text": content_blocks})
        else:
            for block in content_blocks:
                if isinstance(block, str):
                    # Sometimes content array contains plain strings
                    if block:
                        content_parts.append({"type": "text", "text": block})
                elif isinstance(block, dict):
                    block_type = block.get("type")

                    if block_type == "text":
                        text = block.get("text", "")
                        if text:
                            content_parts.append({"type": "text", "text": text})

                    elif block_type == "tool_use":
                        tool_id = block.get("id")
                        tool_name = block.get("name", "unknown")
                        tool_input = block.get("input", {})

                        # Look up the result
                        result_data = tool_results.get(tool_id, {})

                        content_parts.append({
                            "type": "tool-call",
                            "toolCallId": tool_id,
                            "toolName": tool_name,
                            "args": tool_input,
                            "argsText": json.dumps(tool_input),
                            "result": result_data.get("content"),
                            "isError": result_data.get("is_error", False),
                        })

                    # Skip tool_result blocks - they're handled above

        # Only add message if it has content
        if content_parts:
            messages.append({
                "role": role,
                "content": content_parts,
                "uuid": record.get("uuid"),
                "timestamp": record.get("timestamp"),
            })

    return messages
