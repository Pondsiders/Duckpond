import type { FC } from "react";
import { ChevronDown, ChevronRight, Terminal, Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { colors } from "../theme";

interface ToolFallbackProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export const ToolFallback: FC<ToolFallbackProps> = ({
  toolName,
  args,
  result,
  isError,
}) => {
  const [expanded, setExpanded] = useState(false);

  // Defensive: ensure we have valid data
  const safeName = toolName || "Unknown Tool";
  const safeArgs = args || {};

  // Infer status from whether we have a result
  const isComplete = result !== undefined;
  const isRunning = !isComplete;

  // Format tool name nicely (e.g., "Bash" instead of "bash")
  const displayName = safeName.charAt(0).toUpperCase() + safeName.slice(1);

  // Get a summary of the args (first string arg or count of args)
  const argSummary = (() => {
    const entries = Object.entries(safeArgs);
    if (entries.length === 0) return "";

    // For Bash, show the command
    if (safeName.toLowerCase() === "bash" && safeArgs.command) {
      const cmd = String(safeArgs.command);
      return cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
    }

    // For Read/Write, show the file path
    if (safeArgs.file_path) {
      const path = String(safeArgs.file_path);
      const parts = path.split("/");
      return parts[parts.length - 1]; // Just the filename
    }

    // For Grep/Glob, show the pattern
    if (safeArgs.pattern) {
      return String(safeArgs.pattern);
    }

    // Default: first string value or arg count
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
      {/* Header - always visible */}
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
        {/* Expand/collapse chevron */}
        {expanded ? (
          <ChevronDown size={14} color={colors.muted} />
        ) : (
          <ChevronRight size={14} color={colors.muted} />
        )}

        {/* Status icon */}
        {isRunning ? (
          <Loader2 size={14} color={colors.primary} style={{ animation: "spin 1s linear infinite" }} />
        ) : isComplete ? (
          <Check size={14} color="#4ade80" />
        ) : (
          <Terminal size={14} color={colors.muted} />
        )}

        {/* Tool name */}
        <span style={{ color: colors.primary, fontWeight: 600 }}>
          {displayName}
        </span>

        {/* Arg summary */}
        {argSummary && (
          <span style={{ color: colors.muted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {argSummary}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${colors.border}`,
            padding: "12px",
          }}
        >
          {/* Args */}
          <div style={{ marginBottom: result ? "12px" : 0 }}>
            <div style={{ color: colors.muted, fontSize: "11px", marginBottom: "4px", fontFamily: "monospace" }}>
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
              {JSON.stringify(safeArgs, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {result !== undefined && (
            <div>
              <div style={{ color: colors.muted, fontSize: "11px", marginBottom: "4px", fontFamily: "monospace" }}>
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
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Spinner animation */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
