/**
 * Subvox and Scribe hooks — memory systems.
 *
 * Subvox: extracts memorable moments from conversations and stores them to Cortex.
 * Scribe: archives conversation transcripts to Postgres for continuity.
 */

import { spawn } from 'child_process';
import type { UserPromptSubmitHookInput, StopHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { SUBVOX_DIR, SCRIBE_PATH } from '../config.js';

async function runSubvoxScript(
  scriptModule: string,
  inputData: unknown
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('uv', [
      'run',
      '--directory',
      SUBVOX_DIR,
      'python',
      '-m',
      scriptModule,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (stderr) {
        console.log(`[Subvox ${scriptModule} stderr] ${stderr}`);
      }
      if (code !== 0) {
        console.log(`[Subvox ${scriptModule}] exited with code ${code}`);
      }
      resolve(stdout.trim() || null);
    });

    proc.on('error', (err) => {
      console.log(`[Subvox ${scriptModule} error] ${err.message}`);
      resolve(null);
    });

    // Send input data
    proc.stdin.write(JSON.stringify(inputData));
    proc.stdin.end();
  });
}

export async function subvoxPromptHook(
  input: UserPromptSubmitHookInput,
  _toolUseId: string | undefined,
  _context: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  const output = await runSubvoxScript('subvox.prompt_hook', input);

  if (output) {
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: output,
      },
    };
  }

  return {};
}

export async function subvoxStopHook(
  input: StopHookInput,
  _toolUseId: string | undefined,
  _context: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  const output = await runSubvoxScript('subvox.stop_hook', input);

  if (output) {
    console.log(`[Subvox stop hook stdout] ${output}`);
  }

  return {};
}

/**
 * Scribe stop hook — archives conversation turns to Postgres.
 * Runs the Scribe Python script with the stop hook input.
 */
export async function scribeStopHook(
  input: StopHookInput,
  _toolUseId: string | undefined,
  _context: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  return new Promise((resolve) => {
    const proc = spawn('uv', ['run', SCRIBE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (stderr) {
        console.log(`[Scribe stderr] ${stderr}`);
      }
      if (code !== 0) {
        console.log(`[Scribe] exited with code ${code}`);
      }
    });

    proc.on('error', (err) => {
      console.log(`[Scribe error] ${err.message}`);
    });

    // Send input data (contains transcript_path, session_id, etc.)
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Don't wait for Scribe to finish—it can run in background
    resolve({});
  });
}
