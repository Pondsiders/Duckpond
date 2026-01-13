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
export const SYSTEM_PROMPT_PATH = '/Pondside/Alpha-Home/self/system-prompt/system-prompt.md';

// Working directory for the Agent SDK
export const CWD = '/Pondside';

// Agent definitions directory
export const AGENTS_DIR = '/Pondside/Barn/Duckpond/agents';

// Claude Code session storage
export const SESSIONS_DIR = join(homedir(), '.claude', 'projects', '-Pondside');

// Subvox hooks directory
export const SUBVOX_DIR = '/Pondside/Basement/Cortex/subvox';

// Scribe script path
export const SCRIBE_PATH = '/Pondside/Basement/Scribe/scribe.py';

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
  'Skill', // Required for skills
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
 * Dynamic context components fetched from Redis.
 */
export interface DynamicContext {
  // Past: Memory summaries
  summary1?: string;  // Yesterday (or period before last)
  summary2?: string;  // Last night (or previous period)
  summary3?: string;  // Today so far (null at night)

  // Present: Current state
  weather?: string;

  // Future: What's coming
  calendar?: string;
  todos?: string;

  // Metadata
  updated?: string;
}

/**
 * Build a fresh system prompt for a new sitting.
 *
 * Structure uses XML-style tags for clear demarcation:
 * - <eternal>: Soul prompt (system-prompt.md) - the unchanging core
 * - <past>: Memory summaries - what I've been through recently
 * - <present>: Machine info, weather - where I am right now
 * - <future>: Calendar, todos - what's coming
 */
export function buildSystemPrompt(ctx?: DynamicContext): string {
  const sections: string[] = [];

  // === ETERNAL ===
  sections.push('<eternal>');
  sections.push(SOUL_PROMPT);
  sections.push('</eternal>');

  // === PAST ===
  // Memory summaries - what I've been through recently
  const pastParts: string[] = [];
  if (ctx?.summary1) pastParts.push(`Yesterday:\n${ctx.summary1}`);
  if (ctx?.summary2) pastParts.push(`Last night:\n${ctx.summary2}`);
  if (ctx?.summary3) pastParts.push(`Today so far:\n${ctx.summary3}`);

  if (pastParts.length > 0) {
    sections.push('');
    sections.push('<past>');
    sections.push(pastParts.join('\n\n'));
    sections.push('</past>');
  }

  // === PRESENT ===
  // Machine context and current conditions
  const presentParts: string[] = [];
  presentParts.push(`Machine: ${hostname()}`);
  presentParts.push('Via: Duckpond');
  if (ctx?.weather) {
    presentParts.push('');
    presentParts.push(ctx.weather);
  }
  if (ctx?.updated) {
    presentParts.push('');
    presentParts.push(`(Refreshed ${ctx.updated})`);
  }

  sections.push('');
  sections.push('<present>');
  sections.push(presentParts.join('\n'));
  sections.push('</present>');

  // === FUTURE ===
  // Calendar and todos - what's coming
  const futureParts: string[] = [];
  if (ctx?.calendar) futureParts.push(ctx.calendar);
  if (ctx?.todos) {
    if (futureParts.length > 0) futureParts.push('');
    futureParts.push('Todos:');
    futureParts.push(ctx.todos);
  }

  if (futureParts.length > 0) {
    sections.push('');
    sections.push('<future>');
    sections.push(futureParts.join('\n'));
    sections.push('</future>');
  }

  return sections.join('\n').trim();
}

// --- Environment Setup ---

export function configureEnvironment(): void {
  process.env.ANTHROPIC_BASE_URL ??= ANTHROPIC_BASE_URL;
}
