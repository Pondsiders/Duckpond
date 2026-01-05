# Duckpond Notes

Developer notes, quick references, things we learned.

---

## Agent SDK Hooks Reference

The Claude Agent SDK supports exactly **10 hook events**. No more, no less.

### Hook Types

| Hook Event | When It Fires | What It Can Do |
|------------|---------------|----------------|
| **PreToolUse** | Before tool calls | Block tool, modify inputs via `updatedInput` |
| **PostToolUse** | After tool calls complete | Read-only, observe results |
| **PermissionRequest** | When permission dialogs shown | Allow/deny |
| **UserPromptSubmit** | User submits prompt | Block prompt, add `additionalContext` |
| **Stop** | Main agent finishes | Block |
| **SubagentStop** | Subagent finishes | Block |
| **Notification** | Notifications sent | Read-only |
| **PreCompact** | Before compaction | Read-only |
| **SessionStart** | Session starts/resumes | Add context via stdout |
| **SessionEnd** | Session ends | Read-only |

### What Hooks CAN'T Do

- **No `UserPromptModifier`** — There is no hook that rewrites user prompts. The docs showed an `updatedPrompt` example but it doesn't exist. We tested it 2026-01-05; the hook silently didn't fire.
- **Can't modify prompt text** — `UserPromptSubmit` can only *add* context or *block* entirely. It cannot change what the user typed.

### Return Structures

**Simple (exit codes):**
- Exit 0: Success. Stdout added to context (for UserPromptSubmit/SessionStart)
- Exit 2: Blocking error. Stderr shown to Claude, action blocked
- Other: Non-blocking error

**Advanced (JSON):**

```json
// PreToolUse — can modify tool inputs
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "updatedInput": { "field": "new_value" }
  }
}

// UserPromptSubmit — can add context or block
{
  "decision": "block",  // optional
  "reason": "string",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "string"
  }
}

// Stop/SubagentStop — can block
{
  "decision": "block",
  "reason": "string"
}
```

### What We Use in Duckpond

- **UserPromptSubmit** → `subvox_prompt_hook` — Searches Cortex, injects relevant memories
- **Stop** → `subvox_stop_hook` — Extracts memorables from conversation

---

## Experiments Log

### 2026-01-05: UserPromptModifier (FAILED)

Tried to implement timestamp injection via a `UserPromptModifier` hook based on SDK docs example. The hook never fired—`UserPromptModifier` is not a recognized hook type. The SDK silently ignores unknown hook names.

Conclusion: If you need to modify prompts, do it in Eavesdrop (proxy layer) or via `additionalContext` in `UserPromptSubmit`.

---

*Last updated: January 5, 2026*
