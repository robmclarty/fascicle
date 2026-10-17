# Contributing

Fascicle is in an early, exploratory phase and I'm not accepting outside
contributions right now — I'm still figuring out the shape of the project
and want the freedom to make breaking changes without coordination.

Bug reports and feature ideas via GitHub Issues are welcome, but please
don't open pull requests; they'll be closed unmerged. This will likely
change as the project matures.

## Running tests

`pnpm check` runs the default fast set against mocked providers, so it never
touches the network; `pnpm check:all` adds mutation testing and the packaging
gate and is the final gate. A separate opt-in smoke suite under
`src/engine/__tests__/live/` exercises the real provider SDKs to catch
wire-format regressions the mocks cannot see. It is skipped unless
`LIVE_TESTS=1` and the matching API key are set:

```bash
LIVE_TESTS=1 ANTHROPIC_API_KEY=... pnpm exec vitest run src/engine/__tests__/live
```

Per-provider keys, each block skipped independently when its key is absent:

- `ANTHROPIC_API_KEY` for anthropic
- `GOOGLE_GENERATIVE_AI_API_KEY` for google
- `OPENAI_API_KEY` for openai
- `OPENROUTER_API_KEY` for the two Claude 5.5 cases, which reach
  `anthropic/claude-sonnet-5.5` on both Anthropic transports through
  OpenRouter's Anthropic-compatible endpoint

A second opt-in file, `live_reasoning.test.ts`, checks that reasoning survives a
tool loop. It runs a three-step loop on OpenRouter, and on Claude through
OpenRouter's Anthropic-compatible endpoint, and prints one line per case that
says whether the reasoning streamed and whether it came back with the next
request. You don't need any key but `OPENROUTER_API_KEY`. A case where the model
doesn't reason before a tool call skips itself, because it hasn't exercised
anything, and each response stream lands under `research/live/`, which git
ignores. Run it before you change the reasoning path and again after, so you
can compare what it prints:

```bash
LIVE_TESTS=1 OPENROUTER_API_KEY=... pnpm exec vitest run src/engine/__tests__/live/live_reasoning.test.ts
```

— Rob
