# Leaves, arms, spine

Every well-factored fascicle app converges on the same three-layer shape,
whatever its domain. This doc names the layers and gives the decision rules
for choosing the right primitive at each one. The canonical worked example is
[examples/newsroom.ts](../examples/newsroom.ts), which uses every primary
primitive once, each in its suggested role; the app-scale versions are the
reference apps under [examples/](../examples/).

| Layer | What it is | Built from |
| --- | --- | --- |
| **Leaf** | one boundary: a model role, a tool, a pure function | `model_step`, `model_call`, `step`, `define_agent` |
| **Arm** | a named composition around leaves: hardening, selection, verification, fan-out | `retry`, `timeout`, `fallback`, `checkpoint`, `map`, `parallel`, `sequence`, `ensemble_step`, `adversarial`, `consensus`, `tournament` |
| **Spine** | one `chain` per flow: the typed record everything threads through | `chain` with `.step` / `.stage` / `.output`, `ctx.call`, `branch`, `loop` |

The layering is a convention, not a mechanism: nothing in the API forces it.
It is the shape that keeps a flow readable top to bottom, renders fully under
`describe`, and leaves every piece swappable behind a `Step` type.

## Leaves: one boundary each

A leaf is a single call: one model role, one tool invocation, one pure
function. The choices at this layer:

- **`model_step` is the default model boundary.** It returns the reply
  content directly (schema-validated when a schema is set), so downstream
  code never sees the result envelope.
- **`model_call` is the envelope variant.** Reach for it only when the caller
  wants what surrounds the content: `usage`, `cost`, `tool_calls`,
  `finish_reason`. newsroom keeps exactly one `model_call` because its output
  step prints a token cost line.
- **`step(name, fn)` wraps pure functions and port calls.** Parsing,
  formatting, a call on an injected service. Name every step you might
  resume or watch; the id is the trajectory label.
- **`define_agent`** (from `fascicle/agents`) is the markdown-prompt leaf:
  role and constraints in a `.md` file, schema-validated output.

Give each model leaf a stable role id as the first line of its system prompt
(`myapp/reviewer`). Stub engines from `fascicle/testing` route canned
responses on it, and trajectory readers orient by it.

The rule: if it is one call, keep it a leaf. Wrapping a single leaf in
`compose` or `sequence` just to give it a span name is composition theater
(blueprint anti-pattern 3).

## Arms: composition that earns its keep

An arm is a named sub-flow built by composing primitives around leaves. This
is where judgment and resilience live:

- **Hardening**: `retry`, `timeout`, `fallback`, `checkpoint` around a
  fragile or expensive leaf.
- **Selection**: `ensemble_step` (or `ensemble`, `tournament`) when several
  leaves compete and a judge picks.
- **Verification**: `consensus` for independent agreement, `adversarial` for
  a build-and-critique loop.
- **Fan-out**: `map` and `parallel` for per-item and heterogeneous
  concurrency.
- **Straight pipes**: `sequence([a, b, c])` when each step consumes exactly
  its predecessor's output.

Two rules keep arms honest:

1. **An arm exists when a second primitive genuinely composes around a
   leaf.** Hardening, selection, verification, and fan-out all qualify; a
   renamed single leaf does not.
2. **Unwrap envelopes at the source with `project`.** The judgment
   composites return result envelopes (`{ winner, scores }`,
   `{ candidate, converged, rounds }`, `{ result, converged }`). Their
   `project` option maps the envelope into the arm's output type, so the arm
   presents a domain value (`Step<string, Draft>`) instead of leaking its
   internal machinery downstream.

## The spine: one chain per flow

The spine is a single `chain` that sequences the arms and holds the flow's
state as a typed record. Each `.step` binding merges its result under a
name; later bindings destructure whatever earlier names they need, checked
at compile time. `.stage` marks phase barriers (a grouping span in the
trajectory; with a projection, earlier bindings go out of scope).

A binding invokes an arm with `ctx.call(arm, input)`, never a bare
`arm.run(input, ctx)`, which bypasses the dispatcher and loses the span.
Pass the same value as `arm` metadata so the static tree stays complete:

```ts
.step('article', ({ outline, style }, ctx) =>
  ctx.call(polish, format_draft_prompt(outline, style)), { arm: polish })
```

