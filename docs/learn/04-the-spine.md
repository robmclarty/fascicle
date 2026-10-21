# The Spine

A sequence hands each step the output of the step before it, and nothing else.
That's perfect right up until a step needs something from further back. This
lesson introduces `chain`, the tool for that moment, and a small vocabulary
(leaf, arm, and spine) for the shape that almost every real Fascicle flow grows
into. About twenty minutes.

## The Bucket Brigade

Say you want a report on a pair of numbers that mentions the pair itself, its
sum, its product, and whether the sum is even. With `sequence`, the last step
only sees what the step before it handed over, so every step has to pass along
everything that anyone after it might need:

```ts
const by_hand = sequence([
  step('sum', (pair: Pair) => ({ pair, sum: pair.a + pair.b })),
  step('product', (s: { pair: Pair; sum: number }) => ({ ...s, product: s.pair.a * s.pair.b })),
  step('even', (s: { pair: Pair; sum: number; product: number }) => ({ ...s, even: s.sum % 2 === 0 })),
  step('report', ({ pair, sum, product, even }: { pair: Pair; sum: number; product: number; even: boolean }) =>
    `${pair.a} + ${pair.b} = ${sum} (${even ? 'even' : 'odd'}), and ${pair.a} * ${pair.b} = ${product}`),
])
```

It works, and it's a bucket brigade. Each step copies the whole bucket forward,
and the types get longer at every joint. Add one more value and you're editing
every step after it. (To run it, paste it into `04-chain.ts` once you've made
that file below, and add `sequence` to its import.)

## A Chain Carries the Bucket for You

Create `04-chain.ts`:

```ts
// 04-chain.ts
import { chain, describe, run, step } from 'fascicle'

type Pair = { a: number; b: number }

const add = step('add', ({ a, b }: Pair) => a + b)

const report = chain('pair').input<Pair>()
  .step('sum', add, ({ pair }) => pair)
  .step('product', ({ pair }) => pair.a * pair.b)
  .step('even', ({ sum }) => sum % 2 === 0)
  .output(({ pair, sum, product, even }) =>
    `${pair.a} + ${pair.b} = ${sum} (${even ? 'even' : 'odd'}), and ${pair.a} * ${pair.b} = ${product}`)

console.log(describe.diagram(report))
console.log(await run(report, { a: 2, b: 3 }))
```

```bash
pnpm exec tsx 04-chain.ts
```

```text
chain
├─ sum      step
│  └─ add   step
├─ product  step
├─ even     step
└─ output   step
2 + 3 = 5 (odd), and 2 * 3 = 6
```

Here's how to read it, a line at a time:

- `chain('pair').input<Pair>()` opens a chain. Its input is called `pair` and
  has the type `Pair`, so the chain starts out holding one named value,
  `{ pair }`.
- Each `.step(name, ...)` works something out and adds it to the record under
  that name, and a named value like that is called a **binding**. The record
  grows to `{ pair, sum }`, then `{ pair, sum, product }`, and so on.
- Every step can pull out any name that came before it. `even` reads `sum`, and
  `output` reads all four. TypeScript knows exactly which names exist at each
  point, so a typo or a name that doesn't exist yet is a compile error.
- `.output(fn)` picks the result and closes the chain. What comes back is an
  ordinary step, `Step<Pair, string>`, which you run like any other.

`.step` comes in two forms. The `product` and `even` lines use the function
form, where you write the work right there. The `sum` line uses the step form:
you hand it a step you already have (`add`), plus a small function that picks
that step's input out of the record (`({ pair }) => pair`). The step form is how
you plug real pieces into a chain, and it's why `add` shows up under `sum` in
the diagram.

## Say What Goes In

Leave off `.input<Pair>()` and TypeScript can't tell what the chain takes in,
so it assumes the input can never exist (the type `never`), and you'll see
errors like these:

```text
error TS2339: Property 'a' does not exist on type 'never'.
error TS2345: Argument of type '{ a: number; b: number; }' is not assignable to parameter of type 'never'.
```

