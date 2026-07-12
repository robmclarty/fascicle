# Harden anthropic_native.ts mutation coverage

**Phase:** frame
**Size:** medium (five steps: four region-hardening + a gate)

The direct follow-up to "Harden mutation coverage on the native provider + loop
surface" (5/5, 2026-07-11), which resolved its **Q2** by naming this file as its own
build. `anthropic_native.ts` is the native-transport exemplar and the single biggest
remaining mutation gap in the tree: 703 lines at **73.9%** killed, **145 survived /
37 no-coverage** — while its native siblings (`openai_compatible_native`,
`ollama_native`) now sit at ~96.5%. Same surface family, same C7 assertion debt, same
strategy that just worked four times.

## Frame

- **Problem:** `anthropic_native.ts` carries the tree's largest surviving-mutant
  cluster. From the fresh full-repo `.check/mutation.json` (2026-07-11, the gate the
  predecessor build left green): 512 killed + 2 timeout of 696 = **73.9%**, with 145
  survivors and 37 no-coverage. The survivor shape is the same one the sibling files
  had: `ConditionalExpression` (91), `StringLiteral` (30), `EqualityOperator` (18),
  `LogicalOperator` (18) — branch boundaries and exact wire strings no assertion pins
  — plus no-coverage clusters in the empty-content, streaming-error, and
  adapter-wiring paths. It survives the gate only because `thresholds.break` is 82
  (aggregate ~85.2%), so a file at 74% never trips it.
- **Smallest thing that solves it:** Add C7-style concrete-value assertions to the
  colocated `__tests__/` (`anthropic_native.test.ts`, `anthropic_native_e2e.test.ts`),
  region by region, killing every killable survivor and eliminating no-coverage;
  annotate the genuine equivalents inline. No source behavior change. This is exactly
  the D2 playbook that took the four sibling files to 93-100%.
- **Done looks like:** Each of the four regions reaches zero no-coverage and every
  residual survivor is either killed or carries an inline equivalence rationale
  (target ≥90% killed, the ~96.5% sibling bar); `pnpm check:all` (incl. mutation)
  exits 0; a before/after per-region table and the equivalents list land in the build
  log; `thresholds.break` is ratcheted up if the new aggregate gives headroom (never
  down, D5).
- **Explicitly NOT doing:**
  - The shared-giant loop-knob survivors (`turn_timeout_ms` in `generate.ts`,
    `prepare_step` in `tool_loop.ts`) — the predecessor's **Q1**, still its own build.
  - The `ai_sdk` Anthropic adapter (`providers/ai_sdk/anthropic.ts` /
    `anthropic.test.ts`) — different transport, different surface.
  - Non-native gaps (`core/runner.ts`, `composites/*`, `claude_cli/*`).
  - Gaming the metric: no blanket `Stryker disable`, no lowering `thresholds.break`,
    no loosening the `mutate` globs.
  - Refactoring source to be mutation-friendly, beyond a trivially-correct
    simplification that deletes a genuinely-equivalent (dead/defensive) branch.

## Architecture sketch

Not architecture — the baseline and the region split the survivors imply. The file is
one adapter with clean functional regions; the survivors cluster by region, so each
step is a contiguous slice reviewable in one pass.

```text
Region (lines)                                   funcs                         surv  nocov  step
  request + message mapping (51-229)             thinking budgets,             ~20    5     1
                                                 to_user/assistant_blocks,
                                                 to_anthropic_messages/tools,
                                                 build_messages_body
  response + usage/stop maps (231-314)           map_stop_reason, map_usage,   ~11    0     2
                                                 parse_messages_response
  streaming aggregator (315-530)                 stream_event_error,           ~24    5     3
                                                 read_block_index,
                                                 create_stream_aggregator
  error-classify + SSE-drain + adapter (532-703) extract_error_message,        ~16    7     4
                                                 response_error, rethrow_*,
                                                 consume_sse_response, adapter

Survivor shape → assertion strategy (same as the sibling build):
  ConditionalExpression / EqualityOperator / LogicalOperator → assert BOTH boundaries
     (thinking-vs-sampling-vs-passthrough precedence, stop_reason/usage maps,
      status classification 401/429/5xx, empty-content trim branches)
  StringLiteral → assert EXACT wire strings
     (x-api-key / anthropic-version headers, /messages path, error-type→status,
      capability-error codes, thinking {type:'enabled'} block)
  NoCoverage → execute the untested path
     (empty user/assistant content 88-113, malformed tool_use + invalid-JSON stream
      throws 386/395/475, empty/oversized error bodies 534/547, null stream body 607,
      next_bytes network catch 620, tail flush 644, empty api_key 664)
```

