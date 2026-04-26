# TIL

Today-I-Learned snippets extracted from commit messages that pre-dated the open-source squash. Newest first. Each entry references the original commit hash and subject for context.

---

## Zod v4 ships `z.toJSONSchema(schema)` as a built-in
*2026-04-22 — c7d76ed `docs(ridgeline): tighten MCP spec for builder ambiguity`*

No need for `json-schema-to-zod` or `zod-to-json-schema` as a separate dependency.

---

## JS function `.name` is assigned from the enclosing property key for object-literal shorthand
*2026-04-22 — e91bfe8 `feat(core): include function name in describe output when available`*

`{ predicate: (r) => ... }` yields `predicate.name === 'predicate'` rather than an empty string.

---

## `git push origin vX.Y.Z` also sends the commit the tag points to
*2026-04-22 — b72521f `feat(version): tag release commits and push the tag`*

So the release commit reaches the remote even when the branch ref on origin hasn't moved yet.

---

## `git log --grep=` uses POSIX regex by default
*2026-04-22 — 67b4dbe `feat(version): have script resolve previous release boundary`*

`-E` switches it to extended regex so `+` and `|` behave as expected.

---

## Claude Code skill preflight `!` blocks substitute `$ARGUMENTS`
*2026-04-22 — ea173e4 `refactor(version): move bump + dirty-tree check into preflight`*

So a skill can hand the user's argument string to a backend script and consume its JSON before the LLM reasons about the task.

---

## `claude_cli` provider drops `Tool.execute` closures under the default `tool_bridge` allowlist_only mode
*2026-04-22 — 566a9d4 `docs(examples): add checkpoint, trajectory, tool_loop, structured_output`*

Execute tools need `anthropic` (or another provider) to actually run; `claude_cli` only forwards the names to the CLI built-in tools.

---

## The claude CLI under oauth needs `HOME` and `PATH` in its env to find the logged-in session
*2026-04-22 — 10e0ece `feat(engine): add engine defaults, oauth env inheritance, forward_standard_env helper`*

Which is why oauth-mode inherit is a sensible default and api_key mode can stay strict.

---

## `--experimental-strip-types` on Node 24 does not rewrite `.js` specifiers back to `.ts`
*2026-04-22 — 2685cdf `refactor(examples): hoist examples to root, route through @robmclarty/agent-kit`*

So `tsx` stays the right runner for examples under NodeNext resolution.

---

## Stryker's `incrementalFile` lets you commit the mutation-run cache
*2026-04-21 — 067a0b4 `feat(check): wire mutation testing into pnpm check`*

So CI and contributors share a warm baseline instead of paying the full run on every invocation.

---

## Stryker's sandbox copy strips the exec bit on fixture files
*2026-04-21 — 58b5a1e `refactor(workspace): publish-readiness phase 1 — @repo/* internal rename`*

A test-side `chmodSync(path, 0o755)` on the mock binary is needed before any spawn test runs.

---

## Zod 4 `z.array(z.unknown()).transform()` is the idiomatic way to filter per-entry invalid items
*2026-04-21 — caee3b5 `refactor(engine): validate claude_cli events with Zod, close coverage gaps`*

Without rejecting the whole array.

---

## Node 24 ships `process.loadEnvFile()` as stable
*2026-04-20 — e31f0e7 `feat(engine): prep for claude_cli subprocess provider`*

`.env` parsing is built in, and real `process.env` already takes precedence over file values without any third-party loader.

---

## A spec written before workspace layout and naming rules solidify can silently diverge from both
*2026-04-20 — a3a6b8b `docs(ridgeline): align ai engine spec with constraints and workspace layout`*

Worth an explicit audit pass before implementation begins.

---

## TypeScript value and type namespaces are separate
*2026-04-20 — cbd4e00 `refactor(core): rename types and interfaces to PascalCase per constraints rule`*

So the `step` factory function and the `Step` type can share the same identifier pair without collision.
