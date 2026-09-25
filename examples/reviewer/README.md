# reviewer

Structured code review against a stubbed engine. The example wires the
markdown-defined `reviewer` agent against a tiny in-process engine that
returns canned, schema-conforming output. No API keys, no network: it exists
to demonstrate how an agent factory plugs into the rest of Fascicle and
produces typed, structured findings.

![terminal output of the reviewer example: a review summary followed by severity-tagged findings with suggestions](./screenshot.png)

Swap `make_stub_engine` for `create_engine({...})` from `fascicle` to drive
the same flow against a real provider. The agent definition itself is demo
code in [`../agents/`](../agents/); copy it alongside this example when
porting it into your own project.

## Flow

The flow is the single `reviewer` step, so this tree draws the program that
drives it.

```text
run_reviewer         review the sample payments diff, no keys or network
├─ make_stub_engine  answer any prompt with one canned review
└─ reviewer          the model call, focused on correctness and tests
   ├─ md_path        prompt.md, sent as the system prompt
   ├─ build_prompt   the focus areas, then the diff, as the user message
   └─ schema         check the reply against reviewer_output_schema
```

## Run

```bash
pnpm exec tsx examples/reviewer/main.ts
```
