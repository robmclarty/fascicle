/**
 * Subprocess lifecycle for the claude_cli adapter (spec §6, constraints §5.10).
 *
 * The factory exposes:
 *   - `live_children`: a closure-captured Set<ChildProcess> per-adapter-factory
 *     call (constraints §7 invariant 5: no module-level mutable state).
 *   - `spawn_cli(...)`: spawns the child with { detached: true, stdio: [...],
 *     env, cwd, shell: false }; arms startup + stall timers; SIGTERM→SIGKILL
 *     escalation on signal; removes from live set on close.
 *   - `dispose_all()`: issues SIGTERM→SIGKILL for every live child and awaits
 *     every close.
 *
 * A single process-wide `exit` handler synchronously SIGKILLs every live
 * child across every spawn registry (constraints §5.10 #5). The handler is
 * installed once per Node process and iterates a registry of adapter
 * live-sets.
 *
 * `node:child_process` imports are confined to this directory (enforced by
 * rules/no-child-process-outside-claude-cli.yml). The spawn call passes
 * `shell: false` via argv array form; no value is string-interpolated into
 * argv.
 */

import { spawn as node_spawn, type ChildProcess } from 'node:child_process';
import { aborted_error, claude_cli_error } from '../../errors.js';
import { SIGKILL_ESCALATION_MS } from './constants.js';

export type SpawnArgs = {
  readonly cmd: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd?: string;
  readonly stdin: string;
  readonly startup_timeout_ms: number;
  readonly stall_timeout_ms: number;
  readonly abort?: AbortSignal;
};

export type SpawnCloseOutcome = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
};

export type SpawnSession = {
  readonly child: ChildProcess;
  readonly stdout_lines: AsyncIterable<string>;
  readonly wait_close: () => Promise<SpawnCloseOutcome>;
  readonly request_terminate: (reason: 'abort' | 'disposed' | 'timeout') => void;
};

type ChildRegistry = Set<ChildProcess>;

const ALL_REGISTRIES: Set<ChildRegistry> = new Set();
let exit_handler_installed = false;

function install_exit_handler_once(): void {
  if (exit_handler_installed) return;
  exit_handler_installed = true;
  const handler = (): void => {
    for (const reg of ALL_REGISTRIES) {
      for (const child of reg) {
        if (child.pid === undefined || child.exitCode !== null) continue;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already exited, or signal failed; nothing more we can do synchronously
        }
      }
    }
  };
  process.on('exit', handler);
}

export type SpawnRuntime = {
  readonly live_children: ChildRegistry;
  readonly spawn_cli: (args: SpawnArgs) => Promise<SpawnSession>;
  readonly dispose_all: () => Promise<void>;
};