Per-region inner loop: `pnpm exec stryker run --mutate
'src/engine/providers/anthropic_native.ts'` (incremental keeps it fast), then re-parse
`.check/mutation.json` for the region's killed/survived/no-coverage. `pnpm check`
(excludes mutation) for test-authoring iterations; `pnpm check:all` once at the end
(C1). Process notes carried from the sibling build's mutation-landscape ledger: a
failing test aborts Stryker's dry run so a scoped score reads STALE — confirm `vitest`
is green before trusting a number; and the `--mutate` CLI override re-mutates test
files, so ignore `__tests__` rows in scoped runs.

## Decisions

- D1: Scope to `anthropic_native.ts` alone, split into four contiguous regions plus a
  gate — *because* the predecessor build already carved this off as Q2, one file keeps
  the diff reviewable, and the regions are the natural seams (each a distinct wire
  concern: request-out, response-in, stream, errors).
- D2: Kill with concrete-value assertions in the colocated `__tests__/`; document true
  equivalents inline with `// Stryker disable next-line <mutator>: <reason>` — *because*
  config excludes and blanket disables defeat the purpose; the just-set sibling bar
  (openai/ollama native ~96.5%, one annotated equivalent between them) is the target,
  not 100%.
- D3: No-coverage mutants are the priority within each region — *because* they are code
  paths with zero test execution (the highest-value kills), and here they sit in the
  empty-content, malformed-block, and drain-lifecycle paths where wire bugs hide.
- D4: "Done" per step is **zero no-coverage in the region + every residual survivor
  killed or annotated equivalent** (target ≥90% killed) — *because* a bare % floor
  collides with unkillable equivalents; the annotation makes the verify unambiguous.
- D5: At the gate, re-run the full mutation, record the before/after, and ratchet
  `thresholds.break` upward only if the new aggregate leaves headroom (never down) —
  *because* the config comment says to; killing ~145 survivors on a 696-denom file
  lifts the ~10360-denom aggregate ~1.4pts (~85.2%→~86.6%), which likely supports 82→83
  with the same ~3pt headroom, but the exact number is a step-5 read of the real delta.
- D6: Use `toStrictEqual` (not `toEqual`) for the present-only-when-defined keys —
  usage `cached_input_tokens`/`cache_write_tokens`, tool_call `input`, the
  `responseHeaders` object — *because* vitest `toEqual` ignores `key: undefined` and
  will not kill the mutants that add or drop an optional key (a known trap from the
  mutation-landscape ledger).

## Constraints

- C1: `pnpm check:all` (incl. mutation) exits 0 at the final gate; `pnpm check` for
  inner iteration; `pnpm exec stryker run --mutate '<file>'` for per-region loops.
- C2: Tests only. Source behavior is unchanged and no public surface moves; the sole
  source latitude is D2's equivalence annotations and a trivially-correct dead-branch
  deletion. No new runtime dependencies.
- C3: No metric gaming — no blanket `Stryker disable`, no lowering the break threshold,
  no loosening the `mutate` globs (D2).
- C4: No live network; recorded fixtures / hand-authored SSE + JSON payloads only. The
  e2e suite already drives a mocked `fetch`; new stream cases author raw SSE frames.
- C5: Scope is `src/engine/providers/anthropic_native.ts`, its colocated
  `src/engine/providers/__tests__/anthropic_native.test.ts` and
  `anthropic_native_e2e.test.ts`, and `stryker.config.mjs` (threshold ratchet only).
  Every other file is untouched.

## Steps

