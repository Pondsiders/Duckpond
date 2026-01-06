"""Chat route — the main conversation endpoint.

POST /api/chat handles sending messages and streaming responses
via the assistant-stream protocol.
"""

import json
import socket

import pendulum

import logfire
from fastapi import APIRouter
from pydantic import BaseModel

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    UserMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
    HookMatcher,
)
from claude_agent_sdk.types import StreamEvent
from assistant_stream import create_run, RunController
from assistant_stream.serialization import DataStreamResponse

from ..config import CWD, ALLOWED_TOOLS, load_system_prompt
from ..hooks import subvox_prompt_hook, subvox_stop_hook, inject_session_tag

router = APIRouter()

# Load system prompt once at module import
SYSTEM_PROMPT = load_system_prompt()


def pso8601_date() -> str:
    """Return current date in PSO-8601 format: Wed Dec 31 2025"""
    now = pendulum.now()
    return now.format("ddd MMM DD YYYY")


def pso8601_time() -> str:
    """Return current time in PSO-8601 format: 4:23 PM (no leading zero)"""
    now = pendulum.now()
    return now.format("h:mm A")


def pso8601_datetime() -> str:
    """Return full datetime in PSO-8601 format: Wed Dec 31 2025, 4:23 PM"""
    now = pendulum.now()
    return now.format("ddd MMM DD YYYY, h:mm A")


class AssistantTransportCommand(BaseModel):
    """A command from assistant-ui."""

    type: str
    message: dict | None = None  # For add-message commands


class ChatRequest(BaseModel):
    """Request body for /api/chat — matches assistant-ui transport format."""

    state: dict | None = None
    commands: list[AssistantTransportCommand] = []
    system: str | None = None
    tools: list | None = None


def extract_user_message(commands: list[AssistantTransportCommand]) -> tuple[list[dict], list[dict]] | tuple[None, None]:
    """Extract the user message content from add-message commands.

    Returns two lists:
    - sdk_content: Content parts formatted for the Claude Agent SDK
    - ui_content: Content parts formatted for assistant-ui (for state/display)
    """
    for cmd in commands:
        if cmd.type == "add-message" and cmd.message:
            # Message parts can be in "parts" or "content"
            parts = cmd.message.get("parts") or cmd.message.get("content", [])
            sdk_content = []
            ui_content = []

            for part in parts:
                if part.get("type") == "text":
                    text = part.get("text", "").strip()
                    if text:
                        sdk_content.append({"type": "text", "text": text})
                        ui_content.append({"type": "text", "text": text})
                elif part.get("type") == "image":
                    # Image part — extract the data URL
                    image_data = part.get("image", "")
                    if image_data:
                        # Keep original format for UI display
                        ui_content.append({"type": "image", "image": image_data})

                        # Convert to Claude API format for SDK
                        if image_data.startswith("data:"):
                            # Parse data URL: data:image/png;base64,XXXXX
                            header, data = image_data.split(",", 1)
                            media_type = header.split(":")[1].split(";")[0]
                            sdk_content.append({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": data,
                                }
                            })

            if sdk_content:
                return sdk_content, ui_content
    return None, None


