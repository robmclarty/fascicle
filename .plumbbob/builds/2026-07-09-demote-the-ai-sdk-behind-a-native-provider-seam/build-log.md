<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — Demote the AI SDK behind a native provider seam

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
- [x] Native transport provider_options passthrough: TurnRequest.provider_options reaches invoke_turn but anthropic_native does not read it yet. Precedence vs engine-computed body fields and camelCase (ai_sdk-style) vs snake_case (wire) keys are undefined in S-P3; decide once before P4.2 native OpenAI faces the same question.
- [x] Barrel exports for native custom providers: NativeProviderAdapter, TurnRequest, TurnResult (and ProviderTransport) are not exported from the engine barrel / fascicle top level, so a consumer writing a kind:'native' custom provider relies on contextual typing through ProviderFactory. Docs (step 15) document the contextual-typing path; decide whether to export the named types.

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

- 2026-07-10 (post step 15) — provider_options passthrough: proposed tangent
  (defer to the native-OpenAI intent); human overrode to implement now. Folded
  into the plan as step 17, which fixes the convention: wire-format snake_case
  keys, shallow-merged last, explicit user key beats every engine-derived field.
- 2026-07-10 (post step 15) — barrel exports for native custom providers:
  proposed tangent (defer); human overrode to implement now. Folded into the
  plan as step 16 (type-only exports of NativeProviderAdapter, ProviderTransport,
  TurnRequest, TurnResult plus the docs touch-up).

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-10 — step 1 checkpointed · 8ab8848b4 — Dev-dependency sweep (V-P1.1..P1.4: vitest, oxlint, tsdown, zod, cspell,
- 2026-07-10 — step 2 checkpointed · 74302d994 — Lint-tool catch-up + sweep fallout (oxlint 1.60→1.73, oxlint-tsgolint
- 2026-07-10 — step 3 checkpointed · 9c7a86f35 — Agent-layer boundary ADR (V-P2.1..P2.2)
- 2026-07-10 — step 4 checkpointed · 36ad674c8 — v7 core bump + codemod + rename reconciliation (V-P3.1..P3.3: `ai@^7` and
- 2026-07-10 — step 5 checkpointed · 3208ac72c — v7 usage + stream-shape review (V-P3.4..P3.7: per-provider
- 2026-07-10 — step 6 checkpointed · 9ec197bb0 — v7 live smoke + release (V-P3.8..P3.9)
- 2026-07-10 — step 7 checkpointed · f9a2dc817 — Open the registry (S-P1.1..P1.4: `custom_providers` on `EngineConfig`,
- 2026-07-10 — step 8 checkpointed · 20db92fc9 — Neutral turn types + shared error classifier (S-P2.1..P2.3:
- 2026-07-11 — step 9 checkpointed · aee2ed45e — Three-way dispatch (S-P2.4..P2.6: extract `build_ai_sdk_invoke`, add
- 2026-07-11 — step 10 checkpointed · 8d6f17fad — Loop-inheritance proof (S-P2.7)
- 2026-07-11 — step 11 checkpointed · 02d8cb730 — Rename `subprocess` to `external` (S-P4.1)
- 2026-07-11 — step 12 checkpointed · da4e99ab1 — Native Anthropic: mapping, non-stream, auth (S-P3.1..P3.3, S-P3.5:
- 2026-07-11 — step 13 checkpointed · c045b2cb3 — Native Anthropic: streaming, capabilities, e2e (S-P3.4, S-P3.6..P3.7:
- 2026-07-11 — step 14 checkpointed · 10468f26e — Invert the seam (S-P4.4, committed per D8)
- 2026-07-11 — step 15 checkpointed · ab68fe6d8 — Docs sweep (S-§6.5)
- 2026-07-11 — step 16 checkpointed · 8b3f37a8e — Export the native provider contract from the barrel
- 2026-07-11 — step 17 checkpointed · 9f6e6fda5 — Native transport `provider_options` passthrough
