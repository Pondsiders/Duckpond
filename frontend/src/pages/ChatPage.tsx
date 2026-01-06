/**
 * ChatPage — The main conversation view.
 *
 * Built on assistant-ui primitives following the official Claude example.
 * Backend streams state via assistant-stream; we just render it.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowUp, Square } from "lucide-react";
import { ContextMeter } from "../components/ContextMeter";
import {
  useAssistantTransportRuntime,
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  AssistantIf,
} from "@assistant-ui/react";
import type {
  AssistantTransportConnectionMetadata,
  ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownText } from "../components/MarkdownText";
import { colors, fontScale } from "../theme";

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

type ContextUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AgentState = {
  messages: Array<{
    role: string;
    content: BackendMessageContent;
    uuid?: string;
    timestamp?: string;
  }>;
  sessionId: string | null;
  contextUsage?: ContextUsage | null;
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

      if (m.role === "user") {
        return {
          id,
          createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
          role: "user" as const,
          content: contentParts,
          attachments: [],
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

  return (
    <div
      style={{
        marginBottom: "12px",
        borderRadius: "8px",
        border: `1px solid ${colors.border}`,
        background: colors.surface,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: colors.text,
          fontFamily: "monospace",
          fontSize: "13px",
          textAlign: "left",
        }}
      >
        {/* Status indicator */}
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: isRunning
              ? colors.primary
              : isError
              ? "#ef4444"
              : "#4ade80",
            animation: isRunning ? "pulse 1.5s ease-in-out infinite" : "none",
          }}
        />

        {/* Tool name */}
        <span style={{ color: colors.primary, fontWeight: 600 }}>
          {displayName}
        </span>

        {/* Arg summary */}
        {argSummary && (
          <span
            style={{
              color: colors.muted,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {argSummary}
          </span>
        )}

        {/* Expand indicator */}
        <span style={{ color: colors.muted, fontSize: "10px" }}>
          {expanded ? "▼" : "▶"}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${colors.border}`,
            padding: "12px",
          }}
        >
          <div style={{ marginBottom: result !== undefined ? "12px" : 0 }}>
            <div
              style={{
                color: colors.muted,
                fontSize: "11px",
                marginBottom: "4px",
                fontFamily: "monospace",
              }}
            >
              INPUT
            </div>
            <pre
              style={{
                margin: 0,
                padding: "8px",
                background: colors.codeBg,
                borderRadius: "4px",
                fontSize: "12px",
                fontFamily: "monospace",
                color: colors.text,
                overflow: "auto",
                maxHeight: "200px",
              }}
            >
              {argsText || "{}"}
            </pre>
          </div>

          {result !== undefined && (
            <div>
              <div
                style={{
                  color: colors.muted,
                  fontSize: "11px",
                  marginBottom: "4px",
                  fontFamily: "monospace",
                }}
              >
                OUTPUT
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: "8px",
                  background: colors.codeBg,
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontFamily: "monospace",
                  color: colors.text,
                  overflow: "auto",
                  maxHeight: "300px",
                }}
              >
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
};

// -----------------------------------------------------------------------------
// Message Components (using MessagePrimitive)
// -----------------------------------------------------------------------------

const UserMessage = () => {
  return (
    <MessagePrimitive.Root
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginBottom: "16px",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          background: colors.userBubble,
          borderRadius: "16px",
          maxWidth: "75%",
          color: colors.text,
          fontFamily: "Georgia, serif",
          fontSize: `${16 * fontScale}px`,
        }}
      >
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantMessage = () => {
  return (
    <MessagePrimitive.Root
      style={{
        marginBottom: "24px",
        paddingLeft: "8px",
        paddingRight: "48px",
      }}
    >
      <div
        style={{
          color: colors.text,
          fontFamily: "Georgia, serif",
          fontSize: `${16 * fontScale}px`,
          lineHeight: "1.65",
        }}
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
  // Track context usage from state updates
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(
    initialState.contextUsage ?? null
  );
  const contextUsageRef = useRef(contextUsage);

  // Converter that also captures contextUsage updates
  const converterWithUsage = useCallback(
    (state: AgentState, meta: AssistantTransportConnectionMetadata) => {
      // Capture contextUsage when state updates
      if (state.contextUsage && state.contextUsage !== contextUsageRef.current) {
        contextUsageRef.current = state.contextUsage;
        // Schedule state update outside render
        setTimeout(() => setContextUsage(state.contextUsage ?? null), 0);
      }
      return converter(state, meta);
    },
    []
  );

  const runtime = useAssistantTransportRuntime({
    api: "/api/chat",
    headers: {},
    initialState,
    converter: converterWithUsage,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: colors.background,
        }}
      >
        {/* Header */}
        <header
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid rgba(108,106,96,0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "rgba(43,42,39,0.8)",
            backdropFilter: "blur(8px)",
          }}
        >
          <Link
            to="/"
            style={{
              color: colors.primary,
              textDecoration: "none",
              fontWeight: "bold",
              fontSize: "18px",
              fontFamily: "Georgia, serif",
            }}
          >
            Duckpond
          </Link>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
            }}
          >
            {initialState.sessionId && (
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "12px",
                  color: colors.muted,
                }}
              >
                {initialState.sessionId.slice(0, 8)}...
              </span>
            )}
            <ContextMeter usage={contextUsage} />
          </div>
        </header>

        {/* Thread */}
        <ThreadPrimitive.Root
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <ThreadPrimitive.Viewport
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflowY: "scroll",
              padding: "24px",
            }}
          >
            <div style={{ maxWidth: "768px", margin: "0 auto", width: "100%" }}>
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                }}
              />

              {/* Thinking indicator — only shows when running */}
              <AssistantIf condition={({ thread }) => thread.isRunning}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "12px 8px",
                    color: colors.muted,
                    fontFamily: "Georgia, serif",
                    fontSize: `${14 * fontScale}px`,
                    fontStyle: "italic",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: "8px",
                      height: "8px",
                      background: colors.primary,
                      borderRadius: "50%",
                      animation: "pulse 1.5s ease-in-out infinite",
                    }}
                  />
                  Alpha is thinking...
                </div>
              </AssistantIf>
            </div>

            {/* Bottom spacer */}
            <div aria-hidden="true" style={{ height: "16px" }} />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>

        {/* Composer */}
        <footer
          style={{
            padding: "16px 24px",
            background: colors.background,
          }}
        >
          <div style={{ maxWidth: "768px", margin: "0 auto" }}>
            <ComposerPrimitive.Root
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                padding: "16px",
                background: colors.composer,
                borderRadius: "16px",
                boxShadow:
                  "0 0.25rem 1.25rem rgba(0,0,0,0.4), 0 0 0 0.5px rgba(108,106,96,0.15)",
              }}
            >
              <ComposerPrimitive.Input
                placeholder="Talk to Alpha..."
                style={{
                  width: "100%",
                  padding: "8px 0",
                  background: "transparent",
                  border: "none",
                  color: colors.text,
                  fontSize: `${16 * fontScale}px`,
                  fontFamily: "Georgia, serif",
                  outline: "none",
                  resize: "none",
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span
                  style={{
                    fontFamily: "Georgia, serif",
                    fontSize: `${14 * fontScale}px`,
                    color: colors.muted,
                  }}
                >
                  Opus 4.5
                </span>

                {/* Send button (shown when not running) */}
                <AssistantIf condition={({ thread }) => !thread.isRunning}>
                  <ComposerPrimitive.Send
                    style={{
                      width: "36px",
                      height: "36px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: colors.primary,
                      border: "none",
                      borderRadius: "8px",
                      color: "white",
                      cursor: "pointer",
                    }}
                  >
                    <ArrowUp size={20} strokeWidth={2.5} />
                  </ComposerPrimitive.Send>
                </AssistantIf>

                {/* Cancel button (shown when running) */}
                <AssistantIf condition={({ thread }) => thread.isRunning}>
                  <ComposerPrimitive.Cancel
                    style={{
                      width: "36px",
                      height: "36px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: colors.primary,
                      border: "none",
                      borderRadius: "8px",
                      color: "white",
                      cursor: "pointer",
                    }}
                  >
                    <Square size={16} fill="white" />
                  </ComposerPrimitive.Cancel>
                </AssistantIf>
              </div>
            </ComposerPrimitive.Root>
            <p
              style={{
                textAlign: "right",
                fontSize: `${11 * fontScale}px`,
                color: colors.muted,
                marginTop: "8px",
              }}
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
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: colors.background,
          color: colors.muted,
          fontFamily: "Georgia, serif",
        }}
      >
        Loading session...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: colors.background,
          gap: "16px",
        }}
      >
        <div style={{ color: colors.primary, fontFamily: "Georgia, serif" }}>
          {error}
        </div>
        <button
          onClick={() => navigate("/")}
          style={{
            padding: "12px 24px",
            background: colors.composer,
            border: "1px solid rgba(108,106,96,0.2)",
            borderRadius: "8px",
            color: colors.text,
            cursor: "pointer",
            fontFamily: "Georgia, serif",
          }}
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
