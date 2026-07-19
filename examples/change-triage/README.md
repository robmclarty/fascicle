# change-triage

Release-risk triage for a change set: given a unified diff, produce a scored,
banded risk report. A worked example of the
[blueprint](../../docs/blueprint.md)'s hybrid pattern, distilled from a
production consumer: **deterministic detectors first, one schema-mode model
call second, and a floor the model cannot undercut**.

## What it shows

- **Deterministic + model hybrid.** Seven regex detectors run over every file
  for zero tokens and cannot hallucinate ([`signals.ts`](./src/signals.ts));
  the single `model_call` corroborates and extends them.
- **The score floor.** Hard signals (auth change, secret material, migration)
  impose a minimum score in code ([`floor.ts`](./src/floor.ts)), and the band
  is always derived from the floored score, so the report can never disagree
  with the evidence. Degraded trust in the model is expressed as data flow,
  not prompt pleading.
- **A privacy screen on the model's view.** Fixture/seed/snapshot content
  never reaches the model; detectors already scored it, and the report
  discloses every withheld path ([`screen.ts`](./src/screen.ts)).
- **Blueprint layout end to end**: one composition layer
  ([`flow.ts`](./src/flow.ts)) in fascicle vocabulary only, a markdown system
  prompt with frontmatter ([`src/prompts/assessor.md`](./src/prompts/assessor.md)),
  one `create_engine` site, scope-state casts quarantined in
  [`state.ts`](./src/state.ts), stub-engine tests through the real `run()`,
  and the blueprint's [ast-grep rules](./rules/) wired up.

## Run it

```sh
# no network: canned model response, real detectors + floor + report
pnpm --filter @repo/example-change-triage triage:stub

# real model call (one env var swaps the provider)
ANTHROPIC_API_KEY=... pnpm --filter @repo/example-change-triage triage -- --diff fixtures/risky.patch
FASCICLE_PROVIDER=ollama pnpm --filter @repo/example-change-triage triage -- --diff fixtures/risky.patch

# CI-style gate: nonzero exit when the band reaches the threshold
tsx src/main.ts --diff fixtures/risky.patch --fail-on high
```

Artifacts (report markdown, result JSON, trajectory JSONL) land under
`.runs/<run-id>/`.

## Extending it

The flow takes `{ label, diff }`; where the diff comes from is the shell's
business. To triage a pull request, resolve the diff with your forge's CLI in
`main.ts` (or a `services/` module) and pass it in unchanged. Delivery (a PR
comment, a check run, a label) belongs after `run` returns, keyed off the
typed `TriageReport`.
