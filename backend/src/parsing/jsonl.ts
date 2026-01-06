/**
 * JSONL parsing for Claude Code session files.
 *
 * Claude Code stores conversations in ~/.claude/projects/<slug>/<session-id>.jsonl
 * Each line is a JSON record with type, message, uuid, timestamp, etc.
 */

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface SessionRecord {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

interface DisplayMessage {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    argsText?: string;
    result?: string;
    isError?: boolean;
  }>;
  uuid?: string;
  timestamp?: string;
}

/**
 * Parse JSONL into displayable messages with text and tool calls.
 *
 * Extracts text blocks and tool_use/tool_result pairs for UI rendering.
 * Tool results are matched to their corresponding tool_use by ID.
 */
export function extractDisplayMessages(lines: string[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const toolResults = new Map<string, { content: string; isError: boolean }>();

  // First pass: collect all tool results
  for (const line of lines) {
    if (!line.trim()) continue;

    let record: SessionRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const contentBlocks = record.message?.content;
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, {
            content: block.content || '',
            isError: block.is_error || false,
          });
        }
      }
    }
  }

  // Second pass: build messages with tool calls
  for (const line of lines) {
    if (!line.trim()) continue;

    let record: SessionRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip non-message records
    if (record.type !== 'user' && record.type !== 'assistant') {
      continue;
    }

    const role = record.message?.role;
    const contentBlocks = record.message?.content;
    const contentParts: DisplayMessage['content'] = [];

    // Handle string content
    if (typeof contentBlocks === 'string') {
      if (contentBlocks) {
        contentParts.push({ type: 'text', text: contentBlocks });
      }
    } else if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (typeof block === 'string') {
          if (block) {
            contentParts.push({ type: 'text', text: block });
          }
        } else if (block.type === 'text') {
          if (block.text) {
            contentParts.push({ type: 'text', text: block.text });
          }
        } else if (block.type === 'tool_use') {
          const resultData = toolResults.get(block.id || '');
          contentParts.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            args: block.input,
            argsText: JSON.stringify(block.input),
            result: resultData?.content,
            isError: resultData?.isError || false,
          });
        }
        // Skip tool_result blocks - handled above
      }
    }

    // Only add message if it has content
    if (contentParts.length > 0 && role) {
      messages.push({
        role,
        content: contentParts,
        uuid: record.uuid,
        timestamp: record.timestamp,
      });
    }
  }

  return messages;
}
