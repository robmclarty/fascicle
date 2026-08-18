/**
 * ollama_chat: drive a local Ollama model through the engine layer.
 *
 * Builds an engine on the `ollama` provider's zero-peer native transport
 * (raw HTTP against the daemon's own /api/chat endpoint, nothing beyond
 * `fascicle` itself to install), then composes two model boundaries as a
 * sequence: draft -> refine. Proves the engine and composition layers work
 * against a real local model without any API key.
 *
 * Prereqs:
 *   1. ollama running at OLLAMA_HOST (default http://localhost:11434)
 *   2. model pulled: `ollama pull llama3.2:3b` (~2 GB on disk)
 *
 * Run directly:
 *   pnpm exec tsx examples/ollama_chat.ts
 *
 * Override host or model via env:
 *   OLLAMA_MODEL=qwen2.5:3b pnpm exec tsx examples/ollama_chat.ts
 */

import { create_engine, model_step, run, sequence } from 'fascicle'

const engine = create_engine({
  providers: {
    ollama: {
      base_url: process.env['OLLAMA_HOST'] ?? 'http://localhost:11434',
      transport: 'native',
    },
  },
  defaults: {
    provider: 'ollama',
    model: process.env['OLLAMA_MODEL'] ?? 'llama3.2:3b',
  },
})

const draft = model_step({
  id: 'draft',
  engine,
  system: 'Write a 2-sentence first draft. Plain prose, no preamble, no lists.',
})

const refine = model_step({
  id: 'refine',
  engine,
  system:
    'Rewrite the following to be more concrete and specific. Return only the revised prose, no preamble.',
})

const flow = sequence([draft, refine])

export async function run_ollama_chat(
  topic = 'why small local language models are useful for prototyping agentic workflows',
): Promise<{ readonly topic: string; readonly output: string }> {
  const output = await run(flow, topic, { install_signal_handlers: false })
  return { topic, output }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const topic = process.argv[2]
  run_ollama_chat(topic)
    .then(({ topic: t, output }) => {
      console.log(`topic:\n  ${t}\n\noutput:\n${output}\n`)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => {
      void engine.dispose()
    })
}
