# A Step Is a Function with a Name

Start with a function you already know how to write:

```ts
function add(a: number, b: number): number {
  return a + b
}
```

Fascicle's unit of work is called a **step**, and a step is a function like
this one with two changes. It has a name, and it takes exactly one input. That's
all of it, and everything else in these lessons is a way of combining steps.
About ten minutes.

## One Way In, One Way Out

Why only one input? Because steps snap together. When every step takes one
value and returns one value, the output of any step can become the input of the
next, the way one length of pipe screws onto another. A function that takes two
arguments has two openings on one end, and it won't screw onto anything.

So when a step needs two numbers, you hand it one object that holds both. Create
`01-add.ts` in your workbench:

```ts
// 01-add.ts
import { run, step } from 'fascicle'

type Pair = { a: number; b: number }

const add = step('add', ({ a, b }: Pair) => a + b)

const result = await run(add, { a: 2, b: 3 })
console.log(result)
```

```bash
pnpm exec tsx 01-add.ts
```

```text
5
```

## What Just Happened

`step('add', fn)` wrapped your function and gave it the id `add`. Then
`run(add, { a: 2, b: 3 })` ran it and handed back a promise of the output, which
`await` unwrapped.

A step isn't anything mysterious. Add `console.log(add)` to the file and you'll
see the whole thing:

```text
{ id: 'add', kind: 'step', run: [Function (anonymous)] }
```

It's a plain object with an id, a kind, and a function to run. Hover over `add`
in your editor and TypeScript shows you its type, `Step<Pair, number>`: a pair
goes in, a number comes out. Every piece of a Fascicle program has a type of
that shape, `Step<i, o>`, from this one-line adder to a whole agent with a dozen
model calls inside it. Keep that in mind, because the rest of the course leans
on it.

## Names Matter

The id is how you'll find this step later. It shows up in error messages, in the
diagrams that you'll print in the next lesson, and in the viewer that you'll
watch runs in. An id has to be a plain identifier (letters, digits, and
underscores, not starting with a digit), because Fascicle reads ids back as
property names. Try a space and
the step refuses to be built:

```text
TypeError: step id "add numbers" is not a valid identifier: ids are read back as property names, so use add_numbers and put the label in meta.name
```

The error tells you what to do. Keep the id short and put any prose in the
options:

```ts
const add = step('add', ({ a, b }: Pair) => a + b, { name: 'Add two numbers' })
```

## Slow Steps Are Still Steps

A step can be `async`. Nothing else changes:

```ts
const slow_add = step('slow_add', async ({ a, b }: Pair) => {
  await new Promise((resolve) => setTimeout(resolve, 500))
  return a + b
})

console.log(await run(slow_add, { a: 2, b: 3 }))
```

`run` always hands back a promise, so you `await` it the same way whether the
function inside is quick or slow. Soon the slow thing inside a step will be a
call to a model or a request to some API, and it'll have exactly this shape.

## Another Way to Write It

You don't have to rewrite the functions you already have. A step can call a
plain function and leave it alone:

```ts
function add_numbers(a: number, b: number): number {
  return a + b
}

const add = step('add', ({ a, b }: Pair) => add_numbers(a, b))
```

And a function that already takes one input can be handed over as it is:

```ts
function add_pair({ a, b }: Pair): number {
  return a + b
}

const add = step('add', add_pair)
```

Either way is fine. A good habit is to keep the real work in plain functions
that you can test and reuse anywhere, and to treat the step as a thin wrapper
that gives the work a name and a place in a flow. That split pays off more as
your flows grow, and [lesson 13](./13-grow-into-the-blueprint.md) is about
exactly that.

You can also write `step(fn)` with no id at all. It works, but unnamed steps
make errors and run logs hard to read, and a few of the tools that you'll meet
later refuse them, so name your steps.

## With Your Agent

Ask your agent:

> Add a step called subtract to 01-add.ts that takes the same Pair and returns
> a minus b, then run both steps.

Check that it wrote `step('subtract', ...)` with a `Pair` going in (not two
arguments), and that it ran it with `run(subtract, { a, b })`. Then ask it a
question without letting it change anything:

> What would happen if I named that step "take away"? Just tell me.

It should say the step throws when it's built, and that the error suggests
`take_away`. If it says the name is fine, it's guessing. Point it at the
primer.

## Try It

1. Make `multiply` and `divide` steps. What does
   `run(divide, { a: 1, b: 0 })` give you? (Remember the answer, because it
   comes back in [lesson 8](./08-when-things-break.md).)
2. Give `add` a `name`, then log `add.meta` and see where the name went.
3. Write a step that takes a string and returns its length. What type does your
   editor show for it?

## Remember

- A step is a function with a name and one input.
- `run(step, input)` runs it and returns a promise.
- Everything in Fascicle is a `Step<i, o>`, something that takes an `i` and
  gives back an `o`.

[← Set Up Your Workbench](./00-set-up.md) · [Steps in a Row →](./02-steps-in-a-row.md)
