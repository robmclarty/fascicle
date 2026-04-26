import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const child_script = join(here, 'child-harness.ts');
const register_script = join(here, 'register-ts-resolver.mjs');

async function wait_for_marker(path: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  let last_error: unknown = null;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (err) {
      last_error = err;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  throw new Error(
    `marker never appeared at ${path}: ${last_error instanceof Error ? last_error.message : String(last_error)}`,
  );
}

type child_exit = { code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string };

async function spawn_child(marker_dir: string): Promise<{
  pid: number;
  exit: Promise<child_exit>;
}> {
  const child = spawn(
    process.execPath,
    ['--import', register_script, child_script],
    {
      cwd: here,
      env: { ...process.env, MARKER_DIR: marker_dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  if (child.pid === undefined) {
    throw new Error('child failed to spawn');
  }

  const exit = new Promise<child_exit>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });

  return { pid: child.pid, exit };
}

describe('SIGINT child-process harness', () => {
  it('a real SIGINT runs cleanup, surfaces aborted_error, and exits non-zero', async () => {
    const marker_dir = await mkdtemp(join(tmpdir(), 'fascicle-sigint-'));

    try {
      const { pid, exit } = await spawn_child(marker_dir);

      await wait_for_marker(join(marker_dir, 'ready'), 45_000);

      process.kill(pid, 'SIGINT');

      const result = await exit;

      const exit_is_non_zero = result.code !== 0 || result.signal !== null;
      expect(exit_is_non_zero, `child exit (code=${String(result.code)}, signal=${String(result.signal)}). stderr:\n${result.stderr}`).toBe(true);

      await stat(join(marker_dir, 'cleanup.ok'));

      const abort_reason_raw = await readFile(join(marker_dir, 'abort-reason.json'), 'utf8');
      const abort_reason = JSON.parse(abort_reason_raw) as {
        reason_is_aborted_error: boolean;
        reason_name: string;
        reason_message: string;
        io_error_name: string;
      };
      expect(abort_reason.reason_is_aborted_error).toBe(true);
      expect(abort_reason.reason_name).toBe('aborted_error');
      expect(abort_reason.reason_message).toMatch(/SIGINT/);

      const exit_reason_raw = await readFile(join(marker_dir, 'exit-reason.json'), 'utf8');
      const exit_reason = JSON.parse(exit_reason_raw) as {
        name: string;
        is_aborted_error: boolean;
      };
      expect(exit_reason.is_aborted_error).toBe(true);
      expect(exit_reason.name).toBe('aborted_error');
    } finally {
      await rm(marker_dir, { recursive: true, force: true });
    }
  }, 75_000);
});
