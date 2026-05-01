# Fascicle Viewer — Plan

A minimal, in-repo dev tool for visualizing a fascicle run as it executes (or after the fact). Single HTML page dashboard. Two transports: file-tail (primary) and HTTP push (opt-in, low-latency). Lives inside this monorepo as `@repo/viewer` and ships as part of the `fascicle` umbrella; runtime install graph is `node:*` plus `zod` plus `@repo/core` — no HTTP-server deps to leak. Distinct from the larger `spec/studio.md` PDR, which remains the long-term north star — this is the small, immediately-useful sibling.

> Status: plan accepted, ready to implement. Scope is "watch a flow run; see which step is firing." Nothing more.

---

## 1. Framing

This is a **dev/debugging tool used by an engineer**, not a consumer-facing product. It is not in the user's hot path. It does not render in production. It does not need to be pretty; it needs to be useful and zero-friction.

Two design rules anchor the rest:

1. **Nothing about the viewer ever lives in the user's source code.** The user keeps writing `trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' })` exactly as they do today. The viewer is a separate process that reads what the user already writes. No "remember to remove before deploy" footgun.
2. **The wire format is the trajectory JSONL stream that already exists.** No new schema, no new event kinds. `trajectory_event_schema` from `@repo/core` is the contract.

---

## 2. The two transports

### Primary: file-tail

```bash
# terminal 1 — user's existing dev invocation, unchanged
pnpm tsx app.ts

# terminal 2 — viewer
pnpm fascicle-viewer .trajectory.jsonl
# → opens http://localhost:4242
```

Viewer `fs.watch`es the file, parses each new line through `trajectory_event_schema`, and pushes parsed events to the browser via SSE. Works on a finished run too — point it at any old `.trajectory.jsonl` and you get a static replay. Works on a crashed run. Works on a remote run whose file you `scp`ed back.

### Opt-in: `http_logger({ url })`

Lives in `@repo/observability` alongside `filesystem_logger`. Same shape, conforms to `TrajectoryLogger`. POSTs each event as a single line of JSON to the configured URL.

```ts
// dev only — same opt-in pattern as filesystem_logger today
await run(flow, input, {
  trajectory: http_logger({ url: 'http://localhost:4242/api/ingest' }),
})
```

The viewer accepts these on `/api/ingest` and broadcasts them on the same SSE stream. Use cases: zero-latency live attach, remote dev where the file isn't accessible, debugging a long-running flow inside a container that exposes a port but no shared filesystem.

The user controls which transport applies via the same mechanism they already use for `filesystem_logger`: pass it to `run()` only in dev. The viewer never appears in `import` graphs of production code.

---

## 3. Package layout

New package under `packages/viewer/`. Internal name `@repo/viewer`; ships as part of the `fascicle` umbrella (no separate published artifact). The runtime install graph is `node:*` plus `zod` plus `@repo/core` — no HTTP-server deps to leak.

```
packages/viewer/
├─ src/
│  ├─ index.ts            # programmatic entry: start_viewer(opts)
│  ├─ cli.ts              # bin entry: fascicle-viewer
│  ├─ server.ts           # HTTP + SSE + ring buffer
│  ├─ tail.ts             # JSONL file watcher → event stream
│  ├─ broadcast.ts        # ring buffer + SSE fan-out (in-process pub/sub)
│  ├─ static/
│  │  └─ viewer.html      # single static page, vanilla JS, no build step
│  └─ __tests__/
│     ├─ tail.test.ts
│     ├─ broadcast.test.ts
│     └─ server.test.ts
├─ package.json           # bin: fascicle-viewer → dist/cli.js
└─ README.md
```

`http_logger` lives in `@repo/observability`, NOT here. It is a generic event-push adapter that happens to pair well with the viewer; it does not depend on the viewer.

### Dependencies

The viewer is allowed runtime deps, isolated to this package. Aim to use only `node:*` plus one tiny SSE helper at most. Realistic shopping list:

- `node:http`, `node:fs`, `node:path`, `node:url` — server, file watching, static serving
- `zod` (already a runtime dep of `@repo/core`) — wire-format validation reuses `trajectory_event_schema`
- `@repo/core` (workspace) — types and the schema
- No Express/Fastify/Hono. `node:http` is enough for ~5 routes. If routing gets gnarly, revisit.
- No frontend framework. Vanilla JS in the static HTML. Native `EventSource` for SSE.

### Architectural boundaries

- `@repo/viewer` may import types and `trajectory_event_schema` from `@repo/core`. It must NOT import `@repo/engine`, `@repo/composites`, or any provider SDK.
- New ast-grep rule (or extension of existing rules) to assert the above. The boundary is "viewer is a dev tool that reads the wire format; it has no business knowing about the engine."
- `fallow` adds `packages/viewer` as a root.
- `scripts/check-deps.mjs` asserts `@repo/viewer` IS present in `@repo/fascicle`'s dependency graph (the umbrella owns the bin and the programmatic surface).

---

## 4. Server contract

Tiny HTTP server. Five routes. All of them respond to a single port, default `4242`.

| Route                | Method | Purpose                                                            |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `/`                  | GET    | static `viewer.html`                                               |
| `/api/events`        | GET    | `text/event-stream` of trajectory events; replays ring buffer      |
| `/api/snapshot`      | GET    | JSON dump of current ring buffer (for late connectors / debugging) |
| `/api/ingest`        | POST   | receives newline-delimited events from `http_logger`               |
| `/api/health`        | GET    | `{ ok: true }` — used by tests and the embed shape                 |

In-memory ring buffer of the last N events (default 1000). Events arrive from one of two producers (file-tail or HTTP ingest), get parsed via `trajectory_event_schema`, get pushed into the broadcaster, get fanned out to all SSE clients.

```
event: trajectory
id: 42
data: {"kind":"span_start","span_id":"sequence:abc12345","name":"sequence","run_id":"r1"}
```

Server LOC budget: under 250.

---

## 5. CLI

Single bin: `fascicle-viewer`.

```
fascicle-viewer <path>          # file-tail mode (primary)
fascicle-viewer --listen        # HTTP-ingest only (no file)
fascicle-viewer <path> --port 4242 --no-open
```

Modes:

- **File-tail (default):** path required, `--listen` accepted to also accept HTTP push at the same time (both producers feed the same broadcaster).
- **Listen-only:** `--listen` without a path. Server stands up; it waits for `http_logger` pushes. Useful when there is no JSONL file (e.g. a one-off debugger invocation that doesn't write `filesystem_logger`).

Default behavior: bind `127.0.0.1:4242`, open the user's browser to `http://localhost:4242`, log "watching `<path>`" or "listening on `4242`" to stderr.

