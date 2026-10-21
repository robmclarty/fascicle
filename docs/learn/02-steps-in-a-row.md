# Steps in a Row

One step is a function with a name. Put two steps in a row and you have a
**flow**, which is where Fascicle starts to earn its keep. This lesson
introduces `sequence` and the `describe` verb, which lets you look at a flow
before you run it. About fifteen minutes.

## A Sequence

Create `02-sequence.ts`:

```ts
// 02-sequence.ts
import { describe, run, sequence, step } from 'fascicle'

type Pair = { a: number; b: number }

const add = step('add', ({ a, b }: Pair) => a + b)
const double = step('double', (n: number) => n * 2)
const say = step('say', (n: number) => `the answer is ${n}`)

const flow = sequence([add, double, say])

console.log(describe(flow))
console.log(await run(flow, { a: 2, b: 3 }))
```

```bash
pnpm exec tsx 02-sequence.ts
```

```text
sequence(sequence_1)
  step(add)
  step(double)
  step(say)
the answer is 10
```

`sequence([add, double, say])` runs the steps in order and hands each one the
output of the step before it. Two plus three is five, doubled is ten, and `say`
turns ten into a sentence.

Now hover over `flow` in your editor. Its type is `Step<Pair, string>`. A
sequence of steps is itself a step, so you can run it, put it inside another
sequence, or hand it to anything else that takes a step. A function like
`sequence`, which takes steps and gives back a step, is called a **composer**,
and most of Fascicle is composers.

## Look before You Run

The first four lines of that output came from `describe(flow)`, and they were
printed before anything ran. `describe` doesn't call your functions. It walks the
flow and prints its shape.

That works because a flow is a value: a tree of plain objects, the way a recipe
is a list of instructions before anybody starts cooking. You can print a value,
compare it, test it, and pass it to a function, and every one of those works on
a flow too.

`describe` has a friendlier cousin. Swap it for `describe.diagram(flow)`:

```text
sequence
├─ add     step
├─ double  step
└─ say     step
```

And the diagram gets better when you tell it what each step is for. Every step
and every composer takes an optional `description`. Replace the three step
definitions and the `flow` line in `02-sequence.ts` with these:

```ts
const add = step('add', ({ a, b }: Pair) => a + b, { description: 'add the two numbers' })
const double = step('double', (n: number) => n * 2, { description: 'double it' })
const say = step('say', (n: number) => `the answer is ${n}`, { description: 'put it in words' })

const flow = sequence([add, double, say], { name: 'calculator', description: 'add, double, then say it' })
```

```text
calculator  sequence: add, double, then say it
├─ add      add the two numbers
├─ double   double it
└─ say      put it in words
```

Get used to this picture. It's how you'll check what you built, and later it's
how you and your agent agree on what a flow does before either of you writes
it.

## The Joints Are Checked

Swap two steps so the order is wrong, `sequence([add, say, double])`, and check
the types:

```bash
pnpm exec tsc --noEmit
```

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Step<Pair, number>' is not assignable to type 'Step<number, number>'.
      Type 'number' is not assignable to type 'Pair'.
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Step<number, string>' is not assignable to type 'Step<number, number>'.
      Type 'string' is not assignable to type 'number'.
```

That's noisy, so read it from the bottom up. The last line says it all: a string
showed up where a number was expected. `say` hands `double` a sentence, and
`double` can only double numbers. TypeScript checks every joint in a sequence
that you write out as a list of steps, which means a flow that type-checks is a
flow whose pieces fit together. Put the
order back before you go on.

## Flows Inside Flows

Since a sequence is a step, a sequence can hold another sequence:

```ts
const add_and_double = sequence([add, double])
const nested = sequence([add_and_double, say])

console.log(describe.diagram(nested))
console.log(await run(nested, { a: 2, b: 3 }))
```

```text
sequence
├─ sequence
│  ├─ add     add the two numbers
│  └─ double  double it
└─ say        put it in words
the answer is 10
```

Same answer, with one more level in the tree. This is the idea that the whole
library is built on. Small steps make bigger steps, and the bigger ones are
still steps, all the way up.

## Another Way to Write It

In plain TypeScript, with plain functions, you'd write this:

```ts
say(double(add(pair)))
```

Same result, fewer characters. So why bother with `sequence`? Because the
composed version can do three things that nested calls can't. You can look at
it with `describe`, you can watch it run in the viewer
([lesson 7](./07-watch-it-run.md)), and you can swap any piece of it for
anything else with the same input and output types
([lesson 5](./05-the-model-is-a-step.md) swaps a plain function for a model).
For three lines of arithmetic none of that matters much. For a flow with model
calls in it, it matters a lot.

When all you want is to reshape a step's output, `pipe` saves you from writing a
whole step. It takes one step and one plain function, and it runs the function
on the step's output:

```ts
import { pipe } from 'fascicle'

const dollars = pipe(add, (n) => `$${n.toFixed(2)}`)

console.log(await run(dollars, { a: 2, b: 3 }))
```

```text
$5.00
```

## With Your Agent

> In 02-sequence.ts, add a step called square between double and say, give it a
> description, then print the diagram and run it.

Check that the diagram has four rows in the order you asked for, that
`pnpm exec tsc --noEmit` is clean, and that the run prints `the answer is 100`.
Reading the diagram is faster than reading the code, and it's the habit this
whole course is trying to build.

> Put a step that returns a string in front of double, run tsc, and explain the
> error to me. Then undo the change.

Watch how your agent reads the type error. A good explanation names the joint,
the place where a string meets a step that wants a number.

## Try It

1. Write a `negate` step and a sequence that adds, negates, and says. What does
   a negative answer look like?
2. Give `nested` its own `name` and `description`, then print its diagram.
3. Use `pipe` to round the output of a `divide` step to two decimal places.

## Remember

- `sequence([a, b, c])` runs steps in order, each one feeding the next, and the
  sequence is itself a step.
- `describe(flow)` and `describe.diagram(flow)` show the shape of a flow
  without running it.
- TypeScript checks every joint. Read its errors from the bottom line up.

[← A Step Is a Function with a Name](./01-a-step.md) · [Fan Out, Choose, Repeat →](./03-fan-out-choose-repeat.md)
