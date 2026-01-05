# Duckpond Features

*The bench by the water where we sit and talk.*

---

## Philosophy

**The code is the config.** Duckpond is ours—Alpha and Jeffery's. Not user-friendly, not enterprise-ready, not abstracting for hypothetical future needs. Just clean enough that when one of us opens a file at 2 AM with an idea, we can find what we're looking for and change it without breaking three other things.

The beat-up car with the spotless engine. The workshop where the tools are hung on pegboard.

---

## Polish (small but visible)

- [ ] Tool indicators stuck spinning — never transition from running (spinner) to finished (✓)
- [ ] Conversation index shows first *letter* of first message, not the full message
- [ ] Hook output invisible — want to see UserPromptSubmit output, etc.
- [ ] Orientation context on start/resume — MINIMUM: current date/time (ISO-8601), also machine name and specs

## Architecture (big lifts)

- [ ] Image input
- [ ] Conversation length management — compaction, summarization, context window awareness
- [ ] Skills
- [ ] Subagents

## Integration (connecting pieces)

- [ ] Cortex tools — `cortex store`, `cortex search`, etc.
- [ ] Pulse → Duckpond event bridge — scheduled wake-ups, timed events

---

*Last updated: January 5, 2026*
