# Grafana

This guide takes a Fascicle agent and puts its runs on a Grafana dashboard:
how many tokens it used, how fast the model answered, what the run cost, how
many rate limits the engine quietly retried past, and a clickable tree of
every step in every run. You end up with a live dashboard from one Docker
command, one example script, and one file import, with no API key needed.

Everything travels over OpenTelemetry, which is the open standard that most
monitoring tools speak. Grafana is the tool this guide renders with, but
nothing here is Grafana-specific: the same wiring feeds Datadog, Honeycomb,
Jaeger, or anything else that accepts OpenTelemetry data.

## The Pieces

Four things cooperate, and it helps to know which job belongs to which:

1. **Your program already measures itself.** Every Fascicle run emits a
   trajectory, which is a stream of timed records that says "this step
   started", "the model answered, here is the token count", "this tool took
   140 milliseconds", "that turn cost $0.002". You get this for free; it is
   how `run` reports what happened.
2. **A bridge translates.** `create_otel_trajectory_logger` (from
   `fascicle/otel`) listens to that stream and re-speaks it in
   OpenTelemetry's two dialects: *traces* (one tree of timed spans per run)
   and, when you pass `metrics: true`, *metrics* (running totals and
   timing histograms that a dashboard can graph).
3. **An exporter ships.** The OpenTelemetry SDK batches what the bridge
   produces and posts it over plain HTTP to a collector, which is any
   process that listens on the standard port 4318.
4. **Grafana stores and draws.** The `grafana/otel-lgtm` Docker image is
   the whole receiving side in one container: a collector, a metrics
   database (Prometheus), a trace database (Tempo), and Grafana itself,
   preconfigured to talk to each other.

The seam between 1 and 2 is the part Fascicle owns, and it is one option on
one logger. Steps 3 and 4 are stock OpenTelemetry, the same as for any
Node.js service.

## Try It in Three Steps

The runnable version of this guide is
[`examples/otel_grafana.ts`](../examples/otel_grafana.ts). Its model is a
canned in-process provider with pretend latency, token counts, one tool
call per run, and an occasional simulated rate limit, so the whole demo
runs with no API key and no network beyond your own machine.

First, start the Grafana stack (the image is a few gigabytes on first
pull):

```bash
docker run --rm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
```

Second, run the example. It runs a small trip-planning agent twenty times
and ships every run's traces and metrics to the container:

```bash
pnpm exec tsx examples/otel_grafana.ts
```

Third, open <http://localhost:3000>, go to Dashboards > New > Import, and
upload
[`examples/otel_grafana_dashboard.json`](../examples/otel_grafana_dashboard.json).
You get a dashboard with the totals across the top (model turns, tokens,
estimated cost, retries absorbed), timing and throughput charts below, and
a table of recent runs at the bottom. Click any trace ID in that table and
Grafana opens the run as a tree: the flow at the root, each step inside
it, each model turn and tool call inside those, every bar sized by how
long it took.

The demo dashboard assumes the all-in-one image's data sources, which are
named `prometheus` and `tempo`. If you import it into some other Grafana,
re-point each panel at your own data sources.

## Wiring Your Own App

Three pieces of code turn any Fascicle program into the same picture, and
two of them are ordinary OpenTelemetry setup that any Node.js service
would use.

Install the OpenTelemetry packages (Fascicle deliberately does not bundle
them; a program that skips this section pays nothing):

```bash
pnpm add @opentelemetry/api @opentelemetry/resources \
  @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base \
  @opentelemetry/exporter-metrics-otlp-http @opentelemetry/exporter-trace-otlp-http
```

Register the SDK once, at startup, before the first run. The exporters
default to `http://localhost:4318`, which is where the container listens;
set the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable to
send elsewhere. The `service.name` you pick is the label Grafana groups
everything under:

```ts
import { metrics, trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'

const resource = resourceFromAttributes({ 'service.name': 'my-agent' })

const meter_provider = new MeterProvider({
  resource,
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
})
metrics.setGlobalMeterProvider(meter_provider)

const tracer_provider = new BasicTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
trace.setGlobalTracerProvider(tracer_provider)
```

Then create the bridge and hand it to `run` as the trajectory:

```ts
import { run } from 'fascicle'
import { create_otel_trajectory_logger } from 'fascicle/otel'

const trajectory = create_otel_trajectory_logger({ metrics: true })

const result = await run(flow, input, { trajectory })
```