export function create_spawn_runtime(): SpawnRuntime {
  const live_children: ChildRegistry = new Set();
  ALL_REGISTRIES.add(live_children);
  install_exit_handler_once();

  const spawn_cli = async (args: SpawnArgs): Promise<SpawnSession> => {
    if (args.abort?.aborted === true) {
      throw new aborted_error('aborted', { reason: args.abort.reason });
    }

    let child: ChildProcess;
    try {
      const spawn_opts: Parameters<typeof node_spawn>[2] = {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: args.env,
        shell: false,
      };
      if (args.cwd !== undefined) spawn_opts.cwd = args.cwd;
      child = node_spawn(args.cmd, [...args.argv], spawn_opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new claude_cli_error('binary_not_found', `failed to spawn '${args.cmd}': ${message}`);
    }

    live_children.add(child);

    let spawn_error: Error | undefined;
    let startup_error: claude_cli_error | undefined;
    let stall_error: claude_cli_error | undefined;
    let terminate_reason: 'abort' | 'disposed' | 'timeout' | undefined;
    let startup_timer: NodeJS.Timeout | undefined;
    let stall_timer: NodeJS.Timeout | undefined;
    let sigkill_timer: NodeJS.Timeout | undefined;
    let first_stdout_byte_seen = false;

    const capture: { stderr: string } = { stderr: '' };
    child.stderr?.on('data', (buf: Buffer) => {
      capture.stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      spawn_error = err;
    });

    const clear_all_timers = (): void => {
      if (startup_timer !== undefined) clearTimeout(startup_timer);
      if (stall_timer !== undefined) clearTimeout(stall_timer);
      if (sigkill_timer !== undefined) clearTimeout(sigkill_timer);
      startup_timer = undefined;
      stall_timer = undefined;
      sigkill_timer = undefined;
    };

    const send_signal = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // child already exited, or kill failed; ignore
      }
    };

    const escalate = (reason: 'abort' | 'disposed' | 'timeout'): void => {
      if (terminate_reason !== undefined) return;
      terminate_reason = reason;
      send_signal('SIGTERM');
      sigkill_timer = setTimeout(() => {
        send_signal('SIGKILL');
      }, SIGKILL_ESCALATION_MS);
    };

    if (args.startup_timeout_ms > 0) {
      startup_timer = setTimeout(() => {
        if (first_stdout_byte_seen) return;
        startup_error = new claude_cli_error(
          'startup_timeout',
          `no stdout within ${String(args.startup_timeout_ms)}ms`,
        );
        escalate('timeout');
      }, args.startup_timeout_ms);
    }

    const arm_stall_timer = (): void => {
      if (args.stall_timeout_ms <= 0) return;
      if (stall_timer !== undefined) clearTimeout(stall_timer);
      stall_timer = setTimeout(() => {
        stall_error = new claude_cli_error(
          'stall_timeout',
          `no stdout for ${String(args.stall_timeout_ms)}ms`,
        );
        escalate('timeout');
      }, args.stall_timeout_ms);
    };

    const abort_listener = (): void => {
      escalate('abort');
    };
    if (args.abort !== undefined) {
      if (args.abort.aborted) abort_listener();
      else args.abort.addEventListener('abort', abort_listener, { once: true });
    }

    const close_promise = new Promise<SpawnCloseOutcome>((resolve) => {
      child.on('close', (code, signal) => {
        clear_all_timers();
        live_children.delete(child);
        if (args.abort !== undefined) {
          args.abort.removeEventListener('abort', abort_listener);
        }
        resolve({ code, signal, stderr: capture.stderr });
      });
    });

    const stdin = child.stdin;
    if (stdin !== null) {
      stdin.on('error', () => {
        // CLI may close stdin before we finish writing; swallow.
      });
      stdin.write(args.stdin);
      stdin.end();
    }

    const stdout_lines = build_stdout_lines(child, () => {
      if (!first_stdout_byte_seen) {
        first_stdout_byte_seen = true;
        if (startup_timer !== undefined) {
          clearTimeout(startup_timer);
          startup_timer = undefined;
        }
      }
      arm_stall_timer();
    });

    return {
      child,
      stdout_lines,
      wait_close: async () => {
        const outcome = await close_promise;
        if (spawn_error !== undefined) {
          const message = spawn_error.message;
          throw new claude_cli_error('binary_not_found', message);
        }
        if (startup_error !== undefined) throw startup_error;
        if (stall_error !== undefined) throw stall_error;
        if (terminate_reason === 'abort') {
          throw new aborted_error('aborted', { reason: args.abort?.reason });
        }
        if (terminate_reason === 'disposed') {
          throw new aborted_error('engine disposed', { reason: 'engine_disposed' });
        }
        return outcome;
      },
      request_terminate: (reason) => escalate(reason),
    };
  };

  const dispose_all = async (): Promise<void> => {
    const pending: Promise<void>[] = [];
    for (const child of live_children) {
      pending.push(
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, 'SIGTERM');
            } catch {
              // child already exited or signal failed; ignore
            }
            setTimeout(() => {
              if (child.exitCode === null && child.pid !== undefined) {
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch {
                  // ignore
                }
              }
            }, SIGKILL_ESCALATION_MS);
          }
        }),
      );
    }
    await Promise.all(pending);
    ALL_REGISTRIES.delete(live_children);
  };

  return { live_children, spawn_cli, dispose_all };
}

async function* build_stdout_lines(
  child: ChildProcess,
  on_data: () => void,
): AsyncIterable<string> {
  const stdout = child.stdout;
  if (stdout === null) return;
  let buffer = '';
  let ended = false;
  const queue: string[] = [];
  let resolver: (() => void) | undefined;
  const wake = (): void => {
    const r = resolver;
    if (r !== undefined) {
      resolver = undefined;
      r();
    }
  };
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    on_data();
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      queue.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
    wake();
  });
  stdout.on('end', () => {
    if (buffer.length > 0) {
      queue.push(buffer);
      buffer = '';
    }
    ended = true;
    wake();
  });
  stdout.on('error', () => {
    ended = true;
    wake();
  });
  while (true) {
    if (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) yield next;
      continue;
    }
    if (ended) return;
    await new Promise<void>((r) => {
      resolver = r;
    });
  }
}