---

## 6. UI

A single HTML page. Vanilla JS, no build step, served from `packages/viewer/src/static/viewer.html`.

What it shows, ranked by importance:

1. **Tree of spans.** Built incrementally from `span_start`/`span_end` events using `parent_span_id` to nest. Each row shows the step's `name`, `span_id`, current state (running / done / errored), and elapsed time.
2. **Active highlight.** A span that has opened but not closed is "active": light pulse animation, ochre tint. When it closes, the pulse stops; the row goes neutral.
3. **Error scar.** Any event where `kind === 'error'` (or any span_end with `error` meta) flips its row to a rust-red scar that persists.
4. **Emit pulse.** A 200ms flash on the owning span's row when an `emit` event arrives. Implementation: keep a per-span "last emit ts"; CSS animation triggered on update.
5. **Event log.** Right-side scrolling pane: timestamp + kind + span_id + truncated payload. Click a row to see the full JSON.
6. **Run filter.** Top bar select for `run_id` (events are tagged with `run_id` per Phase 0 of `spec/studio.md`). Multiple runs in one buffer get separated.

What it does NOT show:

- No graph layout, no edges, no React Flow. The tree is enough to see what is firing.
- No replay scrubber. Reload the page to replay; the snapshot endpoint refills the buffer.
- No editing, no codegen, no aesthetic story (no FFT palette, no parchment). Boring grey-on-light-grey is the look. This is a dev tool.
- No streaming-model-output preview. Dev users can read the JSONL directly if they want raw chunks.

The page weight target: under 50 KB total, fully self-contained, no external CDN fetches.

---

## 7. Behavioral details that matter

- **File watcher.** Use `fs.watch` plus a tail-style read-from-offset. Handle file truncation (someone deleted and re-created the file mid-run): detect a shorter file, reset offset to 0, re-stream from scratch. Handle rotation similarly.
- **Partial last line.** If the watcher fires and the last byte isn't `\n`, buffer it and wait for the next chunk. Do not parse partial lines.
- **Schema failures.** If a line fails `trajectory_event_schema.parse`, log a warning to stderr and skip the line. Never crash. The `custom` variant of the schema is permissive enough that real failures are rare; when they do happen, the user should know.
- **Ring buffer sizing.** Default 1000. Override with `--buffer 5000`. Memory cost is bounded by the slowest consumer.
- **Backpressure.** SSE writes use `res.write` with the standard heartbeat. If a client falls behind, drop events for *that client only*, not for the broadcaster.
- **Graceful shutdown.** SIGINT closes SSE clients with a final `event: close`, then closes the server, then exits 0. No half-open handles.
- **Security.** Bind `127.0.0.1` only by default. `--host 0.0.0.0` is allowed but warns to stderr. No auth — this is a localhost dev tool. The README says so explicitly.

---

## 8. Tests and `pnpm check` integration

Standard fascicle conventions apply: vitest, 70% coverage floor, named exports, no classes, snake_case identifiers, `.js` import extensions.

- `tail.test.ts` — file watcher: append, truncate, rotate, partial line, malformed line.
- `broadcast.test.ts` — ring buffer ordering, fan-out, slow-client backpressure.
- `server.test.ts` — five routes hit with `node:http` clients; SSE handshake; ingest round-trip.
- `viewer.html` itself is not unit-tested in v1. If it grows, add a Playwright smoke test under `--include e2e` (opt-in, mirroring the studio plan). Not v1.

