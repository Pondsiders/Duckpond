"""Duckpond server.

Bridges the Claude Agent SDK to assistant-ui via the assistant-stream protocol.
"""

import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)
from assistant_stream import create_run, RunController
from assistant_stream.serialization import DataStreamResponse

# Langfuse instrumentation via OpenTelemetry
from langfuse import get_client
from langsmith.integrations.claude_agent_sdk import configure_claude_agent_sdk

# Configure Langfuse (uses env vars: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST)
os.environ.setdefault("LANGSMITH_OTEL_ENABLED", "true")
os.environ.setdefault("LANGSMITH_OTEL_ONLY", "true")
os.environ.setdefault("LANGSMITH_TRACING", "true")

# Initialize Langfuse client and configure SDK instrumentation
langfuse = get_client()
configure_claude_agent_sdk()

# Load system prompt (stripping frontmatter)
SYSTEM_PROMPT_PATH = Path("/Volumes/Pondside/.claude/agents/Reciter.md")
_raw = SYSTEM_PROMPT_PATH.read_text()
# Strip YAML frontmatter (between --- markers)
if _raw.startswith("---"):
    _, _, SYSTEM_PROMPT = _raw.split("---", 2)
    SYSTEM_PROMPT = SYSTEM_PROMPT.strip()
else:
    SYSTEM_PROMPT = _raw

# Point at Eavesdrop
os.environ.setdefault("ANTHROPIC_BASE_URL", "http://alpha-pi:8080")

app = FastAPI(
    title="Duckpond",
    description="The duck, the pond, and a cozy bench by the water",
    version="0.1.0",
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AssistantTransportCommand(BaseModel):
    """A command from assistant-ui."""
    type: str
    message: dict | None = None  # For add-message commands


class ChatRequest(BaseModel):
    """Request body for /api/chat - matches assistant-ui transport format."""
    state: dict | None = None
    commands: list[AssistantTransportCommand] = []
    system: str | None = None
    tools: list | None = None


def extract_user_message(commands: list[AssistantTransportCommand]) -> str | None:
    """Extract the user message text from add-message commands."""
    for cmd in commands:
        if cmd.type == "add-message" and cmd.message:
            # Message parts can be in "parts" or "content"
            parts = cmd.message.get("parts") or cmd.message.get("content", [])
            for part in parts:
                if part.get("type") == "text":
                    return part.get("text", "")
    return None


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """Send a message, stream the response via assistant-stream protocol."""

    # Debug: log incoming request
    print(f"[Duckpond] Received request:")
    print(f"[Duckpond]   state: {request.state}")
    print(f"[Duckpond]   commands: {request.commands}")

    # Extract user message from commands
    user_message = extract_user_message(request.commands)
    print(f"[Duckpond]   extracted message: {user_message}")

    if not user_message:
        print("[Duckpond] ERROR: No message found!")
        return {"error": "No message found in commands"}

    async def run_callback(controller: RunController):
        # State is already initialized from create_run(state=request.state)
        # Only set default if no state was provided
        if controller.state is None:
            controller.state = {"messages": [], "sessionId": None}

        # Add user message to state
        controller.state["messages"].append({
            "role": "user",
            "content": user_message,
        })

        # Get session ID from state if present
        session_id = controller.state.get("sessionId")

        options = ClaudeAgentOptions(
            system_prompt=SYSTEM_PROMPT,
            resume=session_id,
            allowed_tools=["WebFetch", "WebSearch"],  # Librarian tools
            permission_mode="bypassPermissions",  # No prompts on primer
            cwd="/Volumes/Pondside",
        )

        async with ClaudeSDKClient(options=options) as client:
            await client.query(user_message)

            async for message in client.receive_response():
                # Update state based on message type
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        messages = controller.state["messages"]

                        # Ensure we have an assistant message to append to
                        if not messages or messages[-1].get("role") != "assistant":
                            messages.append({
                                "role": "assistant",
                                "content": [],  # Array of content parts
                            })

                        current_msg = messages[-1]
                        # Ensure content is a list
                        if isinstance(current_msg.get("content"), str):
                            current_msg["content"] = [{"type": "text", "text": current_msg["content"]}] if current_msg["content"] else []

                        if isinstance(block, TextBlock):
                            # Append or merge text part
                            content = current_msg["content"]
                            if content and content[-1].get("type") == "text":
                                content[-1]["text"] += block.text
                            else:
                                content.append({"type": "text", "text": block.text})

                        elif isinstance(block, ToolUseBlock):
                            # Add tool call part
                            current_msg["content"].append({
                                "type": "tool-call",
                                "toolCallId": block.id,
                                "toolName": block.name,
                                "args": block.input,
                                "argsText": json.dumps(block.input),
                            })

                        elif isinstance(block, ToolResultBlock):
                            # Find the matching tool call and update it with result
                            content = current_msg["content"]
                            for part in content:
                                if part.get("type") == "tool-call" and part.get("toolCallId") == block.tool_use_id:
                                    part["result"] = block.content
                                    part["isError"] = getattr(block, "is_error", False)
                                    break

                elif isinstance(message, ResultMessage):
                    controller.state["sessionId"] = message.session_id

    stream = create_run(run_callback, state=request.state)
    return DataStreamResponse(stream)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "version": "0.1.0"}


# --- Session Management ---

# Claude Code stores sessions in ~/.claude/projects/<project-slug>/<session-id>.jsonl
# For /Volumes/Pondside, the slug is -Volumes-Pondside
SESSIONS_DIR = Path.home() / ".claude" / "projects" / "-Volumes-Pondside"


def extract_display_messages(lines: list[str]) -> list[dict]:
    """Parse JSONL into displayable messages with text and tool calls.

    Extracts text blocks and tool_use/tool_result pairs for UI rendering.
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


@app.get("/api/sessions/{session_id}")
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


@app.get("/api/sessions")
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
