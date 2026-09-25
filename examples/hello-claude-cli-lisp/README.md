# hello-claude-cli-lisp

The same harness as [hello-claude-cli](../hello-claude-cli/), rewritten in a
Lisp-flavored style. Functionally identical, different shape.

![terminal output of the hello-claude-cli-lisp example: the same input prompt and greeting as the plain version](./screenshot.png)

The point is pedagogical: TypeScript is an expression language hiding inside
a statement language, and if you lean on that you can write something that
maps almost line-for-line onto Scheme. Each technique in [main.ts](./main.ts)
is annotated so you can see the correspondence, and the header comment
carries a Scheme shadow of the whole program to read alongside it.

## Flow

```text
sequence    ask claude once, then keep the reply text
├─ step     one claude_cli call, model and system from defaults
└─ extract  keep the reply text, or its JSON when not a string
```

The code differs only in shape, so the flow draws the same tree as the plain
version.

## Run

```bash
pnpm exec tsx examples/hello-claude-cli-lisp/main.ts
pnpm exec tsx examples/hello-claude-cli-lisp/main.ts "your prompt here"
```