That is the entire Fascicle-specific part. You do not instrument steps,
tools, or model calls yourself: the composition layer threads the
trajectory into every `model_step` and `ctx.call` for you, so the engine's
spans and events flow through the one logger you passed. Create the logger
once and reuse it across runs, because the metric instruments live on it.

Before the process exits, flush what the batching exporters still hold:

```ts
await tracer_provider.shutdown()
await meter_provider.shutdown()
```

A long-running service can skip this and rely on the periodic export; a
short script that exits right after its last run cannot, because the last
batch would die with the process.

## What the Numbers Mean

The bridge records the OpenTelemetry community's standard instruments for
model calls (the GenAI semantic conventions), plus two Fascicle-named ones
for data the conventions do not cover yet. Prometheus stores each under a
flattened name:

| In Prometheus | What it measures |
| --- | --- |
| `gen_ai_client_token_usage` | tokens per model turn, split by the `gen_ai_token_type` label into `input` and `output` |
| `gen_ai_client_operation_duration_seconds` | wall-clock time of one successful model round trip, with retries and tool time excluded |
| `gen_ai_client_operation_time_to_first_chunk_seconds` | how long the first streamed chunk took to arrive (recorded only on streamed turns) |
| `gen_ai_execute_tool_duration_seconds` | how long each tool ran, labelled with `gen_ai_tool_name` |
| `fascicle_client_operation_cost_usd` | estimated cost per turn, from the engine's pricing table |
| `fascicle_client_turn_retries_total` | provider failures the engine retried past, labelled with `error_type` (`rate_limit`, `provider_5xx`, `network`, `timeout`) |

Every point also carries the provider, the model id, and your
`service.name`, so one dashboard can split by model or compare two
services.

The retries counter deserves a sentence, because it is the one your error
logs cannot give you. A retried 429 never surfaces as an error; the flow
just gets slower. This counter is where that pressure becomes visible
before it becomes an outage.

## Building a Panel by Hand

The importable dashboard is a shortcut, and building one panel yourself
shows there is no magic in it. In Grafana choose Dashboards > New >
Add visualization, pick the Prometheus data source, and paste this into
the query box:

```text
sum by (gen_ai_token_type) (rate(gen_ai_client_token_usage_sum[$__rate_interval])) * 60
```

That reads: take the running token total, turn it into a per-second rate,
scale to per-minute, and draw one line for input tokens and one for
output. Every other panel is the same move with a different query:

```text
# model turn time, 95th percentile
histogram_quantile(0.95, sum by (le) (rate(gen_ai_client_operation_duration_seconds_bucket[$__rate_interval])))

# estimated spend per hour, at the current pace
sum(rate(fascicle_client_operation_cost_usd_sum[$__rate_interval])) * 3600

# total spend over the dashboard's time range
sum(fascicle_client_operation_cost_usd_sum)

# tool time, 95th percentile, one line per tool
histogram_quantile(0.95, sum by (le, gen_ai_tool_name) (rate(gen_ai_execute_tool_duration_seconds_bucket[$__rate_interval])))

# retries the engine absorbed, split by failure kind
sum by (error_type) (increase(fascicle_client_turn_retries_total[$__rate_interval]))
```

## Reading a Run as a Tree

Metrics answer "how is the agent doing overall"; a trace answers "what did
run number seventeen actually do". In Grafana open Explore, pick the Tempo
data source, choose TraceQL, and search:

```text
{resource.service.name="my-agent"}
```

Each result is one `run` call. Opening it shows the structure Fascicle
already knew: the flow span at the root, a child span per step, an
`engine.generate` span per model call with a child per turn, and the
events (tool calls, tool results, cost, retries) pinned to the spans they
happened in. Span attributes carry the details, prefixed with `fascicle.`
so they never collide with OpenTelemetry's own names.

## From Your Laptop to Production

The all-in-one container stores everything in memory and is meant for a
laptop. Moving to a real setup changes one thing, which is the address you
export to: point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector, whether
that is Grafana Cloud's, your platform team's, or a self-hosted one. The
program, the bridge, and the dashboard queries stay exactly as they are.

Two pointers for going deeper. The bridge's options (a custom tracer or
meter, the attribute prefix, and the second, `ai_sdk`-only telemetry
layer) are documented in
[configuration.md](./configuration.md#opentelemetry). And if you want the
raw stream instead of the OpenTelemetry view of it, the same trajectory
feeds the bundled [viewer](./viewer.md) and the plain
[`filesystem_logger`](./cookbook.md#observing-a-run-with-a-filesystem-logger), with no
OpenTelemetry packages involved.