Dispatch ignores the metadata (the body's `ctx.call` is what runs the arm);
`describe` renders the arm's subtree as the binding's child, so the printed
tree shows the whole topology without running anything.

The rule for spine versus straight pipe: **fan-in decides**. The moment any
step needs a value that is not its immediate predecessor's output (the brief
three steps back, two arms' results combined), you are at spine level and
`chain` is the tool. A linear pipe where each step consumes exactly the
previous output is an arm-level `sequence`, and forcing it into a chain is
ceremony. In practice: a step needing only step N-1 keeps you in `sequence`;
the first step needing N-2 moves you to `chain`.

## The shape, end to end

<!-- snippet: check -->

```ts
import { chain, consensus, model_step, retry, sequence, step, timeout } from 'fascicle';
import type { Engine, Step } from 'fascicle';
import { z } from 'zod';

const verdict_schema = z.object({ ok: z.boolean(), notes: z.string() });

export function build_flow(engine: Engine): Step<string, string> {
  // Leaves: one model boundary each, routed by a stable role id.
  const summarize = model_step({ engine, system: 'app/summarize', id: 'summarize' });
  const checker = (n: number) =>
    model_step({ engine, system: 'app/check', schema: verdict_schema, id: `check_${n}` });

  // Arm: hardening composed around the summarize leaf.
  const research: Step<string, string> = sequence([
    step('fetch', (url: string) => `contents of ${url}`),
    timeout(retry(summarize, { max_attempts: 2 }), 30_000),
  ]);

  // Arm: verification; project unwraps the envelope at the source.
  const fact_gate = consensus({
    members: { first: checker(1), second: checker(2) },
    agree: (verdicts) => Object.values(verdicts).every((v) => v.ok),
    max_rounds: 2,
    project: (r) => r.converged,
  });

  // Spine: one chain; each binding calls its arm and declares it as metadata.
  return chain<string, 'url'>('url')
    .step('summary', ({ url }, ctx) => ctx.call(research, url), { arm: research })
    .step('verified', ({ summary }, ctx) => ctx.call(fact_gate, summary), { arm: fact_gate })
    .output(({ summary, verified }) => (verified ? summary : `UNVERIFIED: ${summary}`));
}
```

`describe(build_flow(engine))` prints this same structure as a tree: the
chain with its plan, each binding with its arm's subtree nested beneath it,
down to the leaves with their role ids. The full-size version of this shape
is newsroom's brief-to-article flow; the app-scale versions are
change-triage (minimal spine, one leaf), pr-improve (branching between
chains), amplify (a loop whose carry-state rides the spine's bindings), and
red-green-refactor (stage barriers as phases).

## What the layering buys

- **The topology is the file.** The spine reads top to bottom as the agent
  diagram; arms are named; leaves are role ids.
- **`describe` renders everything.** Because arms are declared on their
  bindings, the static tree matches the runtime span tree.
- **Trajectories nest**: spine binding spans wrap arm spans wrap leaf spans,
  with no extra wiring.
- **Arms are swap surfaces.** An arm's `Step<In, Out>` type is its whole
  contract: replace a one-shot leaf with a hardened ensemble behind the same
  type and the spine does not change.
- **Tests stay black-box.** `make_stub_engine` from `fascicle/testing`
  routes canned responses by leaf role ids, so the real spine and arms run
  through the real `run()` with zero network.

## Common failure modes

Each of these has a longer treatment in [blueprint.md](./blueprint.md)'s
anti-patterns:

- **Composition theater**: single-leaf arms, spans for the sake of spans.
  Collapse to the leaf.
- **Buried control flow**: an `if`/`for`/try-fallback hidden in a step body
  where `branch`/`loop`/`fallback` would show in the trajectory. Lift it,
  or if the wiring is genuinely dynamic, keep the body named, use
  `ctx.call`, and say why.
- **Envelope leakage**: an arm returning `{ winner, scores }` so every
  caller unwraps it downstream. Move the unwrap into the arm with `project`.
- **Ambient state**: reaching for `scope`/`stash`/`use` string keys where
  chain bindings would be typed. The raw state primitives remain for shapes
  bindings cannot express; they are not the default.

## See also

- [composition.md](./composition.md): the full primitive-by-primitive surface
- [blueprint.md](./blueprint.md): the app architecture around the flow
  (engine seam, prompts, schemas, testing, enforcement rules)
- [api-reference.md](./api-reference.md): signatures at a glance