When you see `never` in an error about a chain, the fix is almost always to say
what goes in. That's what 0.16.3 and earlier print. Later releases put the fix
in the type itself, as in
`Property 'a' does not exist on type 'ChainInputUndeclared<"call .input<T>() on the chain to say what it takes">'`. You'll also see chains opened the other way in Fascicle's own
docs, as `chain<Pair, 'pair'>('pair')`, which means exactly the same thing, and
as `chain<Pair>()`, which names the input `input` instead of `pair`.

## Sequence or Chain?

One question decides it: does any step need something other than the output of
the step right before it?

- If every step needs only its predecessor's output, it's a straight pipe, so
  use `sequence`.
- If any step needs something older (the original input, or two earlier results
  together), use `chain`.

That's the whole rule. Fascicle's docs call it "fan-in decides," because the
moment two earlier values have to come together in one place, you want them to
have names.

## Leaves, Arms, and a Spine

You now have enough pieces to see the shape that almost every Fascicle app ends
up with. It has three layers:

- **Leaves** are single pieces of work. A step around a function is a leaf, and
  soon a call to a model will be one too.
- **Arms** are compositions around leaves, like a `sequence`, the `parallel`
  and `map` from the last lesson, and the `retry` and `fallback` that you'll
  meet in [lesson 8](./08-when-things-break.md).
- **The spine** is one `chain` that runs the whole job from top to bottom and
  holds its named state. A `branch` or a `loop` belongs to the spine too, since
  it steers the whole job rather than hardening one piece of it.

Read a well-shaped flow from the top and the spine tells the story. Each binding
is a chapter, and the arms and leaves underneath it are the details. When you want
the full treatment, [Leaves, Arms, Spine](../leaf-arm-spine.md) is the guide
behind this idea.

## Another Way to Write It

If you'd rather write a few lines of ordinary code than chain calls together,
you can. This is called the direct style:

```ts
const report_direct = step('report', async (pair: Pair, ctx) => {
  const sum = await ctx.call(add, pair)
  const product = pair.a * pair.b
  const even = sum % 2 === 0
  return `${pair.a} + ${pair.b} = ${sum} (${even ? 'even' : 'odd'}), and ${pair.a} * ${pair.b} = ${product}`
}, { arm: add })
```

Every step's function gets a second argument, `ctx`, and `ctx.call(add, pair)`
runs another step from inside the body. Use it instead of calling `add.run`
yourself, because `ctx.call` keeps the run visible to the viewer and passes
along cancellation. The `{ arm: add }` option tells `describe` that this body
uses `add`, so the diagram still shows it:

```text
report  step
└─ add  step
```

(The option is called `arm` because the steps that a body runs are usually
composed pieces, but any step works.)

Same answer, different feel. The chain puts the shape on display, and the
direct style reads like the code you already write. Both are first-class, and
[lesson 9](./09-many-ways-to-think.md) sets them side by side with three more
ways to write the same flow.

## With Your Agent

> In 04-chain.ts, add a binding called difference, and change the output so it
> mentions the difference too. Print the diagram.

Check that the diagram has a new `difference` row between `even` and `output`,
and that the output reads `difference` without any casts.

> Turn the by_hand sequence from this lesson into a chain, run both, and tell
> me which one you'd rather change next month and why.

## Try It

1. Add a `ratio` binding that needs both `sum` and `product`. Which earlier
   steps does it read from?
2. Take `.input<Pair>()` out of `04-chain.ts`, run `pnpm exec tsc --noEmit`,
   and read the errors. Then put it back.
3. Write `report` in the direct style from memory, then compare its diagram with
   the chain's.

## Remember

- `chain('name').input<Type>()` opens a chain whose record starts with your
  input under that name.
- `.step(name, ...)` adds a named value that every later step can read, and
  `.output(fn)` closes the chain into a regular step.
- Use `sequence` for a straight pipe, and use `chain` as soon as a step needs
  something older.
- Leaves do the work, arms compose around them, and one chain is the spine.

[← Fan Out, Choose, Repeat](./03-fan-out-choose-repeat.md) · [The Model Is Just Another Step →](./05-the-model-is-a-step.md)
