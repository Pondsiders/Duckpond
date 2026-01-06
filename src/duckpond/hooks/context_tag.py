"""Context tag hook — session tracking for accurate token counting.

Injects a session UUID tag into the user message so Eavesdrop can
identify which conversation the API request belongs to. Eavesdrop
strips the tag, counts tokens, and stashes the count in Redis keyed
by session ID.
"""


async def inject_session_tag(input_data: dict, tool_use_id: str | None, context) -> dict:
    """UserPromptSubmit hook — injects session UUID as a tag for Eavesdrop."""
    # Session ID comes from the input_data's session context
    session_id = input_data.get("session_id")

    if session_id:
        tag = f"<duckpond-session>{session_id}</duckpond-session>"
        return {
            "hookSpecificOutput": {
                "hookEventName": input_data.get("hook_event_name", "UserPromptSubmit"),
                "additionalContext": tag,
            }
        }

    return {}
