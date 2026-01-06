/**
 * ContextMeter — shows context window usage as a percentage.
 *
 * Color shifts as we approach the auto-compact threshold (77.5%):
 * - Green: comfortable, plenty of runway
 * - Yellow: getting close (within 10% of threshold)
 * - Red: at or past threshold, compact imminent
 */

import { colors } from "../theme";

// Auto-compact triggers at approximately 77.5% usage
const COMPACT_THRESHOLD_PERCENT = 77.5;
const CONTEXT_WINDOW_SIZE = 200_000;

type ContextUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type ContextMeterProps = {
  usage: ContextUsage | null | undefined;
};

export function ContextMeter({ usage }: ContextMeterProps) {
  if (!usage) {
    return (
      <span style={{ color: colors.muted, fontSize: "0.875rem" }}>
        —%
      </span>
    );
  }

  // Sum all input token types (they all count against context window)
  const totalTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);

  const percentUsed = (totalTokens / CONTEXT_WINDOW_SIZE) * 100;
  const percentToCompact = COMPACT_THRESHOLD_PERCENT - percentUsed;

  // Determine color based on distance to compact threshold
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
      style={{
        color,
        fontSize: "0.875rem",
        fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
      }}
      title={title}
    >
      {percentUsed.toFixed(0)}%
    </span>
  );
}