1. [x] Harden the request + message-mapping region (51-229) — **done when:** the
   region has zero no-coverage and every residual survivor is killed or annotated
   (target ≥90%): `ANTHROPIC_THINKING_BUDGETS` exact values, `to_user_blocks` /
   `to_assistant_blocks` empty-trim and image-capability-error branches, the
   role-merge and mid-conversation-system throw in `to_anthropic_messages`, and
   `build_messages_body`'s max_tokens default, thinking-vs-sampling-vs-passthrough
   precedence, and `system`/`tools`/`stream` inclusion are each asserted at both
   boundaries with exact wire values
   - seam: `src/engine/providers/__tests__/anthropic_native.test.ts`, `src/engine/providers/anthropic_native.ts`
   - model: opus — the thinking/sampling/passthrough precedence matrix and the exact wire body are the judgment
2. [x] Harden the response + usage/stop maps (231-314) — **done when:** zero
   no-coverage and residual survivors annotated (target ≥90%): `map_anthropic_stop_reason`
   asserts every case arm (tool_use→tool_calls, max_tokens/model_context_window_exceeded→length,
   refusal→content_filter, default→stop), `map_anthropic_usage` pins the cache-inclusive
   input sum and the present-only-when-defined cache keys (D6), and
   `parse_messages_response` asserts text/tool_use extraction plus the malformed-block
   throw
   - seam: `src/engine/providers/__tests__/anthropic_native.test.ts`, `src/engine/providers/anthropic_native.ts`
   - model: sonnet — exact-value switch tables and usage math; mechanical apart from the D6 present-when-defined assertions
3. [ ] Harden the streaming aggregator (315-530) — **done when:** zero no-coverage and
   residual survivors annotated (target ≥90%): `stream_event_error` error-type→status
   map (overloaded_error→529, api_error→500, rate_limit_error→429, else provider_error),
   `read_block_index` throw, and `create_stream_aggregator`'s event state machine
   (text/tool_use/thinking block start-delta-stop, `input_json_delta` parse-at-stop,
   `merge_usage` overlay, `message_stop` step_finish, and `complete()`'s
   truncated-stream throw) are asserted against a dispatch spy with the streamed
   TurnResult proven equal to the non-streamed one
   - seam: `src/engine/providers/__tests__/anthropic_native.test.ts`, `src/engine/providers/anthropic_native.ts`
   - model: opus — the SSE event state machine and synthetic-payload reconstruction are the subtle part
4. [ ] Harden error-classification + SSE-drain + adapter (532-703) — **done when:**
   zero no-coverage and residual survivors annotated (target ≥90%):
   `extract_error_message` (empty/oversized/non-JSON branches), `response_error`
   (401→auth, 429/5xx→status+retry-after, else permanent), `rethrow_network_failure`
   (abort passthrough vs network-wrap), `consume_sse_response` (null-body throw,
   next_bytes network catch, reader-cancel, tail flush), the `SUPPORTED` capability
   set, and `create_anthropic_native_adapter` (empty-api_key throw, base_url default +
   trailing-slash strip, exact request headers/path, stream-vs-json branch) are each
   asserted concretely
   - seam: `src/engine/providers/__tests__/anthropic_native_e2e.test.ts`, `src/engine/providers/__tests__/anthropic_native.test.ts`, `src/engine/providers/anthropic_native.ts`
   - model: opus — network/error classification and the drain lifecycle (cancel, tail flush, abort vs network) are the subtle part
5. [ ] Final gate + ratchet — **done when:** `pnpm check:all` (incl. mutation) exits 0,
   a before/after per-region mutation-score table and the equivalents list are recorded
   in the build log, and `thresholds.break` is ratcheted up to the new aggregate minus
   headroom if the delta supports it (never down, D5)
   - seam: `stryker.config.mjs`, `.plumbbob/`
   - model: opus — reading the mutation delta and choosing the ratchet is the judgment

## Open questions

- Q1: Does the streamed-vs-non-streamed equality (C4-style, step 3) want a shared
  property-style assertion helper, or is a hand-authored SSE fixture per case enough?
  *Resolve by:* decide in step 3 once the first stream case is written; default to
  hand-authored fixtures (the e2e suite's existing pattern).
- Q2: After the kills, does the aggregate lift actually clear 82→83, or is the headroom
  too thin? *Resolve by:* step 5 reads the real full-repo delta; ratchet only if the
  new aggregate leaves the established ~3pt cushion.

## Verdicts

*(Filled in as spikes and forks resolve — the audit trail of "these were my calls.")*
