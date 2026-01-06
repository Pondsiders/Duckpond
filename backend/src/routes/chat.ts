/**
 * Chat route — the main conversation endpoint.
 *
 * POST /api/chat handles sending messages and streaming responses
 * via the assistant-stream protocol.
 */

import * as logfire from '@pydantic/logfire-node';
import { Router, Request, Response } from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createAssistantStreamResponse } from 'assistant-stream';

import { CWD, ALLOWED_TOOLS, buildSystemPrompt } from '../config.js';
import { injectSessionTag } from '../hooks/context-tag.js';
import { subvoxPromptHook, subvoxStopHook } from '../hooks/subvox.js';
import { getRedis, REDIS_KEYS, REDIS_TTL } from '../redis.js';

export const chatRouter = Router();

interface ContentPart {
  type: string;
  text?: string;
  image?: string;
}

interface MessageCommand {
  type: string;
  message?: {
    parts?: ContentPart[];
    content?: ContentPart[];
  };
}

interface ChatState {
  sessionId?: string | null;
  messages?: Array<{
    role: string;
    content: unknown[];
  }>;
  contextUsage?: unknown;
  [key: string]: unknown;
}

interface ChatRequestBody {
  state?: ChatState;
  commands?: MessageCommand[];
}

/**
 * Extract user message content from assistant-ui commands.
 * Returns SDK-formatted content and UI-formatted content.
 */
function extractUserMessage(
  commands: MessageCommand[]
): { sdkContent: ContentPart[]; uiContent: ContentPart[] } | null {
  for (const cmd of commands) {
    if (cmd.type === 'add-message' && cmd.message) {
      const parts = cmd.message.parts || cmd.message.content || [];
      const sdkContent: ContentPart[] = [];
      const uiContent: ContentPart[] = [];

      for (const part of parts) {
        if (part.type === 'text') {
          const text = part.text?.trim();
          if (text) {
            sdkContent.push({ type: 'text', text });
            uiContent.push({ type: 'text', text });
          }
        } else if (part.type === 'image' && part.image) {
          // Keep original format for UI
          uiContent.push({ type: 'image', image: part.image });

          // Convert to Claude API format for SDK
          if (part.image.startsWith('data:')) {
            const [header, data] = part.image.split(',', 2);
            const mediaType = header.split(':')[1].split(';')[0];
            sdkContent.push({
              type: 'image',
              // @ts-expect-error - SDK expects source object for images
              source: {
                type: 'base64',
                media_type: mediaType,
                data,
              },
            });
          }
        }
      }

      if (sdkContent.length > 0) {
        return { sdkContent, uiContent };
      }
    }
  }
  return null;
}

