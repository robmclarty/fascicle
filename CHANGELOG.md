# Changelog

## v0.12.3 — 2026-08-19

### Changed

- **Every id in a flow is a JavaScript identifier now.** Ids are read back as property names, because a `chain` binding merges its result into the growing record under its own name, and a binding you cannot destructure is one the record cannot offer. That constraint used to be emergent and unenforced, so `chain.step('user id', ...)` quietly cost you shorthand destructuring while `step('user id', ...)` beside it looked like it worked. `step`, `chain.step`, `chain`'s input name, and `define_agent` now hold ids to one rule and throw at construction when it is broken, naming both the spelling they would have picked and where the prose belongs instead. Nothing normalizes an id on your behalf, because a silent rewrite maps `my-id`, `my.id`, and `my id` onto a single key and would have to stay bug-for-bug in sync with the equivalent type-level rewrite. Generated ids moved to satisfy the same rule: a `model_call` without an explicit id reads `model_call_<hash>_<n>` rather than `model_call:<hash>:<n>`, and `loop` no longer folds its display name into its id, which is `loop_<n>` unconditionally. Code that parses either shape needs updating.

- **`compose` takes its config last, like everything else.** `compose(name, inner)` was the last positional-name holdout in the API, and its one string did two jobs, because it was the display label and the id prefix at once, so renaming a composite for readability moved its trajectory id. The form is `compose(inner, { name })` now, matching `sequence`, `parallel`, `pipe`, and the rest, and the id is `compose_<n>` with the label living only in `config.display_name`. The type is `ComposeConfig` rather than `ComposeOptions`, because the argument is required, which is the rule the rest of the composition layer already followed and AGENTS.md now states. The trade is that a composite that used to surface as `judge_llm_3` in an `error_path` surfaces as `compose_3`, with `judge_llm` still its span label. Set `id:` on the `model_call` inside it when a path has to name the role.

- **`StepMetadata.display_name` is `name`, and it finally does something.** The field had been declared since the type landed and nothing in `src/` ever read it, so a step carried a display channel on paper and none in practice, which is why step ids kept getting written for human eyes and then resisted becoming checkpoint keys. Every consumer that renders a step for a human now resolves the same order through `resolve_display_name`: `config.display_name` first, then `meta.name`, then the step's kind. `describe.json` echoes `meta` verbatim, so the key it emits changed with the field.

- **Six adapter and viewer types are named `Config` now.** A factory's trailing argument is named for whether you can drop it. It is `XConfig` when the argument is required and `XOptions` when it can be omitted, which is a rule `src/core` and `src/composites` had followed everywhere without anyone writing it down. The adapters and the viewer had not. `FilesystemLoggerOptions`, `FilesystemStoreOptions`, `HttpLoggerOptions`, `BroadcasterOptions`, `ServerOptions`, and `TailOptions` each take a required argument that carries required fields, so all six end in `Config` now, and the parameter each factory takes is `config` rather than `options`. AGENTS.md states the rule. `GenerateOptions` and `EngineConfig` keep the names they have, because the required-argument test and the required-field test disagree on both and neither name reads wrong.

- **Error messages name the remedy and carry the value.** Nineteen runtime messages were rewritten against the one already in the tree that got it right, `no provider specified: pass ... (configured: anthropic, ollama)`, which states the symptom, the fix, and the state the caller needs. Six numeric-bound errors stated a constraint and swallowed the input, so `turn_timeout_ms must be > 0` now reports what it got, matching the `retry: max_attempts ... got X` shape that already existed. `engine_disposed_error`, the `checkpoint` and `gate` anonymous-step guards, tool approval with no handler, and the `claude_cli` execute-closure rejection each name what to do next. Nothing about the errors' types, `kind` discriminants, or thrown classes moved; code that matches on an error's message text rather than its `kind` will need updating, which is the reason `kind` exists.

- **`provider_not_configured_error` reports what the engine can route to.** The error meaning "you named a provider this engine has no adapter for" withheld the list you would check the name against. It now takes the configured names as an optional second constructor argument, exposes them as a readonly `configured` array, and prints them, exactly as its sibling `provider_required_error` already did.

- **`fascicle-viewer` prefixes every line it writes.** Five of its eight stderr lines carried a `fascicle-viewer:` prefix and three did not, so `watching <path>` and `viewer at <url>` were anonymous in a terminal running more than one thing, while `shutting down` beside them was labelled. All of them carry it now, and a bad `--port` or `--buffer` says what a valid value looks like instead of only echoing the rejected one.

### Added

- **A display label on chain bindings and on agents.** `chain.step(name, fn, { name })` and its arm form `chain.step(name, arm, select, { name })` label the binding's span and its `describe` line without touching the record key, which is the same split `step(id, fn, { name })` gives a plain step. `define_agent` gained `config.id` beside `config.name`, so an agent whose frontmatter reads `name: Change Triage` keeps that prose as its label and takes `id: 'change_triage'` as its identity. The `agent.call` event carries both now, since the two can differ and a consumer holding only the name could not join back to the span.

- **The identifier rule and the label rule are exported.** `is_valid_step_id`, `suggest_step_id`, and `assert_valid_step_id` come out of `fascicle`, so a harness that mints ids of its own can hold them to the same rule the factories use, and can reuse the message shape rather than inventing a second one. `resolve_display_name` is exported beside them for anything that renders a step tree and wants the label a span would have opened under.

- **The `security` slot gates the check suite.** `pnpm audit --audit-level=high` had sat outside the loop since the checkride config landed, as a `check:security` script nothing ran, so a new high advisory reached a release without failing anything. The slot is now in the default set, which is what CI runs, and clearing it took one devDependency bump (`markdownlint-cli2` 0.23.2, whose pinned `js-yaml` is patched), a `vite ^8.0.16` override for the `server.fs.deny` bypass under vitest, and a lockfile re-resolution that carried the other twelve advisories across. `check:security` is now `checkride --only security`, so the gate has one implementation rather than two that can disagree. Nothing in the published package changed: every advisory was dev-tree only, and `dependencies` is still empty.

- **The `prose` slot: how the words read is checked now.** The gate covered types, structure, dead code, spelling, and markdown lint, and nothing looked at the writing. Vale runs over markdown and TypeScript doc comments with rules the repo owns outright, copied in rather than installed, so disagreeing with one means editing it. `.vale/exemplars/` holds seven excerpts of the author's own published writing, verbatim and nothing later than 2022, so no sample can have been shaped by a model, and an `exemplars` check fails on any diff to them. `scripts/prose-health.mjs` measures the thing vale cannot see, which is a whole file drifting compressed, and ratchets each file against its own past rather than against a target.

- **Two prose rules that reach string literals.** Vale maps `ts = js`, which lints doc comments and leaves the code alone, so no user-facing message in this package had ever been checked against a house rule. `rules/no-latin-abbrev-in-strings.yml` and `rules/no-em-dash-pair-in-strings.yml` mirror the vale rules of the same name into ast-grep, run in the `struct` slot, and cover `src`, `test`, and `examples`. Message *shape* stays a matter of judgment and gets no rule, because "does this name a remedy" is not something a matcher can decide.

### Fixed

- **The docs printed a peer-dependency error the package does not emit.** `providers.md` twice and `troubleshooting.md` once showed `missing peer dependency 'X'. Install it with: pnpm add X`, while the code has long said `Install it with your package manager, e.g., ... or npm install X`. The docs now quote the message as thrown.

- **The `fascicle-viewer` help and the doc that documents it disagreed.** `--buffer <n>` sat one space short of the four flags beside it, and `docs/viewer.md` had the same block correctly aligned. The usage example in the CLI's own header comment was misaligned in the other direction.

- **Comments and markdown that describe a layout this repo left behind.** Four doc comments narrated design history rather than present behavior, three named a contract test, a provider option, and source paths that do not exist, and `src/core/BACKLOG.md` still carried the `@repo/core` package name from the workspace v0.8.0 collapsed into one. The `claude_cli` test README listed 9 of its 14 test files, promised a `grep` that finds all 31 spec items when it finds 22, and documented a `RUN_E2E=1` gate that appears nowhere else in the repo. The amplify example's layout tree advertised a `src/state.ts` that the app deliberately does not have, its flow being built on `chain` bindings.

### Internal

- **`docs/` was moved toward the voice in the exemplars.** A sweep across every page restored the relative clauses a compression pass had eaten, split the sentences doing too much, and put the doc comments back in the present tense. Headings went to Chicago Title Case, 232 of them, chosen over AP because AP accepts "Where to Put the Harness" and rejects "Where to Go Next", a distinction no writer can predict. A `HeadingCase` rule holds the line.

- **The three site pages were rewritten.** `site/*.html` is the one body of hand-written prose here that nothing gates, because vale is scoped to markdown and TypeScript and the prose-health corpus is `docs/` plus the top-level markdown. Extracting the text nodes and running both tools over them turned up eleven error-level violations that would have failed the `prose` slot anywhere else. The hero pitch leads with the claim rather than the mechanism now, and the primitive groups are separated.

- **The `claude_cli` spec items are all tagged.** The README promised that `grep -R '§12 #'` finds every one of the 31 items and it found 22. Tagging the missing nine restored the claim, and turned up two existing tags that pointed at the wrong item.

## v0.12.1 — 2026-08-18

### Added

- **The `gate` composite: paid work survives an approval pause.** `gate(inner, { id, store?, format?, name? })` runs `inner`, checkpoints its result under `gate:<id>`, then suspends with that result as the payload, so the approver sees what they are approving. Resuming passes the inner result through unchanged, and a fresh run after a process restart with the same store replays from the checkpoint instead of paying for the model call again. Built from public primitives only, so it renders as one composite node in `describe`; reach for raw `checkpoint` plus `suspend` when the decision must shape the output.

- **`chain` states its input type once.** `chain('question').input<Request>()` replaces `chain<Request, 'question'>('question')`; the refinement is available only on a freshly opened chain, before the first binding.

- **Arm-first chain bindings.** `.step(name, arm, select)` takes a composed `Step` and a selector from the record to the arm's input: the chain dispatches the arm and records it as the binding's describe child in one statement, so the run tree and the described tree cannot drift apart. The `fn` plus `{ arm }` form remains for bodies that invoke an arm conditionally, in a loop, or more than once.

- **Scripted and sequenced test doubles.** `make_script_engine(responses, options?)` plays a strict call-order queue whose entries are plain content values or `{ content?, tool_calls?, finish_reason?, usage?, throw? }`, so a converging loop, a tool-call path, or a provider error can be scripted without hand-rolling an engine; a `make_stub_engine` response's `content` may now be a function of the call and its per-route index. `text_of(opts)` reads the user-visible prompt out of a captured `GenerateOptions` whatever its shape, and `engine_from_generate(generate)`, the shell both factories are built on, is now exported for custom doubles. `docs/testing.md` is the new guide.

- **Caller-shaped generation knobs everywhere they were missing.** `temperature`, `max_tokens`, `top_p`, `turn_timeout_ms`, and `prepare_step` ride on `ModelCallConfig` (and so on `model_step`); the three sampling knobs also work as `EngineDefaults`, with the per-call value winning. `define_agent` accepts `provider`, `effort`, `temperature`, `max_tokens`, and `top_p` through both markdown frontmatter and code config, code winning over frontmatter and frontmatter over the engine default. Previously the only route to a temperature was frontmatter or dropping to `engine.generate` inside a step body.

- **Terminal and checkpoint trajectory events.** Every run now ends with `run_end` carrying `status: 'done' | 'failed' | 'aborted' | 'suspended'`, so a consumer no longer infers a failed run from silence, and a failing span records `error_name`, `error_kind`, and `error_path` alongside the message. Checkpoint lookups emit `checkpoint` with `status: 'hit' | 'miss' | 'read_error'`; a store that throws still degrades to a miss, but visibly. Guards: `is_run_end_event`, `is_checkpoint_event`.

- **`run.until_suspended` outcomes carry their `payload`.** A driver loop can render what is awaiting approval without threading a side channel out of the `on` callback.

- **A bare predicate as a `loop` guard.** `guard: (state) => boolean`, or a promise of one, no longer needs wrapping in a step that returns `{ stop, state }`.

- **Every type a public signature names.** The composer configs (`SequenceOptions`, `ParallelOptions`, `BranchConfig`, `MapConfig`, `PipeOptions`, `RetryConfig`, `FallbackOptions`, `TimeoutOptions`, `CheckpointConfig`, `SuspendConfig`, `ScopeOptions`, `StashOptions`, `UseOptions`, `GateConfig`), the run vocabulary (`RunOptions`, `StreamingRunHandle`, `StepFn`, `CleanupFn`), the schema vocabulary (`ToolSchema`, `AnySchema`, `SchemaIssue`), `ClaudeCliErrorReason`, and the extractors `StepInput<s>` / `StepOutput<s>` are exported now, and `is_step` joins `is_step_kind` at runtime. Writing the wrapper factories the blueprint teaches no longer requires `Parameters<typeof run>[2]`.

