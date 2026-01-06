/**
 * Subvox hooks — the voice that whispers.
 *
 * These hooks bridge Duckpond to the Subvox memory system, which extracts
 * memorable moments from conversations and stores them to Cortex.
 */

import * as logfire from '@pydantic/logfire-node';
import { spawn } from 'child_process';
import type { UserPromptSubmitHookInput, StopHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { SUBVOX_DIR } from '../config.js';

async function runSubvoxScript(
  scriptModule: string,
  inputData: unknown
): Promise<string | null> {
  logfire.debug('Running Subvox script', { scriptModule });

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
        logfire.debug('Subvox script stderr', { scriptModule, stderr: stderr.slice(0, 200) });
        console.log(`[Subvox ${scriptModule} stderr] ${stderr}`);
      }
      if (code !== 0) {
        logfire.warning('Subvox script exited with non-zero code', { scriptModule, code });
        console.log(`[Subvox ${scriptModule}] exited with code ${code}`);
      }
      logfire.debug('Subvox script completed', { scriptModule, hasOutput: !!stdout.trim() });
      resolve(stdout.trim() || null);
    });

    proc.on('error', (err) => {
      logfire.error('Subvox script error', { scriptModule, error: err.message });
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
  logfire.info('subvoxPromptHook called');
  const output = await runSubvoxScript('subvox.prompt_hook', input);

  if (output) {
    logfire.info('subvoxPromptHook returning context', { outputLength: output.length });
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: output,
      },
    };
  }

  logfire.debug('subvoxPromptHook returning empty');
  return {};
}

export async function subvoxStopHook(
  input: StopHookInput,
  _toolUseId: string | undefined,
  _context: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  logfire.info('subvoxStopHook called');
  const output = await runSubvoxScript('subvox.stop_hook', input);

  if (output) {
    logfire.info('subvoxStopHook output', { outputLength: output.length });
    console.log(`[Subvox stop hook stdout] ${output}`);
  }

  logfire.debug('subvoxStopHook completed');
  return {};
}
