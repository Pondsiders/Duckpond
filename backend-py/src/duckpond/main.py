"""Duckpond backend - FastAPI application.

One process. One client. One duck.

Lazy initialization: no client at startup.
First chat request creates the client.
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logfire

from duckpond.client import client
from duckpond.routes.chat import router as chat_router
from duckpond.routes.stream import router as stream_router
from duckpond.routes.sessions import router as sessions_router
from duckpond.routes.context import router as context_router

# Suppress harmless "Failed to detach context" warnings from OTel
# These occur when spans cross async generator boundaries - expected behavior
logging.getLogger("opentelemetry.context").setLevel(logging.CRITICAL)

# Initialize Logfire
# Scrubbing disabled - too aggressive (redacts "session", "auth", etc.)
# Our logs are authenticated with 30-day retention; acceptable risk for debugging visibility
logfire.configure(
    service_name="duckpond",
    distributed_tracing=True,
    scrubbing=False,
)

# Route Python logging through Logfire
logging.basicConfig(handlers=[logfire.LogfireLoggingHandler()], level=logging.INFO)


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

# Instrument FastAPI with Logfire for automatic request tracing
logfire.instrument_fastapi(app)

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
app.include_router(stream_router)
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
