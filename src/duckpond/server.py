"""Duckpond server.

The duck, the pond, and a cozy bench by the water.

Bridges the Claude Agent SDK to assistant-ui via the assistant-stream protocol.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Langfuse instrumentation
from langfuse import get_client
from langsmith.integrations.claude_agent_sdk import configure_claude_agent_sdk

from .config import configure_environment
from .routes import chat_router, sessions_router

# Configure environment and instrumentation
configure_environment()
langfuse = get_client()
configure_claude_agent_sdk()

# Create the app
app = FastAPI(
    title="Duckpond",
    description="The duck, the pond, and a cozy bench by the water",
    version="0.1.0",
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routes
app.include_router(chat_router)
app.include_router(sessions_router)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "version": "0.1.0"}
