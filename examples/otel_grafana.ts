/**
 * otel_grafana: watch an agent's traces and metrics on a Grafana dashboard.
 *
 * Everything Fascicle knows about a run travels on one trajectory stream.
 * `create_otel_trajectory_logger` (from `fascicle/otel`) turns that stream
 * into OpenTelemetry spans and, with `metrics: true`, standard GenAI metric
 * instruments: token usage, model turn duration, tool duration, estimated
 * cost, and retries the engine absorbed. Register the OpenTelemetry SDK once
 * at startup, hand the logger to `run`, and any OTel-speaking backend can
 * chart the results; this example ships them to Grafana's all-in-one image.
 *
 * The model is a canned in-process provider with pretend latency, token
 * counts, one tool call per run, and an occasional simulated rate limit, so
 * no API key is needed. Swapping in a real provider changes nothing below:
 * the logger observes the run, not the provider.
 *
 * Prereqs: Docker, with the Grafana OTel stack listening on localhost:
 *   docker run --rm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
 *
 * Run directly:
 *   pnpm exec tsx examples/otel_grafana.ts
 *
 * Then open http://localhost:3000 and import
 * examples/otel_grafana_dashboard.json (Dashboards > New > Import).
 * docs/grafana.md walks through every step in detail.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { metrics as otel_metrics, trace as otel_trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { z } from 'zod'

import { chain, create_engine, model_step, run } from 'fascicle'
import { create_otel_trajectory_logger } from 'fascicle/otel'
import type { ProviderFactory, Tool, TurnResult } from 'fascicle'

// Where the local collector listens. The exporters read the same variable
// themselves; this copy only feeds the preflight check and the final hint.
const OTLP_BASE = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318'

// --- OpenTelemetry plumbing, registered once at startup -------------------
//
// The exporters default to the standard local OTLP address (localhost:4318),
// which is where the grafana/otel-lgtm container listens. `service.name` is
// the label Grafana groups everything under.

const resource = resourceFromAttributes({ 'service.name': 'trip-planner' })

const meter_provider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 2_000,
    }),
  ],
})
otel_metrics.setGlobalMeterProvider(meter_provider)

const tracer_provider = new BasicTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
otel_trace.setGlobalTracerProvider(tracer_provider)

// --- A pretend model and one tool, so the example needs no API key --------

const forecast_input = z.object({ city: z.string() })

const fetch_forecast: Tool = {
  name: 'fetch_forecast',
  description: 'Look up the weather forecast for a city.',
  input_schema: forecast_input,
  execute: async (raw) => {
    const { city } = forecast_input.parse(raw)
    await sleep(40 + Math.random() * 120)
    return { city, forecast: 'sunny, 24 C' }
  },
}

let turn_count = 0

const create_demo_provider: ProviderFactory = () => ({
  kind: 'native',
  name: 'demo',
  supports: (capability) => capability === 'text' || capability === 'tools',
  async invoke_turn(req) {
    turn_count += 1
    // Every ninth turn fails like a real 429 so the engine's retry policy
    // absorbs it and the dashboard's retry panel has data.
    if (turn_count % 9 === 0) {
      throw Object.assign(new Error('demo: simulated rate limit'), { status: 429 })
    }
    await sleep(150 + Math.random() * 450)
    const usage = {
      input_tokens: 200 + Math.round(Math.random() * 300),
      output_tokens: 30 + Math.round(Math.random() * 90),
    }
    if (req.step_index === 0) {
      return {
        text: '',
        tool_calls: [
          { id: `call_${turn_count}`, name: 'fetch_forecast', input: { city: 'Lisbon' } },
        ],
        finish_reason: 'tool_calls',
        usage,
      } satisfies TurnResult
    }
    return {
      text: 'Sunny all weekend. Pack light layers and walk the castle early.',
      tool_calls: [],
      finish_reason: 'stop',
      usage,
    } satisfies TurnResult
  },
})

// --- The agent and its surrounding flow, same as any Fascicle app ---------

const engine = create_engine({
  providers: { demo: {} },
  custom_providers: { demo: create_demo_provider },
  defaults: { provider: 'demo', model: 'trip-model-1' },
  pricing: { 'demo:trip-model-1': { input_per_million: 3, output_per_million: 15 } },
})

const planner = model_step({
  engine,
  system: 'You are a trip planner. Check the forecast before advising.',
  tools: [fetch_forecast],
  id: 'planner',
})

const flow = chain<string, 'question'>('question')
  .step('advice', ({ question }, ctx) => ctx.call(planner, question))
  .output(({ advice }) => advice)

const QUESTIONS = [
  'What should I pack for a weekend in Lisbon?',
  'Is Saturday better than Sunday for the coastal walk?',
  'Do I need a rain jacket for the old town?',
  'Should we book the rooftop dinner or the courtyard one?',
]

export async function run_otel_grafana(runs = 20): Promise<{ completed: number }> {
  // One logger for the whole program: it feeds every run's spans and metric
  // points to whatever the global OTel providers were configured with above.
  const trajectory = create_otel_trajectory_logger({ metrics: true })
  let completed = 0
  for (let i = 0; i < runs; i += 1) {
    const question = QUESTIONS[i % QUESTIONS.length] ?? ''
    await run(flow, question, { install_signal_handlers: false, trajectory })
    completed += 1
    if (completed % 5 === 0) console.log(`ran ${completed}/${runs} flows`)
  }
  return { completed }
}

async function collector_is_up(): Promise<boolean> {
  try {
    await fetch(OTLP_BASE, { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const main = async (): Promise<void> => {
    if (!(await collector_is_up())) {
      console.error(`No OpenTelemetry collector is answering at ${OTLP_BASE}.`)
      console.error('Start the local Grafana stack first:')
      console.error('  docker run --rm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm')
      process.exit(1)
    }
    const { completed } = await run_otel_grafana()
    await engine.dispose()
    // Shutdown flushes whatever the batching exporters are still holding.
    await tracer_provider.shutdown()
    await meter_provider.shutdown()
    console.log(`Sent traces and metrics for ${completed} runs to ${OTLP_BASE}.`)
    console.log('Open http://localhost:3000, then Dashboards > New > Import,')
    console.log('and upload examples/otel_grafana_dashboard.json to see them.')
  }
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
