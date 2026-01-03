import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

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
        background: "#0a0a0a",
        color: "#e0e0e0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "48px 24px",
      }}
    >
      <h1
        style={{
          fontSize: "48px",
          marginBottom: "48px",
          fontWeight: 300,
        }}
      >
        MOOSE
      </h1>

      {/* Resume Section */}
      <div
        style={{
          width: "100%",
          maxWidth: "500px",
          marginBottom: "32px",
        }}
      >
        <h2
          style={{
            fontSize: "14px",
            color: "#888",
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          Resume Session
        </h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            placeholder="Session UUID..."
            value={resumeId}
            onChange={(e) => setResumeId(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1,
              padding: "12px 16px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "8px",
              color: "#e0e0e0",
              fontSize: "14px",
              outline: "none",
              fontFamily: "monospace",
            }}
          />
          <button
            onClick={handleResume}
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
            Resume
          </button>
        </div>
      </div>

      {/* Divider */}
      <div
        style={{
          width: "100%",
          maxWidth: "500px",
          display: "flex",
          alignItems: "center",
          gap: "16px",
          marginBottom: "32px",
          color: "#555",
        }}
      >
        <div style={{ flex: 1, height: "1px", background: "#333" }} />
        <span>or</span>
        <div style={{ flex: 1, height: "1px", background: "#333" }} />
      </div>

      {/* New Conversation */}
      <button
        onClick={() => navigate("/chat")}
        style={{
          width: "100%",
          maxWidth: "500px",
          padding: "16px",
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: "8px",
          color: "#e0e0e0",
          cursor: "pointer",
          fontSize: "16px",
          marginBottom: "48px",
        }}
      >
        + New Conversation
      </button>

      {/* Recent Sessions */}
      <div style={{ width: "100%", maxWidth: "500px" }}>
        <h2
          style={{
            fontSize: "14px",
            color: "#888",
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          Recent
        </h2>
        {loading ? (
          <div style={{ color: "#555" }}>Loading...</div>
        ) : sessions.length === 0 ? (
          <div style={{ color: "#555" }}>No sessions yet</div>
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
                  padding: "12px 16px",
                  background: "#1a1a1a",
                  border: "1px solid #222",
                  borderRadius: "8px",
                  color: "#e0e0e0",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: "#666",
                  }}
                >
                  {s.id.slice(0, 8)}...
                </span>
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.title}
                </span>
                <span style={{ fontSize: "12px", color: "#555" }}>
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
