"""Memories package - Alpha's associative memory system.

Two operations:
- recall: What sounds familiar from this prompt? (prompt → memories)
- suggest: What's memorable from this conversation? (conversation → memorables)

This is the thick-client implementation - Duckpond handles memory operations
directly instead of calling out to the Intro microservice.
"""

from .recall import recall

__all__ = ["recall"]
