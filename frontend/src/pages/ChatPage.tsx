/**
 * ChatPage — The main conversation view.
 *
 * Uses Zustand for state management and useExternalStoreRuntime to bridge
 * to assistant-ui primitives. State lives in the store, not in React state.
 *
 * SSE model: One persistent EventSource per session (GET /api/stream).
 * Messages sent via fire-and-forget POST /api/chat.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowUp, Square } from "lucide-react";
import { ContextMeter } from "../components/ContextMeter";
import { ToolFallback } from "../components/ToolFallback";
import {
  ComposerAttachments,
  ComposerAddAttachment,
  UserMessageAttachments,
} from "../components/Attachment";
import {
  useExternalStoreRuntime,
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  SimpleImageAttachmentAdapter,
} from "@assistant-ui/react";
import type { ThreadMessageLike, AppendMessage } from "@assistant-ui/react";
import { MarkdownText } from "../components/MarkdownText";
import {
  useGazeboStore,
  type Message,
} from "../store";

// Font scale for 125% sizing
const fontScale = 1.25;

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

const ThinkingBlock = ({ text, status }: { text: string; status: unknown }) => {
  const isStreaming = (status as { type?: string })?.type === "running";

  return (
    <details open={isStreaming} className="mb-3 group">
      <summary
        className="cursor-pointer text-muted italic font-serif select-none list-none flex items-center gap-2"
        style={{ fontSize: `${13 * fontScale}px` }}
      >
        <span className="text-muted/60 group-open:rotate-90 transition-transform inline-block">▶</span>
        {isStreaming ? "Alpha is thinking..." : "Alpha's thinking"}
      </summary>
      <div
        className="mt-2 pl-4 border-l-2 border-muted/20 text-muted italic font-serif leading-relaxed whitespace-pre-wrap"
        style={{ fontSize: `${13 * fontScale}px` }}
      >
        {text}
      </div>
    </details>
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
            Reasoning: ThinkingBlock,
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
// Convert our Message to ThreadMessageLike
// -----------------------------------------------------------------------------

const convertMessage = (message: Message): ThreadMessageLike => {
  // Map our internal content parts to assistant-ui's expected types
  const content = message.content.map((part) => {
    if (part.type === "thinking") {
      // Map thinking blocks to assistant-ui's native "reasoning" part type
      return { type: "reasoning" as const, text: part.thinking };
    }
    return part;
  });

  return {
    id: message.id,
    role: message.role,
    content,
    createdAt: message.createdAt,
  };
};

// -----------------------------------------------------------------------------
// Thread View (External Store Runtime)
// -----------------------------------------------------------------------------

function ThreadView() {
  // === ZUSTAND STATE ===
  const messages = useGazeboStore((s) => s.messages);
  const isRunning = useGazeboStore((s) => s.isRunning);
  const sessionId = useGazeboStore((s) => s.sessionId);
  const inputTokens = useGazeboStore((s) => s.inputTokens);

  // === ZUSTAND ACTIONS (used by onNew and runtime) ===
  const addUserMessage = useGazeboStore((s) => s.addUserMessage);
  const setMessages = useGazeboStore((s) => s.setMessages);
  // SSE event handlers use useGazeboStore.getState() directly
  // to avoid stale closures in EventSource listeners

  // Track the current assistant message ID for SSE event routing
  const currentAssistantIdRef = useRef<string | null>(null);

  // === EventSource: persistent SSE pipe ===
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Build SSE URL
    const params = new URLSearchParams();
    if (sessionId) {
      params.set("sessionId", sessionId);
    }
    const url = `/api/stream${params.toString() ? `?${params}` : ""}`;

    console.log("[Gazebo] Opening EventSource:", url);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    // --- Event handlers ---

    es.addEventListener("turn-start", () => {
      console.log("[Gazebo] turn-start");
      // Create assistant placeholder for this turn
      const { addAssistantPlaceholder, setRunning } = useGazeboStore.getState();
      const id = addAssistantPlaceholder();
      currentAssistantIdRef.current = id;
      setRunning(true);
    });

    es.addEventListener("text-delta", (e: MessageEvent) => {
      const { text } = JSON.parse(e.data);
      const id = currentAssistantIdRef.current;
      if (id && text) {
        useGazeboStore.getState().appendToAssistant(id, text);
      }
    });

    es.addEventListener("thinking-delta", (e: MessageEvent) => {
      const { text } = JSON.parse(e.data);
      const id = currentAssistantIdRef.current;
      if (id && text) {
        useGazeboStore.getState().appendThinking(id, text);
      }
    });

    es.addEventListener("tool-call", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const id = currentAssistantIdRef.current;
      if (id) {
        useGazeboStore.getState().addToolCall(id, {
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          args: data.args,
          argsText: data.argsText,
        });
      }
    });

    es.addEventListener("tool-result", (e: MessageEvent) => {
      const { toolCallId, result, isError } = JSON.parse(e.data);
      const id = currentAssistantIdRef.current;
      if (id) {
        useGazeboStore.getState().updateToolResult(id, toolCallId, result, isError);
      }
    });

    es.addEventListener("session-id", (e: MessageEvent) => {
      const { sessionId: newSid } = JSON.parse(e.data);
      console.log("[Gazebo] session-id:", newSid?.slice(0, 8));
      useGazeboStore.getState().setSessionId(newSid);
    });

    es.addEventListener("context", (e: MessageEvent) => {
      const { count } = JSON.parse(e.data);
      useGazeboStore.getState().setInputTokens(count);
    });

    es.addEventListener("status", (e: MessageEvent) => {
      const { phase } = JSON.parse(e.data);
      console.log("[Gazebo] status:", phase);
      if (phase === "compacting") {
        useGazeboStore.getState().setRunning(true);
      }
    });

    es.addEventListener("turn-end", () => {
      console.log("[Gazebo] turn-end");
      useGazeboStore.getState().setRunning(false);
      currentAssistantIdRef.current = null;
    });

    es.addEventListener("error", ((e: MessageEvent) => {
      // SSE-level error event (from server)
      if (e.data) {
        try {
          const { message } = JSON.parse(e.data);
          console.error("[Gazebo] Stream error:", message);
        } catch {
          console.error("[Gazebo] Stream error (raw):", e.data);
        }
      }
    }) as EventListener);

    es.onerror = () => {
      // EventSource connection error (network, etc.)
      // Browser will auto-reconnect
      console.warn("[Gazebo] EventSource connection error, will auto-reconnect");
    };

    return () => {
      console.log("[Gazebo] Closing EventSource");
      es.close();
      eventSourceRef.current = null;
    };
  }, [sessionId]); // Reconnect when session changes

  // === onNew: Handle new user messages (fire-and-forget POST) ===
  const onNew = useCallback(
    async (appendMessage: AppendMessage) => {
      // Extract text content from the message
      const textParts = appendMessage.content.filter(
        (p): p is { type: "text"; text: string } => p.type === "text"
      );
      const text = textParts.map((p) => p.text).join("\n");

      // Extract image attachments
      const attachments = appendMessage.attachments || [];
      const imageAttachments = attachments.filter(
        (a) => a.type === "image" && "content" in a
      );

      if (!text.trim() && imageAttachments.length === 0) return;

      console.log("[Gazebo] Sending message, text length:", text.length, "images:", imageAttachments.length);

      // 1. Add user message to store immediately (optimistic)
      const storeAttachments = imageAttachments.flatMap(a => {
        if (Array.isArray(a.content)) {
          return a.content
            .filter((c): c is { type: "image"; image: string } => c.type === "image" && "image" in c)
            .map(c => ({ type: "image" as const, image: c.image }));
        }
        return [];
      });
      addUserMessage(text, storeAttachments);

      // 2. Build content for backend (Claude API format)
      const backendContent: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];
      if (text.trim()) {
        backendContent.push({ type: "text", text });
      }
      for (const att of imageAttachments) {
        if (Array.isArray(att.content)) {
          for (const contentPart of att.content) {
            if (contentPart.type === "image" && "image" in contentPart) {
              const dataUrl = contentPart.image as string;
              if (dataUrl.startsWith("data:")) {
                const [header, data] = dataUrl.split(",");
                const mediaType = header.split(":")[1].split(";")[0];
                backendContent.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: data,
                  },
                });
              }
            }
          }
        }
      }

      // 3. Fire-and-forget POST — response comes through EventSource
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            content: backendContent.length === 1 && backendContent[0].type === "text"
              ? text  // Simple string for text-only
              : backendContent,  // Array for multimodal
          }),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const result = await response.json();
        console.log("[Gazebo] POST result:", result.status);
      } catch (error) {
        console.error("[Gazebo] POST error:", error);
        // Don't create assistant placeholder here — turn-start event handles that
        // But we should show the error somehow
        const id = useGazeboStore.getState().addAssistantPlaceholder();
        useGazeboStore.getState().appendToAssistant(
          id,
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        useGazeboStore.getState().setRunning(false);
      }
    },
    [sessionId, addUserMessage]
  );

  // === onCancel: Interrupt current operation ===
  const onCancel = useCallback(async () => {
    console.log("[Gazebo] Interrupting...");
    try {
      await fetch("/api/chat/interrupt", { method: "POST" });
    } catch (error) {
      console.error("[Gazebo] Interrupt error:", error);
    }
  }, []);

  // === Esc key: interrupt when running ===
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useGazeboStore.getState().isRunning) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  // === RUNTIME ===
  // NOTE: We intentionally do NOT pass isRunning to the runtime.
  // assistant-ui disables Send and changes Enter→newline when isRunning=true,
  // but we WANT queueing — sending while Alpha is still responding.
  // We manage running-state UI (thinking indicator, cancel button) ourselves
  // using the store's isRunning, not the runtime's.
  const runtime = useExternalStoreRuntime({
    messages,
    setMessages,
    onNew,
    onCancel,
    convertMessage,
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

              {/* Thinking indicator — uses store's isRunning (not runtime's) */}
              {isRunning && (
                <div
                  className="flex items-center gap-2 px-2 py-3 text-muted font-serif italic"
                  style={{ fontSize: `${14 * fontScale}px` }}
                >
                  <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse-dot" />
                  Alpha is thinking...
                </div>
              )}
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
                  Opus 4.6
                </span>

                {/* Send button (always visible — queueing allowed) */}
                <ComposerPrimitive.Send className="w-9 h-9 flex items-center justify-center bg-primary border-none rounded-lg text-white cursor-pointer">
                  <ArrowUp size={20} strokeWidth={2.5} />
                </ComposerPrimitive.Send>

                {/* Cancel button (uses store's isRunning, not runtime's) */}
                {isRunning && (
                  <button
                    onClick={onCancel}
                    className="w-9 h-9 flex items-center justify-center bg-red-600 border-none rounded-lg text-white cursor-pointer"
                  >
                    <Square size={16} fill="white" />
                  </button>
                )}
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
  const loadSession = useGazeboStore((s) => s.loadSession);
  const reset = useGazeboStore((s) => s.reset);

  // Load state
  const [loading, setLoading] = useState(!!sessionId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId) {
      // Load existing session
      fetch(`/api/sessions/${sessionId}`)
        .then((r) => {
          if (!r.ok) throw new Error(`Session not found`);
          return r.json();
        })
        .then((data) => {
          // Convert backend messages to our format
          const messages: Message[] = (data.messages || []).map(
            (m: { role: string; content: unknown }, i: number) => ({
              id: `loaded-${i}`,
              role: m.role as "user" | "assistant",
              content: Array.isArray(m.content)
                ? m.content
                : [{ type: "text", text: String(m.content) }],
              createdAt: new Date(),
            })
          );
          loadSession(sessionId, messages);
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    } else {
      // New session - reset store
      reset();
      setLoading(false);
    }
  }, [sessionId, loadSession, reset]);

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
        <div className="text-primary font-serif">{error}</div>
        <button
          onClick={() => navigate("/")}
          className="px-6 py-3 bg-composer border border-border rounded-lg text-text cursor-pointer font-serif"
        >
          Back to Home
        </button>
      </div>
    );
  }

  return <ThreadView />;
}
