# Viewer

A minimal in-repo dashboard that shows you a Fascicle run as it executes, or
after the fact. It reads the trajectory you already log, over either of two
transports (file-tail and HTTP push), and draws the flow as a run canvas, a
picture where the composition is dim geometry and the run is amber light that
moves through it. Localhost only, no auth.

It's a debugging tool, and nothing about it reaches your source code. You keep
using `filesystem_logger` (or, opt-in, `http_logger`) exactly as you do today,
and the viewer is a separate process that reads what you already write. The
canvas ships compiled inside the package, so running it stays one command with
nothing for you to build.

## Quickstart

### File Tail

```bash
# terminal 1: generate a demo trajectory (no engine, no API key)
pnpm exec tsx examples/viewer-demo/main.ts

# terminal 2: point the viewer at the JSONL file
pnpm exec fascicle-viewer .trajectory.jsonl
# → http://127.0.0.1:4242
```

[`examples/viewer-demo/main.ts`](../examples/viewer-demo/main.ts) writes
`.trajectory.jsonl` through `filesystem_logger`, and any flow of your own that
logs to a file works the same way. If you'd rather not install anything,
`pnpm dlx --package=fascicle fascicle-viewer .trajectory.jsonl` gets you a
one-off run.

The viewer tails the file with `fs.watch`, parses each new line through
`parse_trajectory_event` (exported from `fascicle`), and pushes the parsed
events to your browser over SSE. It works on a finished run too, so point it at
any old `.jsonl` and you get the whole file folded into the completed run.

### HTTP Push (Low-Latency, Opt-In)

Use this when you want a live attach with no latency at all, when you're
developing remotely and can't reach the file, or when a flow runs long inside a
container:

```ts
import { http_logger } from 'fascicle/adapters'

await run(flow, input, {
  trajectory: http_logger({ url: 'http://localhost:4242/api/ingest' }),
})
```

Then run the viewer in listen-only mode:

```bash
pnpm exec fascicle-viewer --listen
```

`http_logger` drops events on a transport error, so your flow doesn't wait on
the dev tool being up.

## The Run Canvas

