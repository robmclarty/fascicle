# Contributing

Fascicle is in an early, exploratory phase and I'm not accepting outside
contributions right now — I'm still figuring out the shape of the project
and want the freedom to make breaking changes without coordination.

Bug reports and feature ideas via GitHub Issues are welcome, but please
don't open pull requests; they'll be closed unmerged. This will likely
change as the project matures.

## Running tests

`pnpm check` runs the full suite against mocked providers, so it never touches
the network. A separate opt-in smoke suite under `packages/engine/test/live/`
exercises the real provider SDKs to catch wire-format regressions the mocks
cannot see. It is skipped unless `LIVE_TESTS=1` and the matching API key are
set:

```bash
LIVE_TESTS=1 ANTHROPIC_API_KEY=... pnpm exec vitest run packages/engine/test/live
```

Per-provider keys, each block skipped independently when its key is absent:

- `ANTHROPIC_API_KEY` for anthropic
- `GOOGLE_GENERATIVE_AI_API_KEY` for google
- `OPENAI_API_KEY` for openai

— Rob
