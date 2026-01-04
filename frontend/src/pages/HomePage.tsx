import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Claude dark palette
const colors = {
  background: "#2b2a27",
  composer: "#1f1e1b",
  text: "#eee",
  muted: "#9a9893",
  primary: "#ae5630",
  userBubble: "#393937",
};

type Session = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

function formatRelative(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  return `${diffDays}d ago`;
}

export default function HomePage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [resumeId, setResumeId] = useState("");
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleResume = () => {
    const id = resumeId.trim();
    if (id) {
      navigate(`/chat/${id}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleResume();
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: colors.background,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "48px 24px",
      }}
    >
      {/* Header */}
      <h1
        style={{
          fontSize: "48px",
          fontFamily: "Georgia, serif",
          fontWeight: 300,
          color: colors.text,
          marginBottom: "8px",
        }}
      >
        Duckpond
      </h1>
      <p
        style={{
          color: colors.muted,
          marginBottom: "48px",
          fontFamily: "Georgia, serif",
        }}
      >
        The duck, the pond, and a cozy bench by the water
      </p>

      {/* New Conversation - prominent */}
      <button
        onClick={() => navigate("/chat")}
        style={{
          width: "100%",
          maxWidth: "400px",
          marginBottom: "32px",
          padding: "16px 24px",
          background: colors.primary,
          border: "none",
          borderRadius: "16px",
          color: "white",
          fontFamily: "Georgia, serif",
          fontSize: "18px",
          cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        }}
      >
        New Conversation
      </button>

      {/* Resume Section */}
      <div style={{ width: "100%", maxWidth: "400px", marginBottom: "32px" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            placeholder="Resume by session UUID..."
            value={resumeId}
            onChange={(e) => setResumeId(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1,
              padding: "12px 16px",
              background: colors.composer,
              border: "1px solid rgba(108,106,96,0.2)",
              borderRadius: "12px",
              fontFamily: "monospace",
              fontSize: "14px",
              color: colors.text,
              outline: "none",
            }}
          />
          <button
            onClick={handleResume}
            style={{
              padding: "12px 24px",
              background: colors.composer,
              border: "1px solid rgba(108,106,96,0.2)",
              borderRadius: "12px",
              color: colors.text,
              fontFamily: "Georgia, serif",
              cursor: "pointer",
            }}
          >
            Resume
          </button>
        </div>
      </div>

      {/* Divider */}
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          display: "flex",
          alignItems: "center",
          gap: "16px",
          marginBottom: "32px",
          color: colors.muted,
        }}
      >
        <div style={{ flex: 1, height: "1px", background: "rgba(108,106,96,0.2)" }} />
        <span style={{ fontSize: "14px" }}>recent sessions</span>
        <div style={{ flex: 1, height: "1px", background: "rgba(108,106,96,0.2)" }} />
      </div>

      {/* Recent Sessions */}
      <div style={{ width: "100%", maxWidth: "400px" }}>
        {loading ? (
          <div style={{ textAlign: "center", color: colors.muted }}>Loading...</div>
        ) : sessions.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              color: colors.muted,
              padding: "32px 0",
              fontFamily: "Georgia, serif",
            }}
          >
            No sessions yet. Start a new conversation above.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(`/chat/${s.id}`)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "16px",
                  background: colors.composer,
                  border: "1px solid rgba(108,106,96,0.2)",
                  borderRadius: "12px",
                  color: colors.text,
                  textAlign: "left",
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: colors.muted,
                    flexShrink: 0,
                  }}
                >
                  {s.id.slice(0, 8)}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontFamily: "Georgia, serif",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.title}
                </span>
                <span
                  style={{
                    fontSize: "12px",
                    color: colors.muted,
                    flexShrink: 0,
                  }}
                >
                  {formatRelative(s.updated_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
