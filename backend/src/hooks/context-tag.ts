/**
 * Context tag hook — session tracking for accurate token counting.
 *
 * Injects a session UUID tag into the user message so Eavesdrop can
 * identify which conversation the API request belongs to. Eavesdrop
 * strips the tag, counts tokens, and stashes the count in Redis keyed
 * by session ID.
 */

import * as logfire from '@pydantic/logfire-node';
import type { UserPromptSubmitHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export async function injectSessionTag(
  input: UserPromptSubmitHookInput,
  _toolUseId: string | undefined,
  _context: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  const sessionId = input.session_id;

  logfire.info('injectSessionTag hook called', {
    hasSessionId: !!sessionId,
    sessionIdPreview: sessionId ? sessionId.slice(0, 8) : null,
  });

  if (sessionId) {
    const tag = `<duckpond-session>${sessionId}</duckpond-session>`;
    logfire.info('Injecting session tag for Eavesdrop', {
      sessionIdShort: sessionId.slice(0, 8),
      tagLength: tag.length,
    });
    console.log(`[Duckpond] Injecting session tag: ${sessionId.slice(0, 8)}...`);

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: tag,
      },
    };
  }

  logfire.warning('No session ID available for tag injection');
  return {};
}
