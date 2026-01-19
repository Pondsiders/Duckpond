"""Duckpond backend - FastAPI application.

One process. One client. One duck.

Lazy initialization: no client at startup.
First chat request creates the client.
"""

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pondside.telemetry import init

from duckpond.client import client
from duckpond.routes.chat import router as chat_router
from duckpond.routes.sessions import router as sessions_router
from duckpond.routes.context import router as context_router

# Initialize telemetry - must be done before anything else
init("duckpond")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """App lifespan - just cleanup on shutdown.

    Client is created lazily on first request, not at startup.
    """
    print("[Duckpond] Starting up... (client will connect on first request)")

    yield

    print("[Duckpond] Shutting down...")
    await client.shutdown()
    print("[Duckpond] Goodbye.")


app = FastAPI(
    title="Duckpond",
    description="Alpha's home - a persistent Claude interface",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS - allow frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routes
app.include_router(chat_router)
app.include_router(sessions_router)
app.include_router(context_router)


@app.get("/health")
async def health() -> dict[str, str | None]:
    """Health check endpoint."""
    return {
        "status": "healthy",
        "client_connected": str(client.connected),
        "current_session": client.current_session_id[:8] + "..." if client.current_session_id else None,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8766"))
    uvicorn.run(app, host="0.0.0.0", port=port)