The canvas is structure first. The first event of every observed run is
`flow_structure`, the `describe.json` tree of your flow (see
[concepts.md](./concepts.md#what-gets-recorded)), so the canvas draws the whole
composition before a single step runs. You see dim dashed lines for whatever
hasn't executed, a puck and a name for each node, and the group labels that sit
over the composites. A run that has produced nothing yet still shows its full
shape.

From there the spans move the light. A span that opens lights its puck amber and
marches a dashed marquee along the segment that's being traversed, and a span
that closes leaves that segment a traversed grey. Amber is the one accent, and
it carries a single meaning, that the run is alive there right now. Parallel
branches light more than one puck at once, which is legitimate, and the glow
budget is per element (one halo per active puck) so a wide fan never washes the
canvas out.

A few shapes carry their own grammar:

- **Retry** draws as a loop in the line. A spent attempt is a solid grey half
  with a small ✕, the live attempt is the amber half, and the exit stays dashed
  until an attempt earns it.
- **Fallback** draws as a bypass basin under the spine, its two paths labelled
  `STEP · PRIMARY` and `STEP · BACKUP`, and the light reroutes through the
  backup when the primary fails.
- **A scar** is a terminal failure. The puck ring breaks into dashed arcs, a
  small ember ✕ orbits it, the name dims, and the dead segment past it stays
  unbuilt. The scar count surfaces once in the header.
- **Map instances** render as perpendicular ticks on the branch, one per
  iteration. At scale the ticks become a ruler comb, a failure keeps its slot
  as an ✕, and only the running window glows amber.

Ember `#E2503E` shows up only as those small failure marks and counts.
Everything that isn't alive-now amber or failure ember is drawn in the white
family, and hierarchy is opacity rather than added color. The header names the
run (its id truncated to eight characters), a LIVE chip while the app follows
the newest event, and the run's running totals on the right,
`T+130MS · 1 RETRY ABSORBED · SCARS 0 · $0.0000`. Cost under a cent shows four
decimals, and a cent or more shows two.

The marquee, the halo pulse, and the LIVE dot are the only motion, and each one
respects `prefers-reduced-motion`, so a reader who asks for less motion gets a
static glow in place of the animation.

## Replay and the Scrubber

Canvas state is a pure fold, `reduce(flow_structure, events up to t)`, with no
wall-clock reads. Live mode is that fold pinned to the newest event, so replay
isn't a mode bolted on beside it but the same fold stopped earlier. Every run
therefore scrubs.

A time spine runs along the bottom margin in the canvas's own line grammar. It's
traversed grey behind the playhead, dim dashed ahead, a small ember ✕ at each
failure's timestamp, and one amber point for the playhead itself. The header
totals reduce from the same prefix as the canvas, so `T+`, retries absorbed,
scars, and cost stay honest at every position you scrub to.

Scrub off the live edge during a live run and the LIVE chip becomes REPLAY (in
the white family, never amber), the clock freezes at the folded prefix's own
`T+`, and a `RETURN TO LIVE` control re-attaches to the edge. Because the glow
always follows the playhead, amber never lives in two timelines at once.

The scrubber's drawn line is thin, but its hit target isn't, because a 24px band
gives your pointer the room it needs. The keys that move it are these:

- **←** and **→** step one event.
- **Shift+←** and **Shift+→** step one second.
- **Home** rewinds to T+0.
- **End** returns to the live edge.
- **Space** toggles play.

The spine can also shade itself by activity. A `DENSITY` dial in the playback
cluster draws a white-family band behind the spine that brightens where the
events crowd together, which is how map activity at scale reads on the
timeline. The band sits under the failure marks, so every ✕ stays legible, and
the playhead stays the strip's only amber. It's off by default, and the choice
you make persists in `localStorage`, so the viewer remembers it across
sessions.

Opening a finished `.trajectory.jsonl` with no live producer is the same path.
The client folds the whole file over `/api/trajectory`, renders the completed
run, and then follows SSE, which has nothing left to add for a file that's
done.

## Play Mode

Play mode is the showcase path, the one for demo videos and talks. Press play
at T+0 and the canvas performs the run. Light enters at the first node, the
geometry builds as the run traverses it, the retry absorbs, and the terminus
resolves. It eases exactly as a live run does (the same marquee, the same halo
fades), because it's the same fold on a clock rather than a second render path.

Two dials make a long run watchable:

- **Speed** cycles 1x, 2x, and 3x, replaying events on their real timestamp
  deltas divided by the multiplier.
- **Compression** (on by default) caps the wall-clock cost of any single
  inter-event gap at about two seconds, which collapses the dead air inside a
  long model call while dense bursts keep their real pacing. During a capped
  gap the header `T+` visibly accelerates, so the fast-forward stays honest. A
  ten-minute run plays as a performance of a minute or two.

Under both dials sits a floor. No gap between two distinct moments plays
shorter than 400ms of wall time at 1x (200ms at 2x, 133ms at 3x), so a run
whose steps finish in tens of milliseconds, like the demo's 196ms, still
performs as beats you can follow rather than a flash. Events that share a
timestamp still land together, which is how a parallel fan-out keeps lighting
at once. Inside a floored gap the header `T+` visibly slows, the mirror of
compression's acceleration, so the slow-motion stays as honest as the
fast-forward.

A loop toggle repeats the run for booth-style playback. While a performance
runs with the cursor idle, the controls and the scrubber fade after a couple of
seconds, so your screen recording shows only the canvas.

## The Compiled App

The canvas is a compiled Solid app, built by Vite and served as static assets
by the same `node:http` server that carries the API. It ships prebuilt in the
package (under `dist/viewer-app/`), so nothing about installing or running the
viewer asks you to build it.

Two properties are load-bearing, and `pnpm check:all` holds both:

- **The runtime dependency list stays empty.** The whole frontend stack is
  devDependencies, and the shipped artefact is plain static files, so a program
  that installs `fascicle` for its composition layer pays nothing for the
  viewer.
- **The bundle is offline.** It makes no network requests at runtime, so no
  CDN, no Google Fonts fetch, and no telemetry. Sora and Spline Sans Mono are
  vendored as latin-subset WOFF2 beside their OFL license files, and a test
  greps the built assets for external URLs.

If you're working on the viewer itself, `pnpm viewer:app` rebuilds the bundle
(add `:watch` to rebuild on save), and the packaging gate holds the compiled
size to a budget.

## CLI

```text
fascicle-viewer <path>             tail a JSONL file
fascicle-viewer --listen           accept HTTP push only
fascicle-viewer <path> --listen    both producers feed the same broadcaster

  --port <n>      port (default 4242)
  --host <h>      bind host (default 127.0.0.1; --host 0.0.0.0 warns)
  --buffer <n>    ring-buffer size (default 1000)
  --no-open       do not open the browser
  --help          show this message
```

## HTTP Surface

| Route             | Method | Purpose                                        |
| ----------------- | ------ | ---------------------------------------------- |
| `/`               | GET    | the compiled canvas app                        |
| `/api/events`     | GET    | `text/event-stream` of trajectory events       |
| `/api/trajectory` | GET    | full run history as NDJSON (the file, or ring) |
| `/api/snapshot`   | GET    | JSON dump of the ring buffer                   |
| `/api/ingest`     | POST   | newline-delimited events from `http_logger`    |
| `/api/health`     | GET    | `{ ok: true }`                                 |

SSE clients reconnect with `Last-Event-ID` and the server replays anything past
their cursor that's still in the ring buffer. The canvas folds
`/api/trajectory` for the whole run on load, then follows `/api/events` from the
cursor that route names, so the history and the live tail never double-count.

## Programmatic Embed

```ts
import { start_viewer } from 'fascicle/viewer'

const handle = await start_viewer({ path: '.trajectory.jsonl', port: 4242 })
// ...
await handle.close()
```

## Metrics and Dashboards

The viewer is the live picture of one run. For aggregates across many runs
(token counts, cost, latency histograms, a clickable trace tree), the same
trajectory feeds an OpenTelemetry bridge and a Grafana dashboard, covered in
[grafana.md](./grafana.md). The viewer and the dashboard read the one event
stream, so nothing gets instrumented twice.

## Security

Localhost only by default. `--host 0.0.0.0` is allowed, but the CLI warns you
first, because the dashboard has no auth and shows whatever is in your
trajectory stream. Don't bind it to a public interface.
