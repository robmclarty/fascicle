# @repo/core — Backlog

Deferred composition primitives tracked here. Nothing on this list is scoped
into v1. This file is the library-design parking lot for composers only; the
product and distribution roadmap (and the live open design questions that
touch composition) lives in [`docs/roadmap.md`](../../docs/roadmap.md).

## Bar for promotion

A deferred composer graduates into the library when
**"this pattern appeared in two unrelated flows and was awkward to express."**
Both halves matter: the pattern must recur across unrelated callers (not the
same codebase dressing itself up in three disguises), and expressing it with
the existing primitives must be genuinely awkward (not merely a hair longer
than a dedicated composer would be).

## Deferred composers

Each entry captures the pattern, why it might be worth promoting, and the
best user-land expression with the current toolkit. When an entry hits the
bar, move it to a dated "Promoted" section at the bottom of this file before
opening the spec change.

### `race`

Run N children concurrently, return the first to resolve. Cancel the rest.

- **Why someday:** fast-first responses (first-to-acknowledge polling,
  provider failover as an optimization rather than a fallback).
- **User-land form today:** `ensemble` with a score of
  `(_, _, t) => -t` gives first-to-finish semantics post-hoc but does not
  short-circuit cancellation of slower siblings. `race` would differ in
  actually cancelling losers at the moment of the first resolve. (This is the
  same decision as the cancellation-granularity question in the roadmap.)

### `debounce` / `throttle`

Rate-limit a step invocation. Useful at external-API boundaries.

- **Why someday:** every project eventually ends up with one of these
  hand-rolled in the calling step's `fn`.
- **User-land form today:** wrap the step's `fn` in a debounced closure.

### `cache` (in-memory)

A shorter-lived counterpart to `checkpoint` that never touches disk.

- **Why someday:** hot-path memoization within a single run.
- **User-land form today:** use `checkpoint` with a swap-in
  `checkpoint_store` backed by `new Map()`.

### `circuit_breaker`

Skip a flaky step for a cool-off window after N consecutive failures.

- **Why someday:** production-grade reliability for LLM-call-heavy flows.
- **User-land form today:** compose `retry` + `fallback` with a user-owned
  failure counter closed over by both. Awkward but possible.

### `batch` / `unbatch`

Group items into N-sized chunks, run `fn` per chunk, flatten results.

- **Why someday:** LLM providers cap per-request batch sizes; this reshapes
  `map` output on the way out. Shows up in evaluation harnesses.
- **User-land form today:** a user step that does the chunking before `map`
  and the flattening after.

### `poll_until`

Call a step repeatedly until a predicate holds or a deadline elapses.

- **Why someday:** long-running external operations that expose a
  "check status" endpoint (fine-tune jobs, deploy pipelines).
- **User-land form today:** `retry` with an `on_error` that inspects the
  state, or a loop inside a single `step` `fn`.

## Rejected

Considered and deliberately not promoted. Kept here so they are not
re-proposed without new evidence.

### `forkjoin`

Run `a` and `b` from the same input, pass both outputs to a `join(a_out,
b_out)` reducer — a two-child special case of `parallel` + `pipe`. The
user-land form, `pipe(parallel({ a, b }), ({ a, b }) => join(a, b))`, is three
lines and not awkward enough to justify a dedicated composer.

## Promoted

_None yet._