- **A typed error path.** Every Fascicle error class declares `path`, and `error_path(err)` reads it off any thrown value, including a foreign error the runner tagged on its way out. The documented diagnostic previously required a cast.

- **CommonJS consumers can `require()` the package.** Each export entry gained a `default` condition pointing at the same ESM file, so Node's native `require(esm)` resolves it on the supported Node 24 floor. No CJS build, no second artifact.

### Changed

- **Provider resolution no longer falls back to `anthropic`.** With several providers configured and neither a per-call `provider` nor `defaults.provider`, `generate` throws the new `provider_required_error` naming what is configured, instead of quietly sending the call to Anthropic. Per-call choice, engine default, and sole-provider inference are unchanged. **Breaking**, and deliberately so for a provider-agnostic library: a multi-provider engine that leaned on the implicit default now has to say which one it meant.

- **A misspelled provider name is reported at construction.** A provider key matching no built-in and no custom adapter throws `engine_config_error` with `unknown provider '<name>'; built-in providers are: ...`, rather than claiming it is not configured on the engine that just declared it. The call-time `provider_not_configured_error` keeps its own meaning.

- **`chain`'s input type parameter defaults to `never`.** An unannotated `chain()` used to produce a spine that accepted anything at `run`; the omission now fails at the `run` call site. **Breaking** for chains that leaned on the inferred `unknown`: state the type with `chain<Input>()` or `chain('name').input<Input>()`. Every call site in this repo already annotated, so the sweep changed none of them.

- **The viewer moved to the `fascicle/viewer` subpath.** `start_viewer`, `run_viewer_cli`, `StartViewerOptions`, and `ViewerHandle` are no longer re-exported from the package root. **Breaking**, one import line. The subpath also publishes `create_broadcaster`, `start_server`, and `start_tail`, which existed in the barrel but could not be reached from the published surface. The `fascicle-viewer` bin is unaffected.

- **`sequence` type checking.** Runtime-built homogeneous arrays infer as `Step<T, T>` through a new overload instead of degrading to `Step<unknown, unknown>` (which let `run(seq, wrong_type)` compile), a sound spread inside a literal tuple no longer false-positives, and a joint mismatch resolves to a branded `SequenceJointMismatch<At, Expected, Got>`, so the first line of the error names the position and the two types instead of two lines about optional properties.

- **Anonymous step ids are `step_<n>`** (previously `anon_<n>`), and a `model_call` without an explicit `id` mixes in an instance counter, so two identical leaves are distinguishable in `describe` and the trajectory.

- **`describe` shows the model call's knobs.** Temperature, token cap, `top_p`, and turn timeout appear by value when set, with `has_prepare_step` alongside the existing flags.

### Fixed

- **`fallback` no longer discards the primary error.** When the backup also fails, the primary error rides along as the backup error's `cause`, so the interesting failure, why the fallback happened at all, survives to the catch site.

- **`retry` rejects a non-finite `max_attempts` at construction.** A `NaN`, easy to produce from arithmetic on a missing config field, previously ran zero attempts and rejected with a literal `undefined`: no message, no stack.

- **`model_call` names a missing engine.** Constructing without one threw `Cannot read properties of undefined (reading 'generate')` at dispatch; it now throws a `TypeError` at construction saying which option is missing and where an `Engine` comes from.

- **The stub engine reports what failed a schema.** It surfaces the validation issues and throws the real `schema_validation_error`, so a test can exercise the same handling production takes; it previously computed the issues, dropped them, and threw a bare `Error`.

- **Docs no longer teach a model id that 404s.** Every family shorthand (`sonnet`, `opus`, `haiku`) on an API transport became a concrete id, since the engine sends `model` verbatim and only `claude_cli` resolves bare tokens; the README tour and the first-run examples were the worst of it. Several recipes moved to local Ollama and other open models. A compile-only snippet gate cannot catch a wrong id, which is how these survived.

- **The cookbook's multi-provider fallback recipe routes to two providers.** Neither `model_step` set `provider`, so both calls, including the one asking for `gpt-4o`, resolved to the same adapter.

- **`docs/composition.md` is the composition guide again.** It was an old module README, still titled `# core`, ending in a stray closing tag that rendered on GitHub, with a public-surface table missing a dozen exports.

- **The stale concurrency caveat is gone.** Six documents warned that bundled span stacks attribute concurrent children to the wrong parent; the loggers have used the runner-threaded `parent_span_id` for a while, and the roadmap already claimed the fixed behavior. The synchronous-write caveat on `filesystem_logger` is real and stays.

- **Standard Schema is documented as such.** The reference printed `schema?: z.ZodType<t>` and said "a zod schema" in four places, while the contract is any Standard Schema; an ArkType or Valibot user reading it would conclude the headline feature did not exist.

- **A viewer regression test that never ran.** Its path to the built bundle carried an extra `..` from the old workspace layout, so it resolved above the repository root and skipped silently.

### Internal

- `markdownlint` and `cspell` no longer ignore `docs/**`. That gap is how the stray tag and the stale claims survived every release; the twelve lint errors and forty-eight spelling flags it surfaced are fixed.
- The build's bundle invariants walk the root entry's static closure instead of grepping `dist/index.js`, so hoisting the engine into a shared chunk, which the testing subpath's value import now causes, no longer quietly stops the lazy `ai` seam from being checked. `fascicle/ui` is out of scope by design, since it imports `ai` on purpose.
- Getting-started gained a run scaffold (`"type": "module"`, Node 24, `tsx`), the keyless stub-engine path is advertised where a newcomer will see it, and the examples index marks which examples need a key.

## v0.12.0 — 2026-08-18

### Added

- **`chain`: named steps over a growing typed record.** `chain(input_name?)` builds a `Step` from `.step(name, fn)` bindings that each merge one named value into the record, `.stage(name, project?)` markers that conclude a phase (with `project`, narrowing the record), and a final `.output(fn)` projection. A step body receives the record plus the run context, so a binding can `ctx.call` a composed arm directly; passing that arm as step-level `{ arm }` metadata records it as a describe-only child, so `describe` still renders the full tree under the binding.

- **`model_step`: the default model boundary.** Takes the same config as `model_call` and returns a `Step` whose output is the content alone: a `string`, or the schema-validated value when `schema` is set. Implemented as `model_call` with `project` preset to the content, so the leaf is a single node in `describe` and the trajectory; reach for `model_call` when the caller needs the `GenerateResult` envelope (usage, cost, tool calls, finish reason).

- **`run.until_suspended`: suspension as a typed outcome.** Where plain `run` signals a `suspend` gate by throwing `suspended_error`, `run.until_suspended(flow, input, options?)` resolves `{ kind: 'suspended', id, resume }`; calling `resume(data)` re-runs the flow with the decision and resolves to the next outcome. Completion is `{ kind: 'done', output }`; real errors still throw. This supersedes the try/catch dance around `suspended_error`, which remains for plain `run`.

- **A `project` option on the six envelope composites and on `model_call`.** `adversarial`, `ensemble`, `ensemble_step`, `tournament`, `consensus`, and `improve` can now map their result envelope into the step's output at the source (`project: (r) => r.candidate`), so downstream steps see the value instead of the wrapper; `model_call` takes the same option over its `GenerateResult` (`project: (r) => ({ text: r.content, cost: r.cost })`), which is also how `model_step` is now built. In every case the projection runs inside the step, so `describe` and the trajectory gain no wrapper node; omitted, the envelope stays the output, as before.

- **The `fascicle/testing` subpath.** `make_stub_engine(canned, options?)` routes canned responses by system-prompt prefix, validates each one through the call's schema, and throws on an unmatched system; `make_capture_engine(options?)` records every call's `GenerateOptions` into a live `calls` array and answers with a canned result. Types: `StubEngineOptions`, `StubResponse`, `CaptureEngine`, `CaptureEngineOptions`.

- **Compile-time joint checking for literal `sequence` tuples.** Each child of a literal tuple must accept its predecessor's output, and a mismatch errors on the offending element. Arrays built at runtime still degrade to unknown boundaries; annotate the outer `Step<In, Out>` to keep the flow's boundary checked.

- **Docs for the layering.** `docs/leaf-arm-spine.md` names the leaf / arm / spine shape and the decision rules at each layer, `docs/advanced-composition.md` covers the demoted tier (`scope`/`stash`/`use`, plain `ensemble`, `tournament`, `improve`/`learn`), and `examples/newsroom/main.ts` is the vocabulary tour that uses every primary primitive once.

- **A one-file style pair in the examples.** `examples/release-notes/main.ts` and `examples/release-notes-direct/main.ts` build the same release-notes flow two ways (composed through `chain` and arms, and written straight through as one function), so the cost and the benefit of composing are readable side by side rather than asserted. `docs/blueprint.md` is rebuilt around `chain` and points at the pair.

### Changed

- **The `Step` type is sound.** `run` is a function property rather than a method, so a step's input is checked contravariantly, and `AnyStep` (`Step<never, unknown>`) is added as the erased supertype for code that handles steps generically. **Breaking** for consumers that relied on method bivariance: an assignment that only type-checked under that looser method-parameter rule now errors, which is the point of the change.

- **The examples fleet migrated to the `chain` / `model_step` / arm idioms.** The single-file demos and the reference apps now read as leaves, arms, and one spine per flow, matching the layering `docs/leaf-arm-spine.md` names.

- **The prose surface moved onto the `chain` / `model_step` idiom.** `README.md`, `docs/getting-started.md`, `docs/concepts.md`, `docs/api-reference.md`, `docs/cookbook.md`, `docs/composition.md`, `docs/writing-a-harness.md`, and the site pages now teach leaf / arm / spine first and present `pipe`, `sequence`, and `model_call` as the lower tier those primitives sit on. `docs/concepts.md` and `docs/api-reference.md` also state the sound `Step` shape and `AnyStep`.

### Internal

- Re-baselined the duplication report after the stub-engine paydown, and added the `.firecrawl` web-research scratch directory to `.gitignore`.

## v0.11.1 — 2026-08-13

### Fixed
- Broke an import cycle between the viewer CLI and its barrel module.

### Internal
- Reduced complexity across the engine, core, composites, and adapter layers by decomposing large functions (provider dispatch, tool-loop orchestration, generate, retry, native-provider streaming, and more) to clear the health complexity gate.
- Removed dead exports, types, and duplicate re-exports surfaced by dead-code analysis; extracted shared test and trajectory-logger scaffolding to cut duplication.
- Health's complexity metric (CRAP) now reads real test coverage instead of an estimate; closed the viewer CLI's coverage gap with new in-process tests and retired the mutation-testing excludes that existed only because those files were untested.
- Scoped health complexity checks to production source only, de-flaked a claude_cli timing test, and tuned fallow/lint config.

## v0.11.0 — 2026-08-12

### Changed

