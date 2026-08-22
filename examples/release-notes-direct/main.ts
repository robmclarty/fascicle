/**
 * release-notes-direct: the same agent as the release-notes example, written in the
 * direct style.
 *
 * Where release-notes/main.ts declares its topology as a `chain`, this version is
 * one named `step` whose body is ordinary TypeScript: `const` bindings, an
 * `if`, an early return, and `ctx.call(writer, ...)` at the model boundary.
 * `ctx.call` keeps spans, abort, and error paths intact, so the trajectory
 * still shows the writer call nested under the step. The domain helpers
 * (parsing, grouping, the schema, the stub engine) are imported from the
 * sibling so this file shows only what changes between the two styles.
 *
 * The twist that earns the direct style here: the model boundary is
 * conditional. A release with no user-facing commits (no feat, no fix)
 * renders a maintenance note without any model call at all. A static
 * composition cannot express "this stage exists only for some inputs" this
 * plainly; a plain body can. When the topology is fixed, prefer the chain;
 * when the control flow is data, write the body.
 *
 * Run directly:
 *   pnpm exec tsx examples/release-notes-direct/main.ts
 */

import { model_step, step } from 'fascicle'
import type { Engine, Step } from 'fascicle'

import {
  group_by_type,
  notes_schema,
  parse_commits,
  run_with_stub,
  WRITER_SYSTEM,
} from '../release-notes/main.js'

function render_breakdown(grouped: Readonly<Record<string, ReadonlyArray<string>>>): string {
  return Object.entries(grouped)
    .map(([type, subjects]) => `- ${type}: ${subjects.length}`)
    .join('\n')
}

export function build_flow(engine: Engine, model: string): Step<string, string> {
  const writer = model_step({
    engine,
    model,
    system: WRITER_SYSTEM,
    schema: notes_schema,
    schema_repair_attempts: 2,
    id: 'writer',
  })

  return step('release_notes', async (log: string, ctx) => {
    const commits = parse_commits(log)
    const grouped = group_by_type(commits)
    const breakdown = render_breakdown(grouped)
    const user_facing = (grouped['feat'] ?? []).length + (grouped['fix'] ?? []).length

    if (user_facing === 0) {
      return `# Maintenance release\n\nNo user-facing changes in these ${commits.length} commits.\n\n${breakdown}\n`
    }

    const notes = await ctx.call(writer, JSON.stringify(grouped, null, 2))
    const highlights = notes.highlights.map((h) => `- ${h}`).join('\n')
    return `# ${notes.headline}\n\n${highlights}\n\n## In this release (${commits.length} commits)\n\n${breakdown}\n`
  })
}

const FEATURE_LOG = `\
bc46bb3 feat(core): add chain and ctx.call primitives
a22f521 fix(engine): dispose claude_cli subprocesses on abort
9c01d22 docs(readme): re-tier the primitives table
`

const CHORE_LOG = `\
bfaf23d chore(gitignore): ignore the research scratch dir
c113a09 chore(deps): bump vitest
d20c771 docs(contributing): clarify the baseline policy
`

export function run_release_notes_direct(log: string): Promise<string> {
  return run_with_stub(build_flow, log, {
    headline: 'Composable chains, safer aborts',
    highlights: [
      'A whole flow can be plain code with ctx.call at the model boundary.',
      'Aborting a run now cleans up CLI subprocesses reliably.',
    ],
  })
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  Promise.all([run_release_notes_direct(FEATURE_LOG), run_release_notes_direct(CHORE_LOG)])
    .then(([with_model, without_model]) => {
      console.log('=== feature release (model path) ===\n')
      console.log(with_model)
      console.log('=== maintenance release (no model call) ===\n')
      console.log(without_model)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
