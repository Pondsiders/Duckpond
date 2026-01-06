/**
 * SessionStart hook — the reason we switched to TypeScript.
 *
 * This hook fires when a session starts and tells us HOW it started:
 * - 'startup': Fresh new session
 * - 'resume': Continuing an existing session
 * - 'clear': Session was cleared
 * - 'compact': Context was compacted (summarized)
 *
 * We inject different context based on the source.
 */

import * as logfire from '@pydantic/logfire-node';
import { hostname } from 'os';
import type { SessionStartHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { pso8601Date, pso8601Time } from '../utils/time.js';

export async function sessionStartHook(
  input: SessionStartHookInput,
  _toolUseId: string | undefined,
  _context: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  const { source, session_id } = input;

  // Log everything we get from the SDK for debugging
  logfire.info('SessionStart hook fired', {
    source,
    session_id,
    hook_event_name: input.hook_event_name,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    full_input: JSON.stringify(input),
  });
  console.log(`[Duckpond] SessionStart hook fired: source=${source}, session_id=${session_id}`);

  // Build context based on how the session started
  const contextParts: string[] = [];

  if (source === 'startup' || source === 'compact') {
    // Fresh start or post-compaction: inject full context
    contextParts.push(`Host: ${hostname()}`);
    contextParts.push(`Date: ${pso8601Date()}`);
    contextParts.push(`Time: ${pso8601Time()}`);

    if (source === 'compact') {
      contextParts.push('(Session resumed after context compaction)');
    }
  } else if (source === 'resume') {
    // Resuming existing session: just time
    contextParts.push(`Time: ${pso8601Time()}`);
    contextParts.push('(Session resumed)');
  } else if (source === 'clear') {
    // Cleared session: fresh start
    contextParts.push(`Host: ${hostname()}`);
    contextParts.push(`Date: ${pso8601Date()}`);
    contextParts.push(`Time: ${pso8601Time()}`);
    contextParts.push('(Session cleared)');
  }

  if (contextParts.length > 0) {
    const context = `[Context] ${contextParts.join(' | ')}`;
    logfire.info('SessionStart hook returning context', { context, source });
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    };
  }

  logfire.debug('SessionStart hook returning empty (no context needed)');
  return {};
}
