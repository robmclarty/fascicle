# Viewer

A minimal in-repo dashboard that shows you a fascicle run as it executes, or
after the fact. One static HTML page, two transports (file-tail and HTTP
push), no build step, no auth.

It's a debugging tool, and nothing about it reaches your source code. You keep
using `filesystem_logger` (or, opt-in, `http_logger`) exactly as you do today,
and the viewer is a separate process that reads what you already write.

## Quickstart — File Tail

```bash
# terminal 1: generate a demo trajectory (no engine, no API key)
pnpm exec tsx examples/viewer_demo.ts

# terminal 2: point the viewer at the JSONL file
pnpm exec fascicle-viewer .trajectory.jsonl
# → http://127.0.0.1:4242
```

[`examples/viewer_demo.ts`](../examples/viewer_demo.ts) writes
`.trajectory.jsonl` through `filesystem_logger`, and any flow of your own that
logs to a file works the same way. If you'd rather not install anything,
`pnpm dlx --package=fascicle fascicle-viewer .trajectory.jsonl` gets you a
one-off run.

The viewer tails the file with `fs.watch`, parses each new line through
`parse_trajectory_event` (exported from `fascicle`), and pushes the parsed
events to your browser over SSE. It works on a finished run too, so point it
at any old `.jsonl` and you get a static replay.

## Quickstart — HTTP Push (Low-Latency, Opt-In)

Use this when you want a live attach with no latency at all, when you're
developing remotely and can't reach the file, or when a flow runs long inside
a container:

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

| Route           | Method | Purpose                                         |
| --------------- | ------ | ----------------------------------------------- |
| `/`             | GET    | static dashboard                                |
| `/api/events`   | GET    | `text/event-stream` of trajectory events        |
| `/api/snapshot` | GET    | JSON dump of the ring buffer                    |
| `/api/ingest`   | POST   | newline-delimited events from `http_logger`     |
| `/api/health`   | GET    | `{ ok: true }`                                  |

SSE clients reconnect with `Last-Event-ID` and the server replays anything
past their cursor that's still in the ring buffer.

## Programmatic Embed

```ts
import { start_viewer } from 'fascicle/viewer'

const handle = await start_viewer({ path: '.trajectory.jsonl', port: 4242 })
// ...
await handle.close()
```

## Security

Localhost only by default. `--host 0.0.0.0` is allowed, but the CLI warns you
first, because the dashboard has no auth and shows whatever is in your
trajectory stream. Don't bind it to a public interface.