- **A tool's JSON Schema no longer requires the fields that carry a default.** Provider payloads were emitted through Standard JSON Schema's *output* direction, which describes a value that has already been parsed: defaults are filled in by then, so `z.object({ city: z.string(), units: z.string().default('celsius') })` reached the model as `required: ["city","units"]`. That asked the model to supply a value the schema itself supplies, and made a defaulted field indistinguishable from a mandatory one. Emission now uses the *input* direction, which describes what the model should produce, so the same tool arrives as `required: ["city"]`. The input direction on its own also drops `additionalProperties: false` (the guard that stops a model inventing keys, and a prerequisite of several providers' strict and constrained-decode modes), so it is composed with a pass that closes every object node the vendor left open. This is the same pairing `@ai-sdk/provider-utils` applies to every `kind: 'ai_sdk'` provider (all seven Fascicle configures by default), so the native adapters and `claude_cli` now send what the AI SDK path was already sending rather than a second, stricter shape for the same tool. Two restraints keep the closing pass from asserting more than the vendor did: an existing `additionalProperties` is never overwritten, so `z.looseObject`, a `z.record`'s value schema, and a server that published `true` all stay open (the AI SDK overwrites these); and a node is closed only if it declares `properties`, so a bare `{ type: 'object' }` (how a freeform payload is advertised) is left alone instead of being narrowed to "no keys permitted". One capability comes with it: `.output()` throws on a schema carrying a transform (`Transforms cannot be represented in JSON Schema`), so a tool whose schema contained one could not reach a native provider at all; the input direction emits it. **Breaking** on the wire for any tool or structured-output schema with a `.default()` or `.catch()` field: that field moves out of `required`, at every depth, including inside arrays and unions. Schemas without one are byte-identical to before, key order included. A knock-on for MCP: v0.10.3 made an inbound server's advertised schema reach the provider verbatim, and closing objects narrows that — a server that declares `properties` but says nothing about `additionalProperties` now has `additionalProperties: false` added on the native transports. The AI SDK path already did this to those same schemas, so the effect is that MCP tools now behave the same across all transports rather than differing by the one in use.

- **`loop` no longer wraps its output in a result envelope.** It returned `Step<i, LoopResult<o>>` (`{ value, converged, rounds }`), so anything that wanted the projected value had to strip `.value` first, and every one of the six in-repo call sites did: `adversarial` and `consensus` each carried a whole `pipe` for it, `improve` had an `improve_unwrap` step, the researcher agent wrapped its loop in a second `step` that called `inner.run` by hand (skipping the loop's own span) purely to return `result.value`, and both example apps hopped through `.value` at the read site. The envelope was a second projection channel layered over the one `loop` already had: `finish` is where the final state becomes the output, and it was already handed a piece of loop metadata (`round: number`) that no call site used. It now receives all of it (`finish: (state, outcome: LoopOutcome) => o`, with `LoopOutcome` being `{ converged, rounds }`), and `loop` returns `Step<i, o>`: exactly what `finish` projects, nothing around it. Non-convergence is still data rather than error; it arrives as an argument instead of a wrapper, which is why this shape was chosen over an `unwrap: true` flag (that would have needed two return types on one function, and would have discarded `converged` silently — the datum the whole convention rests on). Nothing is lost by dropping the envelope, because `finish` and the `loop({...})` call site always have the same author: the old shape is `finish: (state, outcome) => ({ value: state, ...outcome })`, opt-in in one line. Trajectories are unaffected: a traced composer's span records `{ id }` only, so `converged` and `rounds` were never in the trace to begin with. **Breaking:** `LoopResult` is gone from the published surface, replaced by `LoopOutcome`, and a `loop` step's output type is now `o`. A `finish` that declared a second parameter now receives the outcome object where the round count used to be. `docs/composition.md`, `docs/api-reference.md`, and `docs/deliberation-as-composition.md` state the new shape. In `examples/pr-improve` the `LOOP_RESULT` scope key becomes `FINAL_STATE`, since what the loop stashes is now the carry-state itself — whose own `round` field counts the same rounds the envelope reported.

### Internal

- **The two retry layers' different abort-rejection shapes are now recorded as deliberate, in the code and in `docs/concepts.md`.** The engine's retry always wraps an abort reason in `aborted_error`; core's propagates an `Error` reason verbatim and wraps anything else. Unifying them founders on a Node 24 fact now pinned by tests on both sides: a bare `controller.abort()` sets a `DOMException` reason, which *is* an `instanceof Error`, so adopting core's semantics in the engine would leak `DOMException` where callers expect `aborted_error`. Each retry module names its shape in a `to_abort_error` factory with the rationale attached.
- **The last un-hardened wire adapter is closed: the `ai_sdk` Anthropic adapter went from 66.1% to 100% mutation score.** Its config assembly (api key and base URL coercion, conditional `baseURL`) was covered only by a `toBeDefined()` against the real peer; a mock-the-peer test file now pins every field, and a redundant effort-guard clause was simplified away rather than annotated. Full-repo mutation score 88.4% → 89.0%.
- **The mutation break threshold ratchets 84 → 86**, sized from the measured flake surface (91 Timeout mutants of 10,677 scored = 0.85pt worst case) instead of the previous comment's ~5×-overstated guess.

## v0.10.3 — 2026-08-12

### Fixed

- **`bench` no longer scores a suspended or cancelled run as a set of failed cases.** A `suspended_error` from a human-approval gate inside a benched flow was caught by the same handler as an application failure and recorded as `{ ok: false, error: 'suspended at ...' }`, so a paused case scored a zero and moved `pass_rate` without anything reporting that the flow never finished. `bench` has no resume path, so a suspend inside a benched flow is a usage error: it now rejects with `bench_suspend_error` (exported from `fascicle`), carrying `case_id` and `suspend_id` so the offending case is named rather than searched for. The judge loop's `catch { continue }` abstain path had the same hole and gets the same guard. **Breaking** for anyone benching a flow that suspends: those runs rejected nothing before and reject now, which is the point, since the old report was wrong.

- **The documented install for every `ai_sdk` provider was missing `ai`, and openrouter's named the wrong package.** `docs/configuration.md`'s seven per-provider snippets said `pnpm add @ai-sdk/anthropic` alone. The official `@ai-sdk/*` packages peer-depend on `zod` rather than on `ai`, so once `ai` became optional nothing pulled it in transitively and each of those lines produced an install that could not run a turn. Correcting them surfaced a second, older defect in the same block: openrouter was documented as `@ai-sdk/openai-compatible`, but the adapter loads `@openrouter/ai-sdk-provider`, so the documented install could never satisfy it. `docs/providers.md`'s peer table is the authority for both.

- **`fascicle/ui` never named the peer it requires.** The subpath imports `ai` statically (it speaks the AI SDK's UI message-stream protocol), but none of the places documenting it said so. With `ai` optional and `pnpm add fascicle` now the whole install line, following those docs produced a raw `ERR_MODULE_NOT_FOUND`. `docs/api-reference.md` now separates the two peer-bearing subpaths by failure mode: `fascicle/mcp` loads its SDK dynamically and reports `mcp_sdk_missing_error`, while `fascicle/ui` fails at module resolution.

### Added

- **`ai` is now an optional peer dependency.** It was the last mandatory peer on a package whose own `dependencies` block is empty, so `pnpm add fascicle` forced an install of the AI SDK core even for a `transport: 'native'`-only or `claude_cli`-only setup that never imports it. `ai` is loaded lazily from the one `ai_sdk` turn seam (`src/engine/generate.ts`), same as every `@ai-sdk/*` provider package, so it drops to `peerDependenciesMeta: { ai: { optional: true } }` alongside them; a missing `ai` reports through the same `load_optional_peer` message step 7 named it in. `docs/providers.md` and `README.md` now show `ai` alongside each `ai_sdk`-kind provider's install snippet, since the official `@ai-sdk/*` packages only peer-depend on `zod`, not `ai` — installing just `@ai-sdk/anthropic` no longer pulls `ai` in transitively now that Fascicle's own peer is optional.

- **`BenchOptions` gains `abort`, and a cancelled bench rejects instead of returning a report.** `bench` accepted no signal at all and defaulted `install_signal_handlers` to `false`, so there was no cancellation path through a bench run. The signal now forwards to every per-case `run` and is re-checked before each case is claimed, so an abort halts scheduling at the queue rather than only cancelling work already in flight, and it is checked once more before the report is built, so neither a full fan-out (no queue to halt) nor a flow that ignores `ctx.abort` can yield a report for a run the caller cancelled. An `aborted_error` raised inside a case or a judge propagates rather than being flattened into `ok: false`. Abort reasons follow core's shape: an `Error` reason propagates verbatim, anything else is wrapped in `aborted_error`.

### Changed

- **`zod` is now an optional peer dependency, and Fascicle has zero mandatory peers.** It was the last one: `ai` went optional earlier in this release, and the Standard Schema migration removed every internal zod import from `src/` except the type-only one in `src/mcp/serve.ts` (`McpServer.registerTool` accepts nothing else). `zod` drops to `peerDependenciesMeta: { zod: { optional: true } }` alongside every other peer, so `pnpm add fascicle` alone builds and runs a flow against `transport: 'native'` or `claude_cli` — no AI SDK, no schema library. Schemas accept any Standard Schema implementation (zod, ArkType, Valibot, …); installing zod remains necessary only if that is the vendor you choose. The `no-core-npm-dep-except-zod` and `no-engine-npm-dep-except-ai-zod` ast-grep rules, which permitted an npm dependency neither zone still uses, are replaced by `no-core-npm-dep` and `no-engine-npm-dep`: core and engine (outside `providers/`) now depend on no npm package at all, matching the `#schema`/`#policy` bottom-of-DAG zones that already carry the vendor-specific code. `README.md`, `docs/getting-started.md`, `VALUES.md`, and `SECURITY.md` state the zero-mandatory-peers posture directly.

- **The trajectory wire format is now read through hand-written guards instead of zod schemas.** The five exported schemas — `trajectory_event_schema`, `span_start_event_schema`, `span_end_event_schema`, `emit_event_schema`, and `custom_event_schema` — put a zod object on the published surface of a package that is dropping zod to an optional peer, so a consumer who never writes a zod schema still resolved zod to read a trajectory file. They are replaced by `parse_trajectory_event(value)`, which returns the same `safeParse` shape (`{ success: true, data }` / `{ success: false, error }`), and four type guards: `is_span_start_event`, `is_span_end_event`, `is_emit_event`, `is_custom_trajectory_event`. What parses is unchanged, deliberately down to the permissiveness: an event is any non-array object carrying a string `kind`, so a `span_start` line missing its `span_id` is still accepted as an event (the old ordered union fell through to `custom_event_schema` for exactly that case) and the well-known guards are recognizers layered on top rather than gates. `is_custom_trajectory_event` therefore answers `true` for well-known kinds too, matching `custom_event_schema` before it. Two visible differences: a successful parse now hands the wire value straight back rather than a shallow zod clone, so nothing is dropped on the way through — including a literal `__proto__` key, which zod's clone silently swallowed and which now rides along as the inert own property `JSON.parse` produced (no prototype is mutated either way) — and the failure `error` is a plain `Error` rather than a `ZodError`, so code reading `.issues` off it needs the line itself instead (the viewer's `on_parse_error` already receives that as its second argument). The exported types keep their names (`SpanStartEvent`, `SpanEndEvent`, `EmitEvent`, `CustomTrajectoryEvent`, `ParsedTrajectoryEvent`) and shapes, joined by `TrajectoryParseResult`. **Breaking:** any of the five schema exports, or `ZodError`-shaped handling of a rejected line.

- **Every schema Fascicle validates now runs through Standard Schema, so validation failures read the same whichever library produced them.** Tool inputs, structured-output parsing, `suspend` resume data, and both `run_stdio` IO checks called zod's `safeParse` directly and reported whatever zod handed back. They now go through the vendor-neutral `~standard.validate` interface, so an ArkType or Valibot schema validates on the same path a zod one does. Two things consumers can see change shape. The message fed back to a model on a rejected tool call (and the schema repair prompt, and `schema_validation_error.message`) was zod's own multi-line JSON dump of its issue objects; it is now one line of `path: message` clauses with dotted paths — `city: Invalid input: expected string, received number; opts.deep: Invalid input: expected boolean, received string`. And the `cause` on a `run_stdio` `validate_input` / `validate_output` failure now carries `{ message, path }` issues instead of zod's issue objects, so the `code` and `expected` fields are gone from that JSON. Nothing that was validated before validates differently: only the report changed.

- **Schema failures are now reported vendor-neutrally end to end, closing out the zod-shaped naming and reporting left over from the Standard Schema migration.** `schema_validation_error` (thrown by `generate` and the `claude_cli` adapter after repair attempts are exhausted) carried a field named `.zod_error`; it is renamed `.schema_issues` and now holds the vendor-neutral `{ message, path? }` issue list directly rather than an `Error` wrapping a pre-formatted string. The engine's `schema_validation_failed` trajectory event's `zod_issues` field is renamed `schema_issues` (same one-line formatted string as before). `suspend`'s `resume_validation_error.issues` (called out above as unchanged) now also carries the vendor-neutral issue list instead of a hand-rolled reproduction of zod's `{ formErrors, fieldErrors }` shape. The internal `format_zod_error` helper is gone; formatting goes through `format_schema_issues` everywhere. **Breaking:** code reading `schema_validation_error.zod_error`, `resume_validation_error.issues.formErrors` / `.fieldErrors`, or a trajectory consumer reading `schema_validation_failed.zod_issues` needs to move to the renamed fields and shapes.

- **An inbound MCP tool now reaches the model with the schema its server actually advertised.** The bridge converted a server's JSON Schema into a Zod schema so the tool loop could validate it, and the provider path then converted that Zod back into JSON Schema — a round trip the old file's own header conceded was lossy. It dropped every value constraint on the way through: `minLength`, `maxItems`, `format`, `pattern`, and `enum` descriptions were modeled as plain types, so a model calling an MCP tool was told less about its arguments than the server had published. The bridge now builds a Standard Schema directly over the advertised JSON Schema, and emission hands that schema back verbatim in both directions, so what the server declared is what the provider receives. Validation is unchanged in reach — structure, types, enums, const, unions, and required keys are checked, value constraints are not, extra keys still pass through to the server, and anything unrecognized still accepts — because the server re-validates its own arguments and is the authority on them. Two visible consequences of verbatim emission: a server that declares `additionalProperties: false` now has that reach the provider instead of being loosened away, and `$schema` / `$id` keys the server published now ride along on the transports that accept them. The MCP path no longer imports zod at all. **Breaking:** the `fascicle/mcp` export `json_schema_to_zod` is renamed `json_schema_to_standard` and returns a `ToolSchema` rather than a `z.ZodType`, so a caller using it directly validates through `~standard.validate` (async) instead of `safeParse`.

- **The `zod` peer dependency is pinned to exactly `4.4.3`, up from `^4.0.0`.** Fascicle is moving to emit provider JSON Schema through Standard JSON Schema (`~standard.jsonSchema`) rather than `z.toJSONSchema`, and that interface does not exist before zod 4.2.0: on 4.1.12 `~standard.jsonSchema` is `undefined`, so the old `^4.0.0` range named a floor that cannot work. The pin is exact rather than a range so that the one version Fascicle is tested against is the one version it promises; 4.2.0 and 4.4.3 emit byte-identical draft-2020-12 schemas, so this is a choice about which version is guaranteed, not about behaviour. **Breaking:** an install that resolves zod to any other version, including a later patch such as 4.4.4, now reports a peer dependency conflict, and a project whose other packages peer-depend on a zod range excluding 4.4.3 cannot satisfy both at once. zod is an optional peer as of this release, which lifts the requirement for anyone who never installs it, but a consumer using zod schemas with Fascicle still has to be on 4.4.3.

- **`retry` (composition layer) now jitters its backoff by default and caps it at 30s.** `RetryConfig` gains `max_delay_ms` (defaults to 30_000, matching the engine retry layer's cap) and `jitter` (defaults to `true`), both now expressed through the `#policy` backoff algebra the engine retry layer already used. Un-jittered retries from concurrent callers stampede back onto a recovering dependency in lockstep, and jittering is cheapest to add now, before `retry` has callers depending on its old exact-doubling delays. **Breaking:** a `retry(...)` call with a large `backoff_ms` or high `max_attempts` now serves a longer, randomized delay per attempt and is capped at 30s where it was previously uncapped; pass `jitter: false` and an explicit `max_delay_ms` to keep the old behavior exactly. `retry.test.ts` pins the default-on jitter clamped to an explicit cap, and the old exact-doubling assertion now runs with `jitter: false`.

### Internal

- **Two new bottom-of-DAG zones carry what core and engine used to reach for directly.** `#policy` holds the shared backoff algebra both retry layers now compute delays through; `#schema` holds the Standard Schema helpers (`validate_schema`, `to_json_schema`) that replaced zod at the public surface. Each ships its own ast-grep npm-dependency rule, so the "no npm dependency below this line" invariant is enforced rather than intended, and `snake-case-exports.yml` now covers both.
- **`docs/concepts.md` documents what cooperative cancellation cannot do** — `timeout` and abort signal intent but cannot kill work that ignores `ctx.abort`, and abandoned work keeps spending tokens — and `docs/composition.md`'s `retry` summary picks up the new `max_delay_ms` / `jitter` options.
- **The `claude_cli` SIGTERM-to-SIGKILL escalation test no longer races the wall clock.** It sampled child liveness partway through the escalation window, which under parallel load overran past `SIGKILL_ESCALATION_MS` and reported a dead child on untouched code. The sample is removed rather than given a wider margin, which would have pushed it past SIGKILL instead of clear of it: `signalCode` already proves SIGTERM was survived and the elapsed floor proves the escalator waited, both robust under load.

## v0.10.2 — 2026-08-11

### Added

- **`fallback` gains a `handoff` option, so the backup can be told why it is running.** `fallback(primary, backup, { handoff })` calls `handoff(input, err)` when the primary throws an application error and runs the backup on the result, instead of retrying the same input blind; a handoff note like "a previous attempt failed, answer from scratch" is the intended use. Omitting the option keeps the old behaviour exactly: the backup receives the original input. Control-flow signals are untouched by the new path: suspend and abort still propagate without triggering the backup, and the handoff is never called for them, so an approval gate cannot be bypassed through a mapped input. Tests pin the mapped-input path, the handoff argument order, the success path (no handoff call), and the control-flow bypass.

### Internal

- **The cookbook gains an escalation-tiering recipe: judge the cheap model's actual work, escalate only on real trouble.** Where `fallback` escalates on a throw, the recipe escalates on mediocrity. It covers the single-request shape (a buffered weak draft, a fail-open judge expressed as `fallback` around the judge so a dead judge serves the draft rather than escalating, and an escalate-or-serve `branch` that emits the verdict into the trajectory), a multi-turn latch that holds a confirmation streak in `loop` carry-state (an escalate verdict increments, a decline resets, a fail-open judge holds, two confirmations latch the run onto the strong tier), and a calibration method for deciding when the weak tier is enough (RESCUE/LOSS/SAFE/HARD quadrants over a strong-tier baseline plus a stratified weak-tier probe, harnessed with `bench` and pinned with `regression_compare`). The multi-provider fallback recipe picks up a `handoff` example.
- **`docs/comparison.md` places NVIDIA's Switchyard.** A wire-level routing proxy is a different layer, not competition: aligned with Fascicle on keeping routing policy outside the model surface (its `libsy` library hands every model call back to the caller, the same separation as adapters passed in per run and verbatim model resolution), different on where routing belongs (rewriting traffic for clients you cannot modify versus explicit composition when you own the call site), and usable today as one more OpenAI-compatible gateway behind the compat recipe in `docs/providers.md`.
- **The check runner (checkride) is upgraded from 0.6.0 to 0.12.1.**

## v0.10.1 — 2026-08-07

### Fixed

- **A schema call that finished without finishing no longer returns unchecked text typed as your schema.** `generate` gated schema parsing on `finish_reason === 'stop'` and, on any other finish, fell through to returning the raw model text cast to `T`. A Bedrock guardrail block, a `max_tokens` truncation, or a step-cap exit therefore produced a `GenerateResult<T>` whose `content` was a string wearing the schema's type: reading a field off it crashed, and a defensive consumer got `undefined` fields instead, so a blocked call could score as a low-risk one. The gate now throws `incomplete_generation_error` (exported from `fascicle`) carrying `finish_reason`, `raw_text`, and `provider_reported`, the last so a guardrail's own assessment stays reachable from the catch without logging the matched text. Repair is still not attempted, which was the one correct half of the old behaviour: re-prompting a model that was blocked or cut off cannot produce the missing value. The error is deliberately distinct from `schema_validation_error`, which continues to mean a response that completed normally and then failed validation. **Breaking for schema callers** who relied on the old return: those calls now reject, and a streamed one rejects after its text deltas without emitting a `finish` chunk, matching what `schema_validation_error` already did. Calls without a schema are untouched — `content_filter` and `length` still return the partial text with the finish reason. `claude_cli` was never affected (it validates unconditionally and reports every completion as `stop`), so this closes a divergence between the transports rather than opening one. The flipped criterion is pinned in `spec_coverage.test.ts`, the finish reasons and the no-repair guarantee in `generate.test.ts`, and the payload's survival onto the error across plain, streamed, and multi-step runs in `provider_reported.test.ts`.

- **A schema that validates to `undefined` returned the raw model text instead of the validated value.** `generate` tracked its parsed value in a `T | undefined` and gated the final read on `content_parsed !== undefined`, so a schema whose `.transform()` or `.catch()` legitimately yields `undefined` parsed successfully and was then discarded in favour of the raw string, cast to `T`. The parsed value now rides a `{ value: T }` holder, which distinguishes "validated to undefined" from "nothing parsed" and collapses the three-way final-content branch to two. This also retires the comment claiming the fallthrough was unreachable: it was reachable before this release, and the branch that remains is the no-schema one.

### Internal

- **The two grandfathered `unused_class_members` findings on `errors.ts` are resolved rather than baselined.** `turn_timeout_error.kind` and `schema_validation_error.kind` have no in-repo production reader — `classify_retryable` reaches them through `read_string(err, 'kind')` on an `unknown`, and external consumers switch on the discriminant outside this repo — so the finding was a limitation of static analysis, not real debt. Both now carry an inline `fallow-ignore-next-line` with the reason beside the field, and the baseline entries are gone. The entries were anchored by `line:col`, so any edit above them re-surfaced frozen debt as a new finding; documenting the intent at the field removes that fragility.

## v0.10.0 — 2026-08-05

### Added

- **`provider_reported` now carries what an `ai_sdk` provider reports, for every provider on that transport.** The AI SDK returns provider-volunteered detail on `providerMetadata` (Bedrock's guardrail trace, Anthropic's cache breakdown, OpenAI's service tier), already keyed by provider name. The transport read `text`, `toolCalls`, `finishReason`, and `usage` off the result and dropped the rest, so `GenerateResult.provider_reported` was structurally unreachable for every ai_sdk provider: only `claude_cli` ever populated it. The neutral `TurnResult` gains an optional `provider_reported`, the transport fills it from `providerMetadata` on both the `generateText` result and the streamed step-finish (so a streamed run and a plain run of the same call still report identically), the loop copies it onto `steps[i].provider_reported`, and `generate` folds the last reporting step into the call-level field. Keys and payloads ride through untranslated, so `provider_reported.bedrock.trace` needs no translation layer and a custom `ai_sdk` provider is served without per-provider code; a `native` adapter fills the same field from its own `invoke_turn`. Finish-reason mapping is untouched: a guardrail intervention still surfaces as `content_filter`, now with the trace beside it. This closes a real blind spot for Bedrock guardrails configured with a PII action of `NONE`, which detect and report without rewriting: the model output is byte-identical whether such a guardrail is attached and detecting or absent entirely, so the trace was the only in-process evidence it ran. `bedrock_guardrail_wire.test.ts` pins the round trip against the real peer over a stubbed fetch, and `provider_reported.test.ts` pins pass-through, stream parity, and the multi-step semantics.

### Fixed

- **`docs/cli.md` named a `provider_reported` path that does not exist.** The multi-turn recipe said to capture `result.provider_reported.session_id`, but the adapter reports under a provider-name key, so the value has always been at `result.provider_reported.claude_cli.session_id`. Following the documented path yielded `undefined` and a fresh session on every call.

### Internal

- **The Bedrock guardrail docs show how to read the trace the change above made readable.** `docs/providers.md` gains a worked read of `provider_reported.bedrock.trace` beside the existing guardrail recipe, `docs/troubleshooting.md` gains an entry for the symptom that actually gets reported ("the guardrail seems ignored, the output came back unchanged"), and the adapter docstring carries the same claim at the source. The entry separates policy from wiring: a PII action of `NONE` detects without rewriting, so unchanged output is the configured behaviour rather than a dropped `guardrailConfig`. The way to test the wiring instead is a deliberately invalid `guardrailIdentifier`. AWS rejects the call only if the config reached the Converse command, so a call that succeeds is the failure signal.

## v0.9.11 — 2026-08-05

### Added

- **The bedrock provider has a real ambient-credential mode.** `use_credential_chain: true` loads `@aws-sdk/credential-providers` (a new optional peer) and hands `fromNodeProviderChain()` to the SDK, so `~/.aws/credentials` profiles, SSO, and ECS/EC2 instance roles authenticate without exporting keys into the environment first. `credential_provider` is the escape hatch for callers that already hold a provider, such as an assume-role flow; supplying both is an `engine_config_error`. The chain is built once per adapter so its memoized credential cache survives across requests.

### Fixed

- **`bedrock` documented an ambient AWS credential chain it never had.** The adapter's doc comments, `docs/providers.md`, and `docs/troubleshooting.md` all said that omitting credentials falls back to the AWS credential chain. It does not: `@ai-sdk/amazon-bedrock` resolves SigV4 keys from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` and never opens `~/.aws/credentials`, so "omit the keys" silently produced an unauthenticated client that failed with a SigV4 error reading like a missing IAM grant. The claim is corrected everywhere and the real capability is now the `use_credential_chain` flag above. Lambda was never affected, since the execution role injects those env vars. `bedrock_credential_chain_wire.test.ts` pins the fix where it actually bit: with every AWS variable deleted from the environment and only a shared-credentials profile on disk, driving the real peer over a stubbed fetch and asserting the profile's key appears in the SigV4 `Authorization` scope. Its negative control asserts the same environment fails without the flag, so the suite cannot be masked by ambient credentials the way the bug was.

### Internal

- **The site's three pages carry real head metadata.** `index.html`, `docs.html`, and `blueprint.html` shipped with a head holding only charset and viewport, so tabs showed the bare URL and every link preview and search result had nothing to render. Each page now sets `lang="en"`, a distinct title and description drawn from its own copy, a canonical link, and the Open Graph and Twitter text tags. These sit in the static head rather than the `<helmet>` block, so crawlers that never run JavaScript still see them. No library changes.

## v0.9.10 — 2026-07-30

### Added

- **Bedrock guardrails are documented and pinned by a wire contract test.** `provider_options.bedrock.guardrailConfig` reaches the top level of the Converse command through a seam `@ai-sdk/amazon-bedrock` does not document: its provider-options schema omits the key, and the request builder rest-spreads unknown keys into the command body, so a peer upgrade that tightens that spread would drop guardrails silently. `bedrock_guardrail_wire.test.ts` drives the real peer over a stubbed fetch and asserts the key lands top-level, survives the effort-translation merge, and that a `guardrail_intervened` stop surfaces as `finish_reason: 'content_filter'`. The bedrock section of `docs/providers.md` gains the matching recipe. No runtime changes.

## v0.9.9 — 2026-07-24

No library behavior changes in this release. Every `src/` edit in this range is
a documentation comment, so the published runtime is unchanged from v0.9.8; the
work is in the docs surface, the example apps, and the check suite.

### Changed

- **The public docs surface is now written for the public.** `research/` and the internal build trees are untracked, and the adoption and comparison pages are back in sync with the native transports: the AI SDK is the *default* path for seven of the eight providers rather than the only path, and both pages' AI-SDK-backed versus native counts are corrected.
- **Every example app now matches [docs/blueprint.md](./docs/blueprint.md).** `pr-improve`, the canonical reference, moved its four system prompts into markdown files with frontmatter, renamed its schemas to `snake_case`, and moved the field-level output rules out of prose and into `.describe()` on the schemas, where they travel to the model as part of the JSON schema. `red-green-refactor`, `swebench`, and `amplify` predated the blueprint and were translated: one `create_engine` call site each, markdown prompts, and `state`/`stages`/`services` splits. `amplify`'s round loop was a `while` over mutable parent state driving an `ensemble` whose score callback populated a captured map; it is now `loop` + `map` + `branch` over immutable carry-state, with `fallback` replacing a buried try/catch, so the stop rule, the fan-out, and the accept/reject decision are all visible in the trajectory.

### Fixed

- **`docs/blueprint.md`'s `state.ts` snippet did not compile.** It declared its scope-state readers over `ReadonlyMap` and called `.get()`, but `use(keys, fn)` hands `fn` a plain object projection of the requested keys. The snippet now shows the real shape, with the `ReadonlyMap` variant documented for readers that go through `ctx.state` inside a step body instead.
- **`examples/pr-improve` could not run on its own default provider.** It defaulted every role to `'sonnet'`/`'opus'` and claimed in comments that the engine expands those per provider. It does not (`model` is passed to the provider verbatim), so the documented default path (`FASCICLE_PROVIDER=anthropic`) sent a literal `"sonnet"` and got a not-found error. One per-provider model table now resolves once and threads through as data, which also removes a second copy of that table and makes the `FASCICLE_MODEL_*` overrides reach the flow; they were previously parsed and discarded.

### Internal

- **The check suite is now [checkride](https://www.npmjs.com/package/checkride) 0.6.0**, replacing the hand-rolled orchestrator. `scripts/check.mjs`, `check-links.mjs`, `check-doc-snippets.mjs`, and `check-publish.mjs` are deleted (~960 lines) in favour of built-in slots; `scripts/check-deps.mjs` stays as the one custom check, since the core/engine dependency invariant is Fascicle-specific. The `pnpm check` / `check:all` / `check:json` / `check:bail` contract is unchanged and `pnpm check --changed` is new.
- **Existing debt is grandfathered in `checkride.baseline.json`** (308 diagnostics across lint, struct, dead, dupes, health, spell). The gate ratchets: frozen debt passes, new findings fail. The `dupes` and `health` slots are now enforced rather than folded into a single fallow invocation that could not fail on them.
- The packaging gate gains `publint` and splits the old monolithic `publish` step into `pack`, `smoke`, and `attw` (pinned to the `esm-only` profile). Doc snippets are typechecked against the built `.d.ts` as part of `pnpm check:publish`, rather than as a separate CI step.
- **The blueprint is machine-checked on the examples.** All six composition apps carry its ast-grep rules, run for every app by a new `examples` check slot; `check:rules` was previously invoked by no CI job and no slot, and the library's own rules never matched the example apps because their `files:` globs are anchored at the repo root. `vitest` now globs `examples/*/src/**/__tests__`, so `swebench`'s and `amplify`'s suites, which had never executed, run in CI: 13 example tests became 51.
- Every module-level function in `src/` now carries a doc block, enforced by `rules/function-comment-required.yml`, and the comments are written in the present tense with no design-history references.
- Tooling: fallow 3.6.0, `publint` added, and the marketing site dropped from analysis (it reported every file as unused and its DOM handlers as complexity findings).

## v0.9.8 — 2026-07-19

### Added

- **`define_agent` call-shaping config.** `DefineAgentConfig` accepts `model` and `schema_repair_attempts`, closing the gap where the blueprint's "models are threaded as data" rule could not be followed on the `fascicle/agents` surface (and where schema repair, set on every model call observed in production consumers, required dropping to a stage factory). Precedence: `config.model` > frontmatter `model` > engine default; the blueprint's stage-factory section now states the same rule.
- Two blueprint reference apps translated from production consumers, workspace-wired with stub-engine tests and the blueprint's ast-grep rules: `examples/change-triage/` (deterministic detectors + one schema-mode model call, a score floor the model cannot undercut, a privacy screen on the model's view) and `examples/docs-concierge/` (grounded Q&A with number-based citations, a `define_agent` stage, and a one-way gate that prefers abstaining over confidently wrong).

### Changed

- `docs/blueprint.md` and `site/blueprint.html` now state model precedence consistently (threaded model wins, frontmatter is the role default, engine default is the last resort), and the stage-factory snippet no longer implies frontmatter overrides a threaded model.

## v0.9.7 — 2026-07-17

### Added

- **`fascicle/agents` subpath.** `define_agent` — the markdown-plus-schema agent loader the blueprint recommends for simple one-prompt agents — is now importable by consumers via `import { define_agent } from 'fascicle/agents'`. It was previously reachable only inside the repo. Ships as its own bundle entry (`dist/agents.js`), smoke-verified at build time.
- A dedicated architecture page on the site (`site/blueprint.html`): the agent blueprint's one rule, adoption tiers, module contracts, anti-patterns, and ast-grep enforcement story, linked from both existing pages. `AGENTS.md` and the README now route agents and humans building *on* Fascicle to `docs/blueprint.md` first, and a new `examples/README.md` indexes the example apps around it.
- Opt-in `build` + `publish` steps in the check runner, included by `pnpm check:all`: the tsdown bundle with export smoke imports, and the npm pack manifest + `@arethetypeswrong/cli` validation. Packaging regressions now fail the done-gate instead of surfacing at release time.

### Changed

- Documentation synced with the implementation across `docs/` and the site. The composition surface is documented as 21 primitives (adding `ensemble_step`, `improve`, and `learn` to every list and to the site's interactive tour). Site code samples now show the real config-object APIs (`branch` / `map` / `ensemble` / `tournament` / `consensus`, `adversarial`'s required `accept`, `suspend`'s required `on`, `retry`'s `backoff_ms`). Engine docs are corrected for `claude_cli` reasoning-effort forwarding (`CLAUDE_CODE_EFFORT_LEVEL`), the `'timeout'` member of `DEFAULT_RETRY.retry_on`, the real missing-peer error message, `inherit_env` semantics, the full `EngineConfig` shape, and the complete error and Engine-method lists.
- The reference agents (reviewer, documenter, researcher) moved from `src/agents/` to `examples/agents/` as copy-pasteable demo code — they were never published (their markdown prompts do not ship in `dist/`), and their own docstring called them canonical examples. Their behavior tests still run in the default suite. `src/agents` now contains exactly the published surface: `define_agent`.

### Internal

- Hardened `define_agent` mutation coverage from 91.8% to 98.2% ahead of publication (frontmatter quoting and key-trim edges, primitive-input placeholder substitution, system-key omission, the pre-call abort guard); the three residual survivors are documented equivalent mutants.

## v0.9.6 — 2026-07-17

### Added

- `docs/blueprint.md`: a standard app architecture for building on Fascicle — one composition layer, three adoption tiers, markdown prompts, normalized module shapes, stub-engine testing, and field-observed anti-patterns distilled from the example apps and production consumers.
- Three ast-grep boundary rules wired into `examples/pr-improve` (runnable via `check:rules`): `create_engine` confined to `engine.ts`, no imperative loops in `flow.ts`, and Fascicle value imports confined to the files allowed to know about it.

## v0.9.5 — 2026-07-12

### Fixed

- **`claude_cli` provider structured output.** `compile_schema` now strips the top-level `$schema` (draft-2020-12 URI) and `$id` keys that `z.toJSONSchema` (zod v4) stamps, which `claude --json-schema` rejects. Any `model_call` on the `claude_cli` provider that passed a zod `schema` previously errored out of the box; structured output now works end-to-end.

## v0.9.4 — 2026-07-12

### Internal

- Hardened mutation-test coverage for the shared engine orchestration core: `generate.ts` (77.6% -> 95.79%) and `tool_loop.ts` (83.7% -> 94.59%), via new test suites for streaming dispatch, HITL approval, schema repair, cost/finish accounting, and the timeout/retry machinery.
- Ratcheted the Stryker break/low thresholds from 83 to 84 (full-repo score now 88.33%); documented the remaining equivalent/unreachable mutants inline with `Stryker disable` annotations rather than adding runtime guards.

## v0.9.3 — 2026-07-11

### Internal

- Hardened mutation coverage of the native Anthropic provider (`anthropic_native.ts`) from 73.9% to 98.2%, adding ~900 lines of targeted tests across request/message mapping, the streaming aggregator, the usage/stop maps, and error-classification and SSE-drain paths.
- Simplified the sampling-param branch in `build_messages_body` (redundant `else if` collapsed to a plain `else`, since the inner guards already gate each key) and annotated the remaining equivalent mutants with scoped Stryker disables.
- Ratcheted the mutation-testing break gate from 82 to 83 (full-repo score now ~86.8%).

## v0.9.2 — 2026-07-11

### Added

- **Native provider transport.** Model calls now flow through a neutral native provider contract instead of routing exclusively through the AI SDK. This release lands native Anthropic (mapping, streaming, capabilities, auth), a native OpenAI-compatible core that backs `openai`, `openrouter`, and `lmstudio`, and native Ollama on its `/api/chat` endpoint. The AI SDK becomes one transport behind the seam rather than the only path, and `provider_options` pass straight through to the native transport.
- **Open provider registry.** `custom_providers` on `EngineConfig` lets callers register their own providers, and the native provider contract is exported from the package barrel so those providers can be built against a stable type.
- **Loop knobs.** Per-turn timeout budgets and a `prepare_step` hook give callers control over each step of the tool loop.
- **OpenTelemetry surface.** A trajectory-to-otel bridge plus AI SDK telemetry passthrough emit spans for runs and model calls, with the agent-layer boundary ADR amended to record the seam.

### Changed

- **Breaking: the `subprocess` provider is renamed to `external`.** Update any `provider: "subprocess"` configuration to `provider: "external"`.
- The native provider seam is now the default dispatch path; the AI SDK transport is selected behind it rather than assumed.

### Internal

- Mutation coverage hardened across the native providers (`openai_compatible_native`, `ollama_native`), the otel surface, and `with_providers` in `create_engine`, with the Stryker break gate ratcheted up at the final gate.
- Transport parity golden tests plus an OpenRouter live smoke lock the native and AI SDK transports to identical observable behavior.
- The release skill now detects the previous release from the most recent git tag rather than the last `vX.Y.Z` commit message.

## v0.9.1 — 2026-07-10

### Internal

- Re-pinned every GitHub Actions dependency to its Node 24 runtime major (`actions/checkout` v7, `actions/setup-node` v6, `pnpm/action-setup` v6, `actions/cache` v6, `actions/deploy-pages` v5), clearing GitHub's Node 20 runtime deprecation warning that surfaced on the v0.9.0 publish run. Workflow-only change; the published package is byte-identical to v0.9.0.

## v0.9.0 — 2026-07-10

### Changed

- **Breaking (peer dependencies): AI SDK v7.** The `ai` peer floor is now `^7.0.0` with no v6 compatibility window, and every AI SDK provider peer moves to its v7-line major: `@ai-sdk/anthropic` `^4`, `@ai-sdk/openai` `^4`, `@ai-sdk/google` `^4`, `@ai-sdk/amazon-bedrock` `^5`, `@ai-sdk/openai-compatible` `^3`, `@openrouter/ai-sdk-provider` `^3`, `ai-sdk-ollama` `^4`. Upgrade the whole set together. Fascicle's own API is unchanged: the v7 renames (`system` to `instructions`, `fullStream` to `stream`, `experimental_output` to `output`, `stepCountIs` to `isStepCount`) land at the SDK boundary only, so `generate({ system })` and friends keep their names.
- Usage and cost accounting is verified against v7's nested token-detail shape (`inputTokenDetails`/`outputTokenDetails`, cache-inclusive `inputTokens`, reasoning-inclusive `outputTokens`) with concrete-value tests per provider. On `@ai-sdk/anthropic` v4, cache read and write tokens now fold into `inputTokens` upstream, which makes Fascicle's cost subtraction formula exact instead of skewed for cache-heavy Anthropic calls.

### Fixed

- Streamed `step_finish` chunks now carry the same cached-input/cache-write/reasoning usage granularity as the non-streamed step record (`default_usage_from_sdk` delegates to the provider usage normalizer).
- The `lmstudio` (OpenAI-compatible) provider opts into streaming usage (`stream_options.include_usage`), so streamed calls report real token counts instead of zeros on spec-strict OpenAI-compatible servers such as Ollama's `/v1` endpoint.

### Internal

- Releases are now published from CI with npm Trusted Publishing (OIDC) and a signed provenance attestation, gated by a required-reviewer GitHub Environment (`.github/workflows/publish.yaml`). No long-lived npm token exists anywhere; verify a release with `npm audit signatures`. This makes v0.9.0 the first provenance-attested Fascicle publish (see `research/provenance-publish-spec.md`).
- Agent-layer boundary ADR: Fascicle stays on the single-turn seam (`generateText`/`streamText`) and declines the v7 agent layer (`ToolLoopAgent`, `WorkflowAgent`, `HarnessAgent`, `toolApproval`, `@ai-sdk/otel`), recorded in `research/explorations/2026-07-ai-sdk-agent-layer-boundary.md` and linked from `docs/providers.md`.
- `examples/live-smoke/main.ts`: a manual release smoke gate that runs one tool-loop flow streamed and non-streamed against OpenRouter and an OpenAI-compatible backend, checking the tool round trip, stream/record text parity, and usage/cost accounting. Live network, so it stays out of the test suite by design.
- Dev toolchain sweep: vitest 4.1.10, oxlint 1.73, oxlint-tsgolint 0.24, tsdown 0.22.3, zod 4.4.3, `@types/node` 26, fallow 3, and friends.

## v0.8.16 — 2026-07-07

### Added

- `fascicle/ui` subpath for streaming a run into an AI SDK `useChat` UI: `to_ui_message_response`, `pipe_ui_message_stream_to_response`, and `to_ui_message_chunks` translate trajectory `model_chunk` events onto the AI SDK UI message wire. Ships with `docs/human-in-the-loop.md` and `examples/hitl-http/main.ts` covering suspend/confirm/resume over HTTP.

### Changed

- `model_call` now records `model_chunk` on the trajectory (via `trajectory.record`) instead of routing it through `ctx.emit`, so consumers see a clean top-level `model_chunk` event carrying the `StreamChunk` rather than one wrapped in a generic `emit`.

### Fixed

- Disabled the AI SDK's built-in retry (`maxRetries: 0`) on the generate and stream calls. The engine already owns retry via its retry policy; the SDK's default of 2 nested a second retry loop inside every attempt, inflating provider round-trips and distorting backoff.

## v0.8.15 — 2026-07-07

### Added

- `Tool.ends_turn` (default off): mark a tool terminal so a successful call ends the tool loop deterministically instead of feeding the result back for another model turn. The call executes normally (its output is recorded on the `ToolCallRecord`, fed to history as a tool result, and emitted as `tool_call`/`tool_result` trajectory events and a `tool_result` chunk), then the loop stops with `finish_reason: 'stop'`. Only a successful execution ends the loop: a denied, invalid, dropped, or throwing terminal call is fed back like any other tool error and the loop continues. A terminal finish wins over a coincident `max_steps` cap (a clean `stop`, with `max_steps_reached` still false), and a salvaged terminal call (`tool_call_repair_attempts`) ends the loop identically. Existing loops are unaffected: `ends_turn` undefined preserves prior behavior exactly.

## v0.8.13 — 2026-07-07

### Added

- Two opt-in, provider-agnostic reliability options for `generate` that make local-model tool loops survivable. Both default to off, so existing behavior is unchanged.
  - `tool_call_repair_attempts` (default `0`): when a step returns text with no structured tool calls, salvage a call the model emitted as assistant text in Hermes (`<tool_call>{...}</tool_call>`), bare/`json`-fenced, or Qwen3-Coder XML form. A candidate runs only if its name resolves and its arguments validate against the tool's `input_schema`, so plain JSON-in-prose never false-positives. Salvaged calls run the normal execute path and are marked `salvaged` (with `salvaged_format`) on their `ToolCallRecord`, plus a `tool_call_salvaged` trajectory event. The budget is shared across the whole call, including schema-repair passes.
  - `max_tool_calls_per_step` (default unlimited, must be `>= 1`): execute only the first N tool calls of a step and drop the rest for that turn (the model can re-issue them next turn). Dropped calls surface as `ToolCallRecord`s with `error.message: 'dropped_max_tool_calls_per_step'` and a `tool_calls_dropped` event. Set to `1` for runtimes that mishandle parallel tool calls.
- Both options are threaded through `EngineDefaults` (same per-call-wins merge rule) and `model_call`. The subprocess `claude_cli` provider records `option_ignored` for each, since it does not run the shared tool loop.

## v0.8.12 — 2026-07-04

### Fixed

- `pipe` and `sequence` now validate their arguments at construction time instead of failing deep inside a running flow. Passing a Step where `pipe` expects a plain function (a common mistake when assuming `pipe` is variadic) now throws immediately with a message suggesting `sequence([...])`; `sequence` similarly rejects non-array or non-Step children up front.

## v0.8.11 — 2026-07-03

### Added

- `fascicle/stdio`: run any flow as a single-shot child process with `run_stdio(flow, options)`. Reads JSON from stdin, optionally validates it against a zod `input_schema`, runs the flow, optionally validates the result against an `output_schema`, and writes exactly one JSON document to stdout. Exit code is the verdict (0 = result is authoritative, 1 = flow failure, 2 = contract violation), and a machine-readable failure object is always the last stderr line on non-zero exit.
- `stderr_logger` in `fascicle/adapters`: a JSONL trajectory logger to stderr, the default under `run_stdio` so stdout stays clean for the result envelope.

### Fixed

- `check-publish`'s `@arethetypeswrong/cli` step no longer silently truncates its report when the output exceeds the OS pipe buffer (first hit once the `./stdio` subpath pushed the report past 64 KiB).

### Internal

- Recorded the design rationale for the stdio agent contract as a research note.

## v0.8.10 — 2026-06-20

### Added

- Native constrained decoding for schema-constrained `model_call` on local providers (Ollama and LM Studio), exposed as a new `structured_output` provider capability: the schema now constrains the provider's decode (for example, Ollama's `format`) instead of prompting for JSON and scraping it, so local-model structured output no longer fails validation on the first call. The prompt-based path remains the fallback, and hosted providers are unchanged.
- Live GitHub star count on the marketing site's nav button.

### Internal

- Section taglines on marketing site sections 01, 02, and 05.

## v0.8.9 — 2026-06-19

### Internal

- Deepened mutation-testing coverage: bench (judge skipping on failed/undefined output, throwing-judge abstentions, non-finite cost filtering, nested `trajectory_dir` creation, live_url HTTP logging, run_id/flow_name resolution, concurrency limits, and the newly exported `normalize_score` helper), plus describe rendering and `define_agent` frontmatter.
- Added two Phase 3 essays latent in the codebase and updated the roadmap to reflect the Phase 2 MCP ship and the start of the memory system.
- Added `frontmatter` to the cspell dictionary.

## v0.8.8 — 2026-06-19

### Added

- `fascicle/mcp` bridge: serve any flow over the Model Context Protocol with `serve_flow`, and call MCP tools from inside flows with `mcp_client`.

### Changed

- Release pipeline now emits a GitHub Release from the pushed tag instead of publishing to npm; CI workflows hardened (third-party actions pinned to commit SHAs, persisted credentials dropped, tag jobs env-guarded).

### Internal

- Large mutation-testing campaign raised the real Stryker score from ~61% to ~81% and ratcheted the break gate 50 → 70 → 78. Added genuine tests across the MCP bridge, engine errors, the provider adapters (openai, google, openrouter, bedrock, lmstudio, ollama), model_call, both retry paths, schema, regression, tool_loop, generate (pure helpers and orchestration), composites/judges, claude_cli spawn and sandbox, the viewer HTTP server, the researcher agent, and the core branch/map/timeout/pipe combinators.
- Froze the ridgeline build specs and centralized planning in the roadmap.

## v0.8.7 — 2026-06-18

### Internal

- Added security policy, troubleshooting guide, API reference, and a comparison page under `docs/`.
- Reorganized project docs: reconciled `spec/`, `plans/`, and `adr/` into `docs/` and `research/`, and relocated the core and viewer READMEs into `docs/`.
- Added shared research diagrams (architecture layers, the 20 `STEP_KINDS` taxonomy, and the trajectory event pipeline) as Mermaid sources under `research/diagrams/`.

## v0.8.6 — 2026-06-18

### Internal

- Consolidated the `observability/` and `stores/` modules plus the `adapters.ts` umbrella into a single flat `src/adapters/` module with one barrel, renaming files to match their factories (`filesystem_logger.ts`, `filesystem_store.ts`, …) and retiring the `#observability`/`#stores` import aliases in favour of `#adapters`. The published `fascicle/adapters` subpath and its exports are unchanged.

## v0.8.5 — 2026-06-18

### Internal

- Restructured every `index.ts` barrel to be import/export only, moving inline logic into named sibling files (`agent.ts`, `start_viewer.ts`, `adapter.ts`, `make_builder_tools.ts`); public exports are unchanged.
- Added `rules/no-logic-in-barrel.yml` (ast-grep) to keep barrels declaration-free, with a documenting note in `AGENTS.md`.

## v0.8.4 — 2026-06-18

### Internal

- Relocated each module's `test/` tree to `__tests__/`, lifted the shared SIGINT loader bootstrap and core wiring integration test to a repo-root `test/` tree, and updated cspell, fallow, and ast-grep rule globs to match.
- Dropped lockstep versioning in favor of a single root manifest, so a bump now rewrites exactly one version field.

## v0.8.3 — 2026-06-18

### Added

- npm `keywords` covering core concepts, the AI SDK ecosystem, and every supported provider, so the package surfaces in npm search.

### Changed

- Package metadata now points at the new documentation and marketing site: `homepage` links to https://robmclarty.github.io/fascicle/, and the npm description leads with the "compose agents like plain values" pitch.

### Fixed

- The documentation site listed only 16 composition primitives; it now lists all 18, with the missing `loop` and `compose` entries added to both the homepage chip list and the API reference.

### Internal

- GitHub Pages serves the static site without a generator step, oxlint ignores `site/**`, and the runtime task lock is excluded from version control.

## v0.8.2 — 2026-06-18

### Added

- Published a project site to GitHub Pages: a landing page (`index.html`), a docs page (`docs.html`), and a support script, deployed by a new `Deploy Pages` workflow that uploads the `site/` directory as a Pages artifact on every push to `main`.

### Internal

- No change to the published `fascicle` surface or bundle. Renamed the existing `ci` and `release` workflow files from `.yml` to `.yaml` so every workflow shares one extension.
- Realigned the docs to the v0.7.0 Bedrock provider and dropped stale model-alias mentions.

## v0.8.1 — 2026-06-17

### Internal

- Documentation only (no change to the published surface or bundle): realigned the live docs to the single-package `src/` layout introduced in v0.8.0. Fixed stale `packages/<x>` references (README links, the provider types path, the live-test path and command), rewrote `configuration.md` to read credentials straight from `process.env` now that the `@repo/config` module is gone, updated the harness layout note to the `#<module>` aliases, and refreshed the roadmap (Phase 1 marked shipped, the MCP tools adapter flagged as the next pending task).

## v0.8.0 — 2026-06-17

### Changed

- Collapsed the internal pnpm workspace (the nine `@repo/*` packages) into a single package with `src/<module>/` deep modules. The published `fascicle` surface is unchanged — same exports, same bundle, same install; this restructures the repo's source layout and dev-time tooling only.

### Internal

- Cross-module access is sealed through barrel-only `#<module>` import aliases (declared in `package.json` `imports`, mirrored in `tsconfig.json` paths and the vitest alias); `rules/no-cross-module-relative-import.yml` closes the relative-path escape, so every module is reachable only through its `index.ts`.
- Replaced the per-package manifest dependency graph with a directory-level default-deny boundary DAG in `fallow.toml`, plus `no-core-npm-dep-except-zod` and `no-engine-npm-dep-except-ai-zod` ast-grep rules that recover the old `check-deps.mjs` dependency-shape invariants at the import level.
- Removed the unused `config` module; examples now import the published surface (`fascicle`, `fascicle/adapters`, `fascicle/agents`) and depend on the library via `fascicle: workspace:*`.
- Realigned AGENTS.md, README, docs, and `.ridgeline/{taste,constraints}.md` to the single-package layout (taste Principles 15 and 16 rewritten).

## v0.7.0 — 2026-06-16

### Added

- **AWS Bedrock provider.** A new `bedrock` adapter reaches Bedrock-hosted models (Claude, Llama, Nova, …) through the `@ai-sdk/amazon-bedrock` optional peer, wired like every other AI SDK provider: `create_engine({ providers: { bedrock: { region, ... } } })`, then `generate({ provider: 'bedrock', model: '<bedrock-model-id>' })`. Authenticates with a Bedrock API key (bearer), SigV4 keys, or the ambient AWS credential chain; `region` is required. Reasoning effort maps to Bedrock's `reasoningConfig.budgetTokens` for Claude models. Adds `BEDROCK_*` config env vars and `get_bedrock_*` getters in `@repo/config`.

### Changed

- **Breaking: model resolution is now a verbatim pass-through.** `model` is an opaque string sent to the provider unchanged; `provider` selects the transport. One canonical input shape remains — separate `provider` + `model` params — with no interpretation in between.
  - Removed the `provider:model` colon shorthand. Pass `{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }` instead of `model: 'openrouter:anthropic/claude-sonnet-4.5'`. Model ids that contain colons (Ollama tags like `qwen3-coder:30b`, Bedrock `...-v1:0`) now ride through untouched.
  - Removed the built-in `MODEL_FAMILIES` catalog and the `families` engine-config field. Family tokens (`opus`, `sonnet`, `gpt`, `gemini`) no longer expand — pass the provider's concrete id. (The `claude_cli` transport still resolves `opus`/`sonnet`/`haiku` itself, via the CLI.)
  - Removed the user alias table: `Engine.register_alias` / `unregister_alias` / `resolve_alias` / `list_aliases` and `EngineConfig.aliases`. Keep your own name→id map in your harness if you want shortcuts.
  - `generate` with no `model` and no `defaults.model` now throws the new `model_required_error` (previously fell back silently to `sonnet`).

### Removed

- **Breaking:** types `AliasTable` and `FamilyCatalog`, and errors `model_not_found_error` and `model_family_unavailable_error`. The resolved-target type `AliasTarget` is renamed `ResolvedModel` (`{ provider, model_id }`).

## v0.6.3 — 2026-06-11

### Fixed
- CI `pnpm install --frozen-lockfile` no longer fails with `ERR_PNPM_IGNORED_BUILDS`; the `esbuild` build script is now approved in the `allowBuilds` map, classifying a transitive dependency that a recent toolchain bump introduced.

## v0.6.2 — 2026-06-11

### Internal
- Stopped tracking the local `.codegraph` tooling config (`config.json` and its `.gitignore`). These are per-machine artifacts and no longer belong in version control.

## v0.6.1 — 2026-06-11

### Fixed
- AI-SDK adapter: the caller's `system` prompt is now delivered through the AI SDK's top-level `system` option instead of as a `role: "system"` entry in the `messages` array. This removes the SDK's "System messages in the prompt or messages fields can be a security risk..." warning that fired on every `generateText`/`streamText` call (most visibly on non-Claude providers, flooding build logs), without changing what the model receives. A leading run of system messages is joined into the single `system` option; the `claude_cli` subprocess transport is unaffected.

## v0.6.0 — 2026-06-10

### Added
- Observability now produces correct span trees: `parent_span_id` is populated so nested spans nest, events carry timestamps, tool results are recorded, and `claude_cli` errors are surfaced instead of being dropped.

### Fixed
- **Security.** The sandbox now isolates the network entirely when the allowlist is empty, instead of leaving it open.
- Packaging: the `./adapters` subpath is now published and the package front door (main export) resolves correctly.
- Engine: `provider_options` are threaded through to the provider and reasoning-effort translation is corrected.
- Core: composers no longer swallow control-flow signals.
- Addressed adversarial-review and publish-audit findings across the library and the examples.

### Internal
- Docs reconciled with the shipped API, plus a snippet typecheck harness and CI step that validate doc snippets against the built types.
- Added the release workflow, base CI workflow, opt-in live-provider smoke tests, roadmap, a Stryker baseline note, and the committed `pnpm-lock`.

## v0.5.0 — 2026-06-03

### Added
- Two-axis model resolution. `model` now names either a **family** (`opus`, `sonnet`, `haiku`, `gpt`, `gemini` — "latest of that family") or a specific vendor id (`claude-opus-4-8`), and a new `provider` axis names the transport (`anthropic`, `claude_cli`, `openrouter`, …). `provider` is accepted per-call on `generate` / `model_call` and as an engine default; the same `model: 'opus'` now runs on any transport by swapping `provider`.
- `MODEL_FAMILIES` catalog mapping each family to the latest id per provider, plus a `families` engine-config field that deep-merges per `(family, provider)` so you can pin newer ids or add new families. Exported `FamilyCatalog` type.
- `examples/swebench`: `claude_cli` provider option, selectable via `SWEBENCH_PROVIDER`.

### Changed
- **Breaking.** `create_engine` no longer ships default aliases — the alias table starts empty and is reserved for your own named pins. The built-in `cli-*`, `or:*`, `gemini-pro`/`gemini-flash`, and `gpt-4o*` aliases are gone; use `{ model, provider }` pairs (for example, `{ model: 'sonnet', provider: 'claude_cli' }`) or the colon form (`openrouter:meta-llama/llama-3.3-70b-instruct`).
- **Breaking.** `resolve_model` signature is now `resolve_model(model, provider, { families, aliases })`. Resolution order: colon-form `provider:id` → user alias → family lookup → pass-through specific id. When `model`/`provider` are omitted, `model` defaults to `sonnet` and `provider` resolves to per-call → `defaults.provider` → the sole configured provider → `anthropic`.

### Fixed
- A family with no entry for the chosen provider (for example, `opus` on `openai`) now throws the descriptive `model_family_unavailable_error` instead of the generic not-found path.

## v0.4.3 — 2026-05-10

### Added
- `examples/swebench` — 5-instance smoke harness against SWE-bench Verified. Ships a `Sandbox` seam (`noop` / `local` / `docker` factories), five per-case tools (`read_file`, `write_file`, `run_command` argv-only, `list_files`, `grep_files`), a `solve_instance` flow that captures `git diff` against `base_commit`, and `evaluate_with_sb_cli` for the real eval. Scaling to the 500-instance Verified set is a scale change, not a shape change.
- `examples/pr-improve` Phase C, PR B: builder dispatches by provider. `make_builder_call` now takes `worktree_root` and `provider` explicit params; under `claude_cli` it keeps the schema-only path that delegates to the CLI's built-in Read/Write/Edit, and under API providers (`anthropic`, `openrouter`) it returns a `model_call` configured with the worktree-scoped tools from `make_builder_tools(worktree_root)`. The `Step<string, GenerateResult<Handoff>>` contract is unchanged; `flow.ts` ripples in one place via a new `FlowEnv = { worktree_root, provider }` arg to `build_flow`. The portability proof (same end-to-end result under `--provider claude_cli` and `--provider anthropic`) is now live.

### Internal
- `examples/pr-improve`: split `CLOUD_SPEC.md` out as the active spec for the remaining AWS/Fargate/Terraform deployment work (Fargate worker, webhook Lambda, single Terraform module). `SPEC.md` keeps a deprecation banner and is preserved as historical context.
- `examples/pr-improve` `post_improvement_pr`: dropped the "re-run with `--provider claude_cli`" hint from the no-edits follow-up message, now obsolete since API providers also edit files.
- `vitest.config.ts`: include `examples/pr-improve/src/stages/**/*.{test,spec}.ts` so the new builder-dispatch test runs alongside the tool tests.

## v0.4.2 — 2026-05-09

### Added
- `examples/pr-improve` Phase C, PR A: worktree-scoped builder tools and a safety harness. The builder runs in an isolated git worktree (clean cwd, branch named `fascicle/improve-<n>`) and gets bounded `read_file`, `write_file`, `edit_file`, `list_dir`, and `run_shell` tools that refuse paths outside the worktree, follow no symlinks past the root, and cap stdout/stderr per call.
- `@repo/engine` `claude_cli` provider: typed parsing for `rate_limit_event` stream lines. Trajectories now record a structured `cli_rate_limit_event` (status, rate-limit type, reset times, overage flag) instead of falling through to opaque `cli_unknown_event` blobs. Every field is optional in the schema for forward-compat with future CLI variants.

### Changed
- `@repo/engine` `parse_with_schema` now surfaces the first parseable candidate's schema-validation error, not the last. With multi-candidate JSON extraction (text → fenced blocks → outermost-brace slice → outermost-bracket slice), the bracket-slice fallback could grab an inner array and produce an "expected object, received array" error that buried the real shape mismatch and actively misdirected the schema-repair prompt. The first JSON-parseable candidate represents the model's intent and is what repair feedback should describe.

### Fixed
- `examples/pr-improve` stage prompts: the pragmatist, builder, and build-reviewer system prompts now describe their JSON output contracts explicitly — exact field names, length caps, and an emphatic "JSON only" footer (especially important for the builder, which uses tools and was previously ending its turn with markdown narration). Without the schema spelled out, models invented field names (`id` for `suggestion_id`, `summary` for `one_liner`) or exceeded the 120-char `one_liner` cap, exhausting the schema-repair budget.
- `examples/pr-improve` `run_shell` (auto-applied via PR #5): stream-byte caps now use `Buffer.byteLength` instead of UTF-16 string length, so non-ASCII output is truncated at the correct byte count. Promise settlement is deferred to the `close` event so `AbortController`-driven timeouts return `RunShellOutput { timed_out: true }` instead of always rejecting from the abort-triggered `error` event. Spawn environment strips `ANTHROPIC_*`, `GITHUB_*`, and `AWS_*` keys to prevent credential exfiltration via model-controlled commands.
- `examples/pr-improve` `read_file` / `edit_file` (auto-applied via PR #5): replaced the post-assert `stat()` with `lstat()`, closing a race window where a symlink swapped in after the initial symlink guard could be silently followed.
- `examples/pr-improve` `claude_cli` stall timeout bumped from the 5-minute default to 15 minutes. The default watchdog tripped on legitimate long thinking phases when the CLI's between-turn heartbeat events (session/rate-limit) fired infrequently.
- `examples/pr-improve` `run_shell` error narrowing now uses `'code' in err` type guards instead of unsafe casts to `{ code?: unknown }`. The auto-applied improvement landed casts that the project's `no-unsafe-type-assertion` rule rejected, breaking `pnpm check` on main.

### Internal
- `examples/pr-improve` docs: marked Phase B done and detailed the Phase C tool surface.

## v0.4.1 — 2026-05-09

### Added
- `examples/pr-improve`: an automated PR-improvement pipeline composed as a four-stage Fascicle flow — reviewer (sonnet) → pragmatist (opus, default-reject) → builder (sonnet) → build-reviewer (opus) — inside a bounded `loop` with `guard`-driven convergence. Routes every model call through the engine, so the same flow runs against `anthropic`, `openrouter`, or a local `claude_cli` subprocess by changing one env var. Includes `--pr` mode for posting review suggestions back to a GitHub PR via safe-spawn `gh`/`git` wrappers, and a `bin/pr-improve` entrypoint.

### Fixed
- `@repo/engine` schema validation: `schema.ts` now tolerates fenced JSON code blocks in model output and emits a new `schema_validation_failed` trajectory event when validation fails, instead of throwing without observability. `generate.ts` extracts multiple JSON candidates from a single response and picks the first that parses, recovering from leading prose or partial fences.
- `@repo/engine` `claude_cli` provider: schema-repair attempt count is now configurable (was hard-coded), giving callers control over the retry-vs-fail-fast tradeoff.

## v0.4.0 — 2026-05-07

### Fixed
- `claude_cli` adapter: `build_env` now seeds the standard process-env keys (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`) under every `auth_mode` (was only inherited under `oauth`). Sandbox-enabled runs under `auto`/`api_key` previously spawned with an empty `PATH` and failed with `ENOENT` looking up `greywall`/`bwrap`. Set `inherit_env: false` to opt out of the standard-key seeding.
- `claude_cli` adapter: greywall sandbox plan now writes a temp settings JSON (`{ network: { allowHosts }, filesystem: { allowWrite } }`) and forwards `--settings <path>` instead of the removed `--allow-host`/`--rw` flags. greywall 0.3.0+ rejected the old flags as unknown and exited 1. Consumers managing their own settings file can pass `sandbox.settings_path` to skip the temp-file generation.
- `fascicle-viewer` CLI: replaced the fragile `argv[1].endsWith('/cli.ts'|'/cli.js')` self-execution guard with an `import.meta.url`-based check. The umbrella bundles `cli.ts` into `dist/index.js`, so any consumer whose entry script was named `cli.js` was accidentally hijacked into running the viewer at import time.

## v0.3.8 — 2026-05-06

### Fixed
- `examples/mcp-server/` lint failures that blocked `prepublishOnly`: rewrote the `reverse_text` tool to use `Intl.Segmenter` + `Array#toReversed()` (grapheme-correct, lint-clean), and replaced the chained `as` casts in `client.ts:text_of` with a small `is_record` user-defined type guard. Smoke test output unchanged.

## v0.3.7 — 2026-05-05

### Added
- Public `fascicle/adapters` subpath exposing `filesystem_logger`, `filesystem_store`, `http_logger`, `tee_logger`, and `noop_logger`. Previously these adapters lived in workspace-private packages and were unreachable by `npm install fascicle` consumers despite being referenced throughout the docs.
- Minimal stdio MCP server example under `examples/mcp-server/`, demonstrating how to expose a `Step<i, o>` as an MCP tool.
- `CONTRIBUTING.md` with contribution guidelines, linked from the README.

### Changed
- README hero illustration is now an animated mycelium diagram showing model_call, step, and tool fruiting from a shared substrate; viewer screenshot moved into the live-dashboard section.
- Documented two adapter limits in `docs/concepts.md`: `filesystem_logger` writes synchronously via `appendFileSync`, and the in-memory span stack in `filesystem_logger`/`http_logger` is not async-context-aware. README, getting-started, cookbook, and writing-a-harness all cross-reference the new "Adapter limits" section.
- README primitives count corrected to 18, with `loop` and `compose` listed in the table.

### Internal
- Added `docs/plans/menu.md` cataloguing considered-but-unshipped work.

## v0.3.6 — 2026-04-30

### Added
- `bench` primitive in `@repo/composites`: online counterpart to `learn`. `bench(flow, cases, judges, options?)` runs a flow against a fixture set, scores each output via judges, and returns a structured `BenchReport` with per-case results and summary (pass_rate, mean_scores per judge, total/mean cost). Per-case observability via `trajectory_dir` (one JSONL per case) and `live_url` (push to a viewer); both can be combined. Cost is tracked in-process by intercepting `cost` events on the trajectory pipeline.
- `judge_equals`, `judge_with`, `judge_llm` in `@repo/composites`: stock judges over `{ input, output, meta }`. `judge_llm` takes a `Step<string, string>` model so composites stays engine-free; users wire their own `model_call({...})` into the judge.
- `regression_compare`, `read_baseline`, `write_baseline`: diff two `BenchReport`s against `pass_rate`, per-judge means, and a relative cost threshold (default 10%). Doesn't short-circuit; full delta + per-case report.
- `tee_logger` adapter in `@repo/observability`: fan one `TrajectoryLogger` contract out to N sinks. First sink's `start_span` id is canonical, and per-sink ids are translated back on `end_span`. Sinks that throw don't derail the others.
- `examples/bench-reviewer/main.ts` + `bench/reviewer/{cases.json,baseline.json}`: end-to-end driver against `@repo/agents`'s `reviewer`. `WRITE_BASELINE=1` records, subsequent runs compare and exit 1 on regression.
- Cost rendering in the viewer: per-span cost badges that roll up the tree, plus a header running total (`<n> events · <m> errors · $<total>`). Run filter narrows the total. Cost attribution uses an open-span stack per `run_id`; format is 4 decimals under $0.01, 2 decimals otherwise.
- `examples/amplify` opt-in viewer push via `AMPLIFY_VIEWER_URL`: tees the on-disk trajectory with `http_logger` when set; standalone runs without the env var keep the existing single-sink behaviour.

### Changed
- The viewer ships as part of the `fascicle` umbrella. `start_viewer` is importable from `'fascicle'`; the `fascicle-viewer` bin ships with the published tarball at `dist/bin/fascicle-viewer.js` (with `dist/static/viewer.html` copied alongside). `scripts/check-deps.mjs` now asserts inclusion (was: isolation). Runtime install graph stays free of HTTP-server deps because the viewer only uses `node:*` + `zod` + `@repo/core`.
- README promotes the viewer to a headline surface section with `pnpm dlx fascicle-viewer` and the programmatic `start_viewer` shape.

### Internal
- `scripts/build.mjs` copies `viewer.html` into `dist/static/` and writes a tiny `dist/bin/fascicle-viewer.js` shim that drives `run_viewer_cli` from the bundled umbrella; smoke test asserts `start_viewer` and `run_viewer_cli` are exported.
- `spec/eval.md` records the four-wedge plan and seven open questions surfaced during execution (judge_llm wiring, judge abstention encoding, bench parallelism, baseline `run_id` non-determinism, two viewer UI papercuts, and the live-amplify dogfood result: 51 events, $0.1725 cost, both transports verified end-to-end).
- `spec/viewer.md` reframed packaging and §12 done-def items 2–3 marked verified.

## v0.3.5 — 2026-04-30

### Added
- `@repo/viewer` package and `fascicle-viewer` CLI: minimal in-repo dev dashboard for visualizing a Fascicle run as it executes. Single static HTML page (vanilla JS, no build step), an SSE-fed span tree with active/error/emit highlighting, and a click-to-expand event log. Two transports feed one in-process broadcaster: file-tail (`fascicle-viewer .trajectory.jsonl`) for the primary case and HTTP push (`fascicle-viewer --listen` plus the new `http_logger`) for low-latency or remote attach. Localhost-only by default. Programmatic embed via `start_viewer({...})`. See `packages/viewer/README.md`.
- `http_logger` adapter in `@repo/observability`: a `TrajectoryLogger` that POSTs each event as one line of NDJSON to a configured URL. Drops on transport error, never blocks the user flow. Wire format mirrors `filesystem_logger` byte-for-byte and parses back via `trajectory_event_schema`.

### Internal
- New ast-grep boundary rule (`rules/no-engine-import-from-viewer.yml`) keeps the viewer dev tool isolated from `@repo/engine`, composites, agents, the umbrella, stores, observability, and any provider SDK.
- `scripts/check-deps.mjs` gains a `check_viewer_isolation` invariant: `@repo/viewer` must not appear in `@repo/fascicle`'s dependency graph, so the published `fascicle` install graph stays free of HTTP-server deps.
- `spec/viewer.md` documents the v1 plan, scope boundaries, and the explicit non-goals that separate this dev tool from the larger `spec/studio.md` PDR.

## v0.3.4 — 2026-04-30

### Internal
- Switch to ASI-only style: trailing statement semicolons and multi-line interface/type-member separators removed across all TS sources.
- Add ast-grep rules (`no-semicolons`, `no-semicolons-types`) and a small orchestrator script (`scripts/strip-semicolons.mjs`) wired into `check:fix` to enforce the style going forward.

## v0.3.3 — 2026-04-29

### Added
- `improve` composite in `@repo/composites`: bounded online self-improvement loop with parallel proposers, structured lessons accumulator, plateau detection, and configurable wall-clock + round budgets. Online counterpart to `learn`. Example at `examples/improve/main.ts`.
- `ensemble_step` composite: Step-based sibling of `ensemble` for cases where scoring is itself a `Step`. Returns `winner_id`, `winner`, structured `winner_scored`, and the full `scored` map.

## v0.3.2 — 2026-04-29

### Added
- `@repo/agents` package: markdown-driven `define_agent` loader plus `reviewer`, `documenter`, and `researcher` agents. `reviewer` and `documenter` are markdown-defined; `researcher` is bespoke TypeScript that drives `loop` from core over injected `search`/`fetch` callables, with a per-round summarizer that itself uses `define_agent`.
- Examples wiring each new agent against an in-process stub engine, plus an end-to-end `learn_reviewer` demo that runs the reviewer over three diffs (writing JSONL via `filesystem_logger`) and feeds the directory to `learn` to derive prompt-tightening proposals.

### Internal
- Tightened `learn` tests in `@repo/composites` around truncation events and `flow_description` equality.

## v0.3.1 — 2026-04-29

### Internal
- Colocated unit tests under `__tests__/` subfolders (for example, `packages/core/src/branch.ts` ↔ `packages/core/src/__tests__/branch.test.ts`); cross-cutting tests under `packages/<name>/test/` are unchanged.

## v0.3.0 — 2026-04-29

### Added

- New core primitives `loop` and `compose`, plus a universal `name?` option on every composer.
- New `learn` composer in `@repo/composites` for offline self-improvement, with file-path and directory sources, exported from the package index.
- `amplify` self-improvement loop example with a demo helper providing chart, measure, and reset utilities.
- `learn` example with smoke test.
- `EffortLevel` extended with `xhigh` and `max`, and reasoning support added to the `claude_cli` adapter.
- `spec/plans/ideas.md` capturing possible directions to build on Fascicle.

### Changed

- `adversarial`, `ensemble`, `tournament`, and `consensus` extracted from `@repo/core` into a new `@repo/composites` package.

### Fixed

- `loop` type parameter renamed from `out` to `o` so tsx can parse the source.

### Internal

- Codegraph config plus ignore rules for db/cache files.
- Gitignored the rgr example trajectory output (per-run telemetry).
- Repaired the amplify cascade under tsc 6.x and `pnpm exec`.
- Imported adversarial types directly in the rgr harness; drive-by lint fixes for `pnpm check:all`.

## v0.2.0 — 2026-04-26

### Added

- Phase 0 library surfaces preparing for an upcoming `fascicle-studio` web UI: a `STEP_KINDS` const string union (plus `is_step_kind` and `StepKind`), structured Zod schemas for the trajectory wire format (`span_start_event_schema`, `span_end_event_schema`, `emit_event_schema`, `custom_event_schema`, and the combined `trajectory_event_schema`) configured to allow unknown fields so additional metadata survives a parse / re-serialize round-trip, an optional third-form `step(id, fn, meta?)` overload with `StepMetadata` (display name, description, port labels) echoed on `FlowNode` by `describe.json`, and automatic `run_id` stamping on every emitted trajectory event (a caller-supplied `run_id` is preserved). All re-exported through the `fascicle` umbrella.
- Contract tests locking the studio-facing invariants: `describe.json` is stable per `Step` instance, every emitted event id matches a node id in the flow tree, every event carries `run_id`, and every primitive's `kind` is in `STEP_KINDS`.
- Studio design doc plus parallel research notes at `spec/studio.md` and `spec/research/` capturing decisions for the sibling `fascicle-studio` repo.
- A red/green/refactor TDD harness example at `examples/red-green-refactor/`.
- `docs/til.md` with extracted snippets from pre-squash history.

### Changed

- Dropped the npm scope from the published name (now `fascicle`). README streamlined.
- `prepublishOnly` no longer runs the Stryker mutation check; it stays available via `pnpm check:all`.

## v0.1.13 — 2026-04-25

Initial public release. Fresh git baseline — prior internal commit history is intentionally not carried forward.

The v0.1.13 surface:

- Composition layer (`fascicle` / internal `@repo/core`) — 16 primitives (`step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`/`stash`/`use`), `run`, `run.stream`, `describe`.
- AI engine layer (`@repo/engine`) — `create_engine(config)` returning a unified `generate` surface over seven Vercel AI SDK provider adapters: Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, and a `claude_cli` subprocess adapter that drives the Claude Code CLI.
- Adapter packages — `@repo/observability` (trajectory loggers), `@repo/stores` (checkpoint stores).
- Check pipeline — `pnpm check` / `pnpm check:all` orchestrate types, lint, struct (ast-grep), dead-code (fallow), tests, docs, spell, and opt-in mutation testing (Stryker).
