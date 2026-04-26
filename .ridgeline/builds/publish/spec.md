# Publish Readiness — Specification

**Document:** `spec.md`
**Project-wide documents (authoritative):** `../../constraints.md` (hard non-negotiables — publishing rules live in §8, dep rules in §4, architectural invariants in §7), `../../taste.md` (design philosophy)
**Status:** implementation-ready
**Scope:** ships `@robmclarty/agent-kit` to npm from this workspace, adds a `model_call` composer that bridges `@repo/engine` back into `@repo/core`, adds `describe.json(step)` for tooling, wires a link-check into `pnpm check`, decides the mutation-testing gate, rewrites the `/version` skill to bump the workspace in lockstep, and documents the two-name discipline (`@repo/*` internal, `@robmclarty/agent-kit` public).

---

## §1 — Problem Statement

The workspace is feature-complete for v1 (five packages, 493 passing tests, a green `pnpm check`), but it cannot actually ship. Six concrete gaps:

1. **No publishable artifact.** Every `package.json` carries `"private": true`. Nothing in the repo produces a `dist/` of `.js` + `.d.ts`. `tsdown` is in `devDependencies` but unreferenced by any script.
2. **Name ambiguity.** The root `package.json` and `packages/fascicle/package.json` used to both claim `@robmclarty/agent-kit`; after the `@repo/` rename the umbrella is `@repo/fascicle` and the root is `@robmclarty/agent-kit`. Neither is what gets published: the root never can be (it's the workspace manifest), the umbrella doesn't own the public name. The right answer needs to be written down.
3. **No composition/engine bridge.** Calling `engine.generate(...)` inside a composition-layer step requires a bespoke `step(async (msgs, ctx) => { return engine.generate({ ...msgs, abort: ctx.abort, trajectory: ctx.trajectory, on_chunk: ... }); })` closure every time. The plumbing is mechanical but easy to get wrong (cost events missed, `abort` forgotten, `on_chunk` not forwarded to `ctx.emit`). Nothing in `@repo/core` knows about the engine by design (`constraints.md` §3), so the bridge must live in the umbrella or in a new seam.
4. **`describe` is text-only.** `describe(step)` returns a multi-line string. External tooling (Mermaid renderers, Studio UI, diff tools) has to scrape that text or re-implement the walk. The `flow_schema` JSON Schema is published but nothing emits a conforming JSON tree.
5. **`/version` is single-file.** The `version` skill bumps only the root `package.json`. Every workspace package's `version` stays stale. With five `@repo/*` packages plus the umbrella, lockstep is the only sane policy.
6. **No broken-link guard.** The docs pass `markdownlint` but nothing checks that `[docs/getting-started.md](./docs/getting-started.md)` actually resolves. Every README rewrite to date has silently shipped at least one dead link; `pnpm check` didn't catch it.

This spec closes all six gaps in one pass so "we can ship v0.2.0 today" becomes a true statement.

---

## §2 — Solution Overview

### Core invariant

**No change to the public composition or engine APIs.** Every user who does

```typescript
import { create_engine, run, sequence, step } from '@robmclarty/agent-kit';
```

gets the same symbols they already export from the workspace-internal `@repo/fascicle` today. The published name changes; the import surface does not. Symbol shapes are frozen by `constraints.md` §8 (semver rules). New symbols added this build:

- `model_call` — a composer factory that closes over an `Engine` + model config and returns a `Step<CallInput, GenerateResult>`.
- `describe.json` — a property on the existing `describe` function that returns a `FlowNode` tree matching `flow_schema`.

Everything else is packaging, tooling, or documentation.

### Publish topology

**Option A, umbrella-only.** Only `@robmclarty/agent-kit` publishes to npm. `@repo/core`, `@repo/engine`, `@repo/observability`, `@repo/stores`, and `@repo/fascicle` stay `"private": true` forever. `tsdown` bundles the umbrella's re-exports into a single `dist/index.js` + `dist/index.d.ts`, inlining workspace-internal deps (`@repo/core`, `@repo/engine`, etc.) and leaving provider SDKs plus `ai`, `zod` external.

The root `package.json` keeps its current name `@robmclarty/agent-kit`, keeps `"private": true`, and owns the published artifact via a top-level `build` script that runs `tsdown` against the umbrella's sources and writes to `./dist/` at the repo root. `publishConfig` in the root points `main`, `module`, `types`, and `exports` at the built artifact. Publishing is `pnpm publish` from the repo root.

Rejected: Option B (multi-package publish under `@robmclarty/*`) and Option C (reverting the `@repo/` rename). Rationale in `taste.md` (new principle — see §12). The short version: slim installs matter less than one-artifact simplicity at v1, and `@repo/*` is load-bearing as the internal-vs-public signal.

### Versioning

Lockstep across every workspace `package.json`. The `/version` skill is rewritten (§6) to walk `packages/*/package.json` plus the root, apply the same bump to each, regenerate `CHANGELOG.md`, and commit. No package ever carries a different version from another; `@robmclarty/agent-kit` publishes at the same number its internal deps are pinned at.

### Release flow

```
1. pnpm /version patch | minor | major
   → updates every package.json in lockstep, writes CHANGELOG section, commits "vX.Y.Z"
2. pnpm check                   # must exit 0
3. pnpm build                   # tsdown → root dist/; validates exports
4. pnpm check:publish           # npm pack --dry-run + arethetypeswrong
5. git tag vX.Y.Z
6. pnpm publish --access public # publishes @robmclarty/agent-kit@X.Y.Z
7. git push && git push --tags
```

Every step is a plain script in the root `package.json`; no release-manager daemon, no lerna, no changesets.

### `model_call` composer

Lives in `packages/fascicle/src/model_call.ts` (the umbrella — the first and only file in the umbrella other than the re-export `index.ts`). It's the only place in the repo that imports value symbols from both `@repo/core` and `@repo/engine`. It's also the only place where the composition and engine layers meet at runtime. The composer is a closure-factory:

```typescript
const draft = model_call({
  engine,
  model: 'cli-sonnet',
  system: 'You are a careful planner.',
});

const flow = sequence([
  step('fetch_context', fetch_ctx),
  draft,
  step('parse', parse_plan),
]);

await run(flow, input, { trajectory, abort });
```

`draft` is a `Step<CallInput, GenerateResult>`. Input comes from the upstream step. `ctx.abort`, `ctx.trajectory`, and `ctx.emit` are auto-threaded to the engine call. Cost events, `on_chunk` → `ctx.emit` forwarding, and `aborted_error` propagation are handled once, correctly, inside the composer — not re-invented per caller.

### `describe.json`

```typescript
import { describe } from '@robmclarty/agent-kit';

const tree = describe.json(flow);
// { kind: 'sequence', id: '...', config: {...}, children: [...] }
```

Shape is the `FlowNode` TypeScript type defined in §5.1. Function values render as `{ kind: '<fn>' }`, schemas render as `{ kind: '<schema>' }`. The text form `describe(flow)` is unchanged.

The existing `flow_schema` JSON Schema (exported from `@repo/core`) describes a distinct YAML DSL shape, not the introspection tree; v1 does not attempt to reconcile them. See §5.3.

### Link-check

A new check, `links`, runs a small Node script (`scripts/check-links.mjs`) that walks every `.md` file and verifies every relative link target exists on disk. External (`http://`, `https://`) links are ignored. Runs after `docs` in the `pnpm check` pipeline, ≤200ms.

### Mutation gate

Phase 1 captured a baseline mutation score of **61.44%** on 2026-04-20. The weakest files are `packages/engine/src/errors.ts` (35%), `packages/engine/src/providers/claude_cli/schema.ts` (40%), `packages/engine/src/providers/claude_cli/index.ts` (41%), and `packages/engine/src/providers/openrouter.ts` (46%); documented as follow-up work.

Originally deferred by this spec (decision 2026-04-21). **Superseded 2026-04-21:** mutation is now wired into `pnpm check` as the `mutation` step, with thresholds `{ high: 80, low: 60, break: 50 }` and a committed incremental baseline at `reports/mutation/incremental.json`. `prepublishOnly` inherits the gate because it already runs `pnpm check`. See §8.

---

## §3 — Publish Topology Detail

### §3.1 What publishes, what doesn't

| Package | Directory | Visibility | Published name |
|---|---|---|---|
| root manifest | `./package.json` | public (npm) | `@robmclarty/agent-kit` |
| `@repo/core` | `packages/core/` | private (workspace-only) | — |
| `@repo/engine` | `packages/engine/` | private (workspace-only) | — |
| `@repo/observability` | `packages/observability/` | private (workspace-only) | — |
| `@repo/stores` | `packages/stores/` | private (workspace-only) | — |
| `@repo/fascicle` | `packages/fascicle/` | private (workspace-only) | — |

Only the root manifest loses `"private": true`. Every `packages/*/package.json` keeps it. The root's `name` stays `@robmclarty/agent-kit`, `version` stays `0.1.5`.

The root manifest grows a `publishConfig`, `files`, `main`, `module`, `types`, and `exports` block pointing at the built artifact. Its `devDependencies` and `scripts` stay where they are (this is still the workspace root). Its `dependencies` stays empty — the bundle inlines everything.

### §3.2 Root `package.json` shape (post-build-wiring)

```json
{
  "name": "@robmclarty/agent-kit",
  "version": "0.1.5",
  "description": "Composable agentic workflows for TypeScript — 16 composition primitives plus a provider-agnostic generate() engine.",
  "type": "module",
  "repository": { "type": "git", "url": "git+https://github.com/robmclarty/agent-kit.git" },
  "homepage": "https://github.com/robmclarty/agent-kit#readme",
  "bugs": { "url": "https://github.com/robmclarty/agent-kit/issues" },
  "engines": { "node": ">=24.0.0", "pnpm": ">=9.0.0" },
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "CHANGELOG.md"],
  "peerDependencies": {
    "ai": "^6.0.0",
    "zod": "^4.0.0",
    "@ai-sdk/anthropic": "^3.0.0",
    "@ai-sdk/google": "^3.0.0",
    "@ai-sdk/openai": "^3.0.0",
    "@ai-sdk/openai-compatible": "^2.0.0",
    "@openrouter/ai-sdk-provider": "^2.0.0",
    "ai-sdk-ollama": "^3.0.0"
  },
  "peerDependenciesMeta": {
    "@ai-sdk/anthropic": { "optional": true },
    "@ai-sdk/google": { "optional": true },
    "@ai-sdk/openai": { "optional": true },
    "@ai-sdk/openai-compatible": { "optional": true },
    "@openrouter/ai-sdk-provider": { "optional": true },
    "ai-sdk-ollama": { "optional": true }
  },
  "publishConfig": { "access": "public" },
  "scripts": {
    "check": "node scripts/check.mjs",
    "check:publish": "node scripts/check-publish.mjs",
    "build": "node scripts/build.mjs",
    "prepublishOnly": "pnpm check && pnpm build && pnpm check:publish",
    "...": "..."
  }
}
```

`"private": true` is **removed**. `prepublishOnly` is the belt-and-braces gate — the user can still skip the explicit `pnpm publish` workflow and run it directly; the script still enforces a green check + clean build + `check:publish` before anything hits npm.

`ai` moves from an internal-only concern (currently a `dependency` of `@repo/engine`, bundled into the umbrella) to a required peer. `zod` does the same. Rationale: both are large, commonly co-installed with the consumer's own app; forcing a user-world bundle avoids duplicate copies breaking `instanceof`.

The repo is private and ships without a `LICENSE` file at this stage; the root `package.json` omits the `license` field. `npm publish` will emit a "no license" warning, which is accepted. A license decision (and the corresponding field + `LICENSE` file) is a pre-v1.0 task tracked separately.

### §3.3 `tsdown` configuration

New file at the repo root: `tsdown.config.ts`.

```typescript
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./packages/fascicle/src/index.ts'],
  outDir: './dist',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  platform: 'node',
  // Inline every workspace-internal dep so the artifact is self-contained.
  noExternal: [/^@repo\//],
  // Keep these as runtime/peer resolutions.
  external: [
    'ai',
    'zod',
    /^@ai-sdk\//,
    'ai-sdk-ollama',
    '@openrouter/ai-sdk-provider',
  ],
});
```

### §3.4 Build pipeline

`scripts/build.mjs` (new):

1. Delete `./dist/`.
2. Run `tsdown` with the config above.
3. Verify `./dist/index.js` and `./dist/index.d.ts` exist and are non-empty.
4. Run a tiny smoke script that does `await import('./dist/index.js')` and asserts the 16 composition primitives plus `create_engine`, `model_call`, and `describe.json` are exported.
5. Exit 0 or fail with a diagnostic.

Publish preflight `scripts/check-publish.mjs` (new):

1. `npm pack --dry-run --json` — capture the file list; assert `dist/index.js`, `dist/index.d.ts`, `README.md`, `CHANGELOG.md` are in it; assert no `.ts` source, no test files, no `.ridgeline/`, no `docs/`.
2. Run `@arethetypeswrong/cli` against `./dist/` — assert no resolution failures under Node ESM. (Added to root `devDependencies` as part of this build.)
3. Assert `package.json` version matches every `packages/*/package.json` version *and* the `version` constants in `packages/core/src/version.ts` / `packages/engine/src/version.ts` (lockstep invariant — see §6).
4. Exit 0 or fail.

### §3.5 Two-name discipline

One-paragraph addition to `AGENTS.md` and the repo `README.md`:

> Inside the workspace, every package uses the `@repo/*` prefix (`@repo/core`, `@repo/engine`, etc.) — these names are private and never reach npm. The only published name is `@robmclarty/agent-kit`, which is what users install. The umbrella (`packages/fascicle/src/index.ts`) is the source that `tsdown` bundles into the published artifact.

---

## §4 — `model_call` Composer

### §4.1 File and module

New file: `packages/fascicle/src/model_call.ts`.
Exported from: `packages/fascicle/src/index.ts`.
Re-exported from: the published `@robmclarty/agent-kit` surface (automatic — umbrella is the publish seam).

### §4.2 Signature

```typescript
import type { Step } from '@repo/core';
import type { Engine, GenerateOptions, GenerateResult, Message, StreamChunk } from '@repo/engine';

export type ModelCallInput =
  | string                     // becomes [{ role: 'user', content: [...] }]
  | ReadonlyArray<Message>;    // passed through

export type ModelCallConfig<T = unknown> = {
  readonly engine: Engine;
  readonly model: string;
  readonly id?: string;
  readonly system?: string;
  readonly tools?: GenerateOptions['tools'];
  readonly schema?: GenerateOptions['schema'];
  readonly effort?: GenerateOptions['effort'];
  readonly max_steps?: GenerateOptions['max_steps'];
  readonly provider_options?: GenerateOptions['provider_options'];
  readonly retry_policy?: GenerateOptions['retry_policy'];
  readonly tool_error_policy?: GenerateOptions['tool_error_policy'];
  readonly schema_repair_attempts?: GenerateOptions['schema_repair_attempts'];
  readonly on_tool_approval?: GenerateOptions['on_tool_approval'];
};

export function model_call<T = unknown>(
  cfg: ModelCallConfig<T>,
): Step<ModelCallInput, GenerateResult<T>>;
```

### §4.3 Behavior

The returned `Step` runs the engine call with these wires:

1. `opts.abort = ctx.abort` — always. Callers cannot override; the composition layer owns cancellation.
2. `opts.trajectory = ctx.trajectory` — always. Engine spans nest under the step's span.
3. `opts.on_chunk = (chunk) => ctx.emit({ kind: 'model_chunk', step_id: step.id, chunk })` — only when `run.stream` is driving. When `ctx.emit` is the no-op (plain `run`), `on_chunk` is omitted entirely (engine streaming parity — §5.4 of constraints).
4. Input normalization: `string` → `[{ role: 'user', content: [{ type: 'text', text: input }] }]`; `ReadonlyArray<Message>` passes through unchanged.
5. `step.kind === 'model_call'` (new kind; registered in `@repo/core`'s step registry — see §4.5).
6. `step.id` defaults to a stable hash of `{ model, system, has_tools, has_schema }` if `cfg.id` is omitted. Explicit `cfg.id` wins.
7. `step.config` (for `describe`) surfaces `{ model, system?, has_tools, has_schema, effort? }` — never the raw `engine`, which is a live object.

### §4.4 Cost-forwarding and cleanup

`model_call` registers no `ctx.on_cleanup` handler. Engine-internal HTTP cleanup is the adapter's job; `dispose()` is the Engine's job (called by the application, not by the composer). Cost events flow out via `ctx.trajectory` automatically — the engine emits them per constraints §5.3.

### §4.5 Registering a new step kind in `@repo/core`

`@repo/core`'s `step.ts` currently recognizes `'step'` as the only primitive `kind`; composers add their own (`'sequence'`, `'parallel'`, etc.). `model_call` is defined outside `@repo/core` (it lives in the umbrella), so it cannot extend core's dispatch table. Two options:

1. **`model_call` returns a plain `step(...)` whose `fn` does the engine call.** The outer `kind` becomes `'step'`; the `id` is the only handle. `describe` shows a plain step. Loses the discriminated-kind signal.
2. **`@repo/core` gains a `register_step_kind(kind, options)` seam.** Composers (including the umbrella's `model_call`) register a kind string once at module load; the runner dispatches via the registry. Adds surface area.

**Decision: Option 1** — `model_call` returns a named `step('model_call', fn)`, and `describe`/`describe.json` surface the config via `step.config` rather than via `step.kind`. Rationale: the new surface area from option 2 isn't justified by a single downstream composer, and `describe` already renders `config` in a way that's legible ("`step(generate_plan) { model: "cli-sonnet", has_tools: true }`"). If a second umbrella-layer composer appears (adversarial-model, judge, etc.), revisit.

### §4.6 Abort semantics

- `ctx.abort.aborted === true` at step start: throw `aborted_error({ reason: { signal: 'abort' }, step_index: 0 })` before calling the engine. The engine call is never issued.
- `ctx.abort` fires mid-call: the engine rejects with `aborted_error` (engine-layer behavior, constraints §5.1). The composer re-raises unchanged. `aborted_error` is the same class in both layers (see `NOTES.md` D5).

### §4.7 Typed errors

`model_call` throws only what the engine throws: `aborted_error`, `provider_error`, `provider_auth_error`, `rate_limit_error`, `schema_validation_error`, `tool_error`, `tool_approval_denied_error`, `provider_capability_error`, `engine_config_error`, `on_chunk_error`, `claude_cli_error`, `engine_disposed_error`. No new error class.

### §4.8 Not in scope for `model_call` v1

- **Retry at the step level.** Callers wrap `model_call` in `retry(...)` when they want composition-layer retry; the engine's own `retry_policy` covers transient HTTP failures.
- **Budget gating.** No `max_usd_per_call`. Cost events are emitted; harnesses enforce.
- **Streaming the `content` out as partial step output.** `Step` returns exactly once (constraints §5.4); chunks flow via `ctx.emit`, final result is the single return.
- **Tool registration sugar.** `cfg.tools` is the existing `Tool[]` shape; no DSL.
- **Per-call alias override.** `cfg.model` is a string resolved via the engine's alias table; runtime alias overrides happen at `engine.register_alias(...)` time, not inside the composer.

---

## §5 — `describe.json(step)`

### §5.1 Shape

The contract is the TypeScript type below. The existing `flow_schema` JSON Schema describes the YAML DSL (constraints §6 / composition spec §5.17) — a different shape from this introspection tree — and is intentionally not the validator for `describe.json` output in v1. See §5.3.

```typescript
export type FlowNode = {
  readonly kind: string;
  readonly id: string;
  readonly config?: Readonly<Record<string, FlowValue>>;
  readonly children?: ReadonlyArray<FlowNode>;
};

export type FlowValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<FlowValue>
  | Readonly<Record<string, FlowValue>>
  | { readonly kind: '<fn>' }
  | { readonly kind: '<schema>' }
  | { readonly kind: string; readonly id: string }; // referenced step
```

### §5.2 API

`describe.json(step)` is a property on the function, not a separate export:

```typescript
export function describe<i, o>(root: Step<i, o>): string;
export namespace describe {
  function json<i, o>(root: Step<i, o>): FlowNode;
}
```

Implementation in `packages/core/src/describe.ts` alongside the existing text renderer. Shared tree walk; two formatters.

### §5.3 Stability

The `FlowNode` TypeScript type is the contract in v1. Tests in `packages/core/describe.test.ts` assert shape structurally (field-by-field expectations on representative composer trees); returned values must be assignable to `FlowNode` at compile time. No ajv-backed runtime schema validation this build — `flow_schema` describes the YAML DSL, not the introspection tree, and writing a second JSON Schema purely to guard `describe.json` output is work that can wait until a consumer needs a cross-language contract. Follow-up build may introduce a dedicated `describe_schema` export if that need materializes.

### §5.4 Circular references

`describe.json` detects cycles by tracking visited step identities. A cycle records `{ kind: '<cycle>', id: '<original>' }` at the back-reference and does not recurse further. The original cycle warning (docs-only today) graduates to a `describe_cycle_error` thrown from `describe()` and `describe.json()` when `{ strict: true }` is passed. The default remains tolerant.

---

## §6 — `/version` Skill Rewrite

### §6.1 New behavior

`.claude/skills/version/SKILL.md` is rewritten. Differences from the current single-root version:

1. **Scope.** Walks `packages/*/package.json` plus the root **plus** the two source-level version constants at `packages/core/src/version.ts` and `packages/engine/src/version.ts` (each exports a literal string re-surfaced by the umbrella as `core_version` / `engine_version` — D6). All are part of the lockstep set.
2. **Lockstep.** Every file is bumped to the same `new_version`. A pre-flight asserts every current version already matches (fail fast on skew).
3. **Summary step** unchanged — still writes `CHANGELOG.md` grouped by commit impact.
4. **Commit payload** becomes: root `package.json` + every `packages/*/package.json` + `packages/core/src/version.ts` + `packages/engine/src/version.ts` + `CHANGELOG.md`.
5. **Commit message** unchanged: literally `vX.Y.Z`.
6. **Post-bump verification:** run `pnpm check` (the skill invokes `pnpm check --bail`; failure stops the commit). Optional: `pnpm build` sanity.

### §6.2 Algorithm

```
current = read_root_pkg().version
LOCKSTEP_SET = [
  root package.json,
  ...packages/*/package.json,
  packages/core/src/version.ts   (literal-string constant)
  packages/engine/src/version.ts (literal-string constant)
]
for each target in LOCKSTEP_SET:
  assert target.version === current
    (else fail: "workspace version skew: {target} at {target.version}, root at {current}")
new = bump(current, type)
for each target in LOCKSTEP_SET:
  rewrite target.version = new
regenerate CHANGELOG.md section
stage: every LOCKSTEP_SET file + CHANGELOG.md
commit: "vX.Y.Z"
run: pnpm check --bail (abort with error & git reset if fail)
```

The two `version.ts` files are edited with a literal-string rewrite keyed on the existing `export const version = '<SEMVER>';` pattern — not a general TS-aware transform, just a targeted regex on that single line.

### §6.3 Tag policy

The skill does **not** tag. The user (or CI) tags after reviewing the commit. Matches current behavior.

### §6.4 Skew-repair flag

`/version patch --repair-skew` force-aligns every package to the root's current version (no bump, no CHANGELOG entry). Separate codepath; does not create a release commit. Useful once, the next time skew is discovered.

---

## §7 — Link Check

### §7.1 Script

New file: `scripts/check-links.mjs`. ~60 lines.

```
1. glob all *.md files under the repo, excluding:
   - node_modules/**, dist/**, .check/**, .stryker-tmp/**
   - docs/ (ignored by markdownlint-cli2 already — same ignore list applies)
   - research/**
   - .ridgeline/** (historical; links there may be stale by design)
2. for each file, extract every [text](target) link via a simple regex
3. skip targets that start with http://, https://, mailto:, #
4. resolve relative targets against the file's directory
5. fs.existsSync(resolved) — collect misses
6. if misses: write .check/links.json with an array of { file, line, link, resolved }, exit 1
7. else: write .check/links.json with { ok: true }, exit 0
```

Output shape matches other check tools. The orchestrator picks up the exit code.

### §7.2 Pipeline placement

`scripts/check.mjs`'s `CHECKS` array gains a new entry, placed **after** `docs` (markdownlint) and **before** `spell`:

```
{ name: 'links',
  description: 'Relative markdown link targets exist',
  command: 'node',
  args: ['scripts/check-links.mjs'],
  output_file: 'links.json' },
```

### §7.3 Fragment (anchor) support

Not in v1. `[foo](./bar.md#some-heading)` validates only the file half (`./bar.md`); the anchor is ignored. Anchor validation is deferred — doing it right means parsing every target file for heading anchors and that's a real tool, not a 60-line script.

### §7.4 Allowlist

`scripts/check-links.mjs` accepts a `LINK_CHECK_ALLOWLIST` regex array declared at the top of the file. One entry by default: `/^\.\.\/docs\/agent-kit-.*-spec\.md$/` is **not** allowlisted — those were deleted in Phase 1; any remaining reference should fail. Add allowlist entries only with commit-message justification.

---

## §8 — Mutation Gate (resolved)

Originally deferred by this spec (decision 2026-04-21) and wired in a follow-on pass on the same day. Current state:

- Baseline: 61.44% overall as of 2026-04-20 (see §2 for weak-file list).
- Stryker runs as the `mutation` step of `pnpm check` (`scripts/check.mjs`), using incremental mode with a committed baseline at `reports/mutation/incremental.json`.
- Thresholds in `stryker.config.mjs`: `{ high: 80, low: 60, break: 50 }`. The gate fails `pnpm check` when overall score drops below `break`.
- JSON report emitted to `.check/mutation.json` by Stryker's own reporter. No separate scoring script needed.
- `prepublishOnly` inherits the gate via its existing `pnpm check` invocation. `/version` and `scripts/check-publish.mjs` remain unchanged.
- Developers running tight loops can skip the step with `pnpm check --skip mutation`.

Follow-up work: ratchet `break` upward as the weak files (§2) get covered. Target ranges: 60% for v0.1.x, 70% for v0.2, 80% for v1.0.

---

## §9 — README Documentation

The root `README.md` gains one section at the top of "Layout":

```markdown
## Names

- **`@robmclarty/agent-kit`** — the one thing you install from npm. Bundles the composition primitives and the engine.
- **`@repo/core`, `@repo/engine`, `@repo/observability`, `@repo/stores`, `@repo/fascicle`** — workspace-only. Contributors see these internally; they are never published.

Only `@robmclarty/agent-kit` reaches npm. Contributors work against `@repo/*` symlinks inside this pnpm workspace.
```

No other doc rewrites in this build. `docs/getting-started.md`, `docs/providers.md`, etc. already import from `@robmclarty/agent-kit` (see the README rewrite in Phase 1), so they need no changes.

---

## §10 — Success Criteria

### Automated tests

1. **Umbrella exports.** Unit test asserts the umbrella `index.ts` exports every symbol this spec adds (`model_call`, `describe.json`) plus every symbol already exported pre-build.
2. **`model_call` — happy path.** Mock engine whose `generate` returns a canned `GenerateResult`; build `model_call({ engine, model: 'x' })`; `run(step, 'hi')`; assert `result.content` matches, `step.kind === 'step'`, `step.id === 'model_call'` when no id supplied.
3. **`model_call` — abort pre-flight.** Pre-aborted `ctx.abort`; assert `aborted_error` raised, mock `generate` never called.
4. **`model_call` — abort mid-flight.** Abort fires while engine is pending; assert `aborted_error` propagates and engine received the signal.
5. **`model_call` — streaming parity.** Same canned response with and without `run.stream`; assert identical `GenerateResult`; assert chunks routed through `ctx.emit` only in the streaming path.
6. **`model_call` — describe surfaces model config.** `describe(model_call({ engine, model: 'cli-sonnet', system: 'be careful' }))` output contains `model: "cli-sonnet"` and `system: "be careful"`; no bare `engine` object.
7. **`describe.json` — shape.** Sample `sequence([step(a), parallel([step(b), step(c)])])`; assert `describe.json` returns a tree with the expected `kind`, `id`, `config`, and `children` fields at each level. Type-level: the returned value is assignable to `FlowNode` (tsc enforces in `pnpm check`). No ajv validation in v1 (§5.3).
8. **`describe.json` — fns and schemas.** Assert `<fn>` and `<schema>` placeholders serialize as `{ kind: '<fn>' }` / `{ kind: '<schema>' }`.
9. **`describe.json` — cycle detection.** Construct an artificial cycle; assert the back-reference renders as `{ kind: '<cycle>', id: '<target-id>' }` (loose mode) and throws `describe_cycle_error` under `{ strict: true }`.
10. **Build produces dist.** `pnpm build` → assert `./dist/index.js` and `./dist/index.d.ts` exist, non-zero length.
11. **Build bundles workspace deps.** Grep `./dist/index.js` for `from '@repo/` → assert zero matches (all workspace deps inlined).
12. **Build keeps peer deps external.** Grep `./dist/index.js` for `from 'ai'`, `from '@ai-sdk/anthropic'`, `from 'zod'` → assert each present (kept external).
13. **Smoke import.** `node -e "import('./dist/index.js').then(m => { if (!m.run || !m.create_engine || !m.model_call || !m.describe) throw new Error('missing export') })"` exits 0.
14. **`check:publish` — pack dry-run.** Assert dist files included, test files excluded, `.ridgeline/` excluded, raw `.ts` source excluded.
15. **`check:publish` — arethetypeswrong clean.** Assert no resolution failures reported.
16. **`check:publish` — version lockstep.** Artificially skew one `packages/*/package.json` version; assert `check:publish` fails with a clear message naming the offending file.
17. **Link check — clean repo.** `pnpm check --only links` on the current tree → exit 0.
18. **Link check — broken link.** Add `[bad](./nonexistent.md)` to a test-fixture `.md`; assert `check:links` reports it in `.check/links.json` and exits 1.
19. **Link check — external ignored.** `[x](https://example.com)` in a fixture; assert no failure.
20. **`/version patch` lockstep.** Fresh workspace at `0.1.5`; run skill; assert every `packages/*/package.json`, the root, and both `packages/{core,engine}/src/version.ts` constants are at `0.1.6`; assert single commit with exactly those files + `CHANGELOG.md`.
21. **`/version` skew guard.** Artificially skew one `packages/core/package.json` (or one `version.ts` constant) to `0.1.4`; run `/version patch`; assert skill refuses with a clear message naming the offending file.

### Manual validation

- `pnpm check` exits 0 including the new `links` step (total runtime ≤10s).
- `pnpm build` produces a bundle that imports cleanly in a scratch project (`mkdir /tmp/smoke && cd /tmp/smoke && pnpm init && pnpm add file:/.../agent-kit-0.1.5.tgz && node -e "..."`).
- `pnpm publish --dry-run` from the repo root reports the expected file list and no warnings beyond the acceptable `pnpm`-workspace-root noise.
- The umbrella `README.md` Names section renders as intended on GitHub.

### Architectural validation (mechanically checked)

- **No value import of `@repo/engine` in `packages/core/src/`** (existing rule, still enforced).
- **No value import of `@repo/core` in `packages/engine/src/`** except the `aborted_error` re-export (existing D5 carve-out).
- **`model_call` is the only file in `packages/fascicle/src/` that imports value symbols from both `@repo/core` and `@repo/engine`.** New ast-grep rule: `rules/model-call-is-sole-bridge.yml` (scope: `packages/fascicle/src/**`, allow only `model_call.ts` to do both).
- **`dist/` is never imported from source.** Grep under `packages/*/src/**` for `dist/` → zero matches.
- **`private: true` removed only from root.** Mechanical: every `packages/*/package.json` must keep `"private": true`; root must not have it. Add to `scripts/check-deps.mjs`.
- **Lockstep version invariant.** Same script asserts every `packages/*/package.json` version matches the root's, *and* that the literal constants in `packages/core/src/version.ts` and `packages/engine/src/version.ts` match. Runs in `pnpm check`.

---

## §11 — File Structure

```
agent-kit/
├── dist/                                     # NEW (gitignored; populated by pnpm build)
│   ├── index.js
│   ├── index.js.map
│   └── index.d.ts
├── tsdown.config.ts                          # NEW
├── scripts/
│   ├── build.mjs                             # NEW
│   ├── check-publish.mjs                     # NEW
│   ├── check-links.mjs                       # NEW
│   ├── check-deps.mjs                        # EDIT: add lockstep-version invariant + root-not-private invariant
│   └── check.mjs                             # EDIT: add 'links' check after 'docs'
├── packages/
│   ├── agent-kit/                            # umbrella (stays @repo/fascicle, private)
│   │   └── src/
│   │       ├── index.ts                      # EDIT: export model_call
│   │       └── model_call.ts                 # NEW
│   ├── core/
│   │   └── src/
│   │       ├── describe.ts                   # EDIT: add describe.json namespace; cycle detection; refresh header (drop stale §6.6 cite)
│   │       └── describe.test.ts              # EDIT: add describe.json structural + type-level assertions (no ajv in v1)
│   ├── engine/                               # no source changes; peer deps unchanged
│   ├── observability/                        # no changes
│   └── stores/                               # no changes
├── rules/
│   └── model-call-is-sole-bridge.yml         # NEW
├── .claude/
│   └── skills/
│       └── version/
│           └── SKILL.md                      # EDIT: lockstep walk, skew guard, --repair-skew mode
├── package.json                              # EDIT: drop private, add publishConfig/main/module/types/exports/files/peerDeps, build/check:publish scripts; add @arethetypeswrong/cli to devDependencies
├── README.md                                 # EDIT: add Names section at top of Layout
├── AGENTS.md                                 # EDIT: add one-line pointer to two-name discipline
├── .gitignore                                # EDIT: add /dist
└── CHANGELOG.md                              # populated by /version on next release
```

Public surface additions published through the umbrella (`packages/fascicle/src/index.ts`):

- `model_call`, `ModelCallInput`, `ModelCallConfig`
- `describe.json` (the function is already exported; the namespace member is new)
- `FlowNode`, `FlowValue`
- `describe_cycle_error`

Published package surface for consumers: identical — `import ... from '@robmclarty/agent-kit'`.

---

## §12 — `taste.md` Additions

Two new principles, numbered to continue the existing list. Added to `.ridgeline/taste.md`:

**Principle 15 — Umbrella-is-the-seam.** The workspace publishes exactly one npm package. Multi-package publication is a path we could take later; taking it now doubles the coordination tax (version alignment, dep-graph alignment, peer-dep alignment across N tarballs) before a single user has asked for slim installs. An umbrella with a bundled `dist/` is the simpler shape. Each layer stays a separate workspace package under `@repo/*` so `constraints.md` §3's boundary rules keep their teeth internally; externally, the published artifact is one thing.

**Principle 16 — Lockstep first; semver-per-package on demand.** Every workspace package ships at the same version. This is arbitrary (there is no runtime coupling that would force it) but makes versioning a non-decision: bumping the root bumps everything. The alternative — independent semver per package — is a full-time job masquerading as a tooling setup. Adopt it if and when the shape of the code makes lockstep actively wrong (e.g. one layer churns 10x faster than another). Default is lockstep. One number, one release note, one tag.

---

## §13 — Open Questions

1. **`@arethetypeswrong` false positives.** The `peerDependency` peer on `ai` at `^6.0.0` combined with inlined engine bundling may trip some versions of arethetypeswrong. If so, pin its invocation and document. Decide on first CI run.
2. **Browser build.** Still out. Revisit if a user explicitly asks for an `@robmclarty/agent-kit/browser` entry point. v1 is Node-only.
3. **`describe.json` stability of `<fn>` / `<schema>` placeholders.** These shapes (`{ kind: '<fn>' }`) are technically part of `flow_schema`. Any renderer that diffs across versions relies on them. Commit to stability for v0.x; revisit at v1.0.
4. **Link-check anchors.** Deferred to v0.2. Needs a proper tool (`markdown-link-check` is the likely pick).
5. **`model_call` and HITL.** `cfg.on_tool_approval` is a pass-through to the engine. Some harnesses may want the approval to route through `ctx` instead. Revisit after a first harness reports friction.
6. **`describe_cycle_error` location.** Currently scoped to `@repo/core/errors.ts`. If `describe.json(step, { strict: true })` becomes the norm for all harnesses, promote the error to the top-level umbrella export. v1 keeps it in core.
7. **Repository URL.** Root `package.json`'s `repository.url` is a placeholder (`git+https://github.com/robmclarty/agent-kit.git`) — confirm this is the final GitHub slug before publishing, or publish under the corrected URL. Not a code issue; a metadata issue.

### Closed by the 2026-04-21 review

- **Slim installs / multi-package publish.** No. Only `@robmclarty/agent-kit` publishes; the `@repo/*` packages stay workspace-private. See §3.
- **Bundle vs multi-package install.** Bundle via `tsdown`. See §3.3.
- **Version-bump strategy.** Lockstep. See §6.
- **Mutation in the release gate.** Wired into `pnpm check` 2026-04-21 (reverses the earlier deferral). See §8.
- **Changesets adoption.** Not adopted; superseded by the lockstep + single-publish decisions above.

---

## Bootstrap / required reading for the builder

Read these in order before writing code. Items 1–3 are the contract; 4–6 are source orientation.

1. `../../constraints.md` (project-wide; §3 boundaries, §4 runtime deps, §7 architectural invariants, §8 distribution/versioning)
2. `../../taste.md` (design philosophy)
3. `../../../NOTES.md` (Phase 2 scope and the decisions behind it)
4. Current surface:
   - `../../../packages/fascicle/src/index.ts`
   - `../../../packages/core/src/index.ts`
   - `../../../packages/core/src/describe.ts`
   - `../../../packages/core/src/flow-schema.json`
   - `../../../packages/engine/src/index.ts`
   - `../../../packages/engine/src/types.ts`
5. Check pipeline and scripts:
   - `../../../scripts/check.mjs`
   - `../../../scripts/check-deps.mjs`
6. Existing skill (for rewrite reference):
   - `../../../.claude/skills/version/SKILL.md`

### Build order

1. **`describe.json` + cycle detection.** Small, self-contained, no cross-package impact. Land first; ship under the existing private workspace without affecting any publish plumbing.
2. **`model_call` composer.** Second. Lives only in `packages/fascicle/src/model_call.ts`. Requires `describe.json` to validate its `describe` output.
3. **ast-grep rule `rules/model-call-is-sole-bridge.yml`.** Locks the bridge to one file.
4. **Lockstep-version invariant in `scripts/check-deps.mjs`** plus the root-not-private carve-out. Run `pnpm check` to confirm green.
5. **`scripts/check-links.mjs` + pipeline entry.** Small, independent; can land parallel to 1–4.
6. **`tsdown.config.ts` + `scripts/build.mjs`.** First publish-engineering step. `pnpm build` must produce a self-importable `dist/`.
7. **Root `package.json` rewrite.** Drop `private`; add `publishConfig`, `main`, `module`, `types`, `exports`, `files`, `peerDependencies`, `peerDependenciesMeta`, `build`, `check:publish`, `prepublishOnly` scripts.
8. **`scripts/check-publish.mjs`.** Runs after step 7 can succeed.
9. **`/version` skill rewrite.**
10. **Documentation.** Root `README.md` Names section; one-liner in `AGENTS.md`; `taste.md` principles 15 and 16; `CHANGELOG.md` entry via `/version`.

### Invariants to enforce during implementation

- No new value imports of `@repo/engine` inside `packages/core/src/`. `model_call` lives in the umbrella, not core.
- `dist/` is produced by build only; never imported from source; gitignored.
- The root `package.json` loses `"private": true` but every `packages/*/package.json` keeps it.
- Every workspace `package.json` version (root + six packages) is identical after any `/version` run.
- `describe.json` output validates against `flow_schema` for every composer example in the test suite.
- `model_call` never mutates its `cfg` argument; never reads `process.env`; never installs signal handlers.
- `scripts/build.mjs` exits non-zero on any tsdown warning or failure; silent success is not acceptable.

When in doubt, the spec wins over intuition. Implement the simpler interpretation; mark any divergence with a `TODO` citing the relevant section.
