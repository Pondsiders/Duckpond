"""Chat route - the main conversation endpoint.

POST /api/chat handles sending messages and streaming responses
via the assistant-stream protocol.

POST /api/chat/interrupt stops the current operation.
"""

import json
from typing import Any

from fastapi import APIRouter, Request
from assistant_stream import create_run, RunController
from assistant_stream.serialization import DataStreamResponse

from claude_agent_sdk import (
    AssistantMessage,
    UserMessage,
    SystemMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)

from duckpond.client import client

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
    body = await request.json()
    sdk_content, ui_content, has_images, session_id = extract_user_message(body)
    state = body.get("state", {})
    messages = list(state.get("messages", []))

    # session_id is None for new conversation, or a UUID string for resume
    print(f"[Duckpond] Chat request: sessionId={session_id[:8] if session_id else 'new'}..., hasImages={has_images}")

    # Ensure we're connected to the right session BEFORE entering create_run()
    # This must happen in the main request task, not in the background task
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

        print(f"[Duckpond] run() started, sid={sid}")

        # Add user message to state
        messages.append({"role": "user", "content": ui_content})

        # Update state with user message (use individual assignments, not update())
        controller.state["messages"] = messages
        controller.state["sessionId"] = sid

        # Track assistant content as we receive it
        assistant_content: list[dict[str, Any]] = []

        def send_progress_update():
            """Send incremental state update so UI shows progress."""
            # Build temporary messages list with current assistant content
            temp_messages = list(messages)
            if assistant_content:
                temp_messages.append({
                    "role": "assistant",
                    "content": list(assistant_content),
                })
            controller.state["messages"] = temp_messages
            controller.state["sessionId"] = sid

        try:
            # Send to Claude (session already ensured before create_run)
            await client.query(prompt, session_id=sid)

            # Stream response
            async for message in client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            # Stream text
                            print(f"[Duckpond] TextBlock: {len(block.text)} chars: {block.text[:80]!r}...")
                            controller.append_text(block.text)
                            # Track in assistant content
                            if assistant_content and assistant_content[-1].get("type") == "text":
                                assistant_content[-1]["text"] += block.text
                            else:
                                assistant_content.append({"type": "text", "text": block.text})

                        elif isinstance(block, ToolUseBlock):
                            # Tool call - create controller, set args, close
                            print(f"[Duckpond] ToolUseBlock: name={block.name}, id={block.id}, input={block.input}")
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

                    # Send progress update after each AssistantMessage
                    send_progress_update()

                elif isinstance(message, UserMessage):
                    # Tool results come back as UserMessage
                    # NOTE: We don't call controller.add_tool_result() here because
                    # the TypeScript version doesn't either - it just updates state
                    if hasattr(message, "content"):
                        content = message.content
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, ToolResultBlock):
                                    print(f"[Duckpond] ToolResultBlock: tool_use_id={block.tool_use_id}, content={str(block.content)[:100]}")
                                    # Update assistant content with result (matching TS behavior)
                                    for item in assistant_content:
                                        if (item.get("type") == "tool-call" and
                                            item.get("toolCallId") == block.tool_use_id):
                                            item["result"] = block.content
                                            item["isError"] = block.is_error or False

                    # Send progress update after tool results
                    send_progress_update()

                elif isinstance(message, ResultMessage):
                    # Final result - update session ID
                    sid = message.session_id
                    print(f"[Duckpond] Result: session_id={sid[:8]}...")

            # Add assistant message to state
            if assistant_content:
                messages.append({"role": "assistant", "content": assistant_content})

            # Final state update
            controller.state["messages"] = messages
            controller.state["sessionId"] = sid
            print(f"[Duckpond] run() completed successfully, final sid={sid}")

        except Exception as e:
            import traceback
            print(f"[Duckpond] Chat error: {e}")
            traceback.print_exc()
            controller.add_error(str(e))

    # Create stream and return response
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
        print("[Duckpond] Interrupted")
        return {"status": "interrupted"}
    except Exception as e:
        print(f"[Duckpond] Interrupt error: {e}")
        return {"status": "error", "message": str(e)}
