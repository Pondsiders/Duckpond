/**
 * Subvox hooks — the voice that whispers.
 *
 * These hooks bridge Duckpond to the Subvox memory system, which extracts
 * memorable moments from conversations and stores them to Cortex.
 */

import { spawn } from 'child_process';
import type { UserPromptSubmitHookInput, StopHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { SUBVOX_DIR } from '../config.js';

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