@router.post("/api/chat")
async def chat(request: ChatRequest):
    """Send a message, stream the response via assistant-stream protocol."""

    sdk_content, ui_content = extract_user_message(request.commands)

    if not sdk_content:
        return {"error": "No message found in commands"}

    # Check if this is the first message of a session (no session ID yet)
    session_id = request.state.get("sessionId") if request.state else None
    is_session_start = session_id is None

    # Build context-enriched message stream
    async def context_enriched_prompt():
        """Yield context messages, then the user's prompt."""

        # Build context parts
        context_parts = []

        # Session start: hostname and date
        if is_session_start:
            hostname = socket.gethostname()
            context_parts.append(f"Host: {hostname}")
            context_parts.append(f"Date: {pso8601_date()}")
            logfire.info("Injecting session start context", hostname=hostname)

        # Always: timestamp
        context_parts.append(f"Time: {pso8601_time()}")

        # Inject context as a system-style message
        if context_parts:
            context_text = "[Context] " + " | ".join(context_parts)
            yield {
                "type": "user",
                "message": {"role": "user", "content": context_text},
                "parent_tool_use_id": None,
            }

        # Now the actual user message
        if len(sdk_content) == 1 and sdk_content[0].get("type") == "text":
            # Text-only: yield as string content
            yield {
                "type": "user",
                "message": {"role": "user", "content": sdk_content[0]["text"]},
                "parent_tool_use_id": None,
            }
        else:
            # Multi-part (text + images): yield as content list
            yield {
                "type": "user",
                "message": {"role": "user", "content": sdk_content},
                "parent_tool_use_id": None,
            }

    query_content = context_enriched_prompt()

    async def run_callback(controller: RunController):
        # Initialize state if needed
        if controller.state is None:
            controller.state = {"messages": [], "sessionId": None}

        # Add user message to state (store UI format for display)
        controller.state["messages"].append({
            "role": "user",
            "content": ui_content,
        })

        # Get session ID from state if present
        session_id = controller.state.get("sessionId")

        options = ClaudeAgentOptions(
            system_prompt=SYSTEM_PROMPT,
            resume=session_id,
            allowed_tools=ALLOWED_TOOLS,
            permission_mode="bypassPermissions",
            cwd=CWD,
            include_partial_messages=True,
            hooks={
                "UserPromptSubmit": [HookMatcher(hooks=[inject_session_tag, subvox_prompt_hook])],
                "Stop": [HookMatcher(hooks=[subvox_stop_hook])],
            },
        )

        async with ClaudeSDKClient(options=options) as client:
            await client.query(query_content)

            accumulated_text = ""

            async for message in client.receive_response():
                print(f"[Duckpond] Received message type: {type(message).__name__}")

                # Handle streaming events for real-time text deltas
                if isinstance(message, StreamEvent):
                    event = message.event
                    event_type = event.get("type")

                    if event_type == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                controller.append_text(text)
                                accumulated_text += text

                # Handle complete messages (for state persistence)
                elif isinstance(message, AssistantMessage):
                    messages = controller.state["messages"]

                    # Ensure we have an assistant message to append to
                    if not messages or messages[-1].get("role") != "assistant":
                        messages.append({
                            "role": "assistant",
                            "content": [],
                        })

                    current_msg = messages[-1]
                    # Ensure content is a list
                    if isinstance(current_msg.get("content"), str):
                        current_msg["content"] = (
                            [{"type": "text", "text": current_msg["content"]}]
                            if current_msg["content"]
                            else []
                        )

                    for block in message.content:
                        if isinstance(block, TextBlock):
                            content = current_msg["content"]
                            if content and content[-1].get("type") == "text":
                                content[-1]["text"] += block.text
                            else:
                                content.append({"type": "text", "text": block.text})

                        elif isinstance(block, ToolUseBlock):
                            current_msg["content"].append({
                                "type": "tool-call",
                                "toolCallId": block.id,
                                "toolName": block.name,
                                "args": block.input,
                                "argsText": json.dumps(block.input),
                            })
                            # Emit tool-call-begin event for frontend
                            from assistant_stream.assistant_stream_chunk import ToolCallBeginChunk
                            controller._flush_and_put_chunk(ToolCallBeginChunk(
                                tool_call_id=block.id,
                                tool_name=block.name,
                            ))
                            print(f"[Duckpond] Emitted ToolCallBeginChunk for {block.id}")

                        elif isinstance(block, ToolResultBlock):
                            # Update state for persistence
                            content = current_msg["content"]
                            for part in content:
                                if (
                                    part.get("type") == "tool-call"
                                    and part.get("toolCallId") == block.tool_use_id
                                ):
                                    part["result"] = block.content
                                    part["isError"] = getattr(block, "is_error", False)
                                    break
                            # Emit tool-result event for frontend
                            controller.add_tool_result(block.tool_use_id, block.content)
                            print(f"[Duckpond] Emitted ToolResultChunk for {block.tool_use_id}")

                elif isinstance(message, UserMessage):
                    # UserMessage contains tool results!
                    print(f"[Duckpond] UserMessage content: {message.content}")
                    for block in message.content:
                        if isinstance(block, ToolResultBlock):
                            print(f"[Duckpond] Found ToolResultBlock in UserMessage for {block.tool_use_id}")
                            # Update state so frontend can see the result
                            messages_list = controller.state["messages"]
                            for msg_idx, msg in enumerate(messages_list):
                                if msg.get("role") == "assistant":
                                    content = msg.get("content", [])
                                    for part_idx, part in enumerate(content):
                                        if (
                                            part.get("type") == "tool-call"
                                            and part.get("toolCallId") == block.tool_use_id
                                        ):
                                            # Force state update through proxy
                                            updated_part = dict(part)
                                            updated_part["result"] = block.content
                                            updated_part["isError"] = block.is_error
                                            controller.state["messages"][msg_idx]["content"][part_idx] = updated_part
                                            print(f"[Duckpond] Updated state for tool {block.tool_use_id}")
                                            break
                            # Also emit the event
                            controller.add_tool_result(block.tool_use_id, block.content)
                            print(f"[Duckpond] Emitted ToolResultChunk for {block.tool_use_id}")

                elif isinstance(message, ResultMessage):
                    controller.state["sessionId"] = message.session_id

                    # Add usage data for context meter
                    if message.usage:
                        print(f"[Duckpond] Usage data: {message.usage}")
                        controller.state["contextUsage"] = message.usage

    stream = create_run(run_callback, state=request.state)
    return DataStreamResponse(stream)
