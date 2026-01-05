"""Subvox hooks — the voice that whispers.

These hooks bridge Duckpond to the Subvox memory system, which extracts
memorable moments from conversations and stores them to Cortex.
"""

import asyncio
import json

from ..config import SUBVOX_DIR


async def subvox_prompt_hook(input_data: dict, tool_use_id: str | None, context) -> dict:
    """UserPromptSubmit hook — asks Subvox for memorables to inject into context."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "uv",
            "run",
            "--directory",
            str(SUBVOX_DIR),
            "python",
            "-m",
            "subvox.prompt_hook",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(input=json.dumps(input_data).encode())

        if stderr:
            print(f"[Subvox prompt hook stderr] {stderr.decode()}")

        if stdout:
            output = stdout.decode().strip()
            if output:
                return {
                    "hookSpecificOutput": {
                        "hookEventName": input_data["hook_event_name"],
                        "additionalContext": output,
                    }
                }
    except Exception as e:
        print(f"[Subvox prompt hook error] {e}")

    return {}


async def subvox_stop_hook(input_data: dict, tool_use_id: str | None, context) -> dict:
    """Stop hook — tells Subvox to extract memorables from the conversation."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "uv",
            "run",
            "--directory",
            str(SUBVOX_DIR),
            "python",
            "-m",
            "subvox.stop_hook",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(input=json.dumps(input_data).encode())

        if stderr:
            print(f"[Subvox stop hook stderr] {stderr.decode()}")
        if stdout:
            print(f"[Subvox stop hook stdout] {stdout.decode()}")

    except Exception as e:
        print(f"[Subvox stop hook error] {e}")

    return {}
