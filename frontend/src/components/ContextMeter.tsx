/**
 * ContextMeter — shows context window usage as a percentage.
 *
 * Color shifts as we approach the auto-compact threshold (77.5%):
 * - Green: comfortable, plenty of runway
 * - Yellow: getting close (within 10% of threshold)
 * - Red: at or past threshold, compact imminent
 *
 * Token count comes from Eavesdrop calling Anthropic's count_tokens endpoint,
 * stored in Redis, and fetched via /api/context/{session_id}.
 */

// Auto-compact triggers at approximately 77.5% usage
const COMPACT_THRESHOLD_PERCENT = 77.5;
const CONTEXT_WINDOW_SIZE = 200_000;

type ContextMeterProps = {
  inputTokens: number | null | undefined;
};

export function ContextMeter({ inputTokens }: ContextMeterProps) {
  if (inputTokens == null) {
    return (
      <span className="text-muted text-sm">
        —%
      </span>
    );
  }

  const percentUsed = (inputTokens / CONTEXT_WINDOW_SIZE) * 100;
  const percentToCompact = COMPACT_THRESHOLD_PERCENT - percentUsed;

  // Determine color based on distance to compact threshold
  // These are dynamic so we keep them as inline styles
  let color: string;
  let title: string;

  if (percentToCompact <= 0) {
    // Past threshold — compact imminent or happening
    color = "#ef4444"; // red
    title = "Context full — auto-compact imminent";
  } else if (percentToCompact <= 10) {
    // Getting close — warning zone
    color = "#eab308"; // yellow
    title = `${percentToCompact.toFixed(0)}% until auto-compact`;
  } else {
    // Comfortable
    color = "#22c55e"; // green
    title = `${percentToCompact.toFixed(0)}% until auto-compact`;
  }

  return (
    <span
      className="text-sm font-medium tabular-nums"
      style={{ color }}
      title={title}
    >
      {percentUsed.toFixed(1)}%
    </span>
  );
}
