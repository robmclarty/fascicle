/**
 * adversarial_claude_cli: PRD -> implementation plan, critic-driven loop.
 *
 * Drives a build-and-critique flow entirely through the `claude_cli`
 * subprocess provider. A "builder" step turns the PRD into a draft plan;
 * a "critic" step inspects the plan against a zod-validated verdict
 * schema. If the critic fails it, the builder gets the original PRD,
 * the previous draft, and the critic's notes for the next round. Loops
 * up to `max_rounds` times, or until the critic returns `verdict: 'pass'`.
 *
 * Two layers worth pointing out:
 *
 *   - `model_call` accepts `string | Message[]`. The `adversarial`
 *     primitive feeds the build step `{ input, prior?, critique? }`
 *     instead, so we sequence a `compose_build_prompt` step in front
 *     of `model_call` to flatten that record into a prompt string.
 *   - The critic returns structured output via `--json-schema`. The
 *     CLI provider compiles `critique_schema` to JSON Schema, forwards
 *     it, and parses the reply. One repair round is automatic; a second
 *     failure throws `schema_validation_error`.
 *
 * No API key required: the `claude_cli` provider piggybacks on your
 * existing `claude login` session. Make sure `claude` is on PATH.
 *
 * Run directly:
 *   pnpm exec tsx examples/adversarial_claude_cli.ts
 *   pnpm exec tsx examples/adversarial_claude_cli.ts "your PRD here"
 */

import { z } from 'zod';

import {
  adversarial,
  create_engine,
  model_call,
  run,
  schema_validation_error,
  sequence,
  step,
  type GenerateResult,
} from '@repo/fascicle';

const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
});

type build_in = {
  readonly input: string;
  readonly prior?: string;
  readonly critique?: string;
};

const critique_schema = z.object({
  verdict: z.enum(['pass', 'fail']),
  notes: z.string(),
});

type Critique = z.infer<typeof critique_schema>;

const compose_build_prompt = step(
  'compose_build_prompt',
  (i: build_in): string => {
    if (i.prior !== undefined && i.critique !== undefined) {
      return [
        '# PRD',
        i.input,
        '',
        '# Previous draft',
        i.prior,
        '',
        '# Critic notes (address every point)',
        i.critique,
        '',
        'Return the revised plan as plain markdown. No preamble.',
      ].join('\n');
    }
    return [
      '# PRD',
      i.input,
      '',
      'Return a concrete, ordered implementation plan as plain markdown.',
      'No preamble.',
    ].join('\n');
  },
);

const extract_text = step(
  'extract_text',
  (r: GenerateResult<unknown>): string =>
    typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
);

const build = sequence([
  compose_build_prompt,
  model_call({
    engine,
    model: 'cli-sonnet',
    id: 'build',
    system:
      'You are a staff engineer. Given a PRD, produce a concrete, ordered ' +
      'implementation plan. If a previous draft and critique are supplied, ' +
      'revise the plan to address every point raised by the critic. Output ' +
      'plain markdown only.',
  }),
  extract_text,
]);

const extract_critique = step(
  'extract_critique',
  (r: GenerateResult<Critique>): Critique => r.content,
);

const critique = sequence([
  model_call<Critique>({
    engine,
    model: 'cli-haiku',
    id: 'critic',
    schema: critique_schema,
    system:
      'You are a strict reviewer. Inspect the implementation plan. Reply ' +
      'with JSON {verdict, notes}. Use "pass" only when the plan is ' +
      'concrete, ordered, and free of hand-waving; use "fail" otherwise. ' +
      'Notes must be specific, actionable, and cite every weakness you ' +
      'found so the builder can address it on the next round.',
  }),
  extract_critique,
]);

const flow = adversarial<string, string>({
  build,
  critique,
  accept: (c) => c['verdict'] === 'pass',
  max_rounds: 3,
});

const default_prd = [
  '# Rate-limit middleware for the public API',
  '',
  'We need a rate-limit middleware that:',
  '',
  '- Enforces 100 requests/min per API key by default.',
  '- Allows per-tier overrides set in our existing tier config.',
  '- Returns standard 429 with a Retry-After header.',
  '- Emits a structured log event for every reject.',
  '- Has clean shutdown semantics so no in-flight requests are dropped.',
  '',
  'Stack: Node 22, Fastify, Redis available. Must ship behind a feature ',
  'flag and roll out region by region.',
].join('\n');

export async function run_adversarial_claude_cli(
  input: string = default_prd,
): Promise<{
  readonly input: string;
  readonly candidate: string;
  readonly converged: boolean;
  readonly rounds: number;
}> {
  const result = await run(flow, input, { install_signal_handlers: false });
  return {
    input,
    candidate: result.candidate,
    converged: result.converged,
    rounds: result.rounds,
  };
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const argv_input = process.argv.slice(2).join(' ');
  const chosen = argv_input.length > 0 ? argv_input : undefined;
  run_adversarial_claude_cli(chosen)
    .then(({ candidate, converged, rounds }) => {
      console.log(`converged=${String(converged)} rounds=${String(rounds)}\n`);
      console.log(candidate);
    })
    .catch((err: unknown) => {
      if (err instanceof schema_validation_error) {
        console.error('schema_validation_error from critic:');
        console.error(`  raw_text:  ${err.raw_text}`);
        console.error(`  zod_error: ${JSON.stringify(err.zod_error)}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    })
    .finally(() => {
      void engine.dispose();
    });
}
