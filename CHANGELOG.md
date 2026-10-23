# Changelog

## Unreleased

### Added

- **`assert_prefix_stable` checks that a tool loop only appends.** A provider's prompt cache matches a request by its prefix, so a loop that rewrites the system prompt, the tools, or an earlier message misses the cache on every turn, and nothing failed to say so. `assert_prefix_stable(requests)` reads what `make_loop_engine` recorded and throws a plain `Error` at the first turn that changed what the turn before it sent, naming the call, the step, and the difference, as in `call 1, step 2: message 3 differs from step 1`. It compares messages as JSON text, the way the wire sends them, and tool schemas by reference first and then as JSON Schema. It splits calls wherever `step_index` doesn't increase, so it reads calls that ran one at a time, and a `parallel` flow takes one double per branch. [testing.md](./docs/testing.md#assert_prefix_stable) has the check and a recipe for testing a tool loop keyless.
- **`make_loop_engine` runs a script under the engine's own tool loop.** The three doubles in `fascicle/testing` stand in for the whole engine, so no tool loop runs under them, and a test of a flow whose model calls use tools couldn't see the tools run, the approvals asked, or the results fed back. `make_loop_engine(turns)` builds a real engine with one provider, `'loop'`, that plays a turn of the script each time the loop asks the model for one, and it returns `{ engine, requests }`, where `requests` holds every request the model was sent, tool results included. A turn is a final-answer string, an array of calls, or an object that sets its text, calls, content parts, finish reason, or usage, or throws. A thrown error goes through the engine's retry as a provider's would, so a retried 503 uses up the next turn. [testing.md](./docs/testing.md#make_loop_engine) has the details, and the ACP tests run on it now.
- **The run canvas works under a path of its own.** The canvas was built with an absolute base and asked for `/api/trajectory` and `/api/events` by absolute path, so served at `/viewer/<id>/` behind a host's proxy, its scripts, its styles, its fonts, and both API requests all missed. Its assets and its API requests resolve against the page now, so a host can frame the canvas under any path that ends in a slash by proxying that path to a loopback viewer with the prefix stripped. The proxy sends the viewer a loopback `Host`, and [viewer.md](./docs/viewer.md#serving-under-a-path) has the details. Served at `/`, nothing changes.

### Changed

- **The native Ollama transport streams what the model thinks.** The daemon sends a thinking model's reasoning as `message.thinking`, frame by frame, before the answer, and the native transport read only `content` and `tool_calls`, so nothing reached `on_chunk` or the trajectory while the model thought, whether `think` was unset or `true`. Each frame's thinking dispatches as a `reasoning` chunk now, ahead of the frame's text, and it still joins no content part, since this wire takes no reasoning back. One consequence follows from the first chunk arriving sooner. A connection that drops while the model is thinking fails as `stream interrupted` instead of being retried, the way it already did once text had streamed.

### Fixed

- **A tool call that failed goes back to Claude marked as an error.** The loop feeds a failed call back to the model as `{"error": "…"}` text, whether the tool was unknown, its input failed validation, its approval was denied, or it threw, and no transport said that the text was an error, so Claude read it as what the tool returned. The tool message carries `is_error: true` now. The native Anthropic transport sends it as the `tool_result`'s `is_error`, and the `ai_sdk` transport sends an `error-text` output, a denial included, which `@ai-sdk/anthropic` turns into the same field. The content stays `{"error": "…"}` on every transport, so nothing that reads it breaks. The OpenAI-compatible and Ollama formats have no such field, and the Bedrock peer sends the text alone, even for Claude, so a model there reads the error from the content as it did before.
- **An ACP permission request leaves the kind of a card it didn't draw alone.** The request sent its call's card with `kind: 'other'` for any tool that the session's workspace tools don't cover, such as a check that a flow runs itself and opens as an `execute` card from its own `to_updates`. Zed applies a request's fields to the card that it already drew, so the moment the check asked, its card lost the terminal look and kept the plain one from then on, since nothing sent the kind again. A request names a kind only for a workspace tool now, and for any other tool it sends none, which leaves the card as its opening drew it.
- **`fascicle-viewer` says how a run ended instead of reading LIVE.** The header's chip showed the event stream's state and nothing else, so once a run's `run_end` arrived the clock froze but the chip kept reading LIVE for as long as the stream stayed open, and a finished trajectory read `● LIVE` from the moment it opened. The chip reads LIVE only while the run is going now. Once `run_end` arrives it reads DONE, FAILED, ABORTED, or SUSPENDED, in the white family like REPLAY, and CONNECTING and OFFLINE still show whenever the stream isn't open.
- **`throughput()` reads Ollama's own decode rate.** A step's window was `duration_ms - first_chunk_ms` whenever the turn streamed, and on Ollama a turn can finish generating before it dispatches anything. Ollama sends a tool call whole once it's generated, on either transport, and the native transport dispatched nothing while the model thought, so the window covered the last few milliseconds and the rate came out 100 to 1,600 times the daemon's own. Ollama reports the time it spent generating each step's output as `eval_duration` on both transports, and `throughput()` takes that as an Ollama step's window now, so the step measures `'decode'` exactly, streamed or not.

## v0.16.5 — 2026-10-21

### Fixed

- **A `claude_cli` session that isn't logged in says so.** A `claude -p` with no session to call with writes its reason to stdout, as a message in the model's place with the `authentication_failed` error code and an error result that reads "Not logged in · Please run /login", and it leaves stderr empty. The adapter read only stderr, so the call failed as `claude_cli_error: claude CLI exited with code 1:` with nothing after the colon. It reads the stream's error code as well now and throws `provider_auth_error` in the CLI's own words, `claude CLI reported an auth failure: Not logged in · Please run /login`, and any other failed exit with nothing on stderr carries the text of the CLI's error result. The error's `refresh_command` is `claude auth login`, since the CLI reads `claude login` as a prompt and opens a session.

### Internal

- The `claude_cli` examples and their READMEs say `claude auth login` where they said `claude login`.

## v0.16.4 — 2026-10-21

### Added

- **The package ships a primer for coding agents, as `dist/AGENTS.md`.** An agent in a project that installs Fascicle knows little or nothing about it from training, and the primer it needs lived only in the repository, at `docs/learn/agent-primer.md`, which a project could reach only by cloning. The build now copies it into the package, with each link into the docs pointed at the same file on GitHub at the release's tag, so a `CLAUDE.md` can import `@node_modules/fascicle/dist/AGENTS.md` and get the copy that matches the installed version. The README says where it is.

### Changed

- **A call with a `schema` shows the model the schema.** The engine asked for "a single JSON value that conforms to the expected schema" and never said what the schema was. Only an `ai_sdk` adapter with the `structured_output` capability hands the schema to the provider, and only on a call without tools, so everywhere else the model guessed the field names, and the repair loop taught them one failed reply at a time. The instruction now carries the schema as compact JSON Schema, closed with `additionalProperties: false` as a tool's schema is, so the first reply can fit. On OpenRouter's Claude Haiku 5.5, a three-field extraction with no example in its prompt took two round trips before and one after, at about half the cost, and a 4B model on Ollama that never found the right fields now does. A schema that JSON Schema can't express, such as one that holds a `Date`, keeps the bare request and still validates its replies. The `.describe()` text on a zod field reaches the model the same way, which is what the blueprint's advice to keep field rules there assumed.
- **`branch` returns the union of its arms' outputs.** Both arms had to return the same type, so a branch that answered `null` on one side and a number on the other failed to compile until you wrote `branch<Pair, number | null>(...)`, and the course had to teach that spelling before it taught anything else about `branch`. The otherwise arm now has its own output type, defaulting to the then arm's, and the branch returns either, so the union is inferred. Naming one output type, as in `branch<Pair, string>`, still holds both arms to it, so every existing call compiles unchanged.
- **`describe.diagram` draws a named composite as the steps it was built from.** `adversarial`, `consensus`, `ensemble_step`, `gate`, and `improve` are made of scopes, stashes, and loops, and the diagram drew all of it, so an `adversarial` over a draft and a check took fourteen rows of `stash` and `snapshot` around the two steps that the caller wrote, and a lesson that taught the pattern had to use `loop` instead to stay legible. `compose` takes `parts`, the steps inside it that a reader should see, by role, and records the path to each, so the diagram draws the composite as one row over its parts (`build` and `critique`, the members and the `score`, the gated work and its approval), while `describe.json` keeps the whole tree that the viewer maps spans onto. `{ internals: true }`, or `--internals` on `fascicle-diagram`, draws the insides as before. A part that isn't inside `inner` throws at construction, since the diagram would have nothing to draw for it, and roles that collide, such as a member named `score` beside the judge, get a numbered suffix.

### Fixed

- **A chain opened without its input type says how to fix it.** An unannotated `chain('pair')` typed its input as `never`, so the first field read failed with `Property 'a' does not exist on type 'never'` and `run` with an argument that wasn't assignable to `never`, and neither said what to do. The input now defaults to a branded type that nothing satisfies, so the same mistakes fail where they did, as `Property 'a' does not exist on type 'ChainInputUndeclared<"call .input<T>() on the chain to say what it takes">'`. A chain without an input type in a `parallel` now constrains the parallel's input as well, where `never` constrained nothing.
- **`fascicle-viewer` labels a loop's guard `guard`.** A loop wraps a guard function in an anonymous step whose id it makes up, as `loop_1_guard`, and the canvas labelled the puck with that id, which `describe.diagram` never shows. An anonymous step now reads as the role its parent gives it, `guard` for a loop's second child, and otherwise as its kind, which is how the diagram reads one.
- **`checkpoint_store_conformance` no longer fails a correct store's renewal when the machine stalls.** The renewal check claims a key, renews it halfway through its lifetime, then has a second owner try for it after the original lifetime is up, and a store that restarts the clock on renewal refuses. The check skipped judging when it woke too late, but it read the clock before the second claim, so a machine that stalled inside that claim reached the end of the renewed lifetime, the store rightly handed the key over, and a correct store failed. It reads the clock after the claim now. It flaked this way under the load of the repository's own full check.
- **`fascicle-viewer` counts each place in a flow apart, and labels a step or a composer by the name you gave it.** The canvas joined every span to its node by step id alone, so steps that shared an id pooled their runs. Every chain closes on a step called `output`, so in the course's commit tool, a chain inside a loop inside another chain, a run of three rounds drew the inner `output` as `×4` and the flow's last step as `TERMINUS ×4`. A chain binding that shares the id of the step it wraps doubled the same way. A span now joins the place that its parent span's node holds it in, the canvas keys every place apart, and a suspension or a checkpoint lookup, which names its step by id, lands on the place whose span is open. A group label reads the composer's `name` before its id, so a loop named `draft_until_clean` is `DRAFT_UNTIL_CLEAN` where it was `LOOP_1`, and a step's `name` labels its puck, since core resolves names in that order.
- **`parallel` takes an input that every member accepts, even when a member accepts a union.** The input type pooled every member's input into one union and then intersected its parts, so a member that took `string | readonly Message[]`, as a `model_step` does, beside a member that took a `string` made the input `string & readonly Message[]`, which no string satisfies, and a member that took either of two object shapes demanded both. Each member's input now stays whole while the intersection is taken across the members, so the first case takes a `string`, and the second takes either shape along with the other member's fields. A member whose input reads as `never`, which is what a zero-parameter function's becomes once a generic wrapper loses it, still constrains nothing.
- **A stub's inline `content` function gets its parameter types.** `StubResponse['content']` was typed `unknown`, which absorbs a function type, so `content: (opts, call_index) => ...` written inline failed strict mode with an implicit `any` on both parameters, the example in docs/testing.md included, and every function needed `(opts: GenerateOptions, call_index: number)` by hand. `content` is now a `StubContent`, which is `StubContentFn` alongside any other value, so an inline function takes its parameter types from `StubContentFn`, and a value typed `unknown` is still accepted. `StubContent` is exported from `fascicle/testing`.
- **A `sequence` with a step out of order reports the joint that broke.** TypeScript 7 reports a call that matches no overload against the last overload alone, and the last one was the fallback for runtime arrays, so a step out of order got two errors that only said each step had to be a `Step<T, T>`. The joint-checked signature now comes last as well, and the same mistake gets one error, on the step that can't take its input, naming the joint, the type that arrives there, and the type that the step accepts: `SequenceJointMismatch<"after children[1]", string, number>`. A call that compiles resolves exactly as before.

## v0.16.3 — 2026-10-19

### Fixed

- **`fascicle-viewer` follows a file whose directory doesn't exist yet, or moves away mid-run.** The viewer waited for a missing file through a watch on the file's directory, so a path whose directory didn't exist yet failed that watch with an io error, and the canvas never filled, even after the file appeared. A file watch follows the file rather than the path, so when the file's directory was moved away with the file inside, nothing reported it, and the viewer never saw a new file made at the old path. Volley's `.volley/trajectory.jsonl` does both, since its directory appears when a run starts, and a harness that keeps each run's record moves it away when the run ends. The viewer now watches the closest directory above the path that exists and moves down a level each time the next directory appears, and while it follows the file it keeps a watch on the file's directory, which reports that directory moving or going away. A file made at the path afterwards is read from its first line, as a rotated file is. A file that stands where a directory on the path should be is a wait as well, not an io error.

## v0.16.2 — 2026-10-19

### Added

- **`ServeAcpConfig` takes `additional_directories`, so an agent can keep each session to `cwd`.** An agent always advertised `sessionCapabilities.additionalDirectories` and took every directory that a client sent with `session/new`, so an agent whose tools and checks look at `cwd` alone had to narrow the session itself, and a narrowed copy of the session lost the diffs, the terminals, and the "always" that 0.16.0 gave its cards and prompts. With `additional_directories: false`, `initialize` leaves the capability out, so a client that follows the protocol sends no additional directories. A `session/new` that sends some anyway is refused with invalid params that carry the list as it was sent, before the agent resolves a root or builds a flow, and an empty list counts as none. Every session then has `cwd` as its one root, and the file tools, the prompts, and the cards follow from the session with no change. A config that leaves the option out, or sets `true`, behaves as it did.

- **`ServeAcpConfig` takes `modes`, so an agent that runs on the host can leave Auto out.** Every session offered Manual, Accept edits, and Auto, and both setters took any of the three, so an agent that runs outside a container had to replace `run_command`'s approval check to keep a command from running unasked in Auto, and a prompt from the replaced check came out plain, with no command line and no "always" to grant. `modes: ['manual', 'accept_edits']` lists only those two in `session/new`, in `modes` and in the `mode` config option alike, and `session/set_mode` and `session/set_config_option` refuse Auto as they refuse a mode they don't know, with invalid params that list the modes on offer, nothing sent to the client, and the mode left as it was. Every command then asks through the check that it already has. An edit's prompt offers **Allow all edits this session** only when the agent offers Accept edits, since that's the mode the grant switches to, and otherwise offers Allow and Reject. The offered modes keep the order Manual, Accept edits, Auto whatever order `modes` lists them in, a mode listed twice counts once, and a session starts in `default_mode`, or in the first mode offered when the config sets none. An empty `modes`, an entry that isn't a mode, and a `default_mode` that the agent doesn't offer each reject `acp_agent` with an error that names the problem, before it loads the SDK, so `serve_acp` fails at launch. That last check is new for a config that leaves `modes` out as well, so a `default_mode` outside the three modes, which a caller with no types could pass before and which failed only at the first gated tool call, now fails as the agent is built. A config that sets neither field behaves as it did.

### Internal

- `docs/acp.md`, `docs/api-reference.md`, and `SECURITY.md` cover both options. Each passage says what every ACP client gets before it says what Zed does, and it names the Zed commit that the Zed behavior was read from. Three checks by hand in Zed 1.24.3 confirmed it.

## v0.16.1 — 2026-10-19

### Internal

- The roadmap's Shipped list is up to date with v0.16.0. Near-Term now starts with durable runs across hosts, which covers a shipped store that holds across hosts, a compare-and-set in the store contract, and fixes for the suspend and resume bugs under Known Issues. Known Issues gains two entries: the late-resume windows that v0.16.0 left open, and `throughput()` reading far too high on Ollama.
- checkride moved to 0.15.0, whose `security` slot counts the advisories that the audit report lists rather than its per-severity totals. The braces advisory, which is patched and ignored, no longer keeps `pnpm check:security` red on pnpm 11.

## v0.16.0 — 2026-10-19

### Added

- **`define_tool` gives a tool's `execute` the type that its schema validates to.** A `Tool` whose `execute` wanted `{ city: string }` couldn't go into `tools: [...]`, because a `Tool`'s `execute` takes `unknown`, so every tool took `unknown` and parsed its input a second time, though the engine had already validated it against `input_schema`. `define_tool({ name, description, input_schema, execute })` reads the type from `input_schema`, hands it to `execute` and to `needs_approval`, and returns a plain `Tool` that any `tools` list takes with no cast. The engine passes a tool only the input that passed its schema, and a call that fails goes back to the model as a tool error, so the type that `execute` sees is the type that it gets. A tool written as a plain `Tool` keeps working, and moving one over drops its `parse` call. The cookbook and `examples/tool-loop` now use it.

- **`checkpoint` takes `on_write_error`, and `gate` keeps a failed write fatal.** `on_write_error: 'record'`, the default, records `write_error` and returns the inner result, which is what a failed write now does (see Changed). `'fail'` records the same event and then throws the store's error. `gate` passes `'fail'`, so a gate whose store fails the write still fails the run before it suspends, as it always has, and never asks for approval of a result that its store didn't keep. A flow that builds the same thing from `checkpoint` and `suspend` passes `'fail'` too, and the docs on checkpointing and human-in-the-loop now say so. `flow_schema`'s `checkpoint` takes the field, and `describe` shows a checkpoint the same way whichever value it has.

- **`BedrockCredentialProvider` and `BedrockCredentials` import from `fascicle`.** The `bedrock` provider's `credential_provider` option takes a `BedrockCredentialProvider`, a function that resolves to `BedrockCredentials`, but neither type was exported, so code that wrote its own provider had to restate both shapes. Both import from `fascicle` now.

### Changed

- **The `zod` peer takes any 4.x from 4.2.0, and the package no longer asks for a pnpm version.** The peer was exactly `4.4.3`, so a project on zod 4.4.4 or later got a peer conflict, though every release from 4.2.0 on has the Standard JSON Schema interface that Fascicle reads, and 4.2.0 emits the same schemas that 4.4.3 does. The peer is now `^4.2.0`, and the repo still develops and tests against 4.4.3. `engines.pnpm` is gone as well. It shipped to every consumer, where it could only warn a pnpm user below 10.13 about a floor that matters only to someone working in this repo, and the floor was stale even there, since the workspace needs pnpm 11, which `packageManager` already pins. A project that held zod at 4.4.3 to satisfy the peer can move it.

- **`turn_timeout_error` is exported, and the engine's types promise only what it does.** A turn that outruns `turn_timeout_ms` before any chunk streams throws `turn_timeout_error`, which reaches the caller whenever `retry_on` leaves out `'timeout'`, but the class wasn't exported, so code couldn't catch it by `instanceof`. It now imports from `fascicle`. Three things that nothing implemented are gone. `ClaudeCliProviderConfig` loses `skip_probe`, which no code ever read. `ClaudeCliErrorReason` loses `auth_missing`, `auth_expired`, `api_key_missing`, `engine_disposed`, and `parse_error`, since the adapter reports an auth failure as `provider_auth_error`, a missing key as `engine_config_error`, a disposed engine as an `aborted_error` whose `reason` is `'engine_disposed'`, and a line it can't parse as a trajectory event. `FinishReason` loses `'aborted'`, which no call finished with, since an abort throws. Code that set `skip_probe` drops it, and code that matched one of the removed reasons or `'aborted'` matches the error that the adapter throws instead. `docs/cli.md` now lists the reasons and the dispose errors as they are.

- **`flow_schema` takes every composer and every field that the composer configs take.** The JSON Schema for the YAML flow shape had drifted from the API. It had no key for `gate`, `ensemble_step`, `improve`, or `learn`, so a YAML flow couldn't use one, and now it has a key for each of the four, with a key for every field that its config takes. A `gate`'s `store` is written by its name, `improve`'s `budget` is an object, and `learn`'s `source` is an object whose `kind` picks `events`, `paths`, or `dir`. The other composers now have a key for each field that their configs take, so `retry` gains `max_delay_ms`, `jitter`, `when`, `on_error`, and `project`, `fallback` gains `when`, `handoff`, and `project`, a `step` gains its metadata and `arm`, `adversarial`, `ensemble`, `tournament`, and `consensus` gain `project`, `loop`'s `guard` can name a predicate, and every config that takes a `name` or a `description` has one. A `chain` entry takes the arm form (`step`, `arm`, and `select`), and a `scope` takes any node between its `stash` and `use` entries. Two changes reject what used to validate. `loop` requires `init` and `finish`, as `loop` itself does, and a `use` entry names its function under `fn`, where it took a node under `do`, though `use` runs a function and not a step. A YAML flow that wrote `use` with `do` writes `fn` and the function's name instead. A test now pins every key against its composer's config, so a field that a config gains fails the gate until the schema gains it too.

- **`STEP_KINDS` lists only the kinds that a step can carry.** It named `adversarial`, `ensemble`, `tournament`, and `consensus` as step kinds, but those four factories build a `compose` step that carries the composite's name as its display name, so no step ever had one of those kinds. The four names are gone from `STEP_KINDS` and from the `StepKind` type, and `is_step_kind` answers false for them. A hand-built step that uses one of them as its kind now reads as a kind of its own, so `describe.diagram` labels it by its id. Code that looked for a composite by its `kind` looks for `kind === 'compose'` and the composite's name in `config.display_name` instead, which is what those steps have carried all along.

- **The viewer answers only its own host, and the CLI takes posts only under `--listen`.** Bound to a loopback name, as it is by default, the server answers 403 to a request whose `Host` names anything but `localhost`, `127.0.0.1`, or `::1`, whatever the port, so a web page that rebinds a domain of its own to 127.0.0.1 can't read your trajectories through your browser. `/api/ingest` reads only `application/x-ndjson`, answering 415 to any other content type, which a page on another origin can't send without a preflight, and it answers 413 to a body over 8 MB. `fascicle-viewer <path>` no longer mounts `/api/ingest` at all, though only `--listen` ever said it would. To keep posting to a viewer that tails a file, pass `--listen` beside the path. Open the viewer by one of those three names rather than by another hostname that reaches the machine, and send `application/x-ndjson` from a client of your own, as `http_logger` already does. `start_viewer` and `start_server` gain `ingest`, which defaults to true, so code that embeds the viewer meets nothing new but the `Host` check.

- **`map`, `loop`, and `ensemble` reject a config that can't run when they're built.** A `concurrency` or a `max_rounds` of `NaN` got through every clamp, since `Math.max(1, NaN)` is `NaN`, so `map` started no workers and returned an array of holes, and `loop` ran none of its rounds. Both now throw a `TypeError` when they're built. `map` also rounds a fractional `concurrency` down, so `2.5`, which used to run three items at a time, runs two. `ensemble` with no members threw `no members produced a result` once it ran, and now throws when it's built, as `tournament` does. Code that computes a `concurrency` or a `max_rounds` checks the number before it builds the step, and code that builds an `ensemble` from a list that can be empty checks the list.

- **`suspend` and `gate` hold their ids to the step id rule.** Resume data reaches a gate under its id, but `suspend` and `gate` took any id, though `step` and `chain` refuse an empty id and one that isn't an identifier. Both now throw a `TypeError` when they're built, which names the `suspend id` or the `gate id`, suggests an identifier, and says to put the label in `name`. A gate checks its id before its `suspend` does, so the error names the gate. Every id in the docs and examples already fit. A flow whose id reads like `approve-draft` or `approve draft` renames it, say to `approve_draft`, and moves the prose into `name`. A durable run that's waiting at a gate can't be resumed once that gate's id is renamed, because it waits under the old id, and the rename changes the flow's shape, which `durable` refuses by default with `flow_changed_error`. Let those runs finish, or delete them, before you deploy the rename. Repeated suspend ids still pass, and `docs/roadmap.md` lists that under Known Issues.

- **`checkpoint` keeps the inner step's result when its store fails the write.** A `store.get` that threw counted as a miss, but a `store.set` that threw failed the run, after the inner step had run and been paid for, though a checkpoint is a cache and not the result. A failed write now records a `checkpoint` event with `status: 'write_error'`, the error's message, the step `id`, the `key`, and the `span_id`, as a failed read records `read_error`, and the step returns the inner result. The next run with that key misses and runs the inner step again. A run that used to fail on a broken store now completes, so code that counted on that failure passes `on_write_error: 'fail'` to keep it fatal, or looks for `write_error` in the trajectory. `gate` passes `'fail'` itself, so a gate still fails the run. `CheckpointStatus` gains `'write_error'` and `is_checkpoint_event` accepts it, so code that switches over `CheckpointStatus` needs a case for it. The viewer shows no tick for it, as for a miss.

- **`CaseResult` and `BenchReport` lose their input type parameter.** `CaseResult` had an `_input?: I` field that `bench` never set, and the field existed only to give the input type a use, so `BenchReport<In, Out>` promised an input that no report holds. `_input` is gone, and both types now take `<O = unknown, S = Score>`. `bench` keeps its input type for the flow, the cases, and the judges, and it returns `BenchReport<O, S>`. Drop the first type argument, so `BenchReport<In, Out>` becomes `BenchReport<Out>`, and `CaseResult<In, Out, S>` becomes `CaseResult<Out, S>`. Don't leave a two-argument `BenchReport<In, Out>` as it is: it still compiles, but it now reads as output `In` and score `Out`, since the score type takes any type, so its cases' `output` gets the wrong type. `examples/swebench` drops the argument too.

- **`ensemble`, `ensemble_step`, and `tournament` let an `undefined` result compete, and a NaN score never wins.** The three read a member's result as missing whenever it was `undefined`, so `ensemble` skipped that member without scoring it, `ensemble_step` threw `winner missing from results` when it won, and `tournament` threw `missing result for match` when it played. Each now reads its results by key, so an `undefined` result is scored, can win, and plays its matches, and an `ensemble_step` score that is itself `undefined` can win too. A NaN score in `ensemble`, or a NaN rank in `ensemble_step`, used to win whenever it came first, and now it never wins under either `select`, wherever it falls, though it stays in the score map. A field whose every score is NaN throws an `Error` that says so and asks for a scorer that returns a number. A flow whose scorer can return NaN for every member catches that error or makes the scorer return a number, and a flow that counted on an `undefined` result being skipped, or on its throw, filters it out in the member or the scorer.

- **An `acp_agent` app refuses a second connection.** An app keeps one set of sessions and one client's capabilities, so a second connection to the same app overwrote the first client's capabilities and could reach its sessions by id, though `docs/acp.md` said that an app serves one. A second `connect` now throws an error that says the app already serves a connection and to build an app for each one, and a second `initialize` gets an invalid-request error back before it can touch the first client's capabilities. That second guard covers a server that shares one app among its clients, such as the SDK's `AcpServer`, which runs `initialize` before any connect hook. `serve_acp` builds an app for its one connection and meets nothing new. A transport of your own that connected one app more than once builds one for each connection, and a client that sent `initialize` twice on one connection sends it once.

### Fixed

- **The viewer's scrubber and clock follow the newest run.** In a trajectory file that holds more than one run, the canvas drew only the newest, but the timeline started with the first run. The scrubber and the header's T+ disagreed, an older run's failures were marked, and a scrub could land in a run that the canvas no longer drew. The timeline now starts at the newest run's `flow_structure`, whether the viewer reads the file whole or follows it live, and a run that starts while you watch starts the timeline over and lets go of a scrub that was held in the old run.

- **The viewer follows a trajectory file that appears late or gets rotated.** The tail watched the file itself, so `fascicle-viewer <path>` never read a file that didn't exist yet, though it said it would pick the file up once it was created. After a rotation that renamed the file and made a new one, it read the new file from the old one's offset. The tail now watches the directory while the file is missing or after a rename, and it reads a new file at that path from its first line. A missing file is something the tail waits for now, so `start_tail` no longer reports it through `on_io_error`, though a missing directory still reports there.

- **The viewer's canvas keeps its elements from one event to the next.** Every event rebuilt every node, segment, and label on the stage, and each rebuild restarted the element's animation, so the live march, the halo's pulse, and the bloom on any node that had ever emitted started over with every event. Each element now lasts as long as the glyph that it draws, so an animation runs through, and a node blooms once per emit.

- **`DEFAULT_PRICING` matches the current list prices.** The table had no rows for the Claude models after Opus 4.8, none for OpenAI's after `gpt-4o`, and Gemini 2.5 rows that had fallen behind Google's prices, with 2.5 Pro's output at half of its list price and 2.5 Flash's input at a quarter. Every row was checked against its provider's own pricing page on 2026-10-18, and a comment names the page. New rows price Claude Fable 5.1, Fable 5, Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5, and Haiku 5.5, OpenAI's `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-6-luna`, and Gemini 4 Argon, 3.8 Flash, and 3.5 Flash-Lite, and the Gemini rows gain a cached-input rate. A model whose price rises with the length of its prompt is priced at its base tier, and Gemini 4 Argon and 3.8 Flash are priced at the rates that hold until they double, on 2026-12-01 and 2027-01-01. A cost estimate for a Gemini 2.5 call now comes out higher, and a call to one of the new models now gets a cost where it used to record `pricing_missing`. Code that registered its own price for one of these models keeps it, since an engine's `pricing` wins over the defaults.

- **`openai` native sends `xhigh` and `max` as they are.** The openai dialect clamped both to `high` on `reasoning_effort`, from a time when OpenAI's Chat Completions field took only `low`, `medium`, and `high`. OpenAI's reference now lists every level from `none` through `max` for it, and the `ai_sdk` transport already passed both through, so the two transports sent different efforts for the same call. Effort `xhigh` and `max` now reach OpenAI unchanged on `transport: 'native'`. Not every model takes every level, so a call that relied on the clamp to send `max` to a model that tops out at `high` passes `high` itself. `lmstudio` native keeps the clamp, since a local server takes only the three.

- **`claude_cli` counts its cached input in `input_tokens`.** The CLI reports `input_tokens` without the tokens that it read from or wrote to the cache, as the Messages API does, and the adapter copied that number as it came, though `UsageTotals.input_tokens` counts the cache on every other path. Cost works out the fresh input by taking the cached parts back out of `input_tokens`, so a cached call's reported cost gave fresh input too small a share, or none, and the cache too large a one. `input_tokens` now adds the cache reads and writes, so a result with 100 input, 40 read from the cache, and 20 written to it reports 160, with `cached_input_tokens` at 40 and `cache_write_tokens` at 20. The total cost doesn't change, only how it splits. Code that added the two cache fields to a `claude_cli` call's `input_tokens` reads `input_tokens` alone.

- **`openrouter` native counts the cache writes that OpenRouter reports.** On a model with explicit caching, such as Claude, OpenRouter reports the tokens that a request wrote to the cache as `prompt_tokens_details.cache_write_tokens`, and the native transport read only the `cached_tokens` beside them, so a call that wrote the cache showed no writes. `cache_write_tokens` now carries them, as it already did on `transport: 'ai_sdk'`. `input_tokens` stays as it was, since `prompt_tokens` already counts the writes, as it counts the reads. A request to Claude Sonnet 5.5 that wrote 16,299 tokens to the cache reported 16,358 prompt tokens, and the same request sent again reported the same 16,358, with 16,299 of them read from the cache. The charge that OpenRouter reports doesn't change, only how it splits, so the writes now take their share as `cache_write_usd`, where they used to count as fresh input in `input_usd`. Where OpenRouter reports no charge, a pricing row now prices the writes at its cache-write rate, so that estimate comes out higher. Code that adds up a call's input cost from `input_usd` and `cached_input_usd` adds `cache_write_usd` too.

- **`filesystem_logger` drops an event it can't write instead of failing the run.** An event that JSON can't serialize, such as one that holds a `BigInt`, or an append that fails, such as on a full disk, threw out of the logger and into the flow, so a trajectory file could fail the run that it was recording, while `stderr_logger` and `http_logger` never throw. `filesystem_logger` now takes an optional `on_error`, as `http_logger` does, and hands it each failure. Without one, it writes a single `filesystem_logger:` line to stderr per failure, naming the file and the reason. Either way the event is dropped and the run goes on. `docs/api-reference.md` now states the rule that every adapter logger keeps. Code that caught that throw around `run` passes `on_error` instead.

- **`judge_llm` reads a score that prose follows.** The parser that pulls the JSON out of a judge's reply took the whole reply whenever it began with `{`, so `{"score":0.8} That's my evaluation.` failed to parse and the judge abstained, though the same object with prose before it parsed. It now takes the first balanced object in the reply and skips any brace that sits inside a string, so prose after the object, prose on both sides, a fenced block, and a `}` in the reason all parse. A reply with no object still abstains, and so does one whose first `{` never closes. A bench whose judge answered with JSON and then a sentence now scores those cases, where it used to drop them from that judge's mean.

- **A durable gate gets the first datum that reaches it, even when two resumes race.** `resume` read a gate's inbox and wrote its datum only when the inbox was empty, but two resumes that read before either wrote both found it empty, so the last write won, and a run could resume on the second webhook's data rather than the first's. Each resume now writes under a claim on the gate's inbox key, and the resume that loses the claim drops its datum, as it would on finding one already there. The claim lasts the driver's `lease_ms` and comes off right after the write, so a resume that dies between its claim and its write holds that gate's data back until the claim lapses, and data sent for the gate in that window is dropped. A resume in that window gets `suspended` back at the gate it was meant to move, and the same call sent again once the claim lapses lands as usual.

- **A late durable `resume` drops its datum once the run has passed the gate.** A resume that read the run just before another resume moved it past a gate still wrote its datum into that gate's inbox, where nothing read it until the run was deleted. If the run was deleted in that window and a new run started under the same id, the new run took the stale datum up at that gate. Under its claim on the gate's inbox key, each resume now reads the inbox and then the run's record, and it drops the datum when the run has already passed the gate or is gone, which is what `docs/human-in-the-loop.md` already said it did. A resume whose run was deleted under it still rejects with `run_not_found_error`. Two narrower windows stay open until the store contract gains a compare-and-set: a resume that stalls past its claim between those reads and its write, and a `delete` that lands between the record read and the write.

- **A SIGINT or SIGTERM aborts only the runs that installed the signal handlers.** Every run joined the set that a signal aborts, whatever it passed, so once any run had installed the handlers, a Ctrl-C also aborted the runs started with `install_signal_handlers: false`, though opting out says the host forwards cancellation itself. A run that opts out now keeps going through a signal, and the handlers come off once the last run that installed them settles. A host that counted on another run's handlers to stop its own runs aborts them through `abort`, which `fascicle/acp` and `fascicle/mcp` already do.

- **A `model_call` or `define_agent` step that starts after an abort throws the reason the run was aborted with.** Both steps check the signal before they call the engine, and that check threw an `aborted_error` of its own, which dropped the caller's reason. `model_call` also made up a `{ signal: 'abort' }` reason and a tool-loop `step_index` of 0. Both checks now keep the rule that the rest of core keeps, so an `Error` that the run was aborted with comes back as that same instance, and any other reason arrives as the `reason` of an `aborted_error` that has no `step_index`. A bare `controller.abort()` aborts with the platform's `AbortError`, which is an `Error`, so it comes back as it is too. Code that caught this check by `instanceof aborted_error` alone also catches the error that it aborted with, or the `AbortError`.

- **The permission prompt and the cards know a workspace tool by more than its name.** A tool of the flow's own that was called `write_file` or `edit_file`, one from an MCP server included, got the workspace prompt, with a diff worked out from its input and **Allow all edits this session**, which switched the session to Accept edits. One called `run_command` ran without asking whenever its command matched a grant that the real `run_command` had earned. The prompt now gives that treatment only to a call whose input the session's own workspace tool saw first, so a tool that shares the name gets the plain prompt, and no grant covers it. A card opens with nothing but the tool's name, so cards key on the names that the session's `workspace_tools` built, and in a session that never built them, every tool gets the plain card. Within a session that did, the six names are reserved, and `docs/acp.md` says so. A flow that gave a tool of its own one of those names renames it, and a wrapper that replaces a workspace tool's `needs_approval` gets the plain prompt.

- **An "always allow" for a command covers that exact command and nothing else.** The grant used to key on the program and its first argument that wasn't a flag, so allowing `find . -name '*.ts'` also allowed `find . -delete` and `find . -exec rm`, and `pnpm --filter web test` keyed as `pnpm web`. A grant now covers the command line it was given, with the whitespace at its ends trimmed and everything between compared exactly, so `rm "a  b"` and `rm "a b"` are two grants. The option's label names the whole command. A re-run of the same command still runs without asking, and any variant asks again, so a user who relied on `pnpm test` covering `pnpm test --watch=false` grants each one.

- **`write_file` and `edit_file` refuse writes into `.git` and `node_modules`.** In Accept edits, the model could write `.git/config` or a file in `node_modules/.bin`, and what it wrote would run on the user's next `git` or `pnpm` command without ever showing in `git diff`. Both tools now refuse, in every mode, a path that passes through a file or a directory named `.git` or `node_modules` anywhere under a root, a nested repository's `.git` and a worktree's `.git` file included, whether the path gets there as written or through a symlink. The error names the directory and points the model at `run_command`, and the permission prompt shows it in place of a diff. A flow that wrote there through the file tools uses `run_command` instead. `docs/acp.md` now says that an edit to any other file that git ignores never shows in `git diff` either, so Manual is the mode for a checkout whose ignored files matter.

- **The viewer stays up when it can't read a file.** A read that failed while the viewer tailed a path, as one that names a directory does, crashed the process with an unhandled rejection, and now reaches `on_io_error`. A trajectory or an asset that passes `stat` but can't be opened now costs that one response rather than the server. The published `fascicle-viewer` bin also prints an error as one `fascicle-viewer:` line and exits 1, as the in-repo script always did, where it used to print a raw stack.

- **The viewer warns about any host that reaches beyond the machine, and prints an IPv6 address that it can open.** The no-auth warning fired only for `0.0.0.0`, so `--host 192.168.1.5` or `--host ::` exposed your trajectories without a word. Any host but `127.0.0.1`, `localhost`, or `::1` now warns, and the warning names the host. An IPv6 host gets brackets in the URL that the viewer prints and opens, which used to read `http://::1:4242` and open nothing. `ViewerServer` gains `port`, so code that binds port 0 reads the port without parsing `url`.

- **`tee_logger` keeps each sink's spans apart.** When a sink threw from `start_span`, the span ids of the sinks after it each moved up a place, so each of those sinks ended a span that belonged to its neighbor. Each sink now keeps its own id, and the id that the tee returns is the first one that a sink gave back.

- **`http_logger` hands every failure to `on_error`.** It serialized an event before its promise chain began, so an event that holds a `BigInt`, or a custom `fetch` that throws before it returns a promise, threw out of the logger and into the flow, though the docs say that a failure reaches `on_error`. Both run inside the chain now, so neither one fails the run.

- **`mcp_client` closes a server that it started when listing the tools fails.** If `listTools` rejected, the client that `mcp_client` had opened stayed open, so a stdio server that it spawned outlived the call. The client closes before the error propagates now, and a client that you passed in stays open, as before.

- **OTel metrics keep each model call's attributes when calls overlap.** The metrics dropped the newest call's provider and model whenever any call ended, so with two calls in flight, the one still running reported the attributes of the one that had finished. Each call's context now comes off by its own span id.

- **`run_stdio` sends its console to stderr, as `serve_acp` does.** A flow that called `console.log` under `run_stdio` wrote the line to stdout ahead of the result, which broke the parent's parse, and the run still exited 0. `run_stdio` now moves `console.log`, `console.info`, `console.debug`, `console.dir`, and `console.dirxml` to stderr for the life of the process before it reads stdin, through the same code that `serve_acp` uses. `execute_stdio` leaves the console alone, since it doesn't own the process, and a write that goes straight to `process.stdout` still lands there. Console lines now share stderr with the trajectory, where the viewer skips each one with a warning, so a flow that logged through the console to report progress reports it through `ctx.emit` instead.

- **`serve_acp` keeps `console.dir` off the protocol stream.** It sent `console.log`, `info`, and `debug` to stderr, since stdout carries the protocol, but `dir` and `dirxml` write to the console's own stream, so a flow that called either one wrote into the protocol and could break the session. Both go to stderr now. `run_command` also stops arming a grace timer for a call that an abort has already settled, so no timer outlives the call.

- **`claude_cli` keeps a structured `null` as `null`.** With a `schema` whose reply parsed to `null`, `content` held the reply's raw text, the string `"null"`, because the adapter fell back to the final text whenever the parsed value was `null` or `undefined`. A call with a `schema` now takes `content` from the parsed value every time, and only a call without one takes the final text. Code that compared a nullable result's `content` against `"null"` checks for `null`.

- **`claude_cli` passes `setting_sources` and `plugin_dirs` to the CLI.** The adapter built the CLI's arguments from an empty config, so both options were dropped without a word. Both reach the command line now.

- **`claude_cli` tells a missing sandbox apart from a `claude` binary that the sandbox can't see.** A `sandbox` whose `bwrap` or `greywall` wasn't on `PATH` threw `claude_cli_error` with `reason: 'binary_not_found'`, though `docs/cli.md` said that a missing sandbox binary throws `sandbox_unavailable`. A `bwrap` that ran but found no `claude` binary inside its sandbox threw `sandbox_unavailable`, because its error, `bwrap: execvp <binary>: No such file or directory`, names `bwrap` and a missing file. Each case now gets the other's reason. A missing wrapper throws `sandbox_unavailable`, and a `claude` binary that `bwrap` can't find throws `binary_not_found`, with a message that names the binary and the paths that the sandbox binds. Code that read either reason to tell a user what to install reads it the other way round for these two cases. `docs/roadmap.md` lists the binds that leave out a `claude` in your home directory under Known Issues.

- **Native transports fail a request for the reason that it failed.** Each one built its request body inside the `try` around `fetch`, so a `provider_capability_error` that the mapper threw, for a part that the wire can't carry, was retried as a network failure and reached the caller as one. The body is built before the fetch now, so that error arrives typed on the first attempt. A response body that fails partway through its read is now a network failure that the engine's retry policy retries, as a failed stream read already was. A body that arrives whole but isn't JSON throws a `provider_error` that quotes what came back and asks you to check `base_url`, where it used to throw a bare `SyntaxError`.

- **`ollama` native reports an error that the daemon sends mid-stream.** When a request fails after its stream has started, the daemon writes a frame with an `error` field, which the adapter skipped, so the turn failed as truncated output and the daemon's message was lost. That frame now throws a `provider_error` that carries the message.

- **A thrown `undefined` counts as a failure in a tool and in `map`.** The tool loop and `map` each took a failure to be a thrown value that was defined. A tool that ran `throw undefined` was recorded as a success with no output, and a `map` item that did the same left a hole where its result belonged while the map went on. The tool's call now fails, so it goes back to the model as a tool error, or throws `tool_error` under `tool_error_policy: 'throw'`, and `map` stops and rethrows, as each one does for any other throw.

- **`improve` keeps no lessons when `lessons_capacity` is 0.** A cap of 0 kept every lesson, because `slice(-0)` returns the whole array.

- **`learn` throws the caller's abort reason as it is.** It wrapped an `Error` that the run was aborted with in a new `aborted_error`, while core and `bench` throw that same instance, so code that aborted with its own error couldn't catch it by identity. `learn` now keeps the rule that core keeps.

- **`describe` shows a `fallback`'s `handoff` and a `define_agent` step's description.** `fallback` left `handoff` out of its describe metadata, and `define_agent` never passed the `description` from an agent's frontmatter to its step, so `describe` showed neither.

- **`fascicle-diagram --export` reads only the module's own exports.** It checked the name with `in`, so a name such as `toString` matched a member of `Object.prototype` instead of failing as a missing export. A name that the module doesn't export now fails as any other missing export does.

- **Three errors say what to do.** `stash()` and `use()` outside a `scope` named neither the key nor the fix, and now each one names its keys and says to wrap it in `scope([...])` with the steps that share them. `tee_logger` with no loggers now shows how to pass the sinks.

### Internal

- The docs now say that a `fascicle/ui` stream doesn't stop its run when the client disconnects, and `docs/human-in-the-loop.md` shows how to pass `run.stream` an `abort` that fires with the client, both from a route handler and from `node:http`.
- A sweep brought the docs, the site, and `VALUES.md` back in line with the code, and swapped the opaque decision tags in the source, scripts, configs, and rules for the rules that they name.
- `examples/pr-improve` defaults to OpenRouter, the examples build their tools with `define_tool`, and the smoke suite runs the six examples that need no key.
- The configs, rules, and scripts match the current layout. A new ast-grep rule checks doc comments in `.tsx` files, the `tunnel` override is gone, and `.mcp.json` pins `ast-grep-mcp`.
- The `claude_cli` sandbox test hides `bwrap` from the child's `PATH`, so it passes on GitHub's Ubuntu 26.04 runners, which ship `bwrap`.

## v0.15.0 — 2026-10-17

### Added

- **OpenRouter's reasoning shows on `transport: 'native'`.** The openrouter dialect reads the `reasoning_details` that OpenRouter sends, streamed or not. Each entry's text reaches `on_chunk` as `reasoning` chunks, so Zed's thought block and `fascicle/ui` show what the model reasoned, and each entry becomes a reasoning part that carries the entry itself. Before this, the dialect counted reasoning tokens and showed nothing.
- **A tool loop sends each model its own reasoning back, on both transports.** `AssistantContentPart` gains a `reasoning` kind, and every kind takes `provider_options`, the data that its provider wants back (a thinking block's signature, an OpenRouter reasoning entry, Gemini's thought signature on a tool call), keyed by provider name. `TurnResult.content` holds a turn's parts in the order that the provider sent them, and the loop builds the next assistant message from it. `openrouter` native sends its entries back as `reasoning_details`, `anthropic` native sends each `thinking` and `redacted_thinking` block back as it came, and the `ai_sdk` transport gives every part's `providerMetadata` back as its `providerOptions`. Each provider gets back only the reasoning keyed with its own name, so a `fallback` never hands one vendor's signature to another. Until now every transport dropped a turn's reasoning between steps, so a Claude loop lost its thinking without a word and a Gemini 3 loop could be refused. `ProviderOptions`, the shape that every part's `provider_options` takes, is a named export now, and `docs/providers.md` gains a Reasoning in a Tool Loop section.
- **OpenRouter's reported charge becomes the step's cost.** On `transport: 'native'`, the openrouter dialect reads the cost that OpenRouter reports on every response into `TurnResult.reported_cost_usd`, and the loop records it as the step's cost, split across input, output, and cache tokens by their weight, with the `cost` event's `source` set to `'provider_reported'`. A BYOK request counts the provider's charge (`cost_details.upstream_inference_cost`) as well as OpenRouter's fee. `GenerateResult.cost`, `cost` events, and every budget built on them now work on OpenRouter, where each step used to emit `pricing_missing` and record no cost. A reported charge wins over a pricing row, and `provider_reported.openrouter` keeps `cost`, `is_byok`, and `cost_details` as OpenRouter sent them.
- **A custom `ai_sdk` adapter can hand effort to the SDK and keep its reasoning.** `EffortTranslation` gains `reasoning`, a level for the AI SDK's own `reasoning` option, and `AiSdkProviderAdapter` gains `metadata_key`, the key that its package writes `providerMetadata` under, which defaults to `name`. A custom adapter over `@ai-sdk/anthropic` that runs under a name of its own sets `metadata_key: 'anthropic'`, or its reasoning stays behind.
- **`examples/acp-coder` takes `--effort <level>`.** It's unset by default, because Claude Sonnet 5.5 decides on its own when to think and OpenRouter returns a summary of it, so Zed already shows a thought block. `--effort high` asks for more thinking, more often. An unknown level stops the agent at startup with a message that lists the levels it takes.
- **`workspace_tools` takes `search_timeout_ms`.** Every search had the same 30 seconds to finish, and a repository that's too large to search in that time can now have longer. The budget is still what turns a pattern stuck backtracking into a tool error that the model can act on, and 30 seconds stays the default.
- **A read, a listing, and a search show their results on their cards.** `read_file`, `list_files`, and `search` cards used to close with `rawOutput` alone, so Zed showed the call's title and nothing under it. Each card now closes with the text that the model read, in a code block whose fence outruns any backtick run in it, the way Claude Agent shows a read. A listing or a search goes in a code block as well, where Claude Agent shows plain text, because a matching line can hold markdown that Zed would render. `rawOutput` stays for the hosts that read it, and a failed call keeps its error text.

### Changed

- **`anthropic` native sends effort as adaptive thinking.** Effort `low` through `max` becomes `thinking: { type: 'adaptive', display: 'summarized' }` and `output_config: { effort }`, with the level as it is, in place of a thinking budget, and effort `none` sends neither. The `max_tokens` default keeps its numbers, and sampling parameters still apply only with effort `none`. A model older than Claude 4.6 refuses adaptive thinking, so effort on those models stops working on native. Set `effort: 'none'` and pass a budget as `provider_options.anthropic.thinking`, or use the `ai_sdk` transport, whose peer still sends those models a budget.
- **Effort on the `ai_sdk` transport goes through the AI SDK's own `reasoning` option.** `anthropic`, `bedrock`, `google`, and `openai` hand the level to `generateText` and `streamText` and build none of it into their provider options, so each provider package maps it per model from a table that it keeps, and Fascicle's budget tables and its OpenAI clamp are gone. That changes what some levels send. Claude 4.6 and later get adaptive thinking with an effort on `anthropic` and `bedrock`, Gemini 3 gets a `thinkingLevel` and Gemini 2.5 a budget that the peer works out, and OpenAI gets `xhigh` and `max` as they are, where they used to clamp to `high`. The Anthropic and Bedrock peers, and Google's for Gemini 3, have no mapping for `max`, so a call at `max` runs at the model's default effort, with an SDK warning that Fascicle doesn't surface. `openrouter` still sends `reasoning: { effort }`, and a caller's `provider_options` still merge over the translation.
- **`openrouter` native sends effort as `reasoning: { effort }`.** It used to send the flat `reasoning_effort`, clamped to `high`, and now sends the nested object that the `ai_sdk` transport sends, with every level passed through. An override in `provider_options.openrouter.reasoning_effort` should move to `reasoning`, which replaces the derived object whole. `openai` and `lmstudio` native still send the flat field.
- **`AssistantContentPart` has a third kind.** Code that treats an assistant message's parts as text or else a tool call, in a custom native adapter or a `prepare_step` hook, now sends a `reasoning` part down its tool-call branch. TypeScript catches most of it, since a reasoning part has no `id`. Give `reasoning` a branch of its own that drops the part unless it carries your own provider's key. An assistant turn that carries reasoning or provider data also reaches history as an array of parts even when it called no tools, where it used to be a string.
- **OpenAI on `ai_sdk` sends references to its stored responses in a tool loop.** The loop now gives the Responses API's item ids back, so while `store` is on, `@ai-sdk/openai` sends each earlier part as a reference to the stored response instead of its content, which is what keeps OpenAI's reasoning across a loop. An organization whose responses aren't stored sets `provider_options.openai.store: false`, and the peer sends the content and the encrypted reasoning itself.
- **`list_files` returns at most 1,000 paths a call.** Past that, it returns the first 1,000 in sorted order and a note with the total, in the form that `read_file` and `search` already use, so the model knows to narrow its pattern or path. A listing of a very large repository used to come back whole, however much of the context it took. The tool's description states the cap.
- **`write_file` and `edit_file` refuse a file over a megabyte.** Both read the whole file that they change, to show the change as a diff, and a diff carries that text twice, with the card's closing update carrying it a third time. A file over 1,000,000 bytes is now refused from its size before it's opened, with a message that points the model at `run_command`, and the permission prompt shows the refusal in place of the diff. A file at the limit works as before.
- **`fascicle/mcp` exports `ServeFlowConfig` in place of `ServeFlowOptions`.** Fascicle names the type of a required argument `*Config` and an optional one `*Options`, and `serve_flow`'s argument is required, so the type and the parameter are both `config` now. The old name goes without an alias, since the surface is pre-1.0, so code that imports `ServeFlowOptions` imports `ServeFlowConfig` instead.

### Fixed

- **A turn's history keeps reply text apart across a tool card.** The text before a tool call and the text after it were recorded with nothing between them, so the next turn's history read "...tool calls.All tests pass". The second run now starts on a blank line. What the client is sent is unchanged, since Zed already shows the two runs as separate messages.
- **`examples/pr-improve`'s `edit_file` writes a replacement as the model gave it.** When `find` matched once, the tool replaced it with `String.prototype.replace`, which reads `$&`, `$$`, and their kin in the replacement as patterns even when the search is a plain string. A shell snippet or a regular expression that the model wrote into a file was changed on its way in. A single match now splits and joins the way `replace_all` already did, and the way `fascicle/acp`'s `edit_file` does.
- **`anthropic` native finishes a turn that OpenRouter streams.** OpenRouter's Anthropic-compatible Messages endpoint ends every stream the way a chat-completions stream ends, with a `data: [DONE]` line after `message_stop`. The adapter read that line as an event that wasn't JSON and failed a turn that had already arrived in full. It now skips the line, and any other data that isn't JSON still fails the turn.
- **Effort works on current Claude models, on every transport.** Every Claude model from 4.7 on refuses `thinking: { type: 'enabled', budget_tokens }` with a 400, and that's what `anthropic` native, `anthropic` on `ai_sdk`, and `bedrock` all sent for any effort but `none`. Each one now sends adaptive thinking with an effort, as the Changed entries above describe.
- **A failure that a compatible server reports mid-stream says what went wrong.** OpenRouter reports an error that happens after a stream started as a frame with a top-level `error`, under the HTTP 200 that the stream began with. The core ignored that frame, so the turn failed as a truncated stream or a missing usage object, and OpenRouter's message was lost. It now throws a `provider_error` that carries the server's message, with the error's code as `status` when the code is a number, on every dialect. Before any chunk has streamed, a 429 or a 5xx retries the way the same HTTP status does, and after one, the turn fails as a stream interruption that names the message.

### Internal

- A live reasoning check, `src/engine/__tests__/live/live_reasoning.test.ts`, runs a three-step tool loop on OpenRouter, and on Claude through OpenRouter's Messages endpoint, and asserts that each request carries the last turn's reasoning back and that each OpenRouter run's cost matches the charges it reported. It's opt-in (`LIVE_TESTS=1` and `OPENROUTER_API_KEY`), so `pnpm check` skips it.
- The live smoke gains Claude Sonnet 5.5 on `anthropic` native and on `ai_sdk`, both through OpenRouter, and each of its cases names its provider beside the model id. CONTRIBUTING.md names the key for both.

## v0.14.0 — 2026-10-16

### Added

- **`fascicle/acp` serves a flow as an agent in Zed and the other editors that speak ACP.** `serve_acp(config)` runs the flow over stdio as an [Agent Client Protocol](https://agentclientprotocol.com) v1 agent, so a person talks to it in the editor's agent panel, beside Claude Code, Codex, and Gemini CLI. Each prompt turn runs the flow through `run.stream`, and its text, reasoning, and tool calls stream back as session updates. `stream` sends each model call's text to the reply, to the collapsed thought block, or nowhere, by its `step_id`, and `to_text` writes the reply when the flow streamed none, as for a `define_agent` step's structured output. A turn hands the flow the session's history, with a cancelled turn marked as one, so a stopped request isn't picked up again at the next prompt. Stdout carries the protocol, so `serve_acp` sends `console.log` to stderr, and closing stdin, SIGTERM, and SIGINT all abort every run and dispose the engine. The agent advertises no ACP auth methods, so providers authenticate with whatever the launched process can see, and it ignores the MCP servers the client sends for now. `acp_agent` is the same agent left unconnected, for another transport or a test, and `to_session_updates` with `create_acp_mapper_state` is the mapper underneath. `@agentclientprotocol/sdk` is a new optional peer, with `zod` beside it, which loads only when an agent starts, and `acp_sdk_missing_error` names the install when it's missing. `docs/acp.md` covers all of it.
- **`workspace_tools(session)` gives a coding agent the tools it needs, confined to the session's workspace.** `read_file`, `list_files`, `search`, `write_file`, `edit_file`, and `run_command` work on the files on disk and in a shell of their own, never through the client's file system or terminal, which Claude Agent stopped using and the ACP v2 draft drops. The file tools accept a path only when its real path lands under `cwd` or under an additional directory that the client sent, so a symlink that points out of the workspace is refused. A search runs in a worker thread that a cancel or a 30-second budget can stop mid-match, so a pattern that backtracks without end can't freeze the agent. A command runs with `/bin/sh -c` in a process group of its own, which a cancel, its timeout, and its own exit kill whole, and `command_env` replaces the environment it would inherit, provider keys included. `run_command` is POSIX-only for now, and containment binds the file tools only, since a shell reaches anything the user can. SECURITY.md says what each tool can touch.
- **A coding session asks before it edits or runs anything, as often as its mode says.** Manual, the default, asks before every edit and every command, Accept edits only before a command, and Auto never. The session reports its mode both ways ACP has, so Zed's mode picker and the agent stay in step, and `default_mode` sets the agent's own default. `session.approve` goes in as a model call's `on_tool_approval`, and it sends `session/request_permission` on the card that the user already sees, with an edit's diff on it. It offers Allow, Reject, and an "always" that lasts for the session. For an edit, "always" switches the session to Accept edits, and for a command it covers the program and its first argument that isn't a flag (`pnpm test`), but never a command with shell control syntax. A rejection, a cancelled prompt, and a request that fails all deny the call.
- **Workspace tool calls look the way Claude Agent's do.** Each card carries the kind that picks its icon, a title such as `Read src/a.ts (1 - 40)` or the command line, and the places it touches. A write's or an edit's card keeps its diff in every mode, and a command's card shows its output in a terminal when the client advertises Zed's terminal extension, or as a `console` block otherwise. Location lines count from 1, as Claude Agent's do, and Zed reads both agents' lines one line low.
- **`ToolApprovalRequest` carries `tool_call_id`.** It's the raw call id that `ToolExecContext.tool_call_id` and the `tool_approval_*` events already carry, so an approval handler can point at the call it's being asked about.
- **Two examples run in Zed.** `examples/acp-agent` is a keyless echo that checks the wiring before you spend a token, and `--provider` and `--model` switch it to a real engine. `examples/acp-coder` is a working coding agent on OpenRouter, with `anthropic/claude-sonnet-5.5` by default. Its README has a Zed entry that sets `PATH` for the agent's commands and an eight-step test of the cards, the prompts, and the modes. Its `command_env` leaves out the provider keys, so a command the model runs can't read them.

### Changed

- **`flow_schema`'s declared type is a plain object type.** The schema moved from a JSON module into a TypeScript one, because TypeScript 7's declaration emit writes nothing for a JSON module. The value is the same, and so is its type, apart from the alias members (`properties_1`, `_do`, and the like) that the old declaration carried, so only code that named one of those needs to change.

### Internal

- The dev toolchain moved to TypeScript 7, vitest 5, and Stryker 10, along with checkride 0.14, fallow 3.33, and the newest release inside each other major. Stryker's vitest runner carries a patch for the way vitest 5 names its tests, without which every mutant survives, and the full mutation run scores 91.01%. braces carries a patch against deeply nested patterns (GHSA-vfj7-8cjw-p6xm), since no release fixes it, and it reaches the tree only through the markdown linter's globbing.
- `json_schema_to_standard` moved into the schema layer, so the workspace tools declare their inputs in plain JSON Schema without leaning on zod. `fascicle/mcp` still exports it.
- A new ast-grep rule keeps `node:child_process` in `src/acp/` to `run_command`'s file.

## v0.13.1 — 2026-10-09

### Added

- **`describe.replays(step)` names the steps a resume would pay for twice, before anything runs.** A run that resumes at a `suspend` replays the flow from its input, so a step marked `side_effect` (every `model_call` is) that can run before the gate runs again, unless a `checkpoint` that holds the step and not the gate stored its result. It reads the `describe.json` tree and returns a `ReplayHint` (`{ id, label, gates }`) for each such step, so a test can hold a flow to an empty list, and on `examples/durable-runs` it names the same step that the run's `step_replayed` event reports. Inside a `sequence`, a `chain`, a `fallback`, or one round of a `loop` the children run in order, `parallel` members and a step's arms can start in either order, and the arms of a `branch` never run against each other. A model call that a step's body makes without declaring it as an `arm` is out of its sight.
- **`describe.diagram` and `fascicle-diagram` can mark those steps.** Pass `replays: true` to `describe.diagram`, or `--replays` to the bin, and each of those rows ends with the gates it runs before, as in `(replays before approve)`. Without the option the diagram is unchanged byte for byte.

## v0.13.0 — 2026-10-09

### Added

- **`durable({ store })` keeps a suspended run in a store, so events can drive it from fresh processes.** `start`, `resume`, `get`, and `delete` drive a run one event at a time (a webhook, a finished job, a deadline timer), and every drive runs the flow again from its input, so replay and checkpoints behave the way they always have. A lease keeps two invocations from driving one run at once, a revision on every write stops a stalled drive from writing over the drive that took the run over, an event that finds the run busy waits in its inbox, and a change to the flow's shape mid-run throws `flow_changed_error` unless you pass `on_flow_change: 'replay'`. `examples/durable-runs` races a webhook and a deadline timer for one gate.
- **Checkpoint stores can scope and claim.** `CheckpointStore` gains three optional capabilities, which `durable` needs. `scope(prefix)` hands out a store whose keys and claims stand apart from its parent's and that can `clear`, and `claim(key, owner, ttl_ms)` with `release(key, owner)` takes and frees a key per owner. A store without them satisfies the contract as before, and `filesystem_store` implements all three, with claims created through `link(2)` so that two claimers can't both win.
- **`checkpoint_store_conformance` in `fascicle/testing` proves a store keeps that contract.** It runs 32 checks against fresh stores from your factory, racing claimers, expired claims, damaged values, and a `clear` that mustn't reach a look-alike scope among them, and it returns a report rather than registering tests, so it works under any runner. `examples/object-store` writes a store over an S3-style client, with claims made of conditional writes, and passes every check.
- **A `suspend` gate can carry a deadline.** `deadline_ms` rides out on the `suspended_error`, the `suspended` event, and the outcome that `run.until_suspended` reports, so whoever drives the run can schedule the timer, and `durable` hands it back as `deadline_at`. `resume_validation_error` carries the `suspend_id` of the gate whose data it refused.
- **Replayed side effects show up in the trajectory.** `StepMetadata.side_effect` marks a step that isn't free to run twice, and every `model_call` sets it. When a resumed run starts a marked step before it has reached the gates it was resumed at, the runner records a `step_replayed` event, which `is_step_replayed_event` narrows, so a replay that bills you twice shows up before the invoice does.
- **`map` can settle every item instead of failing on the first.** With `settle: true` every item runs, and the output holds one entry per item, `{ ok: true, value }` or `{ ok: false, error }`. The error is reduced to plain data (`message`, plus `name`, `kind`, and `path` when it has them), so a settled array survives a checkpoint. Each failure records a `map_item_failed` event, which `is_map_item_failed_event` narrows, and `suspended_error` and `aborted_error` still propagate. The config type is `MapSettleConfig`.

### Changed

- **`pipe_ui_message_stream_to_response` returns a promise.** As of `ai` 7.0.130, `pipeUIMessageStreamToResponse` returns one, and the wrapper passes it on and resolves once the response has ended.
- **`filesystem_store` surfaces read failures other than a missing file or one that won't parse.** A permission error or a failing disk used to read as a miss, which could start a durable run over or hand a live claim to a second owner, and now it throws.

### Fixed

- **A `suspend` gate named like an `Object.prototype` member resumes correctly.** It read its resume data with a plain index, so a gate named `toString` or `constructor` found the inherited function on any run that passed resume data. It reads only the run's own data now.

### Internal

- The dependency audit runs only as `pnpm check:security`, outside `pnpm check` and `check:all`. The braces package (3.0.3) has a high advisory and no patched release, and leaving the audit in the default set would have failed CI and the publish job.
- The dev toolchain moved to the newest release inside each major (oxlint 1.87, fallow 3.31, checkride 0.13, vitest 4.1.11, and more), and the audit cleared every advisory that had a fix.
- Nine doc snippets marked for checking sat a blank line away from their fence, so the snippet check skipped them. All of them compile and are checked now, and two doc errors are corrected (ollama native's effort note and the cloud spec's cost guardrail).

## v0.12.13 — 2026-09-25

### Fixed

- **The reference `researcher` agent traces its summarizer.** Each round called the summarizer's `run` directly, which bypasses the dispatcher, so the agent's only model call opened no span. It now goes through `ctx.call` and is declared as the round's `arm`, so the trajectory and `describe` both show the model boundary. The agent is demo code under `examples/agents/`, so this matters if you copied it into your own project.

### Internal

- Every example README now has a flow diagram drawn by `describe.diagram`, one row per step with a note beside it. The hand-drawn trees in `newsroom`, `release-notes`, and `amplify` gave way to rendered ones, and the few examples whose flow is a single step draw the program around it instead.
- Example docs and header comments that had drifted from the code are corrected. `live-smoke` now says it also exits non-zero when no backend was available, the `pr-improve` and `newsroom` headers match their flows again, and the single-file examples' header comments lose their em dashes.

## v0.12.12 — 2026-09-25

### Added

- **`describe.diagram(step)` draws a flow as an annotated tree.** It renders the `describe.json` tree with box-drawing glyphs, one row per node, and puts each node's description in a column beside it. A row is labelled with the node's display name, then an id its author chose, then its kind, so a counter-generated id never appears and the same flow always renders to the same bytes. That lets an app hold the diagram in its `flow.ts` header to the code with one equality test. A branch labels its arms `then` and `else`, a loop labels its guard, parallel members carry their keys, and a chain's stages nest the entries they span. `width` wraps the descriptions, and `prefix` starts every line so the output pastes straight into a doc comment.
- **Composers take a `description`.** Every core composer, every composite, chain bindings, and `model_call` accept a `description` beside `name`. It's stored as `meta.description`, so it reaches `describe.json` and the trajectory's `flow_structure`, and the diagram prints it.
- **`step(id, fn, { arm })` declares the steps its body calls.** A step whose body `ctx.call`s an arm can now name it (one step or a list) the way a chain binding already could. The arm shows up as a child in `describe`, the diagram, and `flow_structure`, and the step never runs it itself. The trailing argument's type is the new `StepOptions`.
- **The `fascicle-diagram` command prints a flow's diagram.** It ships in the package beside `fascicle-viewer`. Point it at a module whose `flow` export is the Step, or a function that builds it from stubs with no arguments, and add `"diagram": "fascicle-diagram src/diagram.ts"` to your scripts to check a header against the code whenever you want. It loads TypeScript through the project's own `tsx` and takes `--export`, `--width`, and `--prefix`. It exits 0 when it prints, 1 when the module won't load or holds no Step, and 2 on a usage error.
- **`FlowNode` marks a generated id.** `describe.json` sets `anonymous: true` on a node whose id was generated rather than chosen, which is what the diagram reads to keep counters out.

### Changed

- **A `model_call` without an `id` is anonymous, like `step(fn)`.** Its generated id carries a process-wide counter, so the diagram labels it by kind rather than printing a number that depends on build order. As a result, `checkpoint` and `gate` now reject an id-less `model_call` the way they reject an anonymous step, so give the call an `id` to wrap it.
- **`describe()` prints a branch's arms once.** Its text tree listed `then` and `otherwise` as config lines and again as children. Each arm now renders once, under its key.

### Internal

- Release workflows survive a tag push that GitHub delivers twice. Both take a per-ref concurrency group, `release.yaml` exits cleanly when the release already exists, and `publish.yaml` skips the publish job before the approval gate when npm already has the version.
- Blueprint rule 3 now has the flow draw its own header diagram, with a test holding the header to `describe.diagram` and a `diagram` script for looking at it. Rule 6 covers declaring the arms that a direct-style step calls.

## v0.12.11 — 2026-09-25

### Added

- **A user content part can carry its own `provider_options`.** Text and image parts take an optional `provider_options` with the same two-level, provider-keyed shape as the call-level field, and the `ai_sdk` transport hands it to the AI SDK as that part's `providerOptions`. Before this, the adapter rebuilt every part from its text or image alone, so part-level provider features were out of reach. The one that prompted it is Bedrock's guard content. Mark a part with `{ bedrock: { guardContent: true } }` and a guardrail's input check reads only the marked parts, which lets a retrieval call check the question without its passages tripping the prompt-attack filter. It needs `@ai-sdk/amazon-bedrock` 5.0.65 or later. Native transports and `claude_cli` ignore the field, and parts without it convert exactly as before.

### Internal

- The Bedrock section of `docs/providers.md` covers guard content, its qualifiers, and the peer version floor.

## v0.12.10 — 2026-09-24

### Fixed

- **`throughput()` counted prompt prefill as decode time on the ai_sdk transport.** A streamed step's `first_chunk_ms` was stamped on the first part of the AI SDK's stream, which is the `start` framing the SDK sends before the model has produced a token. The window `throughput()` treats as decode time (`duration_ms - first_chunk_ms`) still held the prefill, so a rate labeled `basis: 'decode'` was really a blended one. A local Ollama step with a 32k-token prompt reported a 9ms time to first chunk. The stamp now lands on the first chunk the turn dispatches, which is the rule the native transport already followed, and the `response_received` event and the OpenTelemetry time-to-first-chunk histogram carry the corrected value too. The same stamp decides when a failure counts as a mid-stream interruption, so an ai_sdk error after the stream opens but before the first token is now retried under the call's retry policy, as it already was on native.

### Internal

- Markdown linting skips volley's run state (`.volley/` and its `.volley.bak.*/` backups), which night-shift writes into the main checkout. Git already ignored those folders, but the linter keeps its own ignore list.

## v0.12.9 — 2026-09-24

### Added

- **`retry` and `fallback` can choose which errors they handle.** A new `when` predicate narrows either composer to the errors worth handling, and an error it rejects propagates untouched, the way a suspend or an abort already did. `retry` doesn't spend another attempt or fire `on_error` on it, and `fallback` never calls its handoff or its backup. That's what a schema failure needs, since a second attempt fails the same way, and it's what a paid provider needs, since every retry costs money.

- **`retry` and `fallback` can say how they got their result.** The optional `project` that the envelope composites gained in v0.12.0 now reaches both. `retry` hands it `{ value, attempts, errors }` and `fallback` hands it `{ value, source, primary_error }`, so a flow can archive how many retries a value took, or mark a backup's answer as degraded, without keeping a mutable closure or reading the trajectory back. Leave `project` off and the output is the plain value, as before. It lives in its own `RetryProjection` and `FallbackProjection` types rather than on `RetryConfig` and `FallbackOptions`, so a config annotated with the named type still infers its output from the inner steps.

- **`model_call` and `model_step` take an `on_chunk` observer.** It streams the call under a plain `run` and hands the caller that call's chunks, which is what a live terminal renderer wants. The alternative was to drive the whole run through `run.stream`, which tees every token into the trajectory logger (and so into `trajectory.jsonl`) and leaves the consumer to sort chunks back out by `step_id`. Under `run.stream` the observer runs after the `model_chunk` record, never in its place, so abort and the trajectory still belong to the composition layer.

- **Every `GenerateResult` reports how long the whole call took.** `StepTiming` brackets one turn's provider round-trip and leaves tools out, so nothing measured a call from end to end, and `claude_cli` steps carried no timing at all. The new `timing` field (`GenerateTiming`, with `started_at` and `duration_ms`) covers every turn, the tools that ran between them, absorbed retries, and schema repair, and the engine stamps it for every adapter, external ones included.

- **`throughput()` has a rate for `claude_cli`.** The adapter now reads `duration_api_ms` off the CLI's result event, reports it beside `duration_ms`, and splits it across the run's steps by output tokens (the same split it already used for cost). Each step gets a blended `StepTiming`, so a local model and Claude can be compared in tokens per second on the same terms.

- **`claude_cli_reported(result)` reads the CLI's report back typed.** It narrows `provider_reported['claude_cli']` to a `ClaudeCliProviderReported` with a runtime shape check, or returns `undefined`. `ClaudeCliProviderReported` and `GenerateTiming` are exported from the package root now too, so an app that imports from `fascicle` no longer hand-writes either shape.

### Fixed

- **The `run.stream` buffer lost new events once it overflowed.** Past the high-water mark the channel dropped the oldest buffered event and then returned without buffering the new one, so each overflow lost two events while `events_dropped` counted one. Seven events into a buffer of three delivered 3, 5, and 7 with a count of 2. They now deliver 5, 6, and 7 with a count of 4, which is what the documentation always described.

### Internal

- The docs cover all of the above, with a type-checked retry-then-fallback ladder in the cookbook and a per-call streaming recipe. The `branch` entry in `composition.md` now explains that `unicorn/no-thenable` flags its `then` key as a false positive (the config is never awaited) and how to turn the rule off.

- `.gitignore` covers volley's per-run state and the timestamped backups it takes of that state, both of which night-shift runs write into the main checkout.

## v0.12.8 — 2026-09-04

### Added

- **Step mode walks a run one beat at a time.** Play mode performs a run on a clock, which is the wrong instrument for reading one. A `STEP` dial now parks the clock and lets you walk the run yourself: engaging it opens the walk at T+0 and relabels the leading chip from `PLAY` to `NEXT`, and every press of that chip or the space bar advances one beat and stops there. A beat is one moment of run time, meaning every event that shares a timestamp, and the walk lands on exactly the positions a performance passes through, so stepping and playing show the same canvas at the same place and a parallel fan-out lights its branches in a single press. Turning the dial back off leaves the playhead where the walk stopped, so you can step into an interesting moment and then play the rest.

### Changed

- **Play mode paces a fast run into beats you can read.** A run whose steps finish in tens of milliseconds used to flash past in well under a second, because the schedule played every gap at its real length divided by the speed and capped only the long ones. A floor now lifts every gap between two distinct moments to a second of wall time at 1x (500ms at 2x, 333ms at 3x), so a 200ms demo run performs over a dozen seconds instead of vanishing. Events sharing a timestamp still fire together, which is what keeps a parallel fan-out lighting at once, and inside a floored gap the header `T+` visibly slows, the mirror of the acceleration compression already shows in the other direction.

- **The playback controls are big enough to hit.** The dials move from a 10px face with 3px padding to the 11px meta register with a 28px target, and the leading chip holds a fixed width, so relabeling between `PLAY`, `PAUSE`, and `NEXT` no longer shifts the cluster under your pointer. The header's `RETURN TO LIVE` control shares the one chip recipe and grows with it.

### Fixed

- **Two dependency pins lifted past fresh advisories, taking the audit to zero findings at every severity.** Three high advisories landed against `fast-uri` 4.1.2, among them host confusion on scheme-relative references and request forgery via malformed IPv6 normalization. The existing override pinned `>=3.1.2`, which 4.1.2 satisfies, so `ajv` resolved straight onto the vulnerable version. A second pin takes `qs` to 6.16.0, past three moderate advisories the `security` slot never demanded, because it fails at high. Neither package reaches anyone who installs this one: the published tarball has no runtime dependencies, and both paths run through the dev tree or through the optional MCP SDK peer.

### Internal

- The viewer quickstart writes `.trajectory.jsonl` at the repo root and nothing ignored it, so following the documented demo left the working tree dirty and this release's version bump refused to run. The file is ignored now, alongside the red-green-refactor example's trajectory output.

- The comment above the overrides block now records what a `>=` pin cannot do. It is a floor, not a ceiling, so it clears the advisory in front of it and says nothing about the next one inside the same major, which is how the `fast-uri` pin above sat on a vulnerable version until the advisory landed.

## v0.12.7 — 2026-09-01

Everything in v0.12.6 ships here for the first time: that version was tagged but never reached npm, because its publish run failed on the gate described below. Upgrading from v0.12.5 picks up both sections.

### Internal

- **The release gate reads the release notes now.** The v0.12.6 changelog entry carried a sentence with two semicolons, which the `prose` slot rejects (vale's `Repo.Semicolon` rule). The narrow check the release skill runs before tagging covered `docs`, `links`, and `spell` only, so the sentence passed locally and then failed inside `publish.yaml`, stranding the tag on a commit that could never pass. The sentence is split in two, and the pre-tag gate now runs `prose` and `prose-health` as well, because vale reads `CHANGELOG.md` like any other markdown.

## v0.12.6 — 2026-09-01

### Changed

- **The viewer draws a run canvas now.** The one static HTML page is replaced by a compiled Solid app that ships prebuilt inside the package, so running the viewer is still one command with nothing to build. The canvas is structure first: it computes a metro-line layout from the flow's `describe.json` tree and draws the whole composition dim and dashed before a single step runs, then the run moves through that geometry as amber light. Retry draws as a loop in the line, fallback as a bypass basin that reroutes when the primary fails, a terminal failure as a scarred puck, and map instances as perpendicular ticks that become a ruler comb at scale, with suspended, emitting, and annotation states carrying their own card treatments. Two properties are load-bearing and gated by `pnpm check:all`: the runtime dependency list stays empty, and the bundle is offline (vendored fonts, no CDN, no telemetry).

### Added

- **Every run scrubs.** Canvas state is a pure fold of events up to a time, and live mode is that fold pinned to the newest event, so replay is the same fold stopped earlier rather than a second render path. A time spine along the bottom margin carries the playhead. Scrub off the live edge and the LIVE chip becomes REPLAY with a `RETURN TO LIVE` control. Arrow keys step one event, shifted arrows step one second, and Home and End jump to T+0 and the live edge. The server grew `GET /api/trajectory`, which streams the full run history as NDJSON so the client folds the whole run on load and follows SSE from the cursor that route names, never double-counting. An off-by-default DENSITY dial shades the spine where events crowd together, and the choice persists across sessions.

- **Play mode performs the run.** Press play at T+0 and the canvas replays the run on its real timestamp deltas: speeds of 1x, 2x, and 3x, a compression dial (on by default) that caps any single inter-event gap at about two seconds so a ten-minute run plays in a minute or two, a loop toggle for booth-style playback, and controls that fade while a performance runs with the cursor idle.

- **The trajectory records what a canvas needs.** Every observed run now opens with a `flow_structure` event, the `describe.json` tree embedded verbatim, recorded only when a logger or stream consumer is present so an unobserved run pays nothing for the walk. `suspend`'s gate records a `suspended` event before it throws, carrying `suspend_id` plus the step id that joins it back to its `flow_structure` node, so a consumer sees the pause as its own event ahead of the span-end error. And `cost`, `turn_retry`, and `response_received` carry the enclosing step's `span_id`, so a consumer attributes them to the exact turn rather than an open-span-stack guess, which mis-attributes under parallel. The field is additive and optional, so fixtures without it keep the old fallback.

### Internal

- Rewrote `docs/viewer.md` around the run canvas, and pinned the viewer server's heartbeat, close, error, and 500 paths plus the tailer's io-error, drain, stop, and coalescing paths in tests.

## v0.12.5 — 2026-08-21

Everything in v0.12.4 ships here for the first time: that version was tagged but never reached npm, because its publish run failed on the gate described below. Upgrading from v0.12.3 picks up both sections.

### Fixed

- **A type error only CI could see.** `examples/otel-grafana/main.ts` imports `fascicle/otel`, which had no `tsconfig` `paths` entry, so TypeScript fell through to the package `exports` map and resolved the subpath from `./dist/otel.d.ts`. That file is present on any machine that has built before, so the `types` slot passed locally and failed on CI's clean checkout, where `pnpm check` runs ahead of `pnpm build`. `fascicle/viewer` carried the same gap with no importer to expose it yet. Both point at source now, and the `deps` slot fails if a published `exports` subpath ever loses its mapping again.

### Internal

- **A failed check job keeps its evidence.** checkride prints one pass/fail line per slot and writes each tool's real output to `.check/`, so a red run named the failing slot without saying why. Every workflow that runs the suite now uploads that directory as an artifact on failure, minus the coverage and mutation report trees that account for most of its size.
- **The `claude_cli` spawn tests no longer race their own mock.** Both SIGTERM escalator tests slept 150ms to let the mock install its handler before signalling it, which is a bet on how long a cold Node start takes: measured spawn to handler ran from 42ms idle to 127ms under a process spawn storm against that budget. The mock now signals readiness through a file and the tests wait for it.

## v0.12.4 — 2026-08-21

### Added

- **Per-step model timing, and tokens per second derived from it.** Every step the tool loop produces carries a `StepTiming` block (`started_at`, `duration_ms`, and `first_chunk_ms` on streamed turns), stamped so only the successful attempt is measured: failed attempts, backoff waits, and tool execution never inflate the number. `throughput()` derives tokens per second from a `GenerateResult`, a step array, or a single step, and names its basis (`decode` when every turn streamed, `blended` when any window includes network and prefill). The ollama native adapter passes the daemon's own nanosecond durations through `provider_reported.ollama` verbatim.

- **The trajectory stream is dashboard-ready: retry events and opt-in OTel metrics.** `response_received` carries the full flat per-turn record, every absorbed retry becomes a `turn_retry` event (attempt, classified failure kind, HTTP status, and the honored backoff delay), and the closing `engine.generate` span reports step and tool-call counts. On the `fascicle/otel` side, span meta flattens one level so a dashboard can query `fascicle.usage.input_tokens`, and a new opt-in `metrics` option records the GenAI semconv client histograms plus cost and retry instruments, tagged with provider and model.

- **A Grafana walkthrough.** `docs/grafana.md` tells the end-to-end story for the `fascicle/otel` bridge: the mental model, a three-step keyless demo against the `grafana/otel-lgtm` container, wiring for a real app, what each metric means, and hand-built panel queries, with an importable dashboard JSON beside the example.

### Changed

- **Every example lives in its own folder now, with a README and a screenshot of a real run.** The 28 single-file demos moved to `examples/<name>/main.ts`, the seven app workspaces kept their layout and gained screenshots, and the shared agents library got a README. The screenshots are captures rather than mockups: keyless demos as terminal renders, local Ollama and `claude` sessions for the model-backed ones, the viewer UI, and Grafana dashboard and Tempo trace views fed by the demo. Every cross-reference in `docs/`, the README, and the site follows the new paths.

- **`structured-output` and `tool-loop` run on the `openrouter` provider.** The pair used to require `ANTHROPIC_API_KEY`; they now read `OPENROUTER_API_KEY`, matching `live-smoke`, and their hand-rolled key guards are gone because `create_engine` already rejects an empty `api_key` with a message that names the fix.

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

- **Breaking: model resolution is now a verbatim pass-through.** `model` is an opaque string sent to the provider unchanged; `provider` selects the transport. One canonical input shape remains (separate `provider` + `model` params), with no interpretation in between.
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
