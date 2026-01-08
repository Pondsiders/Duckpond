/**
 * Chat route — the main conversation endpoint.
 *
 * POST /api/chat handles sending messages and streaming responses
 * via the assistant-stream protocol.
 */

import { Router, Request, Response } from 'express';
import { query as origQuery } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Laminar } from '@lmnr-ai/lmnr';
import { createAssistantStreamResponse } from 'assistant-stream';

// Wrap query for Laminar observability
const query = Laminar.wrapClaudeAgentQuery(origQuery);

import { CWD, ALLOWED_TOOLS, AGENTS, buildSystemPrompt } from '../config.js';
import { injectSessionTag } from '../hooks/context-tag.js';
import { subvoxPromptHook, subvoxStopHook } from '../hooks/subvox.js';
import { getRedis, REDIS_KEYS, REDIS_TTL } from '../redis.js';
import { pso8601DateTime } from '../utils/time.js';

export const chatRouter = Router();

// UI content part format (data URLs for images)
interface UIContentPart {
  type: string;
  text?: string;
  image?: string;
}

// SDK content part format (Claude API format for images)
interface SDKContentPart {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface MessageCommand {
  type: string;
  message?: {
    parts?: UIContentPart[];
    content?: UIContentPart[];
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
): { sdkContent: SDKContentPart[]; uiContent: UIContentPart[]; hasImages: boolean } | null {
  for (const cmd of commands) {
    if (cmd.type === 'add-message' && cmd.message) {
      const parts = cmd.message.parts || cmd.message.content || [];
      const sdkContent: SDKContentPart[] = [];
      const uiContent: UIContentPart[] = [];
      let hasImages = false;

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
          hasImages = true;

          // Convert to Claude API format for SDK
          if (part.image.startsWith('data:')) {
            const [header, data] = part.image.split(',', 2);
            const mediaType = header.split(':')[1].split(';')[0];
            sdkContent.push({
              type: 'image',
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
        return { sdkContent, uiContent, hasImages };
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
    console.warn('[Duckpond] No message found in commands');
    res.json({ error: 'No message found in commands' });
    return;
  }

  const { sdkContent, uiContent, hasImages } = extracted;

  // Get session ID for resumption
  const sessionId = state.sessionId || undefined;

  console.log(`[Duckpond] Chat request: sessionId=${sessionId || 'new'}, hasImages=${hasImages}`);

  // Build the prompt
  // If we have images, we need to use the full SDKUserMessage format
  // Otherwise, we can use a simple string (which the SDK handles more simply)
  // Prepend timestamp so Alpha knows exactly when the message was sent
  const timestamp = pso8601DateTime();
  const timestampPrefix = `[${timestamp}]\n\n`;

  const promptText = timestampPrefix + sdkContent
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  // Create an async generator that yields a single SDKUserMessage for multimodal content
  // Prepend timestamp as first text part so Alpha knows when the message was sent
  async function* createMultimodalPrompt(): AsyncGenerator<SDKUserMessage> {
    const timestampedContent: SDKContentPart[] = [
      { type: 'text', text: `[${timestamp}]` },
      ...sdkContent,
    ];
    yield {
      type: 'user',
      session_id: sessionId || '',
      message: {
        role: 'user',
        content: timestampedContent as unknown[],
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

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
        }
      } catch (err) {
        console.warn('[Duckpond] Failed to fetch HUD from Redis:', err);
      }

      // Build fresh system prompt for this sitting
      const systemPrompt = buildSystemPrompt(hud);

      // Create the query
      // Use multimodal prompt format if we have images, otherwise use simple string
      const prompt = hasImages ? createMultimodalPrompt() : promptText;

      const queryIterator = query({
        prompt,
        options: {
          systemPrompt,
          resume: sessionId,
          tools: ALLOWED_TOOLS,
          agents: AGENTS,
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

      // Process messages from the SDK
      for await (const message of queryIterator) {

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
            console.log(`[Duckpond] SQUOZE! trigger=${metadata?.trigger}, pre_tokens=${metadata?.pre_tokens}`);
            Laminar.event({
              name: 'squoze',
              attributes: {
                trigger: metadata?.trigger || 'unknown',
                pre_tokens: metadata?.pre_tokens || 0,
                sessionId: sessionId || 'unknown',
              },
            });

            // Set Redis flag for next message to inject orientation context
            if (sessionId) {
              const squozeKey = REDIS_KEYS.squoze(sessionId);
              const squozeData = JSON.stringify({
                trigger: metadata?.trigger,
                pre_tokens: metadata?.pre_tokens,
                timestamp: new Date().toISOString(),
              });
              getRedis().setex(squozeKey, REDIS_TTL.squoze, squozeData).catch((err) => {
                console.error('[Duckpond] Failed to set squoze flag:', err);
              });
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