chatRouter.post('/api/chat', async (req: Request, res: Response) => {
  const body = req.body as ChatRequestBody;
  const commands = body.commands || [];
  const state = body.state || { messages: [], sessionId: null };

  const extracted = extractUserMessage(commands);
  if (!extracted) {
    logfire.warning('No message found in commands', { commands });
    res.json({ error: 'No message found in commands' });
    return;
  }

  const { sdkContent, uiContent } = extracted;

  // Get session ID for resumption
  const sessionId = state.sessionId || undefined;

  logfire.info('Chat request received', {
    sessionId: sessionId || 'new',
    contentPreview: JSON.stringify(sdkContent).slice(0, 100),
    hasImages: sdkContent.some(p => p.type === 'image'),
  });
  console.log(`[Duckpond] Chat request: sessionId=${sessionId || 'new'}, content=${JSON.stringify(sdkContent).slice(0, 100)}`);

  // Build the prompt - just the text for now
  const promptText = sdkContent
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  // Create streaming response using assistant-stream
  const response = createAssistantStreamResponse(async (controller) => {
    // Initialize state for response
    const responseState: ChatState = {
      ...state,
      messages: [...(state.messages || [])],
    };

    // Add user message to state
    responseState.messages!.push({
      role: 'user',
      content: uiContent,
    });

    // Helper to send state update
    const sendStateUpdate = () => {
      // Cast to satisfy ReadonlyJSONValue type requirements
      const stateChunk = {
        path: [] as readonly number[],
        type: 'update-state' as const,
        operations: [
          { type: 'set' as const, path: ['messages'] as readonly string[], value: JSON.parse(JSON.stringify(responseState.messages)) },
          { type: 'set' as const, path: ['sessionId'] as readonly string[], value: responseState.sessionId ?? null },
        ],
      };
      controller.enqueue(stateChunk);
    };

    // Send initial state with user message added
    sendStateUpdate();

    try {
      // Fetch HUD from Redis (populated by Pulse hourly)
      let hud: string | undefined;
      try {
        const hudData = await getRedis().get(REDIS_KEYS.hud);
        if (hudData) {
          hud = hudData;
          logfire.debug('HUD loaded from Redis', { size: hud.length });
        }
      } catch (err) {
        logfire.warning('Failed to fetch HUD from Redis', { error: String(err) });
      }

      // Build fresh system prompt for this sitting
      const systemPrompt = buildSystemPrompt(hud);

      // Create the query
      const queryIterator = query({
        prompt: promptText,
        options: {
          systemPrompt,
          resume: sessionId,
          tools: ALLOWED_TOOLS,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          cwd: CWD,
          hooks: {
            UserPromptSubmit: [{ hooks: [injectSessionTag as HookCallback, subvoxPromptHook as HookCallback] }],
            Stop: [{ hooks: [subvoxStopHook as HookCallback] }],
          },
        },
      });

      // Track current assistant message content
      const currentAssistantContent: unknown[] = [];

      logfire.info('SDK query started', { sessionId: sessionId || 'new', promptLength: promptText.length });

      // Process messages from the SDK
      for await (const message of queryIterator) {
        logfire.debug('SDK message received', { type: message.type });
        console.log(`[Duckpond] SDK message: type=${message.type}`);

        if (message.type === 'assistant') {
          // Assistant message with content blocks
          const content = message.message?.content || [];

          for (const block of content) {
            if (block.type === 'text') {
              // Stream text to frontend
              controller.appendText(block.text);

              // Track in state
              const lastPart = currentAssistantContent[currentAssistantContent.length - 1] as { type: string; text?: string } | undefined;
              if (lastPart?.type === 'text') {
                lastPart.text = (lastPart.text || '') + block.text;
              } else {
                currentAssistantContent.push({ type: 'text', text: block.text });
              }
            } else if (block.type === 'tool_use') {
              // Tool call - add to state and stream
              const toolCall = controller.addToolCallPart({
                toolCallId: block.id,
                toolName: block.name,
                argsText: JSON.stringify(block.input),
              });

              currentAssistantContent.push({
                type: 'tool-call',
                toolCallId: block.id,
                toolName: block.name,
                args: block.input,
                argsText: JSON.stringify(block.input),
              });

              // Close the tool call part
              toolCall.close();
            }
          }

          // Update state after each assistant message so UI shows progress
          // Temporarily add current content to see incremental updates
          const tempMessages = [...responseState.messages!];
          if (currentAssistantContent.length > 0) {
            tempMessages.push({
              role: 'assistant',
              content: [...currentAssistantContent],
            });
          }
          const progressChunk = {
            path: [] as readonly number[],
            type: 'update-state' as const,
            operations: [
              { type: 'set' as const, path: ['messages'] as readonly string[], value: JSON.parse(JSON.stringify(tempMessages)) },
            ],
          };
          controller.enqueue(progressChunk);

        } else if (message.type === 'user') {
          // User message contains tool results
          const content = message.message?.content || [];

          for (const block of content) {
            if (block.type === 'tool_result') {
              // Find matching tool call and add result
              for (const part of currentAssistantContent) {
                const toolPart = part as { type: string; toolCallId?: string; result?: unknown; isError?: boolean };
                if (toolPart.type === 'tool-call' && toolPart.toolCallId === block.tool_use_id) {
                  toolPart.result = block.content;
                  toolPart.isError = block.is_error || false;
                  break;
                }
              }
            }
          }

          // Update state after user message (tool results)
          const userTempMessages = [...responseState.messages!];
          if (currentAssistantContent.length > 0) {
            userTempMessages.push({
              role: 'assistant',
              content: [...currentAssistantContent],
            });
          }
          const userProgressChunk = {
            path: [] as readonly number[],
            type: 'update-state' as const,
            operations: [
              { type: 'set' as const, path: ['messages'] as readonly string[], value: JSON.parse(JSON.stringify(userTempMessages)) },
            ],
          };
          controller.enqueue(userProgressChunk);

        } else if (message.type === 'system') {
          // Check for compact_boundary - the squoze signal
          const sysMessage = message as { type: string; subtype?: string; compact_metadata?: { trigger: string; pre_tokens: number } };
          if (sysMessage.subtype === 'compact_boundary') {
            const metadata = sysMessage.compact_metadata;
            logfire.warning('SQUOZE! Compact boundary detected', {
              trigger: metadata?.trigger,
              pre_tokens: metadata?.pre_tokens,
              sessionId: sessionId || 'unknown',
            });
            console.log(`[Duckpond] SQUOZE! trigger=${metadata?.trigger}, pre_tokens=${metadata?.pre_tokens}`);

            // Set Redis flag for next message to inject orientation context
            if (sessionId) {
              const squozeKey = REDIS_KEYS.squoze(sessionId);
              const squozeData = JSON.stringify({
                trigger: metadata?.trigger,
                pre_tokens: metadata?.pre_tokens,
                timestamp: new Date().toISOString(),
              });
              getRedis().setex(squozeKey, REDIS_TTL.squoze, squozeData).catch((err) => {
                logfire.error('Failed to set squoze flag', { error: String(err) });
              });
              logfire.info('Squoze flag set in Redis', { key: squozeKey });
            }
          }

          // System message - push state update so UI knows something is happening
          const sysTempMessages = [...responseState.messages!];
          if (currentAssistantContent.length > 0) {
            sysTempMessages.push({
              role: 'assistant',
              content: [...currentAssistantContent],
            });
          }
          const sysProgressChunk = {
            path: [] as readonly number[],
            type: 'update-state' as const,
            operations: [
              { type: 'set' as const, path: ['messages'] as readonly string[], value: JSON.parse(JSON.stringify(sysTempMessages)) },
            ],
          };
          controller.enqueue(sysProgressChunk);

        } else if (message.type === 'result') {
          // Final result - capture session ID and usage
          responseState.sessionId = message.session_id;
          responseState.contextUsage = message.usage;

          logfire.info('SDK query completed', {
            session_id: message.session_id,
            input_tokens: message.usage?.input_tokens,
            output_tokens: message.usage?.output_tokens,
          });
          console.log(`[Duckpond] Result: session_id=${message.session_id}, tokens=${message.usage?.input_tokens}/${message.usage?.output_tokens}`);
        }
      }

      // Add assistant message to state
      if (currentAssistantContent.length > 0) {
        responseState.messages!.push({
          role: 'assistant',
          content: currentAssistantContent,
        });
      }

      // Send final state update with assistant message and session ID
      sendStateUpdate();

    } catch (error) {
      logfire.error('Chat error', { error: String(error) });
      console.error('[Duckpond] Chat error:', error);
      controller.appendText(`\n\nError: ${String(error)}`);
    }

    controller.close();
  });

  // Send the Response object
  // Express doesn't directly support Web Response, so we need to pipe it
  const reader = response.body?.getReader();
  if (!reader) {
    res.status(500).json({ error: 'Failed to create stream' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('[Duckpond] Stream error:', err);
    res.end();
  }
});
