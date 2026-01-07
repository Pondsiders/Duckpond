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
    <div className="min-h-screen bg-background flex flex-col items-center px-6 py-12">
      {/* Header */}
      <h1 className="text-5xl font-serif font-light text-text mb-2">
        Duckpond
      </h1>
      <p className="text-muted mb-12 font-serif">
        The duck, the pond, and a cozy bench by the water
      </p>

      {/* New Conversation - prominent */}
      <button
        onClick={() => navigate("/chat")}
        className="w-full max-w-md mb-8 px-6 py-4 bg-primary border-none rounded-2xl text-white font-serif text-lg cursor-pointer shadow-lg"
      >
        New Conversation
      </button>

      {/* Resume Section */}
      <div className="w-full max-w-md mb-8">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Resume by session UUID..."
            value={resumeId}
            onChange={(e) => setResumeId(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 px-4 py-3 bg-composer border border-border rounded-xl font-mono text-sm text-text outline-none"
          />
          <button
            onClick={handleResume}
            className="px-6 py-3 bg-composer border border-border rounded-xl text-text font-serif cursor-pointer"
          >
            Resume
          </button>
        </div>
      </div>

      {/* Divider */}
      <div className="w-full max-w-md flex items-center gap-4 mb-8 text-muted">
        <div className="flex-1 h-px bg-border" />
        <span className="text-sm">recent sessions</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Recent Sessions */}
      <div className="w-full max-w-md">
        {loading ? (
          <div className="text-center text-muted">Loading...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center text-muted py-8 font-serif">
            No sessions yet. Start a new conversation above.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(`/chat/${s.id}`)}
                className="flex items-center gap-3 p-4 bg-composer border border-border rounded-xl text-text text-left cursor-pointer w-full"
              >
                <span className="font-mono text-xs text-muted shrink-0">
                  {s.id.slice(0, 8)}
                </span>
                <span className="flex-1 font-serif overflow-hidden text-ellipsis whitespace-nowrap">
                  {s.title}
                </span>
                <span className="text-xs text-muted shrink-0">
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
