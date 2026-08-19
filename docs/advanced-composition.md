# Advanced Composition

The primitives on this page are fully supported and are not going anywhere.
They are also not the vocabulary to reach for first. Each one is the
low-level or specialized variant of a primary primitive named in
[leaf-arm-spine.md](./leaf-arm-spine.md), and a flow that uses one should be
able to say why the primary form does not fit. The canonical tour,
[examples/newsroom.ts](../examples/newsroom.ts), leaves all of them out on
purpose.

| Advanced | Primary counterpart | The advanced one earns its keep when |
| --- | --- | --- |
| `scope` / `stash` / `use` | `chain` bindings | the state shape is one bindings cannot express |
| `ensemble` | `ensemble_step` | the score is a plain function, not a model |
| `tournament` | `ensemble_step` | quality is only pairwise-comparable |
| `improve` | `adversarial` | quality is a number to climb, not a critic's verdict |
| `learn` | none (offline) | mining recorded trajectories for proposals |

## `scope`, `stash`, `use`: Named State without Types

The raw state tier. `scope([...children])` runs its children in order like
`sequence`, threading each output into the next input, while introducing a
scope-local state map. `stash(key, source)` runs `source`, writes its output
to the state under `key`, and passes the value through unchanged.
`use(keys, fn)` reads the named values and runs `fn` with a plain-object
projection of just those keys. Inner scopes inherit outer state; writes stay
in the inner map. Calling `stash` or `use` outside a `scope` is a runtime
error.

<!-- snippet: check -->

```ts
import { scope, stash, step, use } from 'fascicle';

export const flow = scope([
  stash('user', step('lookup', (email: string) => `user-record:${email}`)),
  use(['user'], ({ user }) => `publish:${String(user)}`),
]);
```

`chain` is the typed front door over the same idea, and the reason this trio
is no longer the default. A chain binding is a named value in a growing
record: later steps destructure it with compile-time checking, `describe`
renders the plan, and a rename is a refactor instead of a string edit. The
raw trio keys a `Map<string, unknown>` by string, so every read needs a cast,
and the [blueprint's `state.ts` quarantine](./blueprint.md#statets-quarantine-the-casts-raw-scope-state-only)
exists to contain exactly that.

What bindings cannot express, the trio still can:

- **Writes from deep inside a subtree.** A chain merges state only at its
  own bindings. A `stash` can run anywhere: a leaf nested three composers
  down can publish a value without every layer above threading it.
- **State shared across sibling compositions** whose common parent does not
  want the value in its own type.
- **Keys computed at runtime**, where the set of names is data.

If none of those apply, use `chain`. If one does, keep the keys and their
typed readers together in one file so the casts stay visible
([blueprint.md](./blueprint.md#statets-quarantine-the-casts-raw-scope-state-only)).

## `ensemble` and `tournament`: The Other Pick-Bests

`ensemble_step` is the primary selection arm because a judge is usually a
model: its scorer is itself a `Step`, so the judge gets its own span in the
trajectory and returns a structured score. Its two siblings drop parts of
that machinery:

- **`ensemble({ members, score, select?, project? })`** scores with a plain
  function `(output) => number`. Right when quality is computable without
  judgment: output length, tests passed, a heuristic. Members run
  concurrently; `select: 'min'` inverts the pick. The envelope is
  `{ winner, scores }`.
- **`tournament({ members, compare, project? })`** never scores at all:
  `compare(a, b)` returns `'a' | 'b'`, and a single-elimination bracket
  reduces the members pairwise. Right when there is no absolute scale, only
  a preference between two candidates. The envelope is
  `{ winner, bracket }`, with every match recorded.

Both take the same `project` option as every envelope composite: unwrap at
the source, so downstream steps see the domain value.

<!-- snippet: check -->

```ts
import { ensemble, step, tournament } from 'fascicle';
import type { Step } from 'fascicle';

const draft = (voice: string): Step<string, string> =>
  step(`draft_${voice}`, (topic: string) => `${voice} take on ${topic}`);

export const tersest = ensemble({
  members: { formal: draft('formal'), breezy: draft('breezy') },
  score: (out) => -out.length,
  project: (r) => r.winner,
});

export const preferred = tournament({
  members: { a: draft('a'), b: draft('b'), c: draft('c') },
  compare: (a, b) => (a.length <= b.length ? 'a' : 'b'),
  project: (r) => r.winner,
});
```

[examples/ensemble_judge.ts](../examples/ensemble_judge.ts) keeps both
variants runnable side by side.

## `improve` and `learn`: The Self-Improvement Pair

Neither belongs in an everyday flow; both are specialized enough that
reaching for them should be a deliberate act.

**`improve({ seed, propose, score, budget, project? })`** is an online
hill-climb. `seed` produces the starting `{ content, score }`; each round
`propose` emits a candidate from `{ parent, parent_score, round, lessons }`
and `score` returns a verdict. Acceptance requires both the scorer's
`accepted` gate and an epsilon improvement over the parent's score; rejected
rounds feed their `reason` back into the next round as lessons. The loop
stops on `budget.max_rounds`, `budget.max_wallclock_ms`, or a plateau
(`patience` rounds without progress), and the envelope is
`{ best, rounds_used, stopped_by, history }`.

Reach for `adversarial` first: when "good enough" is a critic's verdict, the
build-critique loop is simpler and stops on `accept`. `improve` earns its
keep when quality is a number you are pushing up and you want plateau
detection over an iteration budget.

<!-- snippet: check -->

```ts
import { improve, step } from 'fascicle';
import type { Candidate, ImproveRoundInput } from 'fascicle';

export const climb = improve({
  seed: step('seed', (topic: string) => ({ content: topic, score: 0 })),
  propose: step('propose', (r: ImproveRoundInput<string>) => ({
    content: `${r.parent} (round ${r.round})`,
    proposer_id: 'rewrite',
  })),
  score: step('score', (c: Candidate<string>) => ({
    candidate: c,
    score: c.content.length,
    accepted: true,
  })),
  budget: { max_rounds: 3, patience: 2 },
  project: (r) => r.best.content,
});
```

**`learn({ flow, source, analyzer })`** never runs in the request path at
all. It replays recorded trajectories (`source` is inline events, a list of
JSONL paths, or a directory) through an `analyzer` step and returns
`{ proposals, events_considered, run_ids }`. What the proposals are is the
analyzer's business: prompt edits, few-shot candidates, flow changes. Wire
its output into review, not into production behavior.

Runnable references: [examples/improve.ts](../examples/improve.ts),
[examples/learn.ts](../examples/learn.ts), and
[examples/learn_reviewer.ts](../examples/learn_reviewer.ts) (a model
analyzer mining a reviewer's trajectories).

## See Also

- [leaf-arm-spine.md](./leaf-arm-spine.md): the primary vocabulary and the
  decision rules this page defers to
- [composition.md](./composition.md): one-liners for the full primitive
  surface
- [api-reference.md](./api-reference.md): signatures at a glance
