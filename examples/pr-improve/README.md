# pr-improve

Automated PR improvement pipeline. Triggered (eventually) by a `fascicle-improve` label on a GitHub PR; runs a 4-stage agent pipeline that reviews the diff, distills a pragmatic subset of changes, builds them in a new branch, and reviews the build before opening an improvement PR.

- [SPEC.md](./SPEC.md) — full design (4-stage pipeline, Fargate trigger, opt-in, decisions).
- [docs/architecture.md](./docs/architecture.md) — why `flow.ts` is pure fascicle composition, and the module split that keeps it that way.

## Status

**Phase A** (current): local end-to-end against a fixture diff with a stub engine. No GitHub, no webhook, no real model calls.

```sh
pnpm --filter @repo/example-pr-improve improve:stub
```

Phase B and Phase C scopes are described in `SPEC.md`.

## Provider portability proof

Every stage routes through the fascicle engine via `model_call`. Provider is selected by `FASCICLE_PROVIDER` env var (`anthropic` | `openrouter` | …). Acceptance criterion: the same fixture run with `FASCICLE_PROVIDER=openrouter` produces an end-to-end run with no code changes.
