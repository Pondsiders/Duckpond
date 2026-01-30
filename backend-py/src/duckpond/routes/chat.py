"""Chat route - the main conversation endpoint.

EXPERIMENT: Using our own queue/task pattern instead of assistant-stream's create_run().
Testing whether the background task pattern is what makes SDK client reuse work.

Frontend sends minimal payload { sessionId, content }, we stream back SSE events.

POST /api/chat handles sending messages and streaming responses.
POST /api/chat/interrupt stops the current operation.
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

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

from pondside.telemetry import get_tracer

from duckpond.client import client

logger = logging.getLogger(__name__)
tracer = get_tracer()

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

        try:
            with tracer.start_as_current_span("gazebo.run") as span:
                span.set_attribute("duckpond.session_id", sid[:8] if sid else "new")

                # Ensure session exists
                await client.ensure_session(sid)

                # Send query to Claude
                with tracer.start_as_current_span("gazebo.query"):
                    logger.info("Sending query to Claude...")
                    await client.query(content, session_id=sid)
                    logger.info("Query sent, about to receive response...")

                # Stream response
                with tracer.start_as_current_span("gazebo.stream"):
                    async for message in client.receive_response():
                        # Temporarily INFO level to debug streaming
                        logger.info(f"Received message: {type(message).__name__}")

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
                            logger.info(f"ResultMessage: session_id={sid[:8]}...")
                            await queue.put({"type": "session-id", "data": sid})

        except Exception as e:
            logger.exception(f"SDK error: {e}")
            await queue.put({"type": "error", "data": str(e)})

        finally:
            # Signal end of stream
            await queue.put(None)

    with tracer.start_as_current_span("gazebo.stream_response") as span:
        span.set_attribute("duckpond.session_id", session_id[:8] if session_id else "new")

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
            logger.exception(f"Stream error: {e}")
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
    with tracer.start_as_current_span("gazebo.chat") as chat_span:
        # Parse request - now much simpler!
        with tracer.start_as_current_span("gazebo.parse_request"):
            raw_body = await request.body()
            body = orjson.loads(raw_body)

            # New format: { sessionId, content }
            session_id = body.get("sessionId")
            content = body.get("content", "")

        content_desc = f"{len(content)} parts" if isinstance(content, list) else f"{len(content)} chars"
        chat_span.set_attribute("duckpond.content_length", len(content) if isinstance(content, str) else len(content))
        logger.info(f"chat request: sessionId={session_id[:8] if session_id else 'new'}..., content={content_desc}")

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
        logger.info("Interrupted")
        return {"status": "interrupted"}
    except Exception as e:
        logger.exception(f"Interrupt error: {e}")
        return {"status": "error", "message": str(e)}
