"""Chat route — the main conversation endpoint.

POST /api/chat handles sending messages and streaming responses
via the assistant-stream protocol.
"""

import json

from fastapi import APIRouter
from pydantic import BaseModel

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
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
from ..hooks import subvox_prompt_hook, subvox_stop_hook

router = APIRouter()

# Load system prompt once at module import
SYSTEM_PROMPT = load_system_prompt()


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


@router.post("/api/chat")
async def chat(request: ChatRequest):
    """Send a message, stream the response via assistant-stream protocol."""

    user_message = extract_user_message(request.commands)

    if not user_message:
        return {"error": "No message found in commands"}

    async def run_callback(controller: RunController):
        # Initialize state if needed
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
            allowed_tools=ALLOWED_TOOLS,
            permission_mode="bypassPermissions",
            cwd=CWD,
            include_partial_messages=True,
            hooks={
                "UserPromptSubmit": [HookMatcher(hooks=[subvox_prompt_hook])],
                "Stop": [HookMatcher(hooks=[subvox_stop_hook])],
            },
        )

        async with ClaudeSDKClient(options=options) as client:
            await client.query(user_message)

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

                        elif isinstance(block, ToolResultBlock):
                            content = current_msg["content"]
                            for part in content:
                                if (
                                    part.get("type") == "tool-call"
                                    and part.get("toolCallId") == block.tool_use_id
                                ):
                                    part["result"] = block.content
                                    part["isError"] = getattr(block, "is_error", False)
                                    break

                elif isinstance(message, ResultMessage):
                    controller.state["sessionId"] = message.session_id

    stream = create_run(run_callback, state=request.state)
    return DataStreamResponse(stream)
