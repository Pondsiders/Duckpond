import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
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
) => ({
  messages: state.messages.map((m, i) => {
    // Use padded index as ID to maintain order (assistant-ui may sort by ID)
    const id = `msg-${String(i).padStart(6, '0')}`;
    if (m.role === "user") {
      return {
        id,
        createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
        role: "user" as const,
        content: [{ type: "text" as const, text: m.content }],
        attachments: [],
        metadata: { custom: {} },
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
        metadata: { custom: {} },
      };
    }
  }),
  isRunning: meta.isSending,
});

// Minimal message components
function UserMessage() {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "#1a1a2e",
        borderRadius: "8px",
        marginBottom: "8px",
        marginLeft: "48px",
      }}
    >
      <MessagePrimitive.Content />
    </div>
  );
}

function AssistantMessage() {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "#16213e",
        borderRadius: "8px",
        marginBottom: "8px",
        marginRight: "48px",
      }}
    >
      <MessagePrimitive.Content />
    </div>
  );
}

function ThreadView({ initialState }: { initialState: AgentState }) {
  const runtime = useAssistantTransportRuntime({
    api: "/api/chat",
    initialState,
    converter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#0a0a0a",
        }}
      >
        <header
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #222",
            color: "#888",
            fontSize: "14px",
            display: "flex",
            alignItems: "center",
            gap: "16px",
          }}
        >
          <a
            href="/"
            style={{
              color: "#4a9eff",
              textDecoration: "none",
            }}
          >
            MOOSE
          </a>
          {initialState.sessionId && (
            <span style={{ fontFamily: "monospace", color: "#555" }}>
              {initialState.sessionId.slice(0, 8)}...
            </span>
          )}
        </header>

        <main style={{ flex: 1, overflow: "auto", padding: "16px" }}>
          <ThreadPrimitive.Root>
            <ThreadPrimitive.Viewport style={{ height: "100%" }}>
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                }}
              />
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </main>

        <footer
          style={{
            padding: "16px",
            borderTop: "1px solid #222",
            background: "#0a0a0a",
          }}
        >
          <ComposerPrimitive.Root
            style={{
              display: "flex",
              gap: "8px",
            }}
          >
            <ComposerPrimitive.Input
              placeholder="Type a message..."
              style={{
                flex: 1,
                padding: "12px 16px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "8px",
                color: "#e0e0e0",
                fontSize: "14px",
                outline: "none",
              }}
            />
            <ComposerPrimitive.Send
              style={{
                padding: "12px 24px",
                background: "#4a9eff",
                border: "none",
                borderRadius: "8px",
                color: "white",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
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

  // Load existing session if resuming
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
      // New conversation
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
          background: "#0a0a0a",
          color: "#888",
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
          background: "#0a0a0a",
          color: "#e0e0e0",
          gap: "16px",
        }}
      >
        <div style={{ color: "#ff6b6b" }}>{error}</div>
        <button
          onClick={() => navigate("/")}
          style={{
            padding: "12px 24px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "8px",
            color: "#e0e0e0",
            cursor: "pointer",
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
