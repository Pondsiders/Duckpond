"""Chat route - the main conversation endpoint.

EXPERIMENT: Using our own queue/task pattern instead of assistant-stream's create_run().
Testing whether the background task pattern is what makes SDK client reuse work.

Frontend sends minimal payload { sessionId, content }, we stream back SSE events.

POST /api/chat handles sending messages and streaming responses.
POST /api/chat/interrupt stops the current operation.
"""

import asyncio
import json
from typing import Any, AsyncGenerator

import logfire
import orjson
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from claude_agent_sdk import (
    AssistantMessage,
    UserMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)
from claude_agent_sdk.types import StreamEvent

from duckpond.archive import archive_turn
from duckpond.client import client, build_structured_input
from duckpond.memories import recall
from duckpond.memories.suggest import suggest

router = APIRouter()


async def stream_sse_events(content: str | list[Any], session_id: str | None) -> AsyncGenerator[str, None]:
    """Stream Claude's response as SSE events.

    Uses our own queue/task pattern: SDK calls run in a background task,
    results flow through an asyncio.Queue, this generator reads from the queue.

    Event types:
    - text-delta: { type: "text-delta", data: "..." }  -- streaming text chunks
    - text: { type: "text", data: "..." }  -- complete text block (fallback)
    - tool-call: { type: "tool-call", data: { toolCallId, toolName, args, argsText } }
    - tool-result: { type: "tool-result", data: { toolCallId, result, isError } }
    - session-id: { type: "session-id", data: "..." }
    - error: { type: "error", data: "..." }
    - done: data: [DONE]
    """
    # The queue connects the background task to the response generator
    queue: asyncio.Queue[dict | None] = asyncio.Queue()

    async def run_sdk() -> None:
        """Run the SDK interaction in a background task."""
        sid = session_id
        assistant_text_parts: list[str] = []  # Accumulate assistant response for suggest()

        try:
            with logfire.span("gazebo.run", session_id=sid[:8] if sid else "new"):
                # Ensure session exists
                await client.ensure_session(sid)

                # Recall relevant memories (associative recall)
                # Direct Cortex search with the prompt, deduplicates via Redis
                memories = []
                if sid and isinstance(content, str):
                    memories = await recall(content, sid)

                # Build structured input envelope
                # This wraps the user prompt with metadata for the Loom
                with logfire.span("gazebo.build_envelope"):
                    structured_input = build_structured_input(
                        prompt=content,
                        session_id=sid,
                        memories=memories,
                    )
                    logfire.info("Built structured input", bytes=len(structured_input), memories=len(memories))

                # Send query to Claude (the structured JSON goes as the "prompt")
                with logfire.span("gazebo.query"):
                    logfire.info("Sending structured input to Claude")
                    await client.query(structured_input, session_id=sid)
                    logfire.info("Query sent, receiving response")

                # Stream response
                with logfire.span("gazebo.stream"):
                    async for message in client.receive_response():
                        logfire.debug("Received message", message_type=type(message).__name__)

                        # Handle streaming events (real-time text deltas)
                        if isinstance(message, StreamEvent):
                            event = message.event
                            event_type = event.get("type")

                            if event_type == "content_block_delta":
                                delta = event.get("delta", {})
                                delta_type = delta.get("type")

                                if delta_type == "text_delta":
                                    # Stream text chunk immediately!
                                    text = delta.get("text", "")
                                    if text:
                                        assistant_text_parts.append(text)  # Accumulate for suggest
                                        await queue.put({"type": "text-delta", "data": text})

                        # Handle complete messages (tool calls, etc.)
                        elif isinstance(message, AssistantMessage):
                            for block in message.content:
                                # NOTE: We skip TextBlock here because we already streamed
                                # the text via StreamEvent text_delta events above.
                                # Only handle tool calls from AssistantMessage.
                                if isinstance(block, ToolUseBlock):
                                    await queue.put({
                                        "type": "tool-call",
                                        "data": {
                                            "toolCallId": block.id,
                                            "toolName": block.name,
                                            "args": block.input,
                                            "argsText": json.dumps(block.input),
                                        }
                                    })

                        elif isinstance(message, UserMessage):
                            # Tool results come through as UserMessage with ToolResultBlock
                            if hasattr(message, "content"):
                                content_blocks = message.content
                                if isinstance(content_blocks, list):
                                    for block in content_blocks:
                                        if isinstance(block, ToolResultBlock):
                                            await queue.put({
                                                "type": "tool-result",
                                                "data": {
                                                    "toolCallId": block.tool_use_id,
                                                    "result": block.content,
                                                    "isError": block.is_error or False,
                                                }
                                            })

                        elif isinstance(message, ResultMessage):
                            # Capture final session ID
                            sid = message.session_id
                            client.update_session_id(sid)
                            logfire.info("ResultMessage", session_id=sid[:8] if sid else "none")
                            await queue.put({"type": "session-id", "data": sid})

                # === Fire off memorables extraction (fire-and-forget) ===
                # After turn completes, ask OLMo what's memorable
                # Results accumulate in Redis for Loom to inject next turn
                if sid and isinstance(content, str) and assistant_text_parts:
                    assistant_response = "".join(assistant_text_parts)
                    asyncio.create_task(suggest(content, assistant_response, sid))
                    logfire.info("Fired suggest task", user_len=len(content), assistant_len=len(assistant_response))

                # === Archive the turn to Scribe ===
                # Records user and assistant messages to Postgres
                # Awaited because we want to know immediately if archiving fails
                if assistant_text_parts:
                    assistant_response = "".join(assistant_text_parts)
                    archive_result = await archive_turn(content, assistant_response, sid)
                    if not archive_result.success:
                        await queue.put({"type": "archive-error", "data": archive_result.error})

        except Exception as e:
            logfire.exception(f"SDK error: {e}")
            await queue.put({"type": "error", "data": str(e)})

        finally:
            # Signal end of stream
            await queue.put(None)

    with logfire.span("gazebo.stream_response", session_id=session_id[:8] if session_id else "new"):

        # Start the SDK interaction as a background task
        task = asyncio.create_task(run_sdk())

        try:
            # Read from queue and yield SSE events
            while True:
                event = await queue.get()
                if event is None:
                    # End of stream
                    break
                yield f"data: {json.dumps(event)}\n\n"

            # Done
            yield "data: [DONE]\n\n"

        except Exception as e:
            logfire.exception(f"Stream error: {e}")
            event = {"type": "error", "data": str(e)}
            yield f"data: {json.dumps(event)}\n\n"
            yield "data: [DONE]\n\n"

        finally:
            # Make sure the background task completes
            await task


