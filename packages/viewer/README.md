# @repo/viewer

Minimal in-repo dev dashboard for visualizing a fascicle run as it executes
(or after the fact). Single static HTML page, two transports
(file-tail and HTTP push), no build step, no auth.

This is a dev/debugging tool. Nothing about the viewer ever lives in your
source code: you keep using `filesystem_logger` (or, opt-in,
`http_logger`) exactly as you do today, and the viewer is a separate process
that reads what you already write.

## Quickstart — file tail

```bash
# terminal 1: your existing flow, unchanged
pnpm tsx app.ts

# terminal 2: point the viewer at the JSONL file
pnpm fascicle-viewer .trajectory.jsonl
# → http://127.0.0.1:4242
```

The viewer tails the file with `fs.watch`, parses each new line through
`trajectory_event_schema` from `@repo/core`, and pushes parsed events to
the browser via SSE. Works on a finished run too — point it at any old
`.jsonl` for a static replay.

## Quickstart — HTTP push (low-latency, opt-in)

For zero-latency live attach, remote dev where the file isn't accessible,
or long-running flows in a container:

```ts
import { http_logger } from 'fascicle/adapters'

await run(flow, input, {
  trajectory: http_logger({ url: 'http://localhost:4242/api/ingest' }),
})
```

Then run the viewer in listen-only mode:

```bash
pnpm fascicle-viewer --listen
```

`http_logger` drops events on transport error and never blocks the user
flow on the dev tool being up.

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

## HTTP surface

| Route           | Method | Purpose                                         |
| --------------- | ------ | ----------------------------------------------- |
| `/`             | GET    | static dashboard                                |
| `/api/events`   | GET    | `text/event-stream` of trajectory events        |
| `/api/snapshot` | GET    | JSON dump of the ring buffer                    |
| `/api/ingest`   | POST   | newline-delimited events from `http_logger`     |
| `/api/health`   | GET    | `{ ok: true }`                                  |

SSE clients reconnect with `Last-Event-ID` and the server replays anything
past their cursor that is still in the ring buffer.

## Programmatic embed

```ts
import { start_viewer } from '@repo/viewer'

const handle = await start_viewer({ path: '.trajectory.jsonl', port: 4242 })
// ...
await handle.close()
```

## Security

Localhost only by default. `--host 0.0.0.0` is allowed but the CLI warns:
the dashboard has no auth and exposes whatever is in your trajectory
stream. Do not bind it to a public interface.
