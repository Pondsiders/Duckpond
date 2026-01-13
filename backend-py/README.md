# Duckpond Backend (Python)

Alpha's home - a persistent Claude interface built on the Claude Agent SDK.

## Architecture

One process. One client. One duck.

The backend maintains a single `ClaudeSDKClient` for the life of the application,
providing persistent conversation context, real hooks support, and reliable interruption.

## Running

```bash
uv run uvicorn duckpond.main:app --reload --port 8766
```

## Endpoints

- `POST /api/chat` - Send messages, stream responses
- `POST /api/chat/interrupt` - Stop current operation
- `GET /api/sessions` - List recent sessions
- `GET /api/sessions/{id}` - Load session history
- `GET /api/context` - Current time/machine info
- `GET /api/context/{session_id}` - Token counts from Redis
