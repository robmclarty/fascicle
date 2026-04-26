/**
 * ollama_chat: drive a local Ollama model through a composed flow.
 *
 * Wraps Ollama's /api/chat endpoint as a step<string, string>, then
 * composes two calls as a sequence: draft -> refine. Proves the
 * composition layer works against a real model without any API key.
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

import { z } from 'zod';

import { run, sequence, step } from '@repo/fascicle';

const ollama_chat_response = z.object({
  message: z.object({ content: z.string() }),
});

type chat_message = {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
};

type ollama_config = {
  readonly host: string;
  readonly model: string;
};

const resolve_config = (): ollama_config => ({
  host: process.env['OLLAMA_HOST'] ?? 'http://localhost:11434',
  model: process.env['OLLAMA_MODEL'] ?? 'llama3.2:3b',
});

const ollama_chat = async (
  config: ollama_config,
  messages: readonly chat_message[],
): Promise<string> => {
  const res = await fetch(`${config.host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`ollama ${String(res.status)}: ${await res.text()}`);
  }
  const body = ollama_chat_response.parse(await res.json());
  return body.message.content.trim();
};

const draft = step('draft', async (topic: string): Promise<string> =>
  ollama_chat(resolve_config(), [
    {
      role: 'system',
      content: 'Write a 2-sentence first draft. Plain prose, no preamble, no lists.',
    },
    { role: 'user', content: topic },
  ]),
);

const refine = step('refine', async (text: string): Promise<string> =>
  ollama_chat(resolve_config(), [
    {
      role: 'system',
      content:
        'Rewrite the following to be more concrete and specific. Return only the revised prose, no preamble.',
    },
    { role: 'user', content: text },
  ]),
);

const flow = sequence([draft, refine]);

export async function run_ollama_chat(
  topic = 'why small local language models are useful for prototyping agentic workflows',
): Promise<{ readonly topic: string; readonly output: string }> {
  const output = await run(flow, topic, { install_signal_handlers: false });
  return { topic, output };
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const topic = process.argv[2];
  run_ollama_chat(topic)
    .then(({ topic: t, output }) => {
      console.log(`topic:\n  ${t}\n\noutput:\n${output}\n`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
