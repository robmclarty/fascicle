---
title: stdio agent contract — making fascicle agents easy to embed under a harness
status: draft
date: 2026-07-02
author: claude (for rob)
tags: [harness, stdio, embedding, plumbbob, api]
---

# stdio agent contract

## The question

PlumbBob is growing a user-agent plug-in seam: a deterministic parent CLI spawns a
user-authored agent as a **single-shot subprocess** speaking a versioned envelope —
JSON on stdin, exactly one JSON result on stdout, human-readable narration on
stderr, exit code as the verdict (design:
`~/Projects/plumbbob/code/plumbbob/research/04-user-agent-plugins.md`). Fascicle is
the obvious way to *build* such agents — its zod-validated discriminated-union
results are already the right envelope material — but nothing in the library or
docs makes a compliant agent the path of least resistance. What should fascicle add
so that "fascicle agent under a dumb parent" is a five-line pattern instead of
folklore?

This is the **child direction**. `docs/writing-a-harness.md` covers fascicle as the
*parent* (your program owns argv, wiring, and the run). This note is about fascicle
as the *subprocess* — where stdout belongs to someone else.

## What exists today (verified against src)

- `run(flow, input, options)` with `RunOptions` — `abort` (caller-owned
  cancellation), `install_signal_handlers` (default **true**),
  `trajectory`, `checkpoint_store`, `resume_data` (`src/core/runner.ts:92`).
  Suspend/resume machinery exists and is documented.
- Adapters: `filesystem_logger`, `http_logger`, `noop_logger`, `tee_logger`,
  `filesystem_store`. **No console logger ships in the library.** The only modeled
  console pattern is `examples/pr-improve/src/observability.ts`'s local
  `stdout_logger()` — which tees trajectory events onto **stdout**.
- `serve_flow` (`src/mcp/serve.ts`) registers a flow onto a caller-constructed
  `McpServer` — MCP-over-stdio is possible, but it is a stateful JSON-RPC session,
  not a single-shot exec.
- Harness checklist already demands non-zero exit on failure and
  `engine.dispose()` in `finally`.

## The gaps

1. **No stdin entry helper.** Every author hand-rolls read-stdin-to-EOF →
   `JSON.parse` → validate → `run` → serialize → exit-code mapping.
2. **The examples model the wrong stream.** pr-improve tees trajectory to
   *stdout* (legitimate for its CloudWatch/awslogs deployment, wrong under a
   parent that treats stdout as the result channel). There is no library
   `stderr_logger` to reach for instead.
3. **No stream-hygiene doctrine.** Nothing says "stdout belongs to your caller";
   a stray `console.log` in a stage silently corrupts the parent's parse.
4. **No exit-code convention.** "Non-zero on failure" is stated; *which*
   non-zero, and what distinguishes a flow failure from a contract violation,
   is not.

## Recommendations

### R1 — `run_stdio(flow, options)` (the core of it)

A library helper (new `fascicle/stdio` subpath, mirroring `fascicle/adapters` and
`fascicle/mcp`) that makes the whole child contract one call in the author's own
entry point:

```ts
import { run_stdio } from 'fascicle/stdio'

run_stdio(my_flow, {
  input_schema: StepContextSchema,    // optional zod — invalid stdin = exit 2
  output_schema: ResultSchema,        // optional zod — invalid result = exit 2
  engine,                             // disposed in finally
  trajectory: stderr_logger(),        // default when omitted
})
```

Behavior, in order: read stdin to EOF → `JSON.parse` (+ optional schema) →
`run(flow, input, ...)` → serialize the result as the **only** bytes on stdout →
exit. Signals stay installed (default `true` is already right for a single-shot
child — the parent forwards SIGINT and the child must die); `dispose()` in
`finally`; trajectory and errors to stderr.

**Exit codes: `0` = result on stdout is authoritative; `1` = flow failure; `2` =
contract violation** (unparseable stdin, schema mismatch either direction). This
deliberately mirrors checkride's `0` pass / `1` fail / `2` error — one convention
across the toolchain.

