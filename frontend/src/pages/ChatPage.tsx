/**
 * ChatPage — The main conversation view.
 *
 * Uses Zustand for state management and useExternalStoreRuntime to bridge
 * to assistant-ui primitives. State lives in the store, not in React state.
 */

import { useState, useEffect, useCallback } from "react";
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
  AssistantIf,
  SimpleImageAttachmentAdapter,
} from "@assistant-ui/react";
import type { ThreadMessageLike, AppendMessage } from "@assistant-ui/react";
import { MarkdownText } from "../components/MarkdownText";
import {
  useGazeboStore,
  type Message,
  type JSONValue,
  type ToolCallPart,
} from "../store";

// Font scale for 125% sizing
const fontScale = 1.25;

// -----------------------------------------------------------------------------
// SSE Stream Reader
// -----------------------------------------------------------------------------

interface StreamEvent {
  type: "text" | "tool-call" | "tool-result" | "session-id" | "done" | "error";
  data: unknown;
}

async function* readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            yield { type: "done", data: null };
          } else {
            try {
              const parsed = JSON.parse(data);
              yield parsed as StreamEvent;
            } catch {
              // Ignore malformed JSON
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

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
// Convert our Message to ThreadMessageLike
// -----------------------------------------------------------------------------

const convertMessage = (message: Message): ThreadMessageLike => {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
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

  // === ZUSTAND ACTIONS ===
  const addUserMessage = useGazeboStore((s) => s.addUserMessage);
  const addAssistantPlaceholder = useGazeboStore((s) => s.addAssistantPlaceholder);
  const appendToAssistant = useGazeboStore((s) => s.appendToAssistant);
  const addToolCall = useGazeboStore((s) => s.addToolCall);
  const updateToolResult = useGazeboStore((s) => s.updateToolResult);
  const setMessages = useGazeboStore((s) => s.setMessages);
  const setSessionId = useGazeboStore((s) => s.setSessionId);
  const setRunning = useGazeboStore((s) => s.setRunning);
  const setInputTokens = useGazeboStore((s) => s.setInputTokens);

  // Fetch token count when session changes or messages update
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

    // Delay to let the backend count tokens
    const timer = setTimeout(fetchTokenCount, 1000);
    return () => clearTimeout(timer);
  }, [sessionId, messages.length, setInputTokens]);

  // === onNew: Handle new user messages ===
  const onNew = useCallback(
    async (appendMessage: AppendMessage) => {
      // Extract text content from the message
      const textParts = appendMessage.content.filter(
        (p): p is { type: "text"; text: string } => p.type === "text"
      );
      const text = textParts.map((p) => p.text).join("\n");

      // Extract image attachments - these are in appendMessage.attachments, not content!
      // SimpleImageAttachmentAdapter puts images there as CompleteAttachment objects
      const attachments = appendMessage.attachments || [];
      const imageAttachments = attachments.filter(
        (a): a is { type: "image"; name: string; contentType: string; file?: File; content: string } =>
          a.type === "image" && "content" in a
      );

      if (!text.trim() && imageAttachments.length === 0) return;

      console.log("[Gazebo] onNew called, text length:", text.length, "images:", imageAttachments.length);

      // 1. Add user message to store immediately (optimistic)
      // Convert attachments to our store format
      // att.content is an array like [{ type: "image", image: "data:..." }]
      const storeAttachments = imageAttachments.flatMap(a => {
        if (Array.isArray(a.content)) {
          return a.content
            .filter((c): c is { type: "image"; image: string } => c.type === "image" && "image" in c)
            .map(c => ({ type: "image" as const, image: c.image }));
        }
        return [];
      });
      addUserMessage(text, storeAttachments);

      // 2. Create placeholder for assistant response
      const assistantId = addAssistantPlaceholder();
      setRunning(true);

      // Build content for backend (Claude API format)
      const backendContent: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];
      if (text.trim()) {
        backendContent.push({ type: "text", text });
      }
      for (const att of imageAttachments) {
        // att.content is an array like [{ type: "image", image: "data:image/jpeg;base64,..." }]
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

      try {
        // 3. Call backend with content (text + images)
        console.log("[Gazebo] Starting fetch to /api/chat...");
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
        console.log("[Gazebo] Fetch completed, status:", response.status);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        // 4. Stream response
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }
        console.log("[Gazebo] Got reader, starting SSE stream...");

        for await (const event of readSSEStream(reader)) {
          console.log("[Gazebo] SSE event:", event.type);
          switch (event.type) {
            case "text":
              appendToAssistant(assistantId, event.data as string);
              break;

            case "tool-call": {
              const tc = event.data as ToolCallPart;
              addToolCall(assistantId, {
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.args,
                argsText: tc.argsText,
              });
              break;
            }

            case "tool-result": {
              const { toolCallId, result, isError } = event.data as {
                toolCallId: string;
                result: JSONValue;
                isError?: boolean;
              };
              updateToolResult(assistantId, toolCallId, result, isError);
              break;
            }

            case "session-id":
              setSessionId(event.data as string);
              break;

            case "error":
              console.error("[Duckpond] Stream error:", event.data);
              break;

            case "done":
              // Stream complete
              console.log("[Gazebo] Stream complete (done event)");
              break;
          }
        }
        console.log("[Gazebo] Exited SSE loop");
      } catch (error) {
        console.error("[Gazebo] Chat error:", error);
        // Update placeholder with error message
        appendToAssistant(
          assistantId,
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      } finally {
        console.log("[Gazebo] Finally block, setting isRunning=false");
        setRunning(false);
      }
    },
    [
      sessionId,
      addUserMessage,
      addAssistantPlaceholder,
      appendToAssistant,
      addToolCall,
      updateToolResult,
      setSessionId,
      setRunning,
    ]
  );

  // === RUNTIME ===
  const runtime = useExternalStoreRuntime({
    messages,
    setMessages,
    isRunning,
    onNew,
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
