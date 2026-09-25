# hello

Your first Fascicle harness. Three steps compose into a flow, and one `run`
call executes it: no engine, no network, no API keys. This is the smallest
viable shape of a harness (a flow value, one run call, and a tiny surrounding
program).

![terminal output of the hello example: the input sentence and its word-reversed output](./screenshot.png)

## Flow

```text
sequence          three pure steps, no engine and no model call
├─ parse          split the input sentence on whitespace
├─ reverse_words  reverse the order of the words
└─ join           join the words back into one sentence
```

## Run

```bash
pnpm exec tsx examples/hello/main.ts
pnpm exec tsx examples/hello/main.ts "your custom input here"
```
