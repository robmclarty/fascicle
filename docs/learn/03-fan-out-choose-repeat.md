# Fan Out, Choose, Repeat

A sequence is one shape a flow can take. Three more cover most of what you'll
ever need, and they're the ones you already use in plain code every day. You do
several things at once, you pick one path out of two, and you do the same thing
to every item in a list. In Fascicle they're `parallel`, `branch`, and `map`.
About twenty minutes.

Create `03-shapes.ts` with the two steps you'll reuse:

```ts
// 03-shapes.ts
import { branch, describe, map, parallel, run, step } from 'fascicle'

type Pair = { a: number; b: number }

const add = step('add', ({ a, b }: Pair) => a + b)
const multiply = step('multiply', ({ a, b }: Pair) => a * b)

const both = parallel({ sum: add, product: multiply })
console.log(await run(both, { a: 6, b: 3 }))
```

```bash
pnpm exec tsx 03-shapes.ts
```

```text
{ sum: 9, product: 18 }
```

## Fan Out with `parallel`

`parallel` takes a set of named steps and gives every one of them the same
input. They all run at the same time, and you get back an object with the same
names as keys. Hover over `both` and you'll see the type,
`Step<Pair, { sum: number; product: number }>`.

Reach for it when pieces of work don't depend on each other. Two arithmetic
steps finish in no time either way, but when each member is a model call that
takes a few seconds, running them side by side is the difference between
waiting for the slowest one and waiting for all of them in turn.

## Choose with `branch`

Add this to the file:

```ts
const share = branch({
  when: ({ b }: Pair) => b === 0,
  then: step('nobody', () => 'nobody to share with'),
  otherwise: step('divide', ({ a, b }: Pair) => `${a / b} each`),
})

console.log(await run(share, { a: 6, b: 3 }))
console.log(await run(share, { a: 6, b: 0 }))
```

```text
2 each
nobody to share with
```

`branch` asks the `when` function a yes-or-no question about the input, then
runs `then` for yes and `otherwise` for no. Only one of the two runs. `when` is a
plain function, not a step, because it's a question rather than a piece of work.

Both arms hand back a string, and that's deliberate. Whatever comes after a
branch has to cope with either arm's output, so `branch` wants them to agree,
which is the same joint-checking you saw in the last lesson. When you really do
want two different types, spell out the combination and TypeScript will hold
you to it:

```ts
const maybe_divide = branch<Pair, number | null>({
  when: ({ b }) => b === 0,
  then: step('nothing', () => null),
  otherwise: step('divide', ({ a, b }: Pair) => a / b),
})
```

That's required on 0.16.3 and earlier, which reject arms that don't agree.
Later releases work the combination out for you, `number | null` here, so
spelling it out becomes optional, though it still says what you meant.

## Repeat with `map`

Add one more:

```ts
const add_each = map({
  items: (pairs: Pair[]) => pairs,
  do: add,
})

console.log(await run(add_each, [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }]))
```

```text
[ 3, 7, 11 ]
```

`items` pulls a list out of the input (here the input already is the list),
`do` is the step that runs for each item, and the results come back as an array
in the same order. Pass `concurrency: 2` and no more than two items run at
once. With arithmetic that's pointless, but with a model call per item it keeps
you under your provider's rate limit.

## Shapes Nest

Every one of these shapes takes steps and returns a step, so they nest in any
combination you like. For each pair in a list, compute the sum, the product, and
the share, all at once, two pairs at a time:

```ts
const report_all = map({
  items: (pairs: Pair[]) => pairs,
  do: parallel({ sum: add, product: multiply, share }),
  concurrency: 2,
})

console.log(describe.diagram(report_all))
console.log(await run(report_all, [{ a: 6, b: 3 }, { a: 4, b: 0 }]))
```

```text
map
└─ parallel
   ├─ sum  add           step
   ├─ product  multiply  step
   └─ share  branch
      ├─ then  nobody    step
      └─ else  divide    step
[
  { sum: 9, product: 18, share: '2 each' },
  { sum: 4, product: 0, share: 'nobody to share with' }
]
```

Read the diagram top to bottom and it tells you what the flow does, before you
run it. A map, over a parallel, whose third member is a branch. You built a
small program out of four words. (The diagram calls a branch's `otherwise` arm
`else`.)

## Another Way to Write It

You could write all of that in one step with plain code:

```ts
const report_all_by_hand = step('report_all', (pairs: Pair[]) =>
  pairs.map(({ a, b }) => ({
    sum: a + b,
    product: a * b,
    share: b === 0 ? 'nobody to share with' : `${a / b} each`,
  })),
)
```

It gives the same answer, and for arithmetic it's arguably clearer. Now print its
diagram:

```text
report_all  step
```

One row. Everything that happens inside the function is invisible to
`describe`, and later to the viewer, and you'd have to write your own
concurrency cap the day each item becomes a model call.

So which do you use? Ask whether the decision or the loop is part of the story
that your flow tells, something you'd want to see in the diagram, watch in the
viewer, or change later on. If it is, use the composer. If it's a detail inside
one piece of work, plain code inside a step is fine, and nobody will thank you
for turning a ternary into a `branch`.

## With Your Agent

These shapes have names, and the names are how you tell your agent what you
want. Try a request written the way you'd say it out loud:

> In 03-shapes.ts, for each pair in a list, work out the sum and the difference
> at the same time, but only handle two pairs at once. Print the diagram before
> you run it.

"For each" is `map`, "at the same time" is `parallel`, and "two at once" is
`concurrency: 2`. Check that the diagram shows a map over a parallel with two
members. If your agent wrote a `for` loop or a `Promise.all` instead, ask it why,
and point it at this lesson.

> Rewrite share as one step with a plain if inside it. Print both diagrams and
> tell me what the second one can't show me.

## Try It

1. Add a `difference` member to `both`. Watch the output type change in your
   editor.
2. Make a flow that adds a pair and then says "big" when the sum is over 100 and
   "small" otherwise. You'll need a `sequence` with a `branch` in it.
3. Give `report_all` a `name` and some descriptions, and print its diagram
   again.

## Remember

- `parallel({ a, b })` runs steps at the same time on the same input, and
  returns `{ a, b }`.
- `branch({ when, then, otherwise })` runs one of two steps, which must agree on
  their output type.
- `map({ items, do, concurrency })` runs a step for every item in a list.
- Every shape returns a step, so shapes nest inside each other.

[← Steps in a Row](./02-steps-in-a-row.md) · [The Spine →](./04-the-spine.md)
