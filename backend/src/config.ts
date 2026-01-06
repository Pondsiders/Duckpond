/**
 * Duckpond configuration.
 *
 * The code is the config. Change these values directly.
 */

import { readFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';

// --- Paths ---

// Alpha's system prompt
export const SYSTEM_PROMPT_PATH = '/Volumes/Pondside/.claude/agents/Alpha.md';

// Working directory for the Agent SDK
export const CWD = '/Volumes/Pondside';

// Claude Code session storage
export const SESSIONS_DIR = join(homedir(), '.claude', 'projects', '-Volumes-Pondside');

// Subvox hooks directory
export const SUBVOX_DIR = '/Volumes/Pondside/Basement/Cortex/subvox';

// --- API ---

// Eavesdrop proxy (memory injection, observability)
export const ANTHROPIC_BASE_URL = 'http://alpha-pi:8080';

// --- Tools ---

// What Alpha can use in Duckpond
export const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

// --- System Prompt ---

function loadSoulPrompt(): string {
  const raw = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');

  // Strip YAML frontmatter (between --- markers)
  if (raw.startsWith('---')) {
    const parts = raw.split('---');
    if (parts.length >= 3) {
      return parts.slice(2).join('---').trim();
    }
  }

  return raw;
}

// Cache the soul prompt (static, doesn't change)
const SOUL_PROMPT = loadSoulPrompt();

/**
 * Build a fresh system prompt for a new sitting.
 * Includes the soul prompt plus dynamic context.
 *
 * Note: We deliberately exclude time to avoid cache invalidation.
 * The timestamp hook handles per-message timing.
 *
 * @param hud - Optional HUD markdown from Redis (fetched by caller)
 */
export function buildSystemPrompt(hud?: string): string {
  let sittingContext = `
---

## Sitting Context

**Machine:** ${hostname()}
**Via:** Duckpond
`;

  if (hud) {
    sittingContext += `
---

## HUD

${hud}
`;
  }

  return SOUL_PROMPT + sittingContext;
}

// --- Environment Setup ---

export function configureEnvironment(): void {
  process.env.ANTHROPIC_BASE_URL ??= ANTHROPIC_BASE_URL;
}
