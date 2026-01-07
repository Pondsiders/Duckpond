/**
 * ChatPage — The main conversation view.
 *
 * Built on assistant-ui primitives following the official Claude example.
 * Backend streams state via assistant-stream; we just render it.
 */

import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowUp, Square } from "lucide-react";
import { ContextMeter } from "../components/ContextMeter";
import {
  ComposerAttachments,
  ComposerAddAttachment,
  UserMessageAttachments,
} from "../components/Attachment";
import {
  useAssistantTransportRuntime,
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  AssistantIf,
  SimpleImageAttachmentAdapter,
} from "@assistant-ui/react";
import type {
  AssistantTransportConnectionMetadata,
  ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownText } from "../components/MarkdownText";

// Font scale for 125% sizing
const fontScale = 1.25;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

// JSON value types (matching assistant-ui's expectations)
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
type JSONObject = { [key: string]: JSONValue };

// Backend content part format (what the agent sends)
type BackendTextPart = { type: "text"; text: string };
type BackendToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: JSONObject;
  argsText: string;
  result?: JSONValue;
  isError?: boolean;
};
type BackendContentPart = BackendTextPart | BackendToolCallPart;
type BackendMessageContent = string | BackendContentPart[];

type AgentState = {
  messages: Array<{
    role: string;
    content: BackendMessageContent;
    uuid?: string;
    timestamp?: string;
  }>;
  sessionId: string | null;
};

// -----------------------------------------------------------------------------
// Converter: Agent state → assistant-ui format
// -----------------------------------------------------------------------------

// Helper to normalize content to array of parts
function normalizeContent(content: BackendMessageContent): BackendContentPart[] {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    console.warn("[Duckpond] Unexpected content type:", typeof content, content);
    return [];
  }
  return content;
}

// Converter: transform our state -> assistant-ui format
// Uses padded index-based IDs (msg-000000) to ensure correct sort order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const converter = (state: AgentState, meta: AssistantTransportConnectionMetadata): any => {
  // Defensive: filter out malformed messages
  const validMessages = (state.messages || []).filter((m) => m && m.role);

  return {
    messages: validMessages.map((m, i) => {
      // Padded index ensures correct sort order in assistant-ui
      const id = `msg-${String(i).padStart(6, "0")}`;
      const baseMetadata = {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      };
      const contentParts = normalizeContent(m.content);

      // Extract image parts as attachments for MessagePrimitive.Attachments
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attachments = contentParts
        .filter((p): p is { type: "image"; image: string } =>
          p.type === "image" && "image" in p
        )
        .map((p, idx) => ({
          id: `${id}-attachment-${idx}`,
          type: "image" as const,
          name: `image-${idx}.png`,
          content: [{ type: "image" as const, image: p.image }],
          status: { type: "complete" as const },
        }));

      // Filter out image parts from content (they're in attachments now)
      const textContent = contentParts.filter((p) => p.type !== "image");

      if (m.role === "user") {
        return {
          id,
          createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
          role: "user" as const,
          content: textContent,
          attachments,
          metadata: baseMetadata,
        };
      } else {
        return {
          id,
          createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
          role: "assistant" as const,
          content: contentParts,
          status:
            meta.isSending && i === validMessages.length - 1
              ? { type: "running" as const }
              : { type: "complete" as const, reason: "stop" as const },
          metadata: baseMetadata,
        };
      }
    }),
    isRunning: meta.isSending,
  };
};

// -----------------------------------------------------------------------------
// Tool Fallback Component (matches assistant-ui interface)
// -----------------------------------------------------------------------------

