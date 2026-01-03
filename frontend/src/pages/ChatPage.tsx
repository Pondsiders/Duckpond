import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowUp } from "lucide-react";
import {
  useAssistantTransportRuntime,
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
} from "@assistant-ui/react";
import type { AssistantTransportConnectionMetadata } from "@assistant-ui/react";

// State shape matches what backend streams
type AgentState = {
  messages: Array<{ role: string; content: string; uuid?: string; timestamp?: string }>;
  sessionId: string | null;
};

// Converter: transform our state -> assistant-ui format
const converter = (
  state: AgentState,
  meta: AssistantTransportConnectionMetadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => ({
  messages: state.messages.map((m, i) => {
    const id = `msg-${String(i).padStart(6, "0")}`;
    const baseMetadata = {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {},
    };
    if (m.role === "user") {
      return {
        id,
        createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
        role: "user" as const,
        content: [{ type: "text" as const, text: m.content }],
        attachments: [],
        metadata: baseMetadata,
      };
    } else {
      return {
        id,
        createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
        role: "assistant" as const,
        content: [{ type: "text" as const, text: m.content }],
        status:
          meta.isSending && i === state.messages.length - 1
            ? { type: "running" as const }
            : { type: "complete" as const, reason: "stop" as const },
        metadata: baseMetadata,
      };
    }
  }),
  isRunning: meta.isSending,
});

// Claude dark palette
const colors = {
  background: "#2b2a27",
  composer: "#1f1e1b",
  text: "#eee",
  muted: "#9a9893",
  primary: "#ae5630",
  userBubble: "#393937",
};

// Base font size multiplier (125%)
const fontScale = 1.25;

// Claude-styled user message
function UserMessage() {
  return (
    <div
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
        <MessagePrimitive.Content />
      </div>
    </div>
  );
}

// Claude-styled assistant message
function AssistantMessage() {
  return (
    <div
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
        <MessagePrimitive.Content />
      </div>
    </div>
  );
}

function ThreadView({ initialState }: { initialState: AgentState }) {
  const runtime = useAssistantTransportRuntime({
    api: "/api/chat",
    headers: {},
    initialState,
    converter,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on initial load (small delay to let messages render)
  useEffect(() => {
    const timer = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }, 100);
    return () => clearTimeout(timer);
  }, []);

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
            MOOSE
          </Link>
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
        </header>

        {/* Messages */}
        <main style={{ flex: 1, overflow: "auto", padding: "24px" }}>
          <div style={{ maxWidth: "768px", margin: "0 auto" }}>
            <ThreadPrimitive.Root>
              <ThreadPrimitive.Viewport>
                <ThreadPrimitive.Messages
                  components={{
                    UserMessage,
                    AssistantMessage,
                  }}
                />
                <div ref={messagesEndRef} />
              </ThreadPrimitive.Viewport>
            </ThreadPrimitive.Root>
          </div>
        </main>

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
                boxShadow: "0 0.25rem 1.25rem rgba(0,0,0,0.4), 0 0 0 0.5px rgba(108,106,96,0.15)",
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
        <div style={{ color: colors.primary, fontFamily: "Georgia, serif" }}>{error}</div>
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
