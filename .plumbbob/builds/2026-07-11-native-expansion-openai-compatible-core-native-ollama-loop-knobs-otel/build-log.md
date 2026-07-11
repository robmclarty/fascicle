<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — Native expansion: OpenAI-compatible core, native Ollama, loop knobs, otel

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status. Only ONE step is in flight. A step
is done only after a checkpoint — check green + checkpoint taken, via `/pb-verify` or
`/pb-build`.)*

- ☐ 1. <step>

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/pb-park` composes it). Harvest happens only at the boundary.

## Harvest  *(run `/pb-harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                          |
|------------------|-------------------------------------------|---------------------------------|
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/pb-revert`, fold into intent  |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.    |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.      |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- (none yet)

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-11 — step 1 checkpointed · d8da9cd0c — OpenAI-compatible core: mapping, non-stream, auth (25m)
- 2026-07-11 — step 2 checkpointed · f36982faf — OpenAI-compatible core: streaming + e2e (1 drift, 23m)
- 2026-07-11 — step 3 checkpointed · c2be71483 — Wire `openai` native (8m)
- 2026-07-11 — step 4 checkpointed · fb335302e — Wire `openrouter` + `lmstudio` native (+ compat recipe) (11m)
- 2026-07-11 — step 5 checkpointed · 1179e1296 — Native Ollama on `/api/chat` (1 drift, 18m)
- 2026-07-11 — step 6 checkpointed · 0a1c100d9 — Transport parity golden tests + OpenRouter live smoke (24m)
- 2026-07-11 — step 7 checkpointed · 24c68d301 — Turn timeout budgets + V-Phase 5 verdicts (1 drift, 26m)
- 2026-07-11 — step 8 checkpointed · ef6d11e5c — `prepare_step` loop hook (13m)
- 2026-07-11 — step 9 checkpointed · 526e8db73 — Otel: trajectory bridge + ai_sdk telemetry + ADR amendment (1 drift, 39m)
- 2026-07-11 — step 10 checkpointed · a53872cf0 — `with_providers` derivation (1 drift, 11m)
- 2026-07-11 — step 11 checkpointed · 74a342a5a — Barrel exports + docs sweep (1 drift, 18m)
- 2026-07-11 — step 12 live smoke matrix (`examples/live_smoke.ts`, tool loop, streamed + non-streamed):
    - openrouter native (openai/gpt-4o-mini) — **PASS** both modes; usage 179/26, cost $0.000042 (pricing key hit), SSE delta accumulation observed (`tool_call_input_delta` chunks).
    - ollama native `/api/chat` (qwen3-datum:latest, local daemon) — **PASS** both modes; usage 394/33, free-provider zero-cost estimate (D10), NDJSON stream chunks intact.
    - lmstudio native — **NOT RUN**; daemon at http://localhost:1234/v1 unreachable (no LM Studio server on this host).
    - Verdict: all available backends green; the one unavailable backend recorded not-run per C5.