const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const [expanded, setExpanded] = useState(false);

  const safeName = toolName || "Unknown Tool";
  const displayName = safeName.charAt(0).toUpperCase() + safeName.slice(1);

  const isRunning = status?.type === "running";
  const isError =
    status?.type === "incomplete" && status.reason === "error";

  // Parse args for summary
  let args: Record<string, unknown> = {};
  try {
    args = argsText ? JSON.parse(argsText) : {};
  } catch {
    // argsText might not be valid JSON
  }

  // Get a summary of the args
  const argSummary = (() => {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";

    if (safeName.toLowerCase() === "bash" && args.command) {
      const cmd = String(args.command);
      return cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
    }
    if (args.file_path) {
      const path = String(args.file_path);
      const parts = path.split("/");
      return parts[parts.length - 1];
    }
    if (args.pattern) {
      return String(args.pattern);
    }

    const firstString = entries.find(([, v]) => typeof v === "string");
    if (firstString) {
      const val = String(firstString[1]);
      return val.length > 40 ? val.slice(0, 40) + "..." : val;
    }

    return `${entries.length} args`;
  })();

  // Status dot color (dynamic)
  const statusColor = isRunning
    ? "bg-primary"
    : isError
    ? "bg-error"
    : "bg-success";

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-transparent border-none cursor-pointer text-text font-mono text-[13px] text-left"
      >
        {/* Status indicator */}
        <span
          className={`w-2 h-2 rounded-full ${statusColor} ${isRunning ? "animate-pulse-dot" : ""}`}
        />

        {/* Tool name */}
        <span className="text-primary font-semibold">
          {displayName}
        </span>

        {/* Arg summary */}
        {argSummary && (
          <span className="text-muted flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {argSummary}
          </span>
        )}

        {/* Expand indicator */}
        <span className="text-muted text-[10px]">
          {expanded ? "▼" : "▶"}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border p-3">
          <div className={result !== undefined ? "mb-3" : ""}>
            <div className="text-muted text-[11px] mb-1 font-mono">
              INPUT
            </div>
            <pre className="m-0 p-2 bg-code-bg rounded text-xs font-mono text-text overflow-auto max-h-[200px]">
              {argsText || "{}"}
            </pre>
          </div>

          {result !== undefined && (
            <div>
              <div className="text-muted text-[11px] mb-1 font-mono">
                OUTPUT
              </div>
              <pre className="m-0 p-2 bg-code-bg rounded text-xs font-mono text-text overflow-auto max-h-[300px]">
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// Message Components (using MessagePrimitive)
// -----------------------------------------------------------------------------

const UserMessage = () => {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end mb-4">
      {/* Attachments shown above the bubble */}
      <UserMessageAttachments />
      <div
        className="px-4 py-3 bg-user-bubble rounded-2xl max-w-[75%] text-text font-serif break-words"
        style={{ fontSize: `${16 * fontScale}px` }}
      >
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantMessage = () => {
  return (
    <MessagePrimitive.Root className="mb-6 pl-2 pr-12">
      <div
        className="text-text font-serif leading-relaxed"
        style={{ fontSize: `${16 * fontScale}px` }}
      >
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            tools: {
              Fallback: ToolFallback,
            },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
};

// -----------------------------------------------------------------------------
// Thread View
// -----------------------------------------------------------------------------

function ThreadView({ initialState }: { initialState: AgentState }) {
  // Track accurate token count from Eavesdrop (via /api/context endpoint)
  const [inputTokens, setInputTokens] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialState.sessionId);
  const [messageCount, setMessageCount] = useState(initialState.messages.length);

  // Fetch token count when session ID is available or messages change
  useEffect(() => {
    if (!sessionId) return;

    const fetchTokenCount = async () => {
      try {
        const response = await fetch(`/api/context/${sessionId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.input_tokens != null) {
            setInputTokens(data.input_tokens);
          }
        }
      } catch (err) {
        console.warn("[Duckpond] Failed to fetch token count:", err);
      }
    };

    // Delay to let Eavesdrop count tokens (~500-600ms) and stash in Redis
    const timer = setTimeout(fetchTokenCount, 1000);
    return () => clearTimeout(timer);
  }, [sessionId, messageCount]);

  // Converter that captures sessionId updates and tracks message count
  const converterWithTracking = useCallback(
    (state: AgentState, meta: AssistantTransportConnectionMetadata) => {
      // Capture sessionId when it appears
      if (state.sessionId && state.sessionId !== sessionId) {
        setTimeout(() => setSessionId(state.sessionId), 0);
      }
      // Track message count to trigger token count refresh
      const newLength = (state.messages || []).length;
      if (newLength !== messageCount) {
        setTimeout(() => setMessageCount(newLength), 0);
      }
      return converter(state, meta);
    },
    [sessionId, messageCount]
  );

  const runtime = useAssistantTransportRuntime({
    api: "/api/chat",
    headers: {},
    initialState,
    converter: converterWithTracking,
    adapters: {
      attachments: new SimpleImageAttachmentAdapter(),
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="px-6 py-4 border-b border-border flex items-center justify-between bg-background/80 backdrop-blur-sm">
          <Link
            to="/"
            className="text-primary no-underline font-bold text-lg font-serif"
          >
            Duckpond
          </Link>
          <div className="flex items-center gap-4">
            {sessionId && (
              <span className="font-mono text-xs text-muted">
                {sessionId.slice(0, 8)}...
              </span>
            )}
            <ContextMeter inputTokens={inputTokens} />
          </div>
        </header>

        {/* Thread */}
        <ThreadPrimitive.Root className="flex-1 flex flex-col overflow-hidden">
          <ThreadPrimitive.Viewport className="flex-1 flex flex-col overflow-y-scroll p-6">
            <div className="max-w-3xl mx-auto w-full">
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                }}
              />

              {/* Thinking indicator — only shows when running */}
              <AssistantIf condition={({ thread }) => thread.isRunning}>
                <div
                  className="flex items-center gap-2 px-2 py-3 text-muted font-serif italic"
                  style={{ fontSize: `${14 * fontScale}px` }}
                >
                  <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse-dot" />
                  Alpha is thinking...
                </div>
              </AssistantIf>
            </div>

            {/* Bottom spacer */}
            <div aria-hidden="true" className="h-4" />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>

        {/* Composer */}
        <footer className="px-6 py-4 bg-background">
          <div className="max-w-3xl mx-auto">
            <ComposerPrimitive.Root className="flex flex-col gap-3 p-4 bg-composer rounded-2xl shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.4),0_0_0_0.5px_rgba(108,106,96,0.15)]">
              {/* Attachment previews */}
              <ComposerAttachments />

              <ComposerPrimitive.Input
                placeholder="Talk to Alpha..."
                className="w-full py-2 bg-transparent border-none text-text font-serif outline-none resize-none"
                style={{ fontSize: `${16 * fontScale}px` }}
              />
              <div className="flex justify-end items-center gap-3">
                {/* Add attachment button */}
                <ComposerAddAttachment />

                <span
                  className="font-serif text-muted"
                  style={{ fontSize: `${14 * fontScale}px` }}
                >
                  Opus 4.5
                </span>

                {/* Send button (shown when not running) */}
                <AssistantIf condition={({ thread }) => !thread.isRunning}>
                  <ComposerPrimitive.Send className="w-9 h-9 flex items-center justify-center bg-primary border-none rounded-lg text-white cursor-pointer">
                    <ArrowUp size={20} strokeWidth={2.5} />
                  </ComposerPrimitive.Send>
                </AssistantIf>

                {/* Cancel button (shown when running) */}
                <AssistantIf condition={({ thread }) => thread.isRunning}>
                  <ComposerPrimitive.Cancel className="w-9 h-9 flex items-center justify-center bg-primary border-none rounded-lg text-white cursor-pointer">
                    <Square size={16} fill="white" />
                  </ComposerPrimitive.Cancel>
                </AssistantIf>
              </div>
            </ComposerPrimitive.Root>
            <p
              className="text-right text-muted mt-2"
              style={{ fontSize: `${11 * fontScale}px` }}
            >
              Alpha can make mistakes. Please double-check responses.
            </p>
          </div>
        </footer>
      </div>
    </AssistantRuntimeProvider>
  );
}

// -----------------------------------------------------------------------------
// ChatPage (route handler)
// -----------------------------------------------------------------------------

export default function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [initialState, setInitialState] = useState<AgentState | null>(null);
  const [loading, setLoading] = useState(!!sessionId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}`)
        .then((r) => {
          if (!r.ok) throw new Error(`Session not found`);
          return r.json();
        })
        .then((data) => {
          setInitialState({
            messages: data.messages,
            sessionId: sessionId,
          });
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    } else {
      setInitialState({ messages: [], sessionId: null });
    }
  }, [sessionId]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-muted font-serif">
        Loading session...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-background gap-4">
        <div className="text-primary font-serif">
          {error}
        </div>
        <button
          onClick={() => navigate("/")}
          className="px-6 py-3 bg-composer border border-border rounded-lg text-text cursor-pointer font-serif"
        >
          Back to Home
        </button>
      </div>
    );
  }

  if (!initialState) {
    return null;
  }

  return <ThreadView initialState={initialState} />;
}
