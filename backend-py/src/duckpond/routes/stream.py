"""Stream route — the persistent SSE pipe.

GET /api/stream opens a single SSE connection per session.
All responses flow through it. Browser manages reconnection via EventSource.

This replaces the per-POST SSE streams from the old chat route.
"""

import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from duckpond.client import client

router = APIRouter()


@router.get("/api/stream")
async def stream(request: Request, sessionId: str | None = None) -> StreamingResponse:
    """Persistent SSE connection for a session.

    Opens once, stays open, carries all responses.
    Browser reconnects automatically via EventSource.

    Query params:
        sessionId: Session to resume, or omit for new session
    """

    async def event_generator():
        try:
            # Ensure session exists (creates client if needed)
            await client.ensure_session(sessionId)

            # Yield SSE events from the response queue
            async for event in client.events():
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                event_type = event.get("type", "message")
                event_data = json.dumps(event.get("data", {}))
                event_id = event.get("id")

                sse = f"event: {event_type}\ndata: {event_data}\n"
                if event_id is not None:
                    sse += f"id: {event_id}\n"
                sse += "\n"
                yield sse

        except Exception as e:
            error_data = json.dumps({"message": str(e)})
            yield f"event: error\ndata: {error_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
