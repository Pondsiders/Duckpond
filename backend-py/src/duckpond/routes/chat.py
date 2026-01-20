"""Chat route - the main conversation endpoint.

REFACTORED: Now uses simple SSE (Server-Sent Events) instead of assistant-stream.
Frontend sends minimal payload { sessionId, content }, we stream back events.

POST /api/chat handles sending messages and streaming responses.
POST /api/chat/interrupt stops the current operation.
"""

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

from pondside.telemetry import get_tracer

from duckpond.client import client

logger = logging.getLogger(__name__)
tracer = get_tracer()

router = APIRouter()


async def stream_sse_events(content: str, session_id: str | None) -> AsyncGenerator[str, None]:
    """Stream Claude's response as SSE events.

    Event types:
    - text: { type: "text", data: "..." }
    - tool-call: { type: "tool-call", data: { toolCallId, toolName, args, argsText } }
    - tool-result: { type: "tool-result", data: { toolCallId, result, isError } }
    - session-id: { type: "session-id", data: "..." }
    - error: { type: "error", data: "..." }
    - done: data: [DONE]
    """
    sid = session_id

    with tracer.start_as_current_span("duckpond.stream_response") as span:
        span.set_attribute("duckpond.session_id", sid[:8] if sid else "new")

        try:
            # Ensure session exists
            await client.ensure_session(sid)

            # Send query to Claude
            with tracer.start_as_current_span("duckpond.query"):
                await client.query(content, session_id=sid)

            # Stream response
            with tracer.start_as_current_span("duckpond.stream"):
                async for message in client.receive_response():
                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, TextBlock):
                                # Text content
                                event = {"type": "text", "data": block.text}
                                yield f"data: {json.dumps(event)}\n\n"

                            elif isinstance(block, ToolUseBlock):
                                # Tool call
                                event = {
                                    "type": "tool-call",
                                    "data": {
                                        "type": "tool-call",
                                        "toolCallId": block.id,
                                        "toolName": block.name,
                                        "args": block.input,
                                        "argsText": json.dumps(block.input),
                                    }
                                }
                                yield f"data: {json.dumps(event)}\n\n"

                    elif isinstance(message, UserMessage):
                        # Tool results come through as UserMessage with ToolResultBlock
                        if hasattr(message, "content"):
                            content_blocks = message.content
                            if isinstance(content_blocks, list):
                                for block in content_blocks:
                                    if isinstance(block, ToolResultBlock):
                                        event = {
                                            "type": "tool-result",
                                            "data": {
                                                "toolCallId": block.tool_use_id,
                                                "result": block.content,
                                                "isError": block.is_error or False,
                                            }
                                        }
                                        yield f"data: {json.dumps(event)}\n\n"

                    elif isinstance(message, ResultMessage):
                        # Final message with session ID
                        sid = message.session_id
                        event = {"type": "session-id", "data": sid}
                        yield f"data: {json.dumps(event)}\n\n"
                        logger.info(f"ResultMessage: session_id={sid[:8]}...")

            # Done
            yield "data: [DONE]\n\n"

        except Exception as e:
            logger.exception(f"Stream error: {e}")
            event = {"type": "error", "data": str(e)}
            yield f"data: {json.dumps(event)}\n\n"
            yield "data: [DONE]\n\n"


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
    with tracer.start_as_current_span("duckpond.chat") as chat_span:
        # Parse request - now much simpler!
        with tracer.start_as_current_span("duckpond.parse_request"):
            raw_body = await request.body()
            body = orjson.loads(raw_body)

            # New format: { sessionId, content }
            session_id = body.get("sessionId")
            content = body.get("content", "")

        chat_span.set_attribute("duckpond.content_length", len(content))
        logger.info(f"chat request: sessionId={session_id[:8] if session_id else 'new'}..., content_len={len(content)}")

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
