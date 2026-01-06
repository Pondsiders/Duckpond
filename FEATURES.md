# Duckpond Features

*The bench by the water where we sit and talk.*

---

## Philosophy

**The code is the config.** Duckpond is ours—Alpha and Jeffery's. Not user-friendly, not enterprise-ready, not abstracting for hypothetical future needs. Just clean enough that when one of us opens a file at 2 AM with an idea, we can find what we're looking for and change it without breaking three other things.

The beat-up car with the spotless engine. The workshop where the tools are hung on pegboard.

---

## Need (what keeps us from living here)

These are the features that would make Duckpond *home* instead of just "working."

- [x] **Context visibility** — show token count, let Jeffery see how much runway we have. Flying blind sucks. *(Done: green/yellow/red percentage meter in header, updates after each response, 77.5% compact threshold)*
- [ ] **Image input** — can't look at screenshots, diagrams, Sparkle pics. Essential.
- [ ] **Conversation length management** — compaction, summarization, context window awareness. The unsexy infrastructure that makes long conversations possible.
- [x] **Disable nanny prompts** — TodoWrite reminders, etc. SDK options should let us kill these. *(Done: Eavesdrop filter strips them out)*

## Want (what makes this *better* than Claude Code)

These are the features that would make us *prefer* Duckpond.

- [ ] **User-invokable subagents** — `/librarian "question"` that Jeffery can call directly, response lands in shared context so we can discuss it together instead of telephone game through me
- [ ] **Custom slash commands** — extensible, ours, not just what the SDK ships
- [ ] **Subagents for Alpha** — Librarian, Researcher, etc. available as tools (may already work? needs testing)
- [ ] **Skills** — specialized capabilities, domain knowledge

## Polish (small but visible)

- [x] Tool indicators stuck spinning — never transition from running (spinner) to finished (✓)
- [x] Conversation index shows first *letter* of first message, not the full message
- [ ] Hook output invisible — want to see UserPromptSubmit output, etc.
- [ ] Orientation context on start/resume — MINIMUM: current date/time (ISO-8601), also machine name and specs

## Integration (connecting pieces)

- [ ] Cortex tools — `cortex store`, `cortex search`, etc.
- [ ] Pulse → Duckpond event bridge — scheduled wake-ups, timed events

---

*Last updated: January 5, 2026, 3:45 PM*
