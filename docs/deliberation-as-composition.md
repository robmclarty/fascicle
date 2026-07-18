# Deliberation as a composition primitive

Multi-agent deliberation is not a framework feature. It is composition.

By "deliberation" we mean the patterns that run several attempts at the same task and adjudicate between them: keep the best of N, run a bracket, loop until the attempts agree, build-then-critique until a judge accepts. Other frameworks ship these as bespoke orchestrators with their own lifecycle, their own state, and their own way of being configured. fascicle ships them as four ordinary `Step<i, o>` values assembled from the [21 primitives](./composition.md). There is nothing in `ensemble`, `tournament`, `consensus`, or `adversarial` that you could not have written yourself with `parallel`, `loop`, `scope`, and `compose`.

That is the whole claim, and it has consequences. Read [concepts.md](./concepts.md) first if "everything is a `Step<i, o>`" is not yet reflexive; the rest of this page assumes it.

## The invariant, restated for deliberation

Every composer takes one or more `Step<i, o>` values and returns a single `Step`. A deliberation composite is a composer like any other. So:

- **It substitutes anywhere a plain step does.** `ensemble(...)` is a `Step`. You can wrap it in `retry`, drop it into a `sequence`, feed it to `map`, or hand it to `run`. Nothing about it being "multi-agent" changes its surface.
- **It carries no hidden state.** The state a deliberation needs (the prior candidate, the critique notes, the round's results) is threaded explicitly through `scope` / `stash` / `use`, not parked in a closure or an instance field. Two unrelated runs of the same composite share nothing.
- **It is introspectable.** A composite is a tree of plain objects. `describe(step)` walks it. Its trajectory shows the `parallel` fan-out and the `loop` rounds it is actually made of, because that is what it is actually made of.

Here is the substitutability point as code. An `ensemble` is a `Step`, so `retry` wraps it with no special casing:

<!-- snippet: check -->
```typescript
import { ensemble, retry, run, step } from 'fascicle';

// Three cheap attempts at the same task; keep the longest answer.
const guess = ensemble({
  members: {
    short: step('short', (n: number) => 'x'.repeat(n)),
    long: step('long', (n: number) => 'x'.repeat(n * 2)),
  },
  score: (text: string) => text.length,
});

// `guess` is a Step<number, EnsembleResult<string>>, so `retry` treats it as
// the opaque step it is.
const robust = retry(guess, { max_attempts: 3 });

await run(robust, 4); // { winner: 'xxxxxxxx', scores: { short: 4, long: 8 } }
```

Note the output type. `ensemble` does not return the member output `o`; it returns a small result envelope, `EnsembleResult<o>`, carrying the winner and the score map. That envelope is the only difference between a deliberation composite and a plain step, and it changes nothing structural: the result is still a `Step`, so every composer still accepts it. We will lean on that fact when we nest these.

## The four shipped composites

All four live in [`src/composites/`](../src/composites/) and are re-exported from `fascicle`. They are not in `core` because they are conveniences, not architectural primitives. Their source is meant to be read; it is the canonical record of how a deliberation pattern decomposes.

Two of them are a fan-out plus a reducer. Two of them are a bounded loop. None of them is more than that.

### `ensemble`: fan out, then pick

`ensemble({ members, score, select? })` runs every member concurrently with the same input, scores each result, and returns the highest (or `select: 'min'`) scorer plus the full score map.

The assembly, in essence:

```typescript
// src/composites/ensemble.ts, distilled
compose(name, sequence([parallel(members), pick_winner]));
```

`parallel(members)` is the fan-out: it runs the named map of steps concurrently and returns their results keyed by name. `pick_winner` is a single `step` that scores each result and selects. `compose(name, ...)` labels the whole thing so it shows up by intent in a trajectory rather than as an anonymous `sequence`. Cancellation, concurrency, and abort propagation are not re-implemented; they are inherited from `parallel`'s contract.

It returns `Step<i, EnsembleResult<o>>` where `EnsembleResult<o>` is `{ winner: o, scores: Record<string, number> }`.

### `tournament`: fan out once, then reduce pairwise

`tournament({ members, compare })` also fans out every member once, then runs a single-elimination bracket over the settled results. `compare(a, b)` is a function over two member *results* that returns `'a'` or `'b'`: the result that advances. An odd count yields a bye. It returns `{ winner, bracket }`, where `bracket` is the list of every match record.

```typescript
// src/composites/tournament.ts, distilled
compose(name, sequence([parallel(members), run_bracket]));
```

The detail worth internalizing: the bracket does not re-run members. The members produce their candidates once, concurrently, and the `compare` calls operate on those already-computed values. A tournament is a fan-out followed by a reduction over fixed data, not a sequence of fresh matches.

### `consensus`: loop until the attempts agree

`consensus({ members, agree, max_rounds })` runs every member concurrently, checks whether `agree(results)` holds, and if not, re-runs all of them, up to `max_rounds`. It returns `{ result, converged }`. Non-convergence is reported as `converged: false`, not thrown.

This is the first one built on `loop` rather than `parallel` alone:

```typescript
// src/composites/consensus.ts, distilled
compose(name, loop({
  init: (input) => ({ input, results: {} }),
  body: /* scope: run parallel(members) on the carried input */,
  guard: /* step: { stop: agree(results), state } */,
  finish: (state) => state.results,
  max_rounds,
}));
```

The `body` is itself a `scope([...])` block that stashes the round's state, extracts the original input, runs `parallel(members)`, and folds the results back into the carried state. The point of routing the input through `scope` / `stash` / `use` is that each round gets the same input, and the members stay unmodified user-supplied `Step` values. The loop owns the iteration; the members own nothing about it.

### `adversarial`: build, critique, repeat

`adversarial({ build, critique, accept, max_rounds })` runs up to `max_rounds` of: build a candidate (handed the prior candidate and critique notes once they exist), critique it, check `accept`. It returns `{ candidate, converged, rounds }`.

Its source file carries a note in the header: read it as documentation. It is the canonical example of a user-built composite, because nothing about it is privileged. The entire implementation is a `loop` whose `body` is the `build` step wrapped in `scope` (to thread the prior candidate forward) and whose `guard` runs the `critique` step and evaluates `accept`:

```typescript
// src/composites/adversarial.ts, distilled
compose(name, loop({
  init: (input) => ({ input }),
  body: /* scope: build a candidate from { input, prior?, critique? } */,
  guard: /* scope: critique the candidate, stop when accept(notes) */,
  finish: (state) => state.candidate,
  max_rounds,
}));
```

`build` is a `Step<{ input, prior?, critique? }, candidate>`. `critique` is a `Step<candidate, { notes, ... }>`. Both are yours. The composite supplies only the plumbing that loops them and threads state between rounds, and that plumbing is the same `scope` / `stash` / `use` you would reach for in your own code. If you wanted a fifth pattern, you would write it the same way, and it would substitute in the same places.

For runnable versions of all four against real models, see the recipes in [cookbook.md](./cookbook.md): ensemble of judges, build-and-critique, consensus of N runs, tournament of candidates.

## Nesting is free

Because each composite returns a `Step`, a composite can be a member of another composite. There is no integration to write. A tournament of ensembles is a tournament whose members happen to be ensembles, and whose result type is therefore the ensemble's result envelope:

<!-- snippet: check -->
```typescript
import { create_engine, ensemble, model_call, pipe, tournament } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const draft = (id: string, system: string) =>
  pipe(model_call({ engine, id, model: 'sonnet', system }), (r) => r.content);

// An ensemble is a Step. Score its members, keep the winner.
const panel = (prefix: string) =>
  ensemble({
    members: {
      terse: draft(`${prefix}_terse`, 'Write a terse tagline.'),
      bold: draft(`${prefix}_bold`, 'Write a bold tagline.'),
    },
    score: (text: string) => text.length,
  });

// A tournament whose members are ensembles. The inner winner is the outer
// candidate; the outer `compare` reads the ensemble's result envelope. No
// special-casing makes the nesting work.
const bracket = tournament({
  members: { left: panel('left'), right: panel('right') },
  compare: (a, b) => (a.winner.length >= b.winner.length ? 'a' : 'b'),
});
```

`bracket` is a `Step<string, TournamentResult<EnsembleResult<string>>>`. The types stack mechanically because each composite is just a step that wraps its members' output in one more envelope. You can keep going: an ensemble of tournaments, a consensus over adversarial loops. The surface never widens, which is the same property [concepts.md](./concepts.md) claims for the primitives, now extended to deliberation.

## One honest limit: cancellation granularity

There is an open design question here, and overclaiming would undercut the rest.

`ensemble`, `tournament`, and `consensus` inherit `parallel`'s abort semantics: when the run's abort signal fires, every in-flight child is cancelled. That is the right default for "score all of them" and "run until they agree." It is not obviously right for every deliberation. A pattern that only needs the first acceptable answer would want the opposite: let the first resolver win and preemptively cancel its siblings. That is `race` semantics, and fascicle does not ship it yet (see the roadmap's [open design questions](./roadmap.md), and the `race` entry in [`src/core/BACKLOG.md`](../src/core/BACKLOG.md)). The promotion bar is deliberately high: a composer earns a place only when its pattern recurs across unrelated flows and is awkward to express today.

So the claim is bounded. Today's composites cancel all-or-nothing on abort, and the finer-grained "first wins, cancel the rest" control is a parked decision, not a shipped feature. That bound does not touch the thesis. Whatever cancellation granularity eventually lands will land as another composer built from the same primitives, returning the same `Step<i, o>`, substitutable in the same places. Deliberation was composition before that decision, and it will be composition after.

## Further reading

- [concepts.md](./concepts.md) — step-as-value, run context, trajectories, cancellation.
- [composition.md](./composition.md) — the full composition surface and every primitive's signature.
- [cookbook.md](./cookbook.md) — runnable deliberation recipes against real models.
- [api-reference.md](./api-reference.md) — the public surface at a glance.
- [regression-testing-model-behavior.md](./regression-testing-model-behavior.md) — the companion essay: scoring and regression-testing what these composites produce.
