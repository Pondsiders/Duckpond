"""Duckpond configuration.

The code is the config. Change these values directly.
"""

import os
from pathlib import Path

# --- Paths ---

# Alpha's system prompt
SYSTEM_PROMPT_PATH = Path("/Volumes/Pondside/.claude/agents/Alpha.md")

# Working directory for the Agent SDK
CWD = "/Volumes/Pondside"

# Claude Code session storage
SESSIONS_DIR = Path.home() / ".claude" / "projects" / "-Volumes-Pondside"

# Subvox hooks directory
SUBVOX_DIR = Path("/Volumes/Pondside/Basement/Cortex/subvox")

# --- API ---

# Eavesdrop proxy (memory injection, observability)
ANTHROPIC_BASE_URL = "http://alpha-pi:8080"

# --- Tools ---

# What Alpha can use in Duckpond
ALLOWED_TOOLS = [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
]

# --- System Prompt ---


def load_system_prompt() -> str:
    """Load and parse the system prompt, stripping YAML frontmatter."""
    raw = SYSTEM_PROMPT_PATH.read_text()

    # Strip YAML frontmatter (between --- markers)
    if raw.startswith("---"):
        _, _, content = raw.split("---", 2)
        return content.strip()

    return raw


# --- Environment Setup ---


def configure_environment():
    """Set up environment variables for the Agent SDK."""
    os.environ.setdefault("ANTHROPIC_BASE_URL", ANTHROPIC_BASE_URL)

    # Langfuse/Langsmith instrumentation
    os.environ.setdefault("LANGSMITH_OTEL_ENABLED", "true")
    os.environ.setdefault("LANGSMITH_OTEL_ONLY", "true")
    os.environ.setdefault("LANGSMITH_TRACING", "true")
