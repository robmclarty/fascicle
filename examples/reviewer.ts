/**
 * reviewer: structured code review against a stubbed engine.
 *
 * Wires the markdown-defined `reviewer` agent against a tiny in-process
 * engine that returns canned, schema-conforming output. No API keys, no
 * network — the example exists to demonstrate how an agent factory plugs
 * into the rest of fascicle and produces typed, structured findings.
 *
 * Swap `make_stub_engine` for `create_engine({...})` from `@repo/fascicle`
 * to drive the same flow against a real provider.
 *
 * Run directly:
 *   pnpm exec tsx examples/reviewer.ts
 */

import { reviewer, type ReviewerOutput } from '@repo/agents';
import { run } from '@repo/fascicle';
import type { Engine, GenerateOptions, GenerateResult } from '@repo/fascicle';

function make_stub_engine(canned: ReviewerOutput): Engine {
  return {
    generate: async <t = string>(
      opts: GenerateOptions<t>,
    ): Promise<GenerateResult<t>> => {
      const parsed = opts.schema ? opts.schema.parse(canned) : canned;
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 200, output_tokens: 80 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'reviewer-canned' },
      };
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'stub', model_id: 'reviewer-canned' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  };
}

const sample_diff = `\
--- a/src/payments.ts
+++ b/src/payments.ts
@@ -10,6 +10,9 @@
   const total = items.reduce((sum, item) => sum + item.price, 0);
+  if (total < 0) {
+    total = 0;
+  }
   return total;
 }
`;

const canned: ReviewerOutput = {
  findings: [
    {
      severity: 'major',
      file: 'src/payments.ts',
      line: 12,
      category: 'correctness',
      message: '`total` is declared with `const` but reassigned inside the new branch.',
      suggestion: 'Change to `let total` or rewrite the branch as `total = Math.max(total, 0)`.',
    },
    {
      severity: 'minor',
      category: 'tests',
      message: 'No test exercises the negative-total path being added here.',
    },
  ],
  summary:
    'One blocking compile-time mistake (const reassignment) and one missing test for the new branch. Fix the const before merging.',
};

export async function run_reviewer(diff = sample_diff): Promise<{
  readonly diff: string;
  readonly review: ReviewerOutput;
}> {
  const engine = make_stub_engine(canned);
  try {
    const agent = reviewer({ engine });
    const review = await run(
      agent,
      { diff, focus: ['correctness', 'tests'] },
      { install_signal_handlers: false },
    );
    return { diff, review };
  } finally {
    await engine.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_reviewer()
    .then(({ review }) => {
      console.log(`summary: ${review.summary}\n`);
      for (const f of review.findings) {
        const where = f.file ? ` ${f.file}${f.line === undefined ? '' : `:${String(f.line)}`}` : '';
        console.log(`[${f.severity}] (${f.category})${where}`);
        console.log(`  ${f.message}`);
        if (f.suggestion) console.log(`  suggestion: ${f.suggestion}`);
      }
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