Notably this stays true to the standing "no flow-runner bin" stance: `run_stdio`
is a library function the author calls from their own entry point. Fascicle still
ships no generic runner CLI; the author still owns the program.

### R2 — promote `stderr_logger()` into `fascicle/adapters`

One JSON line per trajectory event, written to stderr. It becomes the blessed
console logger in every example and the default trajectory in `run_stdio`.
pr-improve's stdout tee remains available as the *deployment-specific* choice it
actually is (awslogs wants stdout), but the shipped default assumes you might be
somebody's child. A `console_logger({ stream: 'stdout' | 'stderr' })` spelling
would also do; the point is that the library ships the stderr path.

### R3 — document the child direction

A short `docs/embedding-under-a-harness.md`, the mirror of `writing-a-harness.md`,
with the doctrine stated once: **stdout belongs to your caller.** Trajectory,
progress, and errors go to stderr or files; the result envelope is the only
stdout. Add the corresponding line to the writing-a-harness checklist ("if your
harness might be spawned by another program, use `run_stdio`").

### R4 — `examples/stdio_agent.ts`

A ~30-line compliant agent: schema in, ensemble-of-two + synthesize, schema out.
Small enough to copy, real enough to prove the envelope survives a non-trivial
flow. (A plumbbob-flavored variant can live on plumbbob's side of the fence.)

### R5 — structured failure detail

On exit `1`/`2`, stdout carries nothing authoritative; the *last* stderr line is a
single JSON object (`{ error, stage?, cause? }`) so parents that want machine-
readable failure detail can take the tail line, while humans watching the stream
just see it as the final log line. Cheap, backward-compatible, optional to
consume.

### R6 — deferred: the suspended envelope

`checkpoint_store` + `resume_data` already support pause/resume across process
boundaries. A future `run_stdio` extension could emit
`{ status: "suspended", resume: <token> }` (exit 0) and accept a `--resume`
token — human-in-the-loop *inside* an agent, the same shape as A2A's
`input_required` task state. Explicitly not now: plumbbob's pause lives at the
plumbbob layer, and building this before a parent needs it is the same
speculative-machinery mistake the reasoning-seam prototype taught. Record the
option, don't build it.

## Why not just MCP / `serve_flow`?

`serve_flow` over a stdio transport gives a *session*: JSON-RPC framing,
initialize handshake, tool-shaped calls, long-lived process. Right when the
parent is an MCP host; wrong for a deterministic parent that wants Unix-shaped
`exec → result → exit` with no protocol state. Both belong: `serve_flow` for
hosts, `run_stdio` for harnesses. A sentence in each doc pointing at the other
prevents the "which one?" question.

## Prior art (why this exact shape)

| Precedent | Shape | Taken |
|---|---|---|
| Terraform `external` data source | JSON stdin → JSON stdout, stderr for errors, non-zero = fail | the envelope, verbatim |
| git credential helpers | stdio contract + discovery by name, any language | contract over runtime |
| Claude Code hooks | JSON on stdin, exit codes as verdicts | the convention plumbbob users already live in |
| LSP / MCP stdio | framed *session* over stdio | the contrast case — session vs single-shot (§ above) |
| checkride (in-house) | stdout = machine JSON only, stderr = progress, exit 0/1/2 | the stream discipline and the exit codes, already house style |

## Impact

With R1+R2 a plumbbob-compliant fascicle agent is:

```ts
import { run_stdio } from 'fascicle/stdio'
import { flow, engine, Input, Output } from './flow.js'
run_stdio(flow, { engine, input_schema: Input, output_schema: Output })
```

— down from ~40 lines of folklore (stdin plumbing, parse, serialize, exit
mapping, dispose, and knowing not to log to stdout), with the two failure classes
the parent cares about distinguished for free. The R1–R5 set is small, dependency-
free (zod is already the peer for any flow with model calls; schemas are
optional), and none of it couples fascicle to plumbbob — any parent that speaks
JSON-over-stdio gets the same benefit.
