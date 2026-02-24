"""Chat route — fire-and-forget message sending.

POST /api/chat pushes a message onto the queue and returns immediately.
Responses flow through the persistent SSE pipe (GET /api/stream).

POST /api/chat/interrupt stops the current operation.
"""

import orjson
from fastapi import APIRouter, Request

from duckpond.client import client

router = APIRouter()


@router.post("/api/chat")
async def chat(request: Request) -> dict:
    """Queue a message for processing. Returns immediately.

    Request body:
    {
        "sessionId": "optional-session-id",
        "content": "user message text" or [content blocks]
    }

    Response: {"status": "queued"}

    The actual response streams through GET /api/stream.
    """
    raw_body = await request.body()
    body = orjson.loads(raw_body)

    session_id = body.get("sessionId")
    content = body.get("content", "")

    try:
        await client.send(content, session_id=session_id)
        return {"status": "queued"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/api/chat/interrupt")
async def interrupt() -> dict[str, str]:
    """Interrupt the current operation."""
    try:
        await client.interrupt()
        return {"status": "interrupted"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
