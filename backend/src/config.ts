/**
 * Duckpond configuration.
 *
 * The code is the config. Change these values directly.
 */

import { readFileSync, readdirSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

// --- Paths ---

// Alpha's system prompt
// export const SYSTEM_PROMPT_PATH = '/Volumes/Pondside/Alpha-Home/self/system-prompt/system-prompt.md';
export const SYSTEM_PROMPT_PATH = '/Volumes/Pondside/.claude/agents/Alpha.md';

// Working directory for the Agent SDK
export const CWD = '/Volumes/Pondside';

// Agent definitions directory
export const AGENTS_DIR = '/Volumes/Pondside/Barn/Duckpond/agents';

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
  'Task',  // Required for subagent invocation
];

// --- Agents ---

/**
 * Load an agent definition from a markdown file with YAML frontmatter.
 * Expected frontmatter fields: name, description, model, tools (optional)
 */
function loadAgentFromFile(filePath: string): { name: string; definition: AgentDefinition } {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  if (!data.name || !data.description) {
    throw new Error(`Agent file ${filePath} missing required frontmatter (name, description)`);
  }

  const definition: AgentDefinition = {
    description: data.description,
    prompt: content.trim(),
  };

  // Optional fields
  if (data.model) {
    definition.model = data.model;
  }
  if (data.tools && Array.isArray(data.tools)) {
    definition.tools = data.tools;
  }

  return { name: data.name.toLowerCase(), definition };
}

/**
 * Load all agent definitions from the agents directory.
 * Returns a record keyed by agent name (lowercase).
 */
function loadAgents(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  try {
    const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const { name, definition } = loadAgentFromFile(join(AGENTS_DIR, file));
        agents[name] = definition;
        console.log(`[Duckpond] Loaded agent: ${name}`);
      } catch (err) {
        console.error(`[Duckpond] Failed to load agent from ${file}:`, err);
      }
    }
  } catch (err) {
    console.error(`[Duckpond] Failed to read agents directory:`, err);
  }

  return agents;
}

// Cache agents at startup
export const AGENTS = loadAgents();

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
