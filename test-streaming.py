#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "claude-agent-sdk>=0.1.25",
# ]
# ///
"""
Minimal streaming test for Claude Agent SDK.

Run this script, type a prompt, watch for streaming output.
If streaming works, you'll see text appear character by character.
If not, you'll see the whole response dump at once.
"""

import asyncio
import logging
import sys

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from claude_agent_sdk.types import StreamEvent

# Verbose logging
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


async def main():
    # Read prompt from stdin
    print("Enter your prompt (then press Enter):", file=sys.stderr)
    prompt = input()

    if not prompt.strip():
        print("No prompt provided", file=sys.stderr)
        return

    logger.info(f"Prompt: {prompt[:50]}...")

    # Create client with streaming enabled
    options = ClaudeAgentOptions(
        system_prompt="You are a helpful assistant. Keep responses brief.",
        allowed_tools=[],  # No tools, just text
        permission_mode="bypassPermissions",
        cwd="/tmp",
        include_partial_messages=True,  # THE KEY FLAG FOR STREAMING
    )

    logger.info("Creating client...")
    client = ClaudeSDKClient(options)

    logger.info("Connecting...")
    await client.connect()

    logger.info("Sending query...")
    await client.query(prompt)

    logger.info("Receiving response...")
    stream_event_count = 0
    text_delta_count = 0
    other_count = 0

    print("\n--- RESPONSE ---\n", file=sys.stderr)

    async for message in client.receive_response():
        # logger.debug(f"{message}")
        msg_type = type(message).__name__

        if isinstance(message, StreamEvent):
            stream_event_count += 1
            event = message.event
            event_type = event.get("type")

            if event_type == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    text_delta_count += 1
                    text = delta.get("text", "")
                    # Print streaming text to stdout (no newline, flush immediately)
                    print(text, end="", flush=True)
            else:
                logger.debug(f"StreamEvent: {event_type}")
        else:
            other_count += 1
            logger.info(f"Message: {msg_type}")

    print("\n\n--- END ---\n", file=sys.stderr)

    logger.info(f"Stats: StreamEvents={stream_event_count}, text_deltas={text_delta_count}, other={other_count}")

    await client.disconnect()
    logger.info("Done!")


if __name__ == "__main__":
    asyncio.run(main())
