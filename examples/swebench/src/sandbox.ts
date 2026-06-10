/**
 * Sandbox seam for the SWE-bench smoke harness.
 *
 * The harness only knows the `Sandbox` interface — a small set of POSIX-like
 * operations bound to a single checked-out repository state. Three concrete
 * implementations are exposed:
 *
 *   - `docker_sandbox` (recommended for real runs) — boots one of the
 *     prebuilt `swebench/sweb.eval.x86_64.<instance_id>` images, runs every
 *     tool call inside the container via `docker exec`, and captures the
 *     final diff with `git diff` against `base_commit`.
 *   - `local_sandbox` (for smoke) — shallow-clones the repo into a tmpdir at
 *     `base_commit` and runs tools against the host filesystem. No
 *     reproducibility guarantees; useful for verifying the agent loop without
 *     committing to a 200GB Docker pull.
 *   - `noop_sandbox` (for tests and the default smoke) — creates an empty
 *     tmpdir so subprocess providers get a real cwd, but refuses to exec
 *     anything and returns canned responses.
 *
 * The Docker impl is left as a TODO because Auto Mode should not be pulling
 * gigabyte container images on the user's behalf. The seam is shaped so
 * dropping in a real `dockerode`/`spawn('docker', ...)` impl is a contained
 * change.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SweBenchInstance } from './types.js'

export type ExecResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exit_code: number
}

export type Sandbox = {
  readonly workdir: string
  readonly exec: (argv: ReadonlyArray<string>, options?: { readonly timeout_ms?: number }) => Promise<ExecResult>
  readonly read_file: (path: string) => Promise<string>
  readonly write_file: (path: string, contents: string) => Promise<void>
  readonly git_diff: () => Promise<string>
  readonly dispose: () => Promise<void>
}

export type SandboxFactory = (instance: SweBenchInstance, abort: AbortSignal) => Promise<Sandbox>

export const noop_sandbox: SandboxFactory = async (instance) => {
  const workdir = await mkdtemp(join(tmpdir(), `swebench-noop-${instance.instance_id}-`))
  return {
    workdir,
    exec: async () => ({ stdout: '', stderr: 'noop_sandbox: exec disabled', exit_code: 1 }),
    read_file: async () => '',
    write_file: async () => {},
    git_diff: async () => '',
    dispose: async () => {
      await rm(workdir, { recursive: true, force: true })
    },
  }
}

/**
 * Clone the repo at `base_commit` into a tmpdir and run tools against the
 * host filesystem. No isolation; assumes git, the repo's runtime, and any
 * native build deps are already available on the host.
 */
export const local_sandbox: SandboxFactory = async (instance, abort) => {
  const root = await mkdtemp(join(tmpdir(), `swebench-${instance.instance_id}-`))
  const workdir = join(root, 'repo')

  await run_host(['git', 'clone', '--filter=blob:none', '--no-checkout', `https://github.com/${instance.repo}.git`, workdir], abort, root)
  await run_host(['git', '-C', workdir, 'checkout', instance.base_commit], abort, workdir)

  return {
    workdir,
    exec: (argv, options) => run_host(argv, abort, workdir, options?.timeout_ms),
    read_file: async (path: string) => {
      const result = await run_host(['cat', path], abort, workdir)
      if (result.exit_code !== 0) throw new Error(`read_file ${path}: ${result.stderr}`)
      return result.stdout
    },
    write_file: async (path: string, contents: string) => {
      const abs = join(workdir, path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, contents)
    },
    git_diff: async () => {
      const result = await run_host(['git', 'diff', instance.base_commit], abort, workdir)
      return result.stdout
    },
    dispose: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Run-each-tool-inside-a-Docker-container sandbox. Stubbed: returns a clear
 * error so the user sees what to wire up. Switch by setting
 * `SWEBENCH_SANDBOX=docker` once a real impl exists.
 */
export const docker_sandbox: SandboxFactory = async (instance) => {
  throw new Error(
    `docker_sandbox is not implemented yet. Wire up dockerode (or spawn 'docker run -d swebench/sweb.eval.x86_64.${instance.instance_id}') and return the same Sandbox interface.`,
  )
}

async function run_host(
  argv: ReadonlyArray<string>,
  abort: AbortSignal,
  cwd: string,
  timeout_ms?: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [head, ...rest] = argv
    if (head === undefined) {
      reject(new Error('run_host: empty argv'))
      return
    }
    const child = spawn(head, rest, { cwd, signal: abort })
    const stdout_chunks: Buffer[] = []
    const stderr_chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout_chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr_chunks.push(chunk))

    const timer = timeout_ms === undefined
      ? undefined
      : setTimeout(() => child.kill('SIGKILL'), timeout_ms)

    child.on('error', (err) => {
      if (timer !== undefined) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout_chunks).toString('utf8'),
        stderr: Buffer.concat(stderr_chunks).toString('utf8'),
        exit_code: code ?? -1,
      })
    })
  })
}

export function resolve_sandbox_factory(name: string | undefined): SandboxFactory {
  switch (name) {
    case 'docker': return docker_sandbox
    case 'local': return local_sandbox
    case 'noop':
    case undefined:
    case '': return noop_sandbox
    default: throw new Error(`unknown SWEBENCH_SANDBOX: ${name}. Use 'local', 'docker', or 'noop'.`)
  }
}
