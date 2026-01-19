"""Chat route - the main conversation endpoint.

POST /api/chat handles sending messages and streaming responses
via the assistant-stream protocol.

POST /api/chat/interrupt stops the current operation.
"""

import json
import logging
from typing import Any

import orjson
from fastapi import APIRouter, Request
from assistant_stream import create_run, RunController
from assistant_stream.serialization import DataStreamResponse

from claude_agent_sdk import (
    AssistantMessage,
    UserMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)

from pondside.telemetry import get_tracer

from duckpond.client import client

logger = logging.getLogger(__name__)
tracer = get_tracer()

router = APIRouter()


def extract_user_message(body: dict[str, Any]) -> tuple[Any, list[dict], bool, str | None]:
    """Extract user message content from assistant-ui request format.

    Returns:
        tuple of (sdk_content, ui_content, has_images, session_id)
        - sdk_content: Content formatted for Claude SDK (list of content blocks)
        - ui_content: Content for UI state tracking
        - has_images: Whether the message contains images
        - session_id: Session ID from state, if present
    """
    commands = body.get("commands", [])
    state = body.get("state", {})
    session_id = state.get("sessionId")

    sdk_content: list[dict[str, Any]] = []
    ui_content: list[dict[str, Any]] = []
    has_images = False

    for cmd in commands:
        if cmd.get("type") == "add-message" and cmd.get("message"):
            parts = cmd["message"].get("parts") or cmd["message"].get("content") or []

            for part in parts:
                if part.get("type") == "text":
                    text = (part.get("text") or "").strip()
                    if text:
                        sdk_content.append({"type": "text", "text": text})
                        ui_content.append({"type": "text", "text": text})

                elif part.get("type") == "image" and part.get("image"):
                    image_data = part["image"]
                    ui_content.append({"type": "image", "image": image_data})
                    has_images = True

                    # Convert data URL to Claude API format
                    if image_data.startswith("data:"):
                        # Parse data URL: data:image/png;base64,ABC123...
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

    return sdk_content, ui_content, has_images, session_id


@router.post("/api/chat")
async def chat(request: Request) -> DataStreamResponse:
    """Handle chat messages and stream responses."""
    with tracer.start_as_current_span("duckpond.chat") as chat_span:
        # Parse request (using orjson for speed on large payloads)
        with tracer.start_as_current_span("duckpond.parse_request"):
            raw_body = await request.body()
            body = orjson.loads(raw_body)
            sdk_content, ui_content, has_images, session_id = extract_user_message(body)
            state = body.get("state", {})
            messages = state.get("messages", [])

        chat_span.set_attribute("duckpond.message_count", len(messages))
        chat_span.set_attribute("duckpond.has_images", has_images)
        logger.info(f"chat request: sessionId={session_id[:8] if session_id else 'new'}..., messages={len(messages)}")

        # Ensure session
        with tracer.start_as_current_span("duckpond.ensure_session"):
            await client.ensure_session(session_id)

        # sid tracks the current session ID, may be updated when we get ResultMessage
        sid = session_id

        # Build prompt - simple string if text-only, content list if multimodal
        if has_images or len(sdk_content) > 1:
            prompt: Any = sdk_content
        else:
            prompt = sdk_content[0]["text"] if sdk_content else ""

        async def run(controller: RunController) -> None:
            """Stream Claude's response through the controller."""
            nonlocal messages, sid

            with tracer.start_as_current_span("duckpond.run") as run_span:
                run_span.set_attribute("duckpond.session_id", sid[:8] if sid else "new")

                # Add user message to state
                messages.append({"role": "user", "content": ui_content})

                # Update state with user message
                controller.state["messages"] = messages
                controller.state["sessionId"] = sid

                # Track assistant content as we receive it
                assistant_content: list[dict[str, Any]] = []

                def send_progress_update():
                    """Send incremental state update so UI shows progress."""
                    temp_messages = list(messages)
                    if assistant_content:
                        temp_messages.append({
                            "role": "assistant",
                            "content": list(assistant_content),
                        })
                    controller.state["messages"] = temp_messages
                    controller.state["sessionId"] = sid

                try:
                    # Send to Claude
                    with tracer.start_as_current_span("duckpond.query"):
                        await client.query(prompt, session_id=sid)

                    # Stream response
                    with tracer.start_as_current_span("duckpond.stream") as stream_span:
                        first_message = True
                        async for message in client.receive_response():
                            if first_message:
                                stream_span.add_event("first_message_received")
                                first_message = False

                            if isinstance(message, AssistantMessage):
                                for block in message.content:
                                    if isinstance(block, TextBlock):
                                        controller.append_text(block.text)
                                        if assistant_content and assistant_content[-1].get("type") == "text":
                                            assistant_content[-1]["text"] += block.text
                                        else:
                                            assistant_content.append({"type": "text", "text": block.text})

                                    elif isinstance(block, ToolUseBlock):
                                        logger.info(f"ToolUseBlock: name={block.name}")
                                        tool_ctrl = await controller.add_tool_call(
                                            tool_name=block.name,
                                            tool_call_id=block.id,
                                        )
                                        tool_ctrl.append_args_text(json.dumps(block.input))
                                        tool_ctrl.close()

                                        assistant_content.append({
                                            "type": "tool-call",
                                            "toolCallId": block.id,
                                            "toolName": block.name,
                                            "args": block.input,
                                            "argsText": json.dumps(block.input),
                                        })

                                send_progress_update()

                            elif isinstance(message, UserMessage):
                                if hasattr(message, "content"):
                                    content = message.content
                                    if isinstance(content, list):
                                        for block in content:
                                            if isinstance(block, ToolResultBlock):
                                                for item in assistant_content:
                                                    if (item.get("type") == "tool-call" and
                                                        item.get("toolCallId") == block.tool_use_id):
                                                        item["result"] = block.content
                                                        item["isError"] = block.is_error or False

                                send_progress_update()

                            elif isinstance(message, ResultMessage):
                                sid = message.session_id
                                logger.info(f"ResultMessage: session_id={sid[:8]}...")

                    # Add assistant message to state
                    if assistant_content:
                        messages.append({"role": "assistant", "content": assistant_content})

                    # Final state update
                    controller.state["messages"] = messages
                    controller.state["sessionId"] = sid

                except Exception as e:
                    logger.exception(f"Chat error: {e}")
                    controller.add_error(str(e))

        # Create stream and return response
        with tracer.start_as_current_span("duckpond.create_run"):
            initial_state = {
                "messages": messages,
                "sessionId": sid,
            }
            stream = create_run(run, state=initial_state)

        return DataStreamResponse(stream)


@router.post("/api/chat/interrupt")
async def interrupt() -> dict[str, str]:
    """Interrupt the current operation.

    Call this when the user hits the stop button.
    """
    try:
        await client.interrupt()
        logger.info("Interrupted")
        return {"status": "interrupted"}
    except Exception as e:
        logger.exception(f"Interrupt error: {e}")
        return {"status": "error", "message": str(e)}