@router.post("/api/chat")
async def chat(request: Request) -> StreamingResponse:
    """Handle chat messages and stream responses via SSE.

    Request body (new minimal format):
    {
        "sessionId": "optional-session-id",
        "content": "user message text"
    }

    Response: Server-Sent Events stream
    """
    with logfire.span("gazebo.chat") as chat_span:
        # Parse request - now much simpler!
        with logfire.span("gazebo.parse_request"):
            raw_body = await request.body()
            body = orjson.loads(raw_body)

            # New format: { sessionId, content }
            session_id = body.get("sessionId")
            content = body.get("content", "")

        content_desc = f"{len(content)} parts" if isinstance(content, list) else f"{len(content)} chars"
        logfire.info(
            "chat request",
            session_id=session_id[:8] if session_id else "new",
            content_length=len(content) if isinstance(content, str) else len(content),
        )

        # Return SSE stream
        return StreamingResponse(
            stream_sse_events(content, session_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # Disable nginx buffering
            }
        )


@router.post("/api/chat/interrupt")
async def interrupt() -> dict[str, str]:
    """Interrupt the current operation.

    Call this when the user hits the stop button.
    """
    try:
        await client.interrupt()
        logfire.info("Interrupted")
        return {"status": "interrupted"}
    except Exception as e:
        logfire.exception(f"Interrupt error: {e}")
        return {"status": "error", "message": str(e)}
