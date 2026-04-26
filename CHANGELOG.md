# Changelog

## v0.1.13 — 2026-04-25

Initial public release. Fresh git baseline — prior internal commit history is intentionally not carried forward.

The v0.1.13 surface:

- Composition layer (`@robmclarty/fascicle` / internal `@repo/core`) — 16 primitives (`step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`/`stash`/`use`), `run`, `run.stream`, `describe`.
- AI engine layer (`@repo/engine`) — `create_engine(config)` returning a unified `generate` surface over seven Vercel AI SDK provider adapters: Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, and a `claude_cli` subprocess adapter that drives the Claude Code CLI.
- Adapter packages — `@repo/observability` (trajectory loggers), `@repo/stores` (checkpoint stores).
- Check pipeline — `pnpm check` / `pnpm check:all` orchestrate types, lint, struct (ast-grep), dead-code (fallow), tests, docs, spell, and opt-in mutation testing (Stryker).