`pnpm check` requires zero new opt-in steps. Types, lint, ast-grep boundary rules, fallow, vitest, cspell, markdownlint all glob the new package automatically.

---

## 9. Phase plan

Each phase ends with `pnpm check:all` green.

### Phase 1 — Wire format and adapter (this repo)

1. Add `http_logger` to `@repo/observability`. Conforms to `TrajectoryLogger`. POSTs newline-delimited JSON to a URL. Constructor takes `{ url, fetch?, on_error? }`. Drops events on transport error by default; configurable.
2. Test round-trip: build a fake event, push through `http_logger` → in-memory server → assert received bytes parse via `trajectory_event_schema`.
3. Re-export `http_logger` and its options type from the umbrella? **No.** Adapters live under `@repo/observability`'s public surface, not `fascicle`'s. Users `import { http_logger } from '@repo/observability'` (or its eventual published name).

Exit: `http_logger` is shippable as a standalone adapter even without the viewer.

### Phase 2 — Viewer package skeleton + server

4. Create `packages/viewer/` with `package.json`, `src/index.ts`, `src/cli.ts`, empty `src/static/viewer.html`.
5. Implement `tail.ts` (fs.watch + offset tracking + line splitter).
6. Implement `broadcast.ts` (ring buffer + SSE fan-out).
7. Implement `server.ts` (the five routes; static file serving for `viewer.html`).
8. Implement `cli.ts` (arg parsing, mode selection, browser-open with `open` or platform-native `xdg-open`/`open` shell-out — but prefer no dep, so use a tiny inline `node:child_process` helper that spawns the platform default browser).
9. ast-grep / fallow updates to police boundaries.

Exit: `pnpm fascicle-viewer fixtures/sample.jsonl` serves a working SSE stream and `/api/snapshot` returns the events.

### Phase 3 — UI

10. Build `viewer.html`: vanilla JS, native `EventSource`, builds tree from incoming events, highlights active spans, pulses on emit, scars on error.
11. Run-id filter dropdown. Event log pane. Click-row to expand JSON.
12. Style: minimal CSS, system font, neutral palette. No fancy assets. No CDN.

Exit: a user can attach the viewer to a running flow and see which step is active, in real time, without changing their app code.

### Phase 4 — Polish

13. README: install (`pnpm add -D fascicle-viewer`), the file-tail flow, the `http_logger` flow, the listen-only flow, the security note (localhost-only by default).
14. Add a `viewer` link from the main README under "Where to go next."
15. Decide whether to publish on first cut or hold private until shape settles. **Recommendation: hold one version cycle inside the workspace, ship after Phase 3 is dogfooded against `examples/amplify`.**

---

## 10. NOT in scope

These are tempting and wrong for v1.

1. **Drag-to-build / codegen.** That's `spec/studio.md`'s job, not this tool's.
2. **Graph layout.** A tree is enough.
3. **Replay scrubber / time travel.** Reload the page or re-run the flow.
4. **Auth, multi-user, accounts.** Localhost only.
5. **Pretty visuals / aesthetic direction.** Boring grey-on-light-grey. Functional.
6. **Streaming model output preview.** Out of scope; the JSONL file already has it for grep.
7. ~~Bundling into the `fascicle` umbrella.~~ Reversed in `spec/eval.md` wedge 1: viewer ships as part of the umbrella. Runtime install graph stays clean because viewer has no HTTP-server deps (only `node:*`, `zod`, and `@repo/core`).
8. **Browser bundle / Vite / Tailwind / React.** Vanilla HTML+JS, no build step.
9. **WebSocket transport.** SSE is sufficient and half the code.
10. **Plugin system, theme system, layout persistence.** Reload-stable URL params at most.

---

## 11. Open questions

1. Should `start_viewer({ port })` be exported from the package as a programmatic embed for users who want to stand it up from a script? (Tentatively yes; near-zero added cost.)
2. What does the viewer do with `suspend(...)` flows that pause? (Tentatively: span stays "active" in the UI; row shows a pause icon. Defer until we hit it.)
3. `http_logger` failure policy when the viewer is unreachable: drop, buffer, or block? (Tentatively: drop with `on_error` callback, never block. Blocking the user's flow on a dev tool being up is a no.)
4. Auto-open browser on CLI startup: yes by default, `--no-open` to suppress?  (Tentatively: yes. Dev tool ergonomics.)

---

## 12. Done definition for v1

1. `pnpm check:all` exits 0.
2. `pnpm fascicle-viewer examples/amplify/.runs/<latest>/trajectory.jsonl` opens a browser showing the run as a live-updating tree.
3. `pnpm tsx examples/amplify/run.ts` with `trajectory: http_logger({ url: 'http://localhost:4242/api/ingest' })` produces the same picture, in real time.
4. The `fascicle` library bundle is byte-for-byte unchanged from before this work.
5. README quickstart works for a first-time reader inside 60 seconds.
