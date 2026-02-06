"""Chat route - the main conversation endpoint.

Frontend sends minimal payload { sessionId, content }, we stream back SSE events.

POST /api/chat handles sending messages and streaming responses.
POST /api/chat/interrupt stops the current operation.

AlphaClient (via alpha_sdk) handles everything:
- Soul injection and orientation
- Memory recall and suggest
- Compact prompt rewriting
- Turn archiving
- Observability spans

Gazebo just needs to:
1. Pass user content to client.query()
2. Translate client.stream() messages to SSE events
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
    ToolUseBlock,
    ToolResultBlock,
)
from claude_agent_sdk.types import StreamEvent

from duckpond.client import client

router = APIRouter()


async def stream_sse_events(content: str | list[Any], session_id: str | None) -> AsyncGenerator[str, None]:
    """Stream Claude's response as SSE events.

    Event types:
    - text-delta: { type: "text-delta", data: "..." }  -- streaming text chunks
    - tool-call: { type: "tool-call", data: { toolCallId, toolName, args, argsText } }
    - tool-result: { type: "tool-result", data: { toolCallId, result, isError } }
    - session-id: { type: "session-id", data: "..." }
    - context: { type: "context", data: { count, window } }  -- token count update
    - error: { type: "error", data: "..." }
    - done: data: [DONE]
    """
    queue: asyncio.Queue[dict | None] = asyncio.Queue()

    async def run_sdk() -> None:
        """Run the SDK interaction in a background task."""
        sid = session_id

        try:
            with logfire.span("gazebo.run", session_id=sid[:8] if sid else "new"):
                # Ensure session exists
                await client.ensure_session(sid)

                # Wire up token count callback for this turn's SSE stream
                async def on_token_count(count: int, window: int) -> None:
                    await queue.put({
                        "type": "context",
                        "data": {"count": count, "window": window}
                    })

                client.set_token_count_callback(on_token_count)

                # Send query to AlphaClient
                # (AlphaClient handles recall, orientation, soul injection internally)
                with logfire.span("gazebo.query"):
                    await client.query(content, session_id=sid)

                # Stream response
                with logfire.span("gazebo.stream"):
                    async for message in client.stream():
                        logfire.debug("Received message", message_type=type(message).__name__)

                        # Handle streaming events (real-time text deltas)
                        if isinstance(message, StreamEvent):
                            event = message.event
                            event_type = event.get("type")

                            if event_type == "content_block_delta":
                                delta = event.get("delta", {})
                                delta_type = delta.get("type")

                                if delta_type == "text_delta":
                                    text = delta.get("text", "")
                                    if text:
                                        await queue.put({"type": "text-delta", "data": text})

                        # Handle complete messages (tool calls, etc.)
                        elif isinstance(message, AssistantMessage):
                            for block in message.content:
                                # Only handle tool calls - text was already streamed
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
                            # Tool results come through as UserMessage
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

                # After turn: send token count for context-o-meter
                token_count = client.token_count
                context_window = client.context_window
                if token_count > 0:
                    await queue.put({
                        "type": "context",
                        "data": {"count": token_count, "window": context_window}
                    })

        except Exception as e:
            logfire.exception(f"SDK error: {e}")
            await queue.put({"type": "error", "data": str(e)})

        finally:
            await queue.put(None)

    with logfire.span("gazebo.stream_response", session_id=session_id[:8] if session_id else "new"):
        task = asyncio.create_task(run_sdk())

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event)}\n\n"

            yield "data: [DONE]\n\n"

        except Exception as e:
            logfire.exception(f"Stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'data': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

        finally:
            await task


@router.post("/api/chat")
async def chat(request: Request) -> StreamingResponse:
    """Handle chat messages and stream responses via SSE.

    Request body:
    {
        "sessionId": "optional-session-id",
        "content": "user message text" or [content blocks]
    }
    """
    with logfire.span("gazebo.chat"):
        raw_body = await request.body()
        body = orjson.loads(raw_body)

        session_id = body.get("sessionId")
        content = body.get("content", "")

        logfire.info(
            "chat request",
            session_id=session_id[:8] if session_id else "new",
            content_length=len(content) if isinstance(content, str) else len(content),
        )

        return StreamingResponse(
            stream_sse_events(content, session_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
        )


@router.post("/api/chat/interrupt")
async def interrupt() -> dict[str, str]:
    """Interrupt the current operation."""
    try:
        await client.interrupt()
        logfire.info("Interrupted")
        return {"status": "interrupted"}
    except Exception as e:
        logfire.exception(f"Interrupt error: {e}")
        return {"status": "error", "message": str(e)}
